/**
 * Blast Radius Package Tests — Damage Calculation & Budget Enforcement
 *
 * Tests the core blast radius calculation, budget deduction,
 * and velocity rate limiting. Mocks Prisma and Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockRedis = {
  exists: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  decrby: vi.fn(),
  incrby: vi.fn(),
  zadd: vi.fn(),
  zrangebyscore: vi.fn(),
  zremrangebyscore: vi.fn(),
  expire: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => mockRedis),
}));

// Mock @nexusops/db
vi.mock('@nexusops/db', () => ({
  prisma: {
    agent: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(),
    },
    budget: {
      findMany: vi.fn(),
    },
    toolCall: {
      count: vi.fn(),
      aggregate: vi.fn(),
    },
  },
  Environment: { PRODUCTION: 'PRODUCTION', STAGING: 'STAGING', DEVELOPMENT: 'DEVELOPMENT' },
}));

vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  calculateBlastRadius,
  atomicBudgetDeduct,
  initBudgetCounter,
  getBudgetRemaining,
  checkVelocity,
  calculateAnomalyScore,
} from './index';
import { prisma } from '@nexusops/db';

const mockPrisma = prisma as any;

describe('Blast Radius Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateBlastRadius', () => {
    it('should calculate damage for agent with GITHUB + DATABASE tools', async () => {
      mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        name: 'Test Agent',
        toolPermissions: ['GITHUB', 'DATABASE'],
        maxCostUsd: 1000,
        config: {},
      });
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        financialExposureConfig: {},
      });
      mockPrisma.budget.findMany.mockResolvedValue([]);
      mockPrisma.agent.update.mockResolvedValue({});

      const result = await calculateBlastRadius('agent-1', 'ws-1');

      expect(result.score).toBeGreaterThan(0);
      expect(result.maxDamageUsd).toBeGreaterThan(0);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].toolType).toBe('GITHUB');
      expect(result.breakdown[1].toolType).toBe('DATABASE');
      expect(result.calculatedAt).toBeInstanceOf(Date);

      // GITHUB = 500 * 10 (PRODUCTION weight) = 5000
      // DATABASE = 2000 * 10 = 20000
      // Total = 25000
      expect(result.maxDamageUsd).toBe(25000);
    });

    it('should cap governed damage to budget remaining', async () => {
      mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        name: 'Budget Agent',
        toolPermissions: ['CLOUD_DEPLOY'], // 5000 * 10 = 50000
        maxCostUsd: 1000,
        config: {},
      });
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        financialExposureConfig: {},
      });
      mockPrisma.budget.findMany.mockResolvedValue([
        {
          id: 'budget-1',
          maxCostUsd: 500,
          currentCostUsd: 300,
          autoHalt: true,
        },
      ]);
      mockPrisma.agent.update.mockResolvedValue({});

      const result = await calculateBlastRadius('agent-1', 'ws-1');

      // Max damage: 50000, budget monthlyCap = 500 * 30 = 15000
      // governedDamageUsd = min(50000, 15000) = 15000
      expect(result.governedDamageUsd).toBe(15000);
      expect(result.maxDamageUsd).toBe(50000);
      expect(result.activeBudgets).toHaveLength(1);
      expect(result.activeBudgets[0].remainingUsd).toBe(200);
      expect(result.activeBudgets[0].utilizationPercent).toBe(60);
    });

    it('should normalize score to 0-100 range', async () => {
      mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        name: 'All Tools',
        toolPermissions: ['GITHUB', 'JIRA', 'CLOUD_DEPLOY', 'DATABASE', 'CUSTOM'],
        maxCostUsd: null,
        config: {},
      });
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        financialExposureConfig: {},
      });
      mockPrisma.budget.findMany.mockResolvedValue([]);
      mockPrisma.agent.update.mockResolvedValue({});

      const result = await calculateBlastRadius('agent-1', 'ws-1');

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('should persist blast radius to agent record', async () => {
      mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        name: 'Test',
        toolPermissions: ['JIRA'],
        maxCostUsd: null,
        config: {},
      });
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        financialExposureConfig: {},
      });
      mockPrisma.budget.findMany.mockResolvedValue([]);
      mockPrisma.agent.update.mockResolvedValue({});

      await calculateBlastRadius('agent-1', 'ws-1');

      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: expect.objectContaining({
          blastRadiusScore: expect.any(Number),
          blastRadiusMaxDamageUsd: expect.any(Number),
          blastRadiusGovernedDamageUsd: expect.any(Number),
          blastRadiusLastCalculatedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('atomicBudgetDeduct', () => {
    it('should allow deduction when budget has sufficient funds', async () => {
      mockRedis.exists.mockResolvedValue(1);
      mockRedis.decrby.mockResolvedValue(4500); // 45.00 remaining after deduct

      const result = await atomicBudgetDeduct('ws-1', 'agent-1', 5.0);

      expect(result.allowed).toBe(true);
      expect(result.remainingUsd).toBe(45.0);
    });

    it('should deny and rollback when budget insufficient', async () => {
      mockRedis.exists.mockResolvedValue(1);
      mockRedis.decrby.mockResolvedValue(-100); // Negative = exceeded

      const result = await atomicBudgetDeduct('ws-1', 'agent-1', 10.0);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Budget exceeded');
      // Should have rolled back
      expect(mockRedis.incrby).toHaveBeenCalledWith(
        expect.stringContaining('budget:ws-1:agent-1'),
        1000, // 10.0 * 100 cents
      );
    });

    it('should allow when no budget exists (unconfigured)', async () => {
      mockRedis.exists.mockResolvedValue(0);

      const result = await atomicBudgetDeduct('ws-1', 'agent-1', 100.0);

      expect(result.allowed).toBe(true);
      expect(result.remainingUsd).toBe(Infinity);
    });

    it('should use correct budget key format', async () => {
      mockRedis.exists.mockResolvedValue(0);

      await atomicBudgetDeduct('ws-1', 'agent-1', 1.0);

      expect(mockRedis.exists).toHaveBeenCalledWith('budget:ws-1:agent-1:remaining');
    });

    it('should use workspace-level key when no agentId', async () => {
      mockRedis.exists.mockResolvedValue(0);

      await atomicBudgetDeduct('ws-1', undefined, 1.0);

      expect(mockRedis.exists).toHaveBeenCalledWith('budget:ws-1:workspace:remaining');
    });
  });

  describe('initBudgetCounter', () => {
    it('should set Redis key with correct value and TTL', async () => {
      await initBudgetCounter('ws-1', 'agent-1', 100.0, 3600);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'budget:ws-1:agent-1:remaining',
        10000, // $100.00 = 10000 cents
        'EX',
        3600,
      );
    });

    it('should use workspace key when agentId is undefined', async () => {
      await initBudgetCounter('ws-1', undefined, 50.0, 7200);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'budget:ws-1:workspace:remaining',
        5000, // $50.00 = 5000 cents
        'EX',
        7200,
      );
    });
  });

  describe('getBudgetRemaining', () => {
    it('should return remaining USD when key exists', async () => {
      mockRedis.get.mockResolvedValue('7500'); // 7500 cents

      const remaining = await getBudgetRemaining('ws-1', 'agent-1');
      expect(remaining).toBe(75.0);
    });

    it('should return Infinity when no key exists', async () => {
      mockRedis.get.mockResolvedValue(null);

      const remaining = await getBudgetRemaining('ws-1', 'agent-1');
      expect(remaining).toBe(Infinity);
    });
  });

  describe('checkVelocity', () => {
    it('should allow when under velocity limit', async () => {
      mockRedis.zremrangebyscore.mockResolvedValue(0);
      mockRedis.zrangebyscore.mockResolvedValue([]); // No recent entries
      mockRedis.zadd.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      const result = await checkVelocity('ws-1', 'agent-1', 5.0, 100.0);

      expect(result.allowed).toBe(true);
      expect(result.currentRateUsdPerMin).toBe(5.0);
    });

    it('should deny when exceeding velocity limit', async () => {
      mockRedis.zremrangebyscore.mockResolvedValue(0);
      // Existing entries totaling $95
      mockRedis.zrangebyscore.mockResolvedValue([
        `${Date.now() - 1000}:9500`,
      ]);

      const result = await checkVelocity('ws-1', 'agent-1', 10.0, 100.0);

      expect(result.allowed).toBe(false);
      expect(result.currentRateUsdPerMin).toBe(95.0);
    });
  });

  describe('calculateAnomalyScore', () => {
    it('should return low score for normal activity', async () => {
      // 5 calls per call site with matching data
      mockPrisma.toolCall.count
        .mockResolvedValueOnce(10)   // toolCallCount (7d, tool type)
        .mockResolvedValueOnce(0)    // recentErrors (24h FAILED)
        .mockResolvedValueOnce(2)    // hourlyCallCount (1h)
        .mockResolvedValueOnce(14);  // dailyCallCount (7d total)
      mockPrisma.toolCall.aggregate.mockResolvedValue({
        _avg: { costUsd: 5.0 },
        _max: { costUsd: 8.0 },
        _count: 14,
      });

      const result = await calculateAnomalyScore('agent-1', 'ws-1', 'GITHUB', 5.0);

      expect(result.score).toBeLessThanOrEqual(20);
      expect(result.signals.costVelocity).toBeDefined();
      expect(result.signals.toolCallFrequency).toBeDefined();
      expect(result.signals.repetitionScore).toBeDefined();
      expect(result.signals.scopeCreep).toBeDefined();
      expect(result.signals.errorRate).toBeDefined();
    });

    it('should flag never-before-used tool as scope creep', async () => {
      mockPrisma.toolCall.count
        .mockResolvedValueOnce(0)    // toolCallCount: never used this tool
        .mockResolvedValueOnce(0)    // recentErrors
        .mockResolvedValueOnce(1)    // hourlyCallCount
        .mockResolvedValueOnce(7);   // dailyCallCount
      mockPrisma.toolCall.aggregate.mockResolvedValue({
        _avg: { costUsd: 2.0 },
        _max: { costUsd: 3.0 },
        _count: 7,
      });

      const result = await calculateAnomalyScore('agent-1', 'ws-1', 'CLOUD_DEPLOY', 100.0);

      // scopeCreep = 100 (never used) * 0.15 = 15
      // costVelocity: 100/2 = 50x → 100 * 0.30 = 30
      expect(result.score).toBeGreaterThanOrEqual(30);
      expect(result.signals.scopeCreep).toBe(100);
    });

    it('should flag extremely high cost velocity', async () => {
      mockPrisma.toolCall.count
        .mockResolvedValueOnce(50)   // toolCallCount
        .mockResolvedValueOnce(0)    // recentErrors
        .mockResolvedValueOnce(3)    // hourlyCallCount
        .mockResolvedValueOnce(50);  // dailyCallCount
      mockPrisma.toolCall.aggregate.mockResolvedValue({
        _avg: { costUsd: 2.0 },
        _max: { costUsd: 4.0 },
        _count: 50,
      });

      // costUsd = 15, avg = 2 → ratio = 7.5x → costVelocity = 80 + 20 (exceeds max)
      const result = await calculateAnomalyScore('agent-1', 'ws-1', 'DATABASE', 15.0);

      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.signals.costVelocity).toBeGreaterThanOrEqual(80);
    });

    it('should cap score at 100', async () => {
      mockPrisma.toolCall.count
        .mockResolvedValueOnce(0)    // toolCallCount: scope creep = 100
        .mockResolvedValueOnce(10)   // recentErrors: high error = 100
        .mockResolvedValueOnce(100)  // hourlyCallCount: high frequency
        .mockResolvedValueOnce(10);  // dailyCallCount: low daily baseline → high freq ratio
      mockPrisma.toolCall.aggregate.mockResolvedValue({
        _avg: { costUsd: 1.0 },
        _max: { costUsd: 1.0 },
        _count: 10,
      });

      const result = await calculateAnomalyScore('agent-1', 'ws-1', 'CUSTOM', 100.0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.score).toBeGreaterThanOrEqual(50);
    });

    it('should flag high error rate', async () => {
      mockPrisma.toolCall.count
        .mockResolvedValueOnce(20)   // toolCallCount
        .mockResolvedValueOnce(6)    // recentErrors: > 5 → errorRate = 100
        .mockResolvedValueOnce(3)    // hourlyCallCount
        .mockResolvedValueOnce(20);  // dailyCallCount
      mockPrisma.toolCall.aggregate.mockResolvedValue({
        _avg: { costUsd: 5.0 },
        _max: { costUsd: 8.0 },
        _count: 20,
      });

      const result = await calculateAnomalyScore('agent-1', 'ws-1', 'GITHUB', 5.0);

      expect(result.signals.errorRate).toBe(100);
      expect(result.reasons.some((r: string) => r.includes('errors'))).toBe(true);
    });
  });
});
