import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma, AgentStatus } from '@nexusops/db';
import { appendAuditEvent } from '@nexusops/events';
import { atomicBudgetDeduct } from '@nexusops/blast-radius';
import { createLogger } from '@nexusops/logger';
import { createHmac, timingSafeEqual } from 'crypto';
import { JobType } from '@nexusops/types';

const logger = createLogger('ecc-routes');

// ─── HMAC Signature Verification ──────────────────────────────────────────────

const ECC_WEBHOOK_SECRET = process.env.ECC_WEBHOOK_SECRET || '';

function verifyHmacSignature(body: string, signature: string | undefined): boolean {
  if (!ECC_WEBHOOK_SECRET) return true; // Skip if not configured (dev mode)
  if (!signature) return false;

  try {
    const expected = createHmac('sha256', ECC_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    const sig = signature.replace(/^sha256=/, '');
    if (sig.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ─── Validation Schemas ───────────────────────────────────────────────────────
// These MUST match what nexusops-audit-emit.js and cost-tracker.js actually send.

const eccEventSchema = z.object({
  workspaceId: z.string().min(1),
  eventType: z.string().min(3), // ECC_TOOL_ABOUT_TO_EXECUTE, ECC_TOOL_EXECUTED, etc.
  source: z.literal('ecc-hook'),
  agentId: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.string().datetime(),
});

// Matches cost-tracker.js `row` object exactly (snake_case fields)
const eccCostSchema = z.object({
  timestamp: z.string().min(1),
  session_id: z.string().min(1),
  model: z.string().min(1).max(100),
  input_tokens: z.number().int().min(0).max(10_000_000),
  output_tokens: z.number().int().min(0).max(1_000_000),
  estimated_cost_usd: z.number().min(0).max(100),
});

// ─── ECC Agent Definitions ────────────────────────────────────────────────────
// Must stay in sync with ECC agents/ directory (17 agents as of v1.8.0)

const ECC_AGENTS = [
  // Opus tier
  { eccName: 'architect', model: 'claude-opus-4-6', maxCostUsd: 3.0, toolPermissions: ['GITHUB'] },
  { eccName: 'planner', model: 'claude-opus-4-6', maxCostUsd: 3.0, toolPermissions: ['GITHUB'] },
  { eccName: 'chief-of-staff', model: 'claude-opus-4-6', maxCostUsd: 5.0, toolPermissions: ['GITHUB'] },
  // Sonnet tier
  { eccName: 'code-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 0.5, toolPermissions: ['GITHUB'] },
  { eccName: 'security-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 1.0, toolPermissions: ['GITHUB'] },
  { eccName: 'tdd-guide', model: 'claude-sonnet-4-6', maxCostUsd: 1.0, toolPermissions: ['GITHUB'] },
  { eccName: 'loop-operator', model: 'claude-sonnet-4-6', maxCostUsd: 5.0, toolPermissions: ['GITHUB'] },
  { eccName: 'database-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 0.5, toolPermissions: ['GITHUB', 'DATABASE'] },
  { eccName: 'doc-updater', model: 'claude-sonnet-4-6', maxCostUsd: 0.5, toolPermissions: ['GITHUB'] },
  { eccName: 'harness-optimizer', model: 'claude-sonnet-4-6', maxCostUsd: 1.0, toolPermissions: ['GITHUB'] },
  { eccName: 'go-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 0.3, toolPermissions: ['GITHUB'] },
  { eccName: 'python-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 0.3, toolPermissions: ['GITHUB'] },
  { eccName: 'kotlin-reviewer', model: 'claude-sonnet-4-6', maxCostUsd: 0.3, toolPermissions: ['GITHUB'] },
  { eccName: 'build-error-resolver', model: 'claude-sonnet-4-6', maxCostUsd: 0.5, toolPermissions: ['GITHUB'] },
  { eccName: 'refactor-cleaner', model: 'claude-sonnet-4-6', maxCostUsd: 1.0, toolPermissions: ['GITHUB'] },
  { eccName: 'e2e-runner', model: 'claude-sonnet-4-6', maxCostUsd: 0.5, toolPermissions: ['GITHUB'] },
  // Haiku tier
  { eccName: 'go-build-resolver', model: 'claude-haiku-4-5', maxCostUsd: 0.1, toolPermissions: ['GITHUB'] },
] as const;

// ─── Route Registration ───────────────────────────────────────────────────────

export const eccRoutes: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------
  // POST /events — receives hook events from nexusops-audit-emit.js
  // Auth: API key (hooks run in subprocess, no JWT available)
  // ------------------------------------------------------------------
  app.post('/events', {
    onRequest: [app.authenticateApiKey],
    handler: async (request, reply) => {
      // HMAC signature check (enterprise security)
      const rawBody = JSON.stringify(request.body);
      const sig = request.headers['x-ecc-signature'] as string | undefined;
      if (ECC_WEBHOOK_SECRET && !verifyHmacSignature(rawBody, sig)) {
        return reply.status(401).send({ error: 'INVALID_SIGNATURE', message: 'HMAC verification failed' });
      }

      const body = eccEventSchema.parse(request.body);

      // Workspace isolation: API key workspace must match payload
      if (body.workspaceId !== request.workspaceId) {
        return reply.status(403).send({
          error: 'WORKSPACE_MISMATCH',
          message: 'API key workspace does not match event workspaceId',
        });
      }

      // Return 202 immediately — never make ECC hooks wait
      reply.status(202).send({ received: true, eventType: body.eventType });

      // Write to audit chain (async, fire-and-forget from client perspective)
      appendAuditEvent({
        workspaceId: body.workspaceId,
        eventType: body.eventType,
        entityType: 'ecc_session',
        action: 'EMIT',
        metadata: {
          ...body.metadata,
          source: 'ecc-hook',
          eccSessionId: body.sessionId,
          eccTimestamp: body.timestamp,
        },
      }).catch((err) => {
        logger.error({ err, eventType: body.eventType }, 'ECC audit event write failed');
      });

      // Session lifecycle tracking
      if (body.sessionId) {
        if (body.eventType === 'ECC_SESSION_STARTED') {
          prisma.eCCSession
            .upsert({
              where: {
                workspaceId_sessionId: {
                  workspaceId: body.workspaceId,
                  sessionId: body.sessionId,
                },
              },
              create: {
                workspaceId: body.workspaceId,
                sessionId: body.sessionId,
                agentId: body.agentId,
                status: 'active',
                projectHash: (body.metadata?.projectHash as string) || null,
                hookProfile: (body.metadata?.hookProfile as string) || 'standard',
              },
              update: {
                lastEventAt: new Date(),
                eventCount: { increment: 1 },
              },
            })
            .catch((err: unknown) => logger.warn({ err }, 'ECC session upsert failed'));
        } else if (body.eventType === 'ECC_SESSION_COMPLETED') {
          prisma.eCCSession
            .updateMany({
              where: { workspaceId: body.workspaceId, sessionId: body.sessionId },
              data: {
                status: 'completed',
                endedAt: new Date(),
                stopReason: (body.metadata?.stopReason as string) || 'normal',
                lastEventAt: new Date(),
                eventCount: { increment: 1 },
              },
            })
            .catch((err: unknown) => logger.warn({ err }, 'ECC session completion update failed'));
        } else {
          // Any other event — just increment counter
          prisma.eCCSession
            .updateMany({
              where: { workspaceId: body.workspaceId, sessionId: body.sessionId },
              data: {
                lastEventAt: new Date(),
                eventCount: { increment: 1 },
              },
            })
            .catch(() => {});
        }
      }
    },
  });

  // ------------------------------------------------------------------
  // POST /session/cost — receives cost data from cost-tracker.js
  // Field names match cost-tracker.js output exactly (snake_case)
  // ------------------------------------------------------------------
  app.post('/session/cost', {
    onRequest: [app.authenticateApiKey],
    handler: async (request, reply) => {
      const body = eccCostSchema.parse(request.body);
      const workspaceId = request.workspaceId!;

      reply.status(202).send({ recorded: true });

      // Map cost-tracker field names to our domain
      const costUsd = body.estimated_cost_usd;
      const sessionId = body.session_id;

      // Write to audit chain for cost-summary queries
      appendAuditEvent({
        workspaceId,
        eventType: 'ECC_LLM_COST_RECORDED',
        entityType: 'ecc_session',
        action: 'COST',
        metadata: {
          costUsd,
          model: body.model,
          inputTokens: body.input_tokens,
          outputTokens: body.output_tokens,
          eccSessionId: sessionId,
          source: 'ecc-cost-tracker',
        },
      }).catch(() => {});

      // Accumulate cost on the session record
      prisma.eCCSession
        .updateMany({
          where: { workspaceId, sessionId },
          data: {
            totalCostUsd: { increment: costUsd },
            lastEventAt: new Date(),
          },
        })
        .catch(() => {});

      // Budget deduction (cents) — ECC spend counts against NexusOps budget
      const costCents = Math.ceil(costUsd * 100);
      if (costCents > 0) {
        const session = await prisma.eCCSession.findFirst({
          where: { workspaceId, sessionId },
          select: { agentId: true },
        }).catch(() => null);

        if (session?.agentId) {
          atomicBudgetDeduct(workspaceId, session.agentId, costCents).catch((err) => {
            logger.warn({ err, agentId: session.agentId }, 'ECC cost budget deduct failed');
          });
        }
      }
    },
  });

  // ------------------------------------------------------------------
  // GET /agents — list ECC agents registered in this workspace
  // ------------------------------------------------------------------
  app.get('/agents', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const agents = await prisma.agent.findMany({
        where: {
          workspaceId: request.workspaceId!,
          config: { path: ['eccAgent'], equals: true },
        },
        select: {
          id: true,
          name: true,
          description: true,
          version: true,
          status: true,
          config: true,
          toolPermissions: true,
          maxCostUsd: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      });
      return reply.send({ data: { agents, total: agents.length } });
    },
  });

  // ------------------------------------------------------------------
  // POST /agents/sync — idempotent upsert of all 17 ECC agents
  // Creates default policy rules + budget entries.  Role: ADMIN+
  // ------------------------------------------------------------------
  app.post('/agents/sync', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const userId = request.user!.userId;

      for (const agent of ECC_AGENTS) {
        const nexusopsName = `ecc-${agent.eccName}`;
        const agentRecord = await prisma.agent.upsert({
          where: { workspaceId_name: { workspaceId, name: nexusopsName } },
          create: {
            workspaceId,
            name: nexusopsName,
            description: `ECC ${agent.eccName} agent — development governance`,
            version: '1.8.0',
            status: AgentStatus.IDLE,
            config: {
              model: agent.model,
              eccAgent: true,
              eccName: agent.eccName,
              eccVersion: '1.8.0',
              environment: 'DEVELOPMENT',
              autoRegistered: true,
            } as Prisma.InputJsonValue,
            toolPermissions: [...agent.toolPermissions],
            maxCostUsd: agent.maxCostUsd,
          },
          update: {
            version: '1.8.0',
            toolPermissions: [...agent.toolPermissions],
            maxCostUsd: agent.maxCostUsd,
            config: {
              model: agent.model,
              eccAgent: true,
              eccName: agent.eccName,
              eccVersion: '1.8.0',
              environment: 'DEVELOPMENT',
              lastSyncedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });

        // Create budget entry (idempotent — skip if already exists)
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        await prisma.budget.create({
          data: {
            workspaceId,
            agentId: agentRecord.id,
            maxCostUsd: agent.maxCostUsd,
            currentCostUsd: 0,
            periodStart: now,
            periodEnd,
            alertThreshold: 0.8,
          },
        }).catch(() => {
          // Already exists — non-critical
        });
      }

      await upsertECCDefaultPolicies(workspaceId, userId);

      await appendAuditEvent({
        workspaceId,
        eventType: 'ECC_AGENTS_SYNCED',
        entityType: 'agent',
        action: 'SYNC',
        userId,
        metadata: {
          agentCount: ECC_AGENTS.length,
          eccVersion: '1.8.0',
          syncedBy: userId,
        },
      });

      return reply.send({
        data: {
          synced: ECC_AGENTS.length,
          message: `${ECC_AGENTS.length} ECC agents registered with budgets and governance policies`,
        },
      });
    },
  });

  // ------------------------------------------------------------------
  // GET /instincts — governance instincts from production data for ECC
  // ------------------------------------------------------------------
  app.get('/instincts', {
    onRequest: [app.authenticateApiKey],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const instincts = await generateECCInstincts(workspaceId);
      return reply.send({
        data: {
          instincts,
          format: 'ecc-instinct-v1',
          workspaceId,
          generatedAt: new Date().toISOString(),
        },
      });
    },
  });

  // ------------------------------------------------------------------
  // POST /instincts/refresh — trigger instinct regeneration job
  // ------------------------------------------------------------------
  app.post('/instincts/refresh', {
    onRequest: [app.authenticateApiKey],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const { queueManager } = await import('@nexusops/queue');
      await queueManager.addJob('tasks', 'ecc_instinct_refresh', {
        type: JobType.ECC_INSTINCT_REFRESH,
        workspaceId,
        payload: {},
      });
      return reply.send({ data: { queued: true, message: 'Instinct refresh job enqueued' } });
    },
  });

  // ------------------------------------------------------------------
  // GET /status — connection status and session summary
  // ------------------------------------------------------------------
  app.get('/status', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;

      const [sessionsLast24h, totalSessions, registeredAgents, recentEvents] = await Promise.all([
        prisma.eCCSession.count({
          where: { workspaceId, lastEventAt: { gte: new Date(Date.now() - 86400000) } },
        }),
        prisma.eCCSession.count({ where: { workspaceId } }),
        prisma.agent.count({
          where: { workspaceId, config: { path: ['eccAgent'], equals: true } },
        }),
        prisma.auditEvent.count({
          where: { workspaceId, eventType: { startsWith: 'ECC_' }, createdAt: { gte: new Date(Date.now() - 86400000) } },
        }),
      ]);

      return reply.send({
        data: {
          connected: registeredAgents > 0,
          workspaceId,
          registeredAgents,
          sessionsLast24h,
          totalSessions,
          recentEvents,
          integrationVersion: '1.0.0',
          eccVersion: '1.8.0',
        },
      });
    },
  });

  // ------------------------------------------------------------------
  // GET /cost-summary — dev + prod combined cost (30-day window)
  // ------------------------------------------------------------------
  app.get('/cost-summary', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const since = new Date(Date.now() - 30 * 24 * 3600000);

      const [devCostEvents, prodCostAgg] = await Promise.all([
        prisma.auditEvent.findMany({
          where: { workspaceId, eventType: 'ECC_LLM_COST_RECORDED', createdAt: { gte: since } },
          select: { metadata: true, createdAt: true },
        }),
        prisma.toolCall.aggregate({
          where: { workspaceId, createdAt: { gte: since } },
          _sum: { costUsd: true },
          _count: { id: true },
        }),
      ]);

      const devTotal = devCostEvents.reduce((sum, e) => {
        return sum + (((e.metadata as Record<string, unknown>)?.costUsd as number) || 0);
      }, 0);
      const prodTotal = prodCostAgg._sum.costUsd || 0;
      const prodCount = prodCostAgg._count.id || 0;

      return reply.send({
        data: {
          development: {
            totalUsd: Math.round(devTotal * 1e6) / 1e6,
            eventCount: devCostEvents.length,
            source: 'ecc-cost-tracker',
          },
          production: {
            totalUsd: Math.round(prodTotal * 1e6) / 1e6,
            callCount: prodCount,
            source: 'nexusops-proxy',
          },
          combined: {
            totalUsd: Math.round((devTotal + prodTotal) * 1e6) / 1e6,
            ratioDevToProd: prodTotal > 0 ? Math.round((devTotal / prodTotal) * 100) / 100 : null,
          },
          period: '30d',
        },
      });
    },
  });
};

// ─── Policy Setup for ECC Agents ─────────────────────────────────────────────

async function upsertECCDefaultPolicies(workspaceId: string, userId: string) {
  const policies = [
    {
      name: 'ECC: Block all production access',
      description: 'ECC development agents must never touch production systems',
      priority: 1000,
      conditions: JSON.stringify([
        { field: 'agentId', operator: 'startsWith', value: 'ecc-' },
        { field: 'environment', operator: 'equals', value: 'PRODUCTION' },
      ]),
      action: 'DENY' as const,
    },
    {
      name: 'ECC: Loop operator cost circuit breaker',
      description: 'Autonomous loops capped at $5/session — prevents infinite loop spend',
      priority: 900,
      conditions: JSON.stringify([
        { field: 'agentId', operator: 'equals', value: 'ecc-loop-operator' },
        { field: 'taskCostUsd', operator: 'greaterThan', value: 5.0 },
      ]),
      action: 'DENY' as const,
    },
    {
      name: 'ECC: Chief of staff write escalation',
      description: 'Chief of Staff write operations require human approval',
      priority: 800,
      conditions: JSON.stringify([
        { field: 'agentId', operator: 'equals', value: 'ecc-chief-of-staff' },
        { field: 'toolType', operator: 'equals', value: 'GITHUB' },
      ]),
      action: 'ESCALATE_TO_HUMAN' as const,
    },
    {
      name: 'ECC: Security reviewer write escalation',
      description: 'Security reviewer write ops are suspicious — escalate',
      priority: 850,
      conditions: JSON.stringify([
        { field: 'agentId', operator: 'equals', value: 'ecc-security-reviewer' },
        { field: 'toolType', operator: 'equals', value: 'GITHUB' },
      ]),
      action: 'ESCALATE_TO_HUMAN' as const,
    },
    {
      name: 'ECC: Standard agent development allow',
      description: 'ECC agents allowed read ops in development environment',
      priority: 100,
      conditions: JSON.stringify([
        { field: 'agentId', operator: 'startsWith', value: 'ecc-' },
        { field: 'environment', operator: 'equals', value: 'DEVELOPMENT' },
        { field: 'toolType', operator: 'in', value: ['GITHUB', 'DATABASE'] },
      ]),
      action: 'ALLOW' as const,
    },
  ];

  for (const policy of policies) {
    const existing = await prisma.policyRule.findFirst({
      where: { workspaceId, name: policy.name },
    });
    if (!existing) {
      await prisma.policyRule.create({
        data: { workspaceId, createdBy: userId, enabled: true, ...policy },
      });
    }
  }
}

// ─── Governance Instinct Generator ───────────────────────────────────────────

async function generateECCInstincts(workspaceId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000);
  const instincts: Array<{
    id: string;
    rule: string;
    confidence: number;
    source: string;
    category: string;
    instruction: string;
    generatedAt: string;
  }> = [];

  const [violations, sqlBlocks, anomalies, eccToolEvents, eccSessions] = await Promise.all([
    prisma.auditEvent.count({
      where: { workspaceId, eventType: 'POLICY_DENIED', createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.auditEvent.count({
      where: { workspaceId, eventType: 'SQL_GATE_BLOCKED', createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.auditEvent.count({
      where: { workspaceId, eventType: { in: ['ANOMALY_TIER2', 'ANOMALY_TIER3'] }, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.auditEvent.count({
      where: { workspaceId, eventType: { startsWith: 'ECC_' }, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.eCCSession.count({
      where: { workspaceId, createdAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  if (violations > 5) {
    instincts.push({
      id: `nexusops-policy-violations-${workspaceId.slice(-6)}`,
      rule: 'NexusOps: Policy Violation Pattern',
      confidence: Math.min(1.0, violations / 20),
      source: 'nexusops-production-data',
      category: 'governance',
      instruction:
        `Production governance detected ${violations} policy violations in 30 days. ` +
        'Before executing any tool operation, verify it matches allowed toolType and environment scope.',
      generatedAt: new Date().toISOString(),
    });
  }

  if (sqlBlocks > 0) {
    instincts.push({
      id: `nexusops-sql-safety-${workspaceId.slice(-6)}`,
      rule: 'NexusOps: SQL Safety Gate Pattern',
      confidence: 1.0,
      source: 'nexusops-sql-gate',
      category: 'security',
      instruction:
        'NexusOps SQL gate blocked dangerous queries. ' +
        'NEVER generate DROP, TRUNCATE, ALTER TABLE, or DELETE without WHERE clause. ' +
        'Always use parameterized queries.',
      generatedAt: new Date().toISOString(),
    });
  }

  if (anomalies > 0) {
    instincts.push({
      id: `nexusops-cost-velocity-${workspaceId.slice(-6)}`,
      rule: 'NexusOps: Cost Velocity Anomaly',
      confidence: 0.8,
      source: 'nexusops-anomaly-detector',
      category: 'efficiency',
      instruction:
        'Cost velocity anomaly detection triggered. ' +
        'Prefer claude-haiku-4-5 for deterministic subtasks. Reserve opus for architecture only.',
      generatedAt: new Date().toISOString(),
    });
  }

  if (eccSessions > 20) {
    instincts.push({
      id: `ecc-session-volume-${workspaceId.slice(-6)}`,
      rule: 'ECC: High Session Volume',
      confidence: 0.7,
      source: 'ecc-session-analytics',
      category: 'cost-governance',
      instruction:
        `${eccSessions} ECC sessions in 30 days. Consider per-session budget caps.`,
      generatedAt: new Date().toISOString(),
    });
  }

  if (eccToolEvents > 500) {
    instincts.push({
      id: `ecc-tool-volume-${workspaceId.slice(-6)}`,
      rule: 'ECC: High Tool Usage Volume',
      confidence: 0.75,
      source: 'ecc-telemetry',
      category: 'performance',
      instruction:
        `${eccToolEvents} tool events in 30 days. Consider breaking tasks into /orchestrate sub-tasks.`,
      generatedAt: new Date().toISOString(),
    });
  }

  return instincts;
}
