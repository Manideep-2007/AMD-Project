import { PolicyAction, ToolType, Environment } from '@nexusops/db';
import { describe, it, expect } from 'vitest';
import { PolicyEvaluator } from './evaluator';
import type { PolicyRule, PolicyContext } from './types';

describe('PolicyEvaluator', () => {
  const mockRule: PolicyRule = {
    id: 'rule-1',
    workspaceId: 'ws-1',
    name: 'Deny Production Database Writes',
    enabled: true,
    action: PolicyAction.DENY,
    priority: 100,
    version: 1,
    conditions: {
      toolTypes: [ToolType.DATABASE],
      environments: [Environment.PRODUCTION],
    },
  };

  const mockContext: PolicyContext = {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    toolType: ToolType.DATABASE,
    toolMethod: 'executeQuery',
    environment: Environment.PRODUCTION,
    requestedAt: new Date(),
  };

  describe('evaluate', () => {
    it('should match rule when all conditions are met', () => {
      const result = PolicyEvaluator.evaluate([mockRule], mockContext);

      expect(result.matched).toBe(true);
      expect(result.action).toBe(PolicyAction.DENY);
      expect(result.ruleId).toBe('rule-1');
      expect(result.evaluationTimeMs).toBeLessThan(5); // < 5ms requirement
    });

    it('should not match when tool type differs', () => {
      const context = { ...mockContext, toolType: ToolType.GITHUB };
      const result = PolicyEvaluator.evaluate([mockRule], context);

      expect(result.matched).toBe(false);
      expect(result.action).toBe(PolicyAction.DENY); // default
    });

    it('should not match when environment differs', () => {
      const context = { ...mockContext, environment: Environment.STAGING };
      const result = PolicyEvaluator.evaluate([mockRule], context);

      expect(result.matched).toBe(false);
    });

    it('should respect priority order', () => {
      const lowPriorityRule: PolicyRule = {
        ...mockRule,
        id: 'rule-2',
        name: 'Allow Database Reads',
        action: PolicyAction.ALLOW,
        priority: 50,
      };

      const highPriorityRule: PolicyRule = {
        ...mockRule,
        id: 'rule-3',
        name: 'Escalate All Production',
        action: PolicyAction.ESCALATE_TO_HUMAN,
        priority: 150,
      };

      const result = PolicyEvaluator.evaluate(
        [lowPriorityRule, mockRule, highPriorityRule],
        mockContext
      );

      expect(result.ruleId).toBe('rule-3'); // Highest priority
      expect(result.action).toBe(PolicyAction.ESCALATE_TO_HUMAN);
    });

    it('should skip disabled rules', () => {
      const disabledRule: PolicyRule = { ...mockRule, enabled: false };
      const result = PolicyEvaluator.evaluate([disabledRule], mockContext);

      expect(result.matched).toBe(false);
    });

    it('should match wildcard method patterns', () => {
      const rule: PolicyRule = {
        ...mockRule,
        conditions: {
          toolTypes: [ToolType.DATABASE],
          toolMethods: ['execute*', 'run*'],
        },
      };

      const context = { ...mockContext, toolMethod: 'executeQuery' };
      const result = PolicyEvaluator.evaluate([rule], context);

      expect(result.matched).toBe(true);
    });

    it('should evaluate time windows correctly', () => {
      const rule: PolicyRule = {
        ...mockRule,
        conditions: {
          timeWindow: {
            start: '09:00',
            end: '17:00',
          },
        },
      };

      // Simulate time at 10:00 AM
      const morningContext = {
        ...mockContext,
        requestedAt: new Date('2026-03-01T10:00:00'),
      };
      const morningResult = PolicyEvaluator.evaluate([rule], morningContext);
      expect(morningResult.matched).toBe(true);

      // Simulate time at 8:00 AM (before window)
      const earlyContext = {
        ...mockContext,
        requestedAt: new Date('2026-03-01T08:00:00'),
      };
      const earlyResult = PolicyEvaluator.evaluate([rule], earlyContext);
      expect(earlyResult.matched).toBe(false);

      // Simulate time at 6:00 PM (after window)
      const lateContext = {
        ...mockContext,
        requestedAt: new Date('2026-03-01T18:00:00'),
      };
      const lateResult = PolicyEvaluator.evaluate([rule], lateContext);
      expect(lateResult.matched).toBe(false);
    });
  });

  describe('evaluateBatch', () => {
    it('should evaluate multiple contexts efficiently', () => {
      const contexts: PolicyContext[] = [
        mockContext,
        { ...mockContext, toolType: ToolType.GITHUB },
        { ...mockContext, environment: Environment.STAGING },
      ];

      const results = PolicyEvaluator.evaluateBatch([mockRule], contexts);

      expect(results).toHaveLength(3);
      expect(results[0].matched).toBe(true);
      expect(results[1].matched).toBe(false);
      expect(results[2].matched).toBe(false);
    });
  });

  describe('simulate', () => {
    it('should return all matching rules', () => {
      const rule1: PolicyRule = {
        ...mockRule,
        id: 'rule-1',
        priority: 100,
        action: PolicyAction.DENY,
      };

      const rule2: PolicyRule = {
        ...mockRule,
        id: 'rule-2',
        priority: 50,
        action: PolicyAction.ESCALATE_TO_HUMAN,
      };

      const { result, allMatchedRules } = PolicyEvaluator.simulate(
        [rule1, rule2],
        mockContext
      );

      expect(allMatchedRules).toHaveLength(2);
      expect(result.action).toBe(PolicyAction.DENY); // Higher priority
      expect(allMatchedRules[0].rule.id).toBe('rule-1');
      expect(allMatchedRules[1].rule.id).toBe('rule-2');
    });
  });

  describe('performance', () => {
    it('should evaluate policies in < 10ms p99', () => {
      const rules: PolicyRule[] = Array.from({ length: 50 }, (_, i) => ({
        ...mockRule,
        id: `rule-${i}`,
        priority: i,
      }));

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const result = PolicyEvaluator.evaluate(rules, mockContext);
        times.push(result.evaluationTimeMs);
      }

      times.sort((a, b) => a - b);
      const p99 = times[Math.floor(iterations * 0.99)];

      console.log(`P99 latency: ${p99.toFixed(3)}ms`);
      expect(p99).toBeLessThan(10);
    });
  });
});
