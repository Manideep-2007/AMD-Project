/**
 * @nexusops/blast-radius — Real-time dollar-figure damage calculation
 *
 * This is the KILLER APP — the procurement trigger.
 * Every agent action has a dollar figure attached.
 * Shows: "Without NexusOps: $X max damage. With NexusOps: $Y governed damage."
 *
 * Core formula:
 *   BlastRadius = Σ(tool_permission × environment_weight × data_value)
 *   GovernedDamage = BlastRadius × (budget_remaining / budget_total) × policy_restriction_factor
 *
 * Budget enforcement uses Redis DECRBY — mathematically impossible to exceed.
 */

import { prisma, type Agent, type Budget, Environment } from '@nexusops/db';
import { createLogger } from '@nexusops/logger';
import Redis from 'ioredis';

const logger = createLogger('blast-radius');

// ─── Constants ───────────────────────────────

/** Weight multiplier per environment */
const ENV_WEIGHTS: Record<string, number> = {
  PRODUCTION: 10.0,
  STAGING: 3.0,
  DEVELOPMENT: 1.0,
};

/** Base cost per tool type (estimated avg impact per call in USD) */
const TOOL_BASE_COSTS: Record<string, number> = {
  GITHUB: 500,       // PR merge to prod, code deletion
  JIRA: 50,          // Ticket manipulation
  CLOUD_DEPLOY: 5000, // Infrastructure changes
  DATABASE: 2000,    // Data mutation/deletion
  CUSTOM: 200,       // Unknown — conservative estimate
};

/** Hourly developer rate for time-cost calculations */
const DEFAULT_HOURLY_DEV_RATE = 150; // USD

// ─── Types ───────────────────────────────────

export interface BlastRadiusResult {
  /** 0-100 normalized risk score */
  score: number;
  /** Maximum theoretical damage in USD (no governance) */
  maxDamageUsd: number;
  /** Maximum actual damage given budget limits and policies */
  governedDamageUsd: number;
  /** Breakdown by tool type */
  breakdown: ToolDamageBreakdown[];
  /** Active budget constraints */
  activeBudgets: BudgetConstraint[];
  /** Calculated at timestamp */
  calculatedAt: Date;
}

export interface ToolDamageBreakdown {
  toolType: string;
  baseCostUsd: number;
  environmentWeight: number;
  dataValueMultiplier: number;
  maxDamageUsd: number;
}

export interface BudgetConstraint {
  budgetId: string;
  maxCostUsd: number | null;
  currentCostUsd: number;
  remainingUsd: number;
  utilizationPercent: number;
  autoHalt: boolean;
}

export interface BudgetCheckResult {
  allowed: boolean;
  /** Remaining budget in USD */
  remainingUsd: number;
  /** Reason if denied */
  reason?: string;
}

// ─── Core Engine ─────────────────────────────

/**
 * Calculate the blast radius for an agent.
 * This is the enterprise "wow" number shown on dashboards.
 */
export async function calculateBlastRadius(
  agentId: string,
  workspaceId: string,
): Promise<BlastRadiusResult> {
  // Fetch agent + workspace concurrently
  const [agent, workspace, budgets] = await Promise.all([
    prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: {
        id: true,
        name: true,
        toolPermissions: true,
        maxCostUsd: true,
        config: true,
      },
    }),
    prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { financialExposureConfig: true },
    }),
    prisma.budget.findMany({
      where: {
        OR: [
          { workspaceId, agentId },
          { workspaceId, agentId: null }, // workspace-level
        ],
        periodEnd: { gt: new Date() },
      },
    }),
  ]);

  const config = (workspace.financialExposureConfig as Record<string, unknown>) ?? {};
  const hourlyRate = (config.hourlyDevRate as number) ?? DEFAULT_HOURLY_DEV_RATE;
  const dataValueTags = (config.dataValueTags as Record<string, number>) ?? {};

  // Calculate per-tool damage
  const breakdown: ToolDamageBreakdown[] = [];
  let totalMaxDamage = 0;

  for (const toolType of agent.toolPermissions) {
    const baseCost = TOOL_BASE_COSTS[toolType] ?? TOOL_BASE_COSTS.CUSTOM;

    // Assume worst case: production environment
    const envWeight = ENV_WEIGHTS.PRODUCTION;

    // Data value multiplier from customer config
    const dataMultiplier = (dataValueTags[toolType] as number) ?? 1.0;

    const maxDamage = baseCost * envWeight * dataMultiplier;
    totalMaxDamage += maxDamage;

    breakdown.push({
      toolType,
      baseCostUsd: baseCost,
      environmentWeight: envWeight,
      dataValueMultiplier: dataMultiplier,
      maxDamageUsd: maxDamage,
    });
  }

  // Calculate governed damage (with budget limits)
  const activeBudgets: BudgetConstraint[] = budgets.map((b) => ({
    budgetId: b.id,
    maxCostUsd: b.maxCostUsd,
    currentCostUsd: b.currentCostUsd,
    remainingUsd: (b.maxCostUsd ?? Infinity) - b.currentCostUsd,
    utilizationPercent: b.maxCostUsd
      ? (b.currentCostUsd / b.maxCostUsd) * 100
      : 0,
    autoHalt: b.autoHalt,
  }));

  // Governed damage = min(totalMaxDamage, tightest monthly budget cap)
  // Use maxCostUsd × 30 (monthly cap), NOT remaining budget — remaining budget
  // reflects current spend state, not the theoretical governance ceiling
  const tightestBudget = activeBudgets.reduce(
    (min, b) => {
      const monthlyCap = (b.maxCostUsd ?? Infinity) * 30;
      return monthlyCap < min ? monthlyCap : min;
    },
    totalMaxDamage,
  );
  const governedDamageUsd = Math.max(0, Math.min(totalMaxDamage, tightestBudget));

  // Normalize score to 0-100
  const score = Math.min(100, (totalMaxDamage / 100000) * 100);

  const result: BlastRadiusResult = {
    score: Math.round(score * 100) / 100,
    maxDamageUsd: Math.round(totalMaxDamage * 100) / 100,
    governedDamageUsd: Math.round(governedDamageUsd * 100) / 100,
    breakdown,
    activeBudgets,
    calculatedAt: new Date(),
  };

  // Persist to agent record
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      blastRadiusScore: result.score,
      blastRadiusMaxDamageUsd: result.maxDamageUsd,
      blastRadiusGovernedDamageUsd: result.governedDamageUsd,
      blastRadiusLastCalculatedAt: result.calculatedAt,
    },
  });

  logger.info(
    {
      agentId,
      score: result.score,
      maxDamageUsd: result.maxDamageUsd,
      governedDamageUsd: result.governedDamageUsd,
    },
    'Blast radius calculated',
  );

  return result;
}

// ─── Budget Kill-Switch (Redis Atomic) ───────

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
    });
  }
  return redisClient;
}

/**
 * Budget key in Redis: budget:{workspaceId}:{agentId|"workspace"}:remaining
 * Value: remaining budget in CENTS (integer, avoids float issues)
 */
function budgetKey(workspaceId: string, agentId?: string): string {
  return `budget:${workspaceId}:${agentId ?? 'workspace'}:remaining`;
}

/**
 * Initialize a budget counter in Redis.
 * Called when a budget is created or period resets.
 */
export async function initBudgetCounter(
  workspaceId: string,
  agentId: string | undefined,
  maxCostUsd: number,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedis();
  const key = budgetKey(workspaceId, agentId);
  const remainingCents = Math.round(maxCostUsd * 100);

  await redis.set(key, remainingCents, 'EX', ttlSeconds);
  logger.info({ key, remainingCents, ttlSeconds }, 'Budget counter initialized');
}

/**
 * Atomic budget check + deduct using Redis DECRBY.
 *
 * This is the mathematically impossible to exceed guarantee:
 * - DECRBY is atomic in Redis (single-threaded)
 * - If result < 0, we INCRBY back (rollback) and deny
 * - No race condition possible between check and deduct
 *
 * @returns BudgetCheckResult with allowed/denied + remaining
 */
export async function atomicBudgetDeduct(
  workspaceId: string,
  agentId: string | undefined,
  costUsd: number,
): Promise<BudgetCheckResult> {
  const redis = getRedis();
  const key = budgetKey(workspaceId, agentId);
  const costCents = Math.round(costUsd * 100);

  // Check if budget key exists
  const exists = await redis.exists(key);
  if (!exists) {
    // No budget set — allow (workspace may not have budgets configured)
    return { allowed: true, remainingUsd: Infinity };
  }

  // Atomic deduct
  const newBalance = await redis.decrby(key, costCents);

  if (newBalance < 0) {
    // Rollback — restore the deducted amount
    await redis.incrby(key, costCents);

    logger.warn(
      { workspaceId, agentId, costUsd, key },
      'Budget exceeded — action denied',
    );

    return {
      allowed: false,
      remainingUsd: (newBalance + costCents) / 100,
      reason: `Budget exceeded. Remaining: $${((newBalance + costCents) / 100).toFixed(2)}, requested: $${costUsd.toFixed(2)}`,
    };
  }

  return {
    allowed: true,
    remainingUsd: newBalance / 100,
  };
}

/**
 * Get current budget remaining without deducting.
 */
export async function getBudgetRemaining(
  workspaceId: string,
  agentId?: string,
): Promise<number> {
  const redis = getRedis();
  const key = budgetKey(workspaceId, agentId);
  const val = await redis.get(key);
  return val ? parseInt(val, 10) / 100 : Infinity;
}

/**
 * Velocity check: ensure agent isn't spending faster than allowed.
 * Uses Redis sliding window (sorted set).
 */
export async function checkVelocity(
  workspaceId: string,
  agentId: string,
  costUsd: number,
  velocityLimitUsdPerMinute: number,
): Promise<{ allowed: boolean; currentRateUsdPerMin: number }> {
  const redis = getRedis();
  const key = `velocity:${workspaceId}:${agentId}`;
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  // Remove entries older than the window
  await redis.zremrangebyscore(key, 0, now - windowMs);

  // Sum costs in the window
  const entries = await redis.zrangebyscore(key, now - windowMs, now);
  const currentSpendCents = entries.reduce((sum, e) => sum + parseInt(e.split(':')[1] ?? '0', 10), 0);
  const currentRateUsd = currentSpendCents / 100;
  const costCents = Math.round(costUsd * 100);

  if (currentRateUsd + costUsd > velocityLimitUsdPerMinute) {
    logger.warn(
      { workspaceId, agentId, currentRateUsd, costUsd, velocityLimitUsdPerMinute },
      'Velocity limit exceeded',
    );
    return {
      allowed: false,
      currentRateUsdPerMin: currentRateUsd,
    };
  }

  // Record this cost entry
  await redis.zadd(key, now, `${now}:${costCents}`);
  await redis.expire(key, 120); // TTL slightly longer than window

  return {
    allowed: true,
    currentRateUsdPerMin: currentRateUsd + costUsd,
  };
}

// ─── 5-Signal Weighted Anomaly Score ─────────

/**
 * Signal weights — the 5 independent factors that compose the anomaly score.
 * Each signal returns 0-100. The final score is a weighted average.
 *
 * Signal 1: Cost Velocity       (30%) — Is spend rate accelerating abnormally?
 * Signal 2: Tool Call Frequency  (25%) — Is the agent calling tools much faster than baseline?
 * Signal 3: Repetition Score     (15%) — Is the agent repeating the same action?
 * Signal 4: Scope Creep          (15%) — Is the agent accessing new/unusual tools?
 * Signal 5: Error Rate           (15%) — Is the agent producing more errors than normal?
 *
 * Returns 0-100 score. > 75 triggers automatic escalation to human.
 */

const SIGNAL_WEIGHTS = {
  costVelocity: 0.30,
  toolCallFrequency: 0.20,
  repetitionScore: 0.20,
  scopeCreep: 0.15,
  errorRate: 0.15,
} as const;

export interface AnomalyBreakdown {
  /** Final weighted score (0-100) */
  score: number;
  /** Individual signal scores (0-100 each) */
  signals: {
    costVelocity: number;
    toolCallFrequency: number;
    repetitionScore: number;
    scopeCreep: number;
    errorRate: number;
  };
  /** Human-readable explanation */
  reasons: string[];
}

export async function calculateAnomalyScore(
  agentId: string,
  workspaceId: string,
  toolType: string,
  costUsd: number,
): Promise<AnomalyBreakdown> {
  return calculateAnomalyBreakdown(agentId, workspaceId, toolType, costUsd);
}

export async function calculateAnomalyBreakdown(
  agentId: string,
  workspaceId: string,
  toolType: string,
  costUsd: number,
): Promise<AnomalyBreakdown> {
  const reasons: string[] = [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Run all DB queries in parallel for performance
  const [
    toolCallCount,
    costAgg,
    recentErrors,
    hourlyCallCount,
    dailyCallCount,
  ] = await Promise.all([
    // Signal 4 data: tool type usage frequency (scope creep detection)
    prisma.toolCall.count({
      where: {
        agentId,
        workspaceId,
        toolType: toolType as any,
        createdAt: { gt: sevenDaysAgo },
      },
    }),
    // Signal 1 data: average cost over 7 days
    prisma.toolCall.aggregate({
      where: {
        agentId,
        workspaceId,
        createdAt: { gt: sevenDaysAgo },
      },
      _avg: { costUsd: true },
      _max: { costUsd: true },
      _count: true,
    }),
    // Signal 5 data: recent errors (24h) — blocked or errored tool calls
    prisma.toolCall.count({
      where: {
        agentId,
        workspaceId,
        blocked: true,
        createdAt: { gt: oneDayAgo },
      },
    }),
    // Signal 2 data: call count in last hour
    prisma.toolCall.count({
      where: { agentId, workspaceId, createdAt: { gt: oneHourAgo } },
    }),
    // Signal 2 data: daily average call count (last 7 days)
    prisma.toolCall.count({
      where: { agentId, workspaceId, createdAt: { gt: sevenDaysAgo } },
    }),
  ]);

  // ── Signal 1: Cost Velocity (0-100) ───────
  let costVelocity = 0;
  const avgCost = (costAgg._avg as Record<string, number | null>).costUsd ?? 0;
  const maxCost = (costAgg._max as Record<string, number | null>).costUsd ?? 0;

  if (avgCost > 0) {
    const ratio = costUsd / avgCost;
    if (ratio > 10) {
      costVelocity = 100;
      reasons.push(`Cost $${costUsd.toFixed(2)} is ${ratio.toFixed(0)}x the 7-day average ($${avgCost.toFixed(2)})`);
    } else if (ratio > 5) {
      costVelocity = 80;
      reasons.push(`Cost is ${ratio.toFixed(1)}x the 7-day average`);
    } else if (ratio > 3) {
      costVelocity = 50;
    } else if (ratio > 2) {
      costVelocity = 25;
    }
    if (costUsd > maxCost && maxCost > 0) {
      costVelocity = Math.min(100, costVelocity + 20);
      reasons.push(`Cost exceeds 7-day maximum ($${maxCost.toFixed(2)})`);
    }
  } else if (costUsd > 1) {
    costVelocity = 40;
    reasons.push('No cost history available for comparison');
  }

  // ── Signal 2: Tool Call Frequency (0-100) ──
  let toolCallFrequency = 0;
  const dailyAvgCalls = dailyCallCount / 7;
  // Apply a minimum floor of 1 call/hour to the baseline so agents with very
  // infrequent historical usage don't trigger a false anomaly from a single call.
  const hourlyExpected = Math.max(1, dailyAvgCalls / 24);
  if (hourlyCallCount > 0) {
    const velocityRatio = hourlyCallCount / hourlyExpected;
    if (velocityRatio > 10) {
      toolCallFrequency = 100;
      reasons.push(`Call frequency ${velocityRatio.toFixed(0)}x normal rate (${hourlyCallCount} calls/hr vs ~${hourlyExpected.toFixed(1)} expected)`);
    } else if (velocityRatio > 5) {
      toolCallFrequency = 70;
      reasons.push(`Call frequency ${velocityRatio.toFixed(1)}x normal rate`);
    } else if (velocityRatio > 3) {
      toolCallFrequency = 40;
    } else if (velocityRatio > 2) {
      toolCallFrequency = 20;
    }
  } else if (hourlyCallCount > 20) {
    toolCallFrequency = 50;
    reasons.push(`${hourlyCallCount} calls in last hour with no baseline`);
  }

  // ── Signal 3: Repetition Score (0-100) ─────
  let repetitionScore = 0;
  // High call count to a single tool type relative to total suggests repetition
  if (costAgg._count > 0 && toolCallCount > 0) {
    const toolRatio = toolCallCount / costAgg._count;
    if (toolRatio > 0.9 && toolCallCount > 10) {
      repetitionScore = 80;
      reasons.push(`Agent repeats tool "${toolType}" ${(toolRatio * 100).toFixed(0)}% of the time`);
    } else if (toolRatio > 0.7 && toolCallCount > 5) {
      repetitionScore = 50;
    } else if (toolRatio > 0.5) {
      repetitionScore = 20;
    }
  }

  // ── Signal 4: Scope Creep (0-100) ──────────
  let scopeCreep = 0;
  if (toolCallCount === 0) {
    scopeCreep = 100; // Never used this tool — scope creep
    reasons.push(`Agent has never used tool "${toolType}" before — scope creep detected`);
  } else if (toolCallCount < 3) {
    scopeCreep = 60;
    reasons.push(`Agent has rarely used tool "${toolType}" (${toolCallCount} times in 7d)`);
  } else if (toolCallCount < 10) {
    scopeCreep = 25;
  }

  // ── Signal 5: Error Rate (0-100) ───────────
  let errorRate = 0;
  const totalRecentCalls = hourlyCallCount > 0 ? hourlyCallCount : 1;
  if (recentErrors > 5) {
    errorRate = 100;
    reasons.push(`${recentErrors} errors in last 24h (high error pattern)`);
  } else if (recentErrors > 3) {
    errorRate = 75;
    reasons.push(`${recentErrors} errors in last 24h`);
  } else if (recentErrors > 1) {
    errorRate = 40;
    reasons.push(`${recentErrors} errors in last 24h`);
  } else if (recentErrors === 1) {
    errorRate = 20;
  }

  // ── Weighted composite score ──────────────
  const rawScore =
    costVelocity * SIGNAL_WEIGHTS.costVelocity +
    toolCallFrequency * SIGNAL_WEIGHTS.toolCallFrequency +
    repetitionScore * SIGNAL_WEIGHTS.repetitionScore +
    scopeCreep * SIGNAL_WEIGHTS.scopeCreep +
    errorRate * SIGNAL_WEIGHTS.errorRate;

  const finalScore = Math.min(100, Math.round(rawScore * 100) / 100);

  logger.info(
    {
      agentId,
      toolType,
      costUsd,
      score: finalScore,
      signals: { costVelocity, toolCallFrequency, repetitionScore, scopeCreep, errorRate },
    },
    'Anomaly score calculated',
  );

  return {
    score: finalScore,
    signals: { costVelocity, toolCallFrequency, repetitionScore, scopeCreep, errorRate },
    reasons,
  };
}
