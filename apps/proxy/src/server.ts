/**
 * Proxy HTTP Server — Fastify on port 3003
 *
 * Every agent tool call flows through here:
 *   1. Prompt injection scan
 *   2. Policy evaluation (Rust napi-rs, < 2ms)
 *   3. SQL safety gate (if DATABASE tool type)
 *   4. Budget check (Redis atomic DECRBY)
 *   5. Forward to tool proxy
 *   6. Log audit event + compliance artifact
 *
 * This is the enforcement point. The API server delegates tool calls here.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { createLogger } from '@nexusops/logger';
import { prisma, ToolType, type Prisma } from '@nexusops/db';
import { policyEngine } from '@nexusops/policy';
import { scanText } from '@nexusops/injection';
import { atomicBudgetDeduct, checkVelocity, calculateAnomalyScore } from '@nexusops/blast-radius';
import { appendAuditEvent, createComplianceArtifact, notifyEscalation } from '@nexusops/events';
import { hashSha3 } from '@nexusops/crypto';
import { decryptDbUrl } from '@nexusops/crypto';
import { ProxyManager } from './index';

// Types for policy-core native bindings (optional Rust acceleration)
interface NativePolicyCore {
  evaluatePolicyCached: (context: string, workspaceId: string) => { action: string; reasons: string[]; matchedRuleId?: string };
  evaluateSqlQueryCached: (query: string, workspaceId: string, agentId: string) => { allowed: boolean; violations: string[] };
  loadWorkspacePolicies: (workspaceId: string, rulesJson: string, schemasJson: string) => void;
}

let nativePolicy: NativePolicyCore | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativePolicy = require('@nexusops/policy-core') as NativePolicyCore;
} catch {
  // Rust NAPI not built — will use TypeScript policy engine
}

const logger = createLogger('proxy:server');
const PORT = parseInt(process.env.PROXY_PORT || '3003', 10);
const PROXY_INTERNAL_SECRET = process.env.PROXY_INTERNAL_SECRET;

if (!PROXY_INTERNAL_SECRET) {
  throw new Error('PROXY_INTERNAL_SECRET must be set — proxy cannot start without internal auth');
}

if (PROXY_INTERNAL_SECRET.length < 32) {
  throw new Error('PROXY_INTERNAL_SECRET must be at least 32 characters for adequate security');
}

/**
 * buildProxyApp — creates and configures the Fastify instance without starting listen().
 * Use this in tests via app.inject(). startProxyServer() calls this then listens.
 */
export async function buildProxyApp() {
  const app = Fastify({ logger: false });
  const proxyManager = new ProxyManager();

  await app.register(helmet, { contentSecurityPolicy: false });
  // Proxy is on internal network only — no external CORS needed
  await app.register(cors, { origin: false });

  // Internal auth guard: every request must present the shared secret
  app.addHook('onRequest', async (request, reply) => {
    // Skip health check
    if (request.url === '/health') return;

    const secret = request.headers['x-proxy-secret'] as string;
    if (secret !== PROXY_INTERNAL_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized — invalid internal secret' });
    }
  });

  // Health check
  app.get('/health', async () => ({
    status: 'healthy',
    service: 'proxy',
    timestamp: new Date().toISOString(),
  }));

  /**
   * POST /proxy/execute
   * Main entry point for all tool calls.
   * Body: { workspaceId, agentId, taskId, toolType, toolMethod, input, environment, userId, userRole }
   */
  app.post('/proxy/execute', async (request, reply) => {
    const startMs = Date.now();
    const body = request.body as any;
    const {
      workspaceId,
      agentId,
      taskId,
      toolType,
      toolMethod,
      input,
      environment,
      userId,
      userRole,
    } = body;

    if (!workspaceId || !agentId || !taskId || !toolType || !toolMethod) {
      return reply.code(400).send({
        error: 'Missing required fields: workspaceId, agentId, taskId, toolType, toolMethod',
      });
    }

    try {
      // ── Step 0: Agent Identity Verification ──────
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent || agent.workspaceId !== workspaceId) {
        return reply.code(403).send({
          blocked: true,
          reason: 'Agent not found or does not belong to workspace',
        });
      }
      if (agent.status === 'TERMINATED') {
        return reply.code(403).send({
          blocked: true,
          reason: 'Agent is terminated',
        });
      }

      // Validate tool type early — before hitting budget/policy gates — so
      // CUSTOM (unimplemented) doesn't burn budget and then 500.
      const SUPPORTED_TOOL_TYPES = ['GITHUB', 'JIRA', 'DATABASE', 'CLOUD_DEPLOY'];
      if (!SUPPORTED_TOOL_TYPES.includes(toolType)) {
        return reply.code(501).send({
          blocked: true,
          reason: `Tool type '${toolType}' is not yet implemented. Supported: ${SUPPORTED_TOOL_TYPES.join(', ')}`,
        });
      }

      // ── Step 1: Prompt Injection Scan ────────────
      const inputStr = JSON.stringify(input);
      const injectionResult = scanText(inputStr, true);

      if (!injectionResult.safe) {
        await logBlockedCall(workspaceId, taskId, agentId, toolType, toolMethod, input,
          `Prompt injection detected: ${injectionResult.riskLevel}`);

        return reply.code(403).send({
          blocked: true,
          reason: `Prompt injection detected (${injectionResult.riskLevel})`,
          findings: injectionResult.findings,
        });
      }

      // ── Step 2: Policy Evaluation (Rust, < 2ms) ─
      const policyContext = JSON.stringify({
        workspaceId,
        agentId,
        taskId,
        toolType,
        toolMethod,
        environment: environment ?? 'DEVELOPMENT',
        userId,
        userRole,
        requestedAt: new Date().toISOString(),
      });

      let policyDecision: { action: string; reasons: string[]; matchedRuleId?: string };

      if (nativePolicy) {
        // Fast path: Rust NAPI evaluation (< 2ms)
        policyDecision = nativePolicy.evaluatePolicyCached(policyContext, workspaceId);
      } else {
        // Fallback: TypeScript policy engine
        const evalResult = await policyEngine.evaluate({
          workspaceId,
          agentId,
          taskId,
          toolType: toolType as ToolType,
          toolMethod,
          environment: (environment ?? 'DEVELOPMENT') as any,
          userId,
          userRole,
          requestedAt: new Date(),
        });
        policyDecision = {
          action: evalResult.action,
          reasons: evalResult.reason ? [evalResult.reason] : [],
          matchedRuleId: evalResult.ruleId ?? undefined,
        };
      }

      if (policyDecision.action === 'DENY') {
        await logBlockedCall(workspaceId, taskId, agentId, toolType, toolMethod, input,
          `Policy denied: ${policyDecision.reasons.join(', ')}`);

        return reply.code(403).send({
          blocked: true,
          reason: 'Policy denied',
          details: policyDecision,
        });
      }

      if (policyDecision.action === 'ESCALATE_TO_HUMAN') {
        // Calculate blast radius delta for the approval UI
        const blastRadiusDelta = agent?.blastRadiusMaxDamageUsd ?? null;

        // Create approval request with blast radius
        await prisma.taskApproval.create({
          data: {
            taskId,
            blastRadiusDelta,
            riskScore: null, // anomaly score not yet computed at policy-escalation stage
            timeoutAt: new Date(Date.now() + 30 * 60 * 1000), // 30min timeout
          },
        });

        await prisma.task.update({
          where: { id: taskId },
          data: { status: 'PENDING_APPROVAL' },
        });

        // Notify Slack (non-blocking, best-effort)
        notifyEscalation({
          agentName: agent.name,
          agentId: agentId,
          taskName: body.taskName ?? taskId,
          taskId,
          riskLevel: policyDecision.reasons.some((r: string) => r.toLowerCase().includes('critical')) ? 'critical' : 'high',
          blastRadius: blastRadiusDelta ?? undefined,
          reason: policyDecision.reasons.join('; '),
          workspaceId,
        }).catch(() => { /* fire-and-forget */ });

        return reply.code(202).send({
          blocked: false,
          escalated: true,
          reason: 'Escalated to human approval',
          details: policyDecision,
        });
      }

      // ── Step 3: SQL Safety Gate (if DATABASE) ────
      if (toolType === 'DATABASE' && input?.query) {
        let sqlAllowed = true;
        let sqlViolations: string[] = [];

        if (nativePolicy) {
          const sqlDecision = nativePolicy.evaluateSqlQueryCached(
            input.query,
            workspaceId,
            agentId,
          );
          sqlAllowed = sqlDecision.allowed;
          sqlViolations = sqlDecision.violations;
        } else {
          // Basic SQL safety check fallback: block obvious dangerous operations
          const upperQuery = (input.query as string).toUpperCase().trim();
          const dangerousOps = ['DROP ', 'TRUNCATE ', 'ALTER ', 'GRANT ', 'REVOKE '];
          const found = dangerousOps.filter(op => upperQuery.includes(op));
          if (found.length > 0) {
            sqlAllowed = false;
            sqlViolations = found.map(op => `Dangerous operation: ${op.trim()}`);
          }
        }

        if (!sqlAllowed) {
          await logBlockedCall(workspaceId, taskId, agentId, toolType, toolMethod, input,
            `SQL blocked: ${sqlViolations.join(', ')}`);

          return reply.code(403).send({
            blocked: true,
            reason: 'SQL query blocked by safety gate',
            details: { allowed: false, violations: sqlViolations },
          });
        }
      }

      // ── Step 4: Budget Check (Redis atomic) ──────
      // Estimate cost before execution (conservative)
      const estimatedCost = estimateCallCost(toolType);

      const budgetResult = await atomicBudgetDeduct(workspaceId, agentId, estimatedCost);
      if (!budgetResult.allowed) {
        await logBlockedCall(workspaceId, taskId, agentId, toolType, toolMethod, input,
          budgetResult.reason ?? 'Budget exceeded');

        return reply.code(402).send({
          blocked: true,
          reason: budgetResult.reason,
          remainingBudgetUsd: budgetResult.remainingUsd,
        });
      }

      // Velocity check (agent already fetched in Step 0)
      const budgets = await prisma.budget.findFirst({
        where: { agentId, workspaceId },
      });

      if (budgets?.velocityLimitUsdPerMinute) {
        const velocityResult = await checkVelocity(
          workspaceId, agentId, estimatedCost, budgets.velocityLimitUsdPerMinute,
        );

        if (!velocityResult.allowed) {
          // Refund the budget deduction
          await atomicBudgetDeduct(workspaceId, agentId, -estimatedCost);
          return reply.code(429).send({
            blocked: true,
            reason: 'Velocity limit exceeded',
            currentRateUsdPerMin: velocityResult.currentRateUsdPerMin,
          });
        }
      }

      // ── Step 5: Anomaly Score (three-tier) ──────
      //
      // Tier 1 (≥70): Audit alert + log the anomaly, continue execution
      // Tier 2 (≥85): Pause agent + create human-approval gate
      // Tier 3 (≥95): Immediate emergency-stop (equivalent to /emergency-stop)
      //
      const anomalyBreakdown = await calculateAnomalyScore(agentId, workspaceId, toolType, estimatedCost);
      const anomalyScore = anomalyBreakdown.score;

      if (anomalyScore >= 95) {
        // Tier 3: Terminate agent immediately
        await prisma.agent.update({
          where: { id: agentId },
          data: { status: 'TERMINATED' },
        });
        await prisma.task.updateMany({
          where: { agentId, status: { in: ['RUNNING', 'QUEUED', 'PENDING'] } },
          data: { status: 'CANCELLED' },
        });
        // Refund budget deduction
        await atomicBudgetDeduct(workspaceId, agentId, -estimatedCost);

        logger.error({ agentId, anomalyScore }, 'TIER-3 anomaly: agent auto-terminated');
        return reply.code(403).send({
          blocked: true,
          reason: `Critical anomaly (score: ${anomalyScore}) — agent terminated automatically`,
          anomalyScore,
        });
      }

      if (anomalyScore >= 85) {
        // Tier 2: Pause agent + create approval gate
        await prisma.agent.update({
          where: { id: agentId },
          data: { status: 'IDLE' },
        });
        await prisma.taskApproval.create({
          data: {
            taskId,
            riskScore: anomalyScore,
            timeoutAt: new Date(Date.now() + 15 * 60 * 1000),
          },
        });
        await prisma.task.update({
          where: { id: taskId },
          data: { status: 'PENDING_APPROVAL' },
        });
        // Refund budget deduction
        await atomicBudgetDeduct(workspaceId, agentId, -estimatedCost);

        logger.warn({ agentId, anomalyScore }, 'TIER-2 anomaly: agent paused, approval required');
        return reply.code(202).send({
          blocked: false,
          escalated: true,
          reason: `High anomaly (score: ${anomalyScore}) — agent paused, awaiting human approval`,
          anomalyScore,
        });
      }

      if (anomalyScore >= 70) {
        // Tier 1: Audit alert + velocity cut — halve the velocity limit for elevated risk
        logger.warn({ agentId, anomalyScore }, 'TIER-1 anomaly: elevated risk, applying velocity cut');
        appendAuditEvent({
          workspaceId,
          eventType: 'agent.anomaly_alert',
          entityType: 'agent',
          entityId: agentId,
          action: 'ANOMALY_DETECTED',
          metadata: { anomalyScore, toolType, toolMethod, taskId },
        }).catch((err) => logger.error({ err }, 'Failed to write anomaly audit event'));

        // Enforce halved velocity limit for Tier-1 anomaly
        if (budgets?.velocityLimitUsdPerMinute) {
          const halvedLimit = budgets.velocityLimitUsdPerMinute / 2;
          const velocityRecheck = await checkVelocity(workspaceId, agentId, estimatedCost, halvedLimit);
          if (!velocityRecheck.allowed) {
            await atomicBudgetDeduct(workspaceId, agentId, -estimatedCost);
            return reply.code(429).send({
              blocked: true,
              reason: `Velocity limit halved due to anomaly (score: ${anomalyScore}). Current rate exceeds reduced limit.`,
              currentRateUsdPerMin: velocityRecheck.currentRateUsdPerMin,
              anomalyScore,
            });
          }
        }
        // Execution falls through to Step 6
      }

      // ── Step 6: Execute Tool Call ────────────────
      // For DATABASE tool type, decrypt the agent's customer DB URL
      let customerDbUrl: string | undefined;
      if (toolType === 'DATABASE') {
        // Agent was already fetched in Step 0 — refetch with customerDatabaseUrl
        const agentDbConfig = await prisma.agent.findUnique({
          where: { id: agentId },
          select: { customerDatabaseUrl: true },
        });

        if (!agentDbConfig?.customerDatabaseUrl) {
          return reply.code(400).send({
            blocked: true,
            reason: 'DATABASE_NOT_CONFIGURED — No customer database configured for this agent. Set customerDatabaseUrl in agent configuration.',
          });
        }

        try {
          customerDbUrl = decryptDbUrl(agentDbConfig.customerDatabaseUrl);
        } catch (decryptErr: any) {
          logger.error({ agentId, err: decryptErr.message }, 'Failed to decrypt customer DB URL');
          return reply.code(500).send({
            blocked: true,
            reason: 'Failed to decrypt customer database URL — check DB_URL_ENCRYPTION_KEY',
          });
        }
      }

      const result = await proxyManager.route(toolType, {
        toolMethod,
        toolType,
        input,
      }, customerDbUrl, agentId);

      const durationMs = Date.now() - startMs;

      // Record tool call
      const toolCall = await prisma.toolCall.create({
        data: {
          workspaceId,
          taskId,
          agentId,
          toolType: toolType as ToolType,
          toolMethod,
          input,
          output: (result.output ?? null) as Prisma.InputJsonValue | undefined,
          error: (result.error ?? null) as Prisma.InputJsonValue | undefined,
          blocked: false,
          costUsd: estimatedCost,
          tokenCount: 0,
          durationMs,
          policyDecision: policyDecision.action,
        },
      });

      // ── Step 7: Audit Event (async-safe) ─────────
      appendAuditEvent({
        workspaceId,
        eventType: 'tool.executed',
        entityType: 'toolCall',
        entityId: toolCall.id,
        action: 'EXECUTE',
        metadata: {
          toolType,
          toolMethod,
          agentId,
          taskId,
          durationMs,
          costUsd: estimatedCost,
          policyDecision: policyDecision.action,
          anomalyScore,
        },
      }).catch((err) => logger.error({ err }, 'Failed to write audit event'));

      // Compliance artifact (fire and forget)
      createComplianceArtifact({
        workspaceId,
        taskId,
        agentId,
        userPrompt: inputStr,
        submittedAt: new Date(),
        policyDecision: policyDecision.action as any,
        policyRuleId: policyDecision.matchedRuleId ?? undefined,
        toolCallId: toolCall.id,
        requestPayloadHash: hashSha3(inputStr),
        responsePayloadHash: result.output ? hashSha3(JSON.stringify(result.output)) : undefined,
        executionDurationMs: durationMs,
        costUsd: estimatedCost,
      }).catch((err) => logger.error({ err }, 'Failed to write compliance artifact'));

      return reply.code(200).send({
        success: result.success,
        result: result.output,
        blocked: false,
        latencyMs: durationMs,
        costUsd: estimatedCost,
        policyDecision: policyDecision.action,
      });
    } catch (error: any) {
      logger.error({ error: error.message, toolType, toolMethod }, 'Proxy execution error');

      return reply.code(500).send({
        success: false,
        error: error.message,
        durationMs: Date.now() - startMs,
      });
    }
  });

  // ── Cache Management ───────────────────────
  /**
   * POST /proxy/policies/load
   * Load/refresh workspace policies into Rust cache.
   * Called by API server when policies are created/updated.
   */
  app.post('/proxy/policies/load', async (request) => {
    const { workspaceId, rulesJson, schemasJson } = request.body as any;
    if (nativePolicy) {
      nativePolicy.loadWorkspacePolicies(workspaceId, rulesJson, schemasJson ?? '[]');
    } else {
      // TypeScript policy engine uses DB-backed cache, just invalidate
      policyEngine.invalidateCache(workspaceId);
    }
    return { success: true };
  });

  return app;
}

export async function startProxyServer() {
  const app = await buildProxyApp();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info({ port: PORT }, 'Proxy server started');
  } catch (err) {
    logger.error(err, 'Failed to start proxy server');
    process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────

function estimateCallCost(toolType: string): number {
  const costs: Record<string, number> = {
    GITHUB: 0.01,
    JIRA: 0.005,
    DATABASE: 0.02,
    CLOUD_DEPLOY: 0.05,
    CUSTOM: 0.01,
  };
  return costs[toolType] ?? 0.01;
}

async function logBlockedCall(
  workspaceId: string,
  taskId: string,
  agentId: string,
  toolType: string,
  toolMethod: string,
  input: unknown,
  blockReason: string,
) {
  await prisma.toolCall.create({
    data: {
      workspaceId,
      taskId,
      agentId,
      toolType: toolType as ToolType,
      toolMethod,
      input: input as any,
      blocked: true,
      blockReason,
      policyDecision: 'DENY',
    },
  });

  await appendAuditEvent({
    workspaceId,
    eventType: 'tool.blocked',
    entityType: 'toolCall',
    action: 'BLOCK',
    metadata: { toolType, toolMethod, agentId, taskId, blockReason },
  }).catch((err) => logger.error({ err }, 'Failed to log blocked call audit event'));
}

// Auto-start when run directly
startProxyServer();
