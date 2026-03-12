/**
 * ECC Instinct Refresh Job
 *
 * Periodically analyzes ECC audit events to generate governance instincts.
 * Instincts are patterns derived from agent behavior that inform policy evolution.
 *
 * Event types emitted by nexusops-audit-emit.js:
 *   ECC_SESSION_STARTED, ECC_SESSION_COMPLETED, ECC_TOOL_ABOUT_TO_EXECUTE,
 *   ECC_TOOL_EXECUTED, ECC_CONTEXT_COMPACTED, ECC_HOOK_FIRED,
 *   ECC_LLM_COST_RECORDED
 */

import { prisma } from '@nexusops/db';
import { createLogger } from '@nexusops/logger';
import { appendAuditEvent } from '@nexusops/events';

const logger = createLogger('ecc-instinct-refresh');

interface InstinctRule {
  id: string;
  rule: string;
  confidence: number;
  source: string;
  domain: string;
}

export async function eccInstinctRefresh(workspaceId: string): Promise<{ instincts: InstinctRule[] }> {
  logger.info({ workspaceId }, 'Starting ECC instinct refresh');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch recent ECC audit events (all start with ECC_)
  const events = await prisma.auditEvent.findMany({
    where: {
      workspaceId,
      eventType: { startsWith: 'ECC_' },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  if (events.length === 0) {
    logger.info({ workspaceId }, 'No recent ECC events — skipping instinct generation');
    return { instincts: [] };
  }

  // Aggregate patterns from events
  const toolUsage = new Map<string, number>();
  const failedTools = new Map<string, number>();
  const sessionIds = new Set<string>();
  let totalCostUsd = 0;
  let costEventCount = 0;

  for (const ev of events) {
    const meta = ev.metadata as Record<string, unknown> | null;
    if (!meta) continue;

    const toolName = meta.toolName as string | undefined;
    const sessionId = meta.eccSessionId as string | undefined;

    if (sessionId) sessionIds.add(sessionId);

    // Track tool execution volume
    if (ev.eventType === 'ECC_TOOL_EXECUTED' && toolName) {
      toolUsage.set(toolName, (toolUsage.get(toolName) || 0) + 1);
      // Track failed tool executions
      if (meta.success === false) {
        failedTools.set(toolName, (failedTools.get(toolName) || 0) + 1);
      }
    }

    // Track cost
    if (ev.eventType === 'ECC_LLM_COST_RECORDED') {
      totalCostUsd += (meta.costUsd as number) || 0;
      costEventCount++;
    }
  }

  const instincts: InstinctRule[] = [];

  // Pattern: frequently failing tools → suggest investigation
  for (const [tool, count] of failedTools) {
    if (count >= 3) {
      instincts.push({
        id: `failing-tool-${tool}-${workspaceId.slice(0, 8)}`,
        rule: `Tool "${tool}" failed ${count} times in 24h — investigate or consider restricting`,
        confidence: Math.min(0.95, 0.6 + count * 0.05),
        source: 'ecc-audit',
        domain: 'tool-governance',
      });
    }
  }

  // Pattern: high-frequency tool → suggest rate limiting
  for (const [tool, count] of toolUsage) {
    if (count >= 50) {
      instincts.push({
        id: `rate-limit-${tool}-${workspaceId.slice(0, 8)}`,
        rule: `Tool "${tool}" executed ${count} times in 24h — consider rate-limiting policy`,
        confidence: Math.min(0.9, 0.5 + count * 0.005),
        source: 'ecc-audit',
        domain: 'performance',
      });
    }
  }

  // Pattern: many sessions → suggest session budget caps
  if (sessionIds.size >= 10) {
    instincts.push({
      id: `session-budget-${workspaceId.slice(0, 8)}`,
      rule: `${sessionIds.size} ECC sessions in 24h — consider per-session budget caps`,
      confidence: 0.75,
      source: 'ecc-audit',
      domain: 'cost-governance',
    });
  }

  // Pattern: high daily cost → suggest model downgrade for routine tasks
  if (totalCostUsd > 5.0) {
    instincts.push({
      id: `high-daily-cost-${workspaceId.slice(0, 8)}`,
      rule: `$${totalCostUsd.toFixed(2)} spent in 24h across ${costEventCount} events — review model selection`,
      confidence: Math.min(0.95, 0.6 + totalCostUsd * 0.02),
      source: 'ecc-cost-analytics',
      domain: 'cost-governance',
    });
  }

  // Store generated instincts as audit events for traceability
  for (const instinct of instincts) {
    await appendAuditEvent({
      workspaceId,
      eventType: 'ECC_INSTINCT_GENERATED',
      entityType: 'policy',
      action: 'CREATE',
      metadata: { ...instinct },
    });
  }

  logger.info(
    { workspaceId, instinctCount: instincts.length, eventCount: events.length },
    'ECC instinct refresh complete',
  );

  return { instincts };
}
