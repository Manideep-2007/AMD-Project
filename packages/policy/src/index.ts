import { prisma, PolicyAction, type Prisma } from '@nexusops/db';
import { PolicyEvaluator } from './evaluator';
import type { PolicyContext, PolicyRule, PolicyEvaluationResult } from './types';

/**
 * Policy Engine Service
 * Manages policy evaluation with database integration and caching
 */
export class PolicyEngine {
  private ruleCache: Map<string, PolicyRule[]> = new Map();
  private cacheEnabled: boolean;
  private cacheTTLSeconds: number;
  private lastCacheUpdate: Map<string, number> = new Map();

  constructor(config?: { cacheEnabled?: boolean; cacheTTLSeconds?: number }) {
    this.cacheEnabled = config?.cacheEnabled ?? true;
    this.cacheTTLSeconds = config?.cacheTTLSeconds ?? 60;
  }

  /**
   * Load policy rules for a workspace from database
   */
  private async loadRules(workspaceId: string): Promise<PolicyRule[]> {
    const rules = await prisma.policyRule.findMany({
      where: {
        workspaceId,
        enabled: true,
      },
      orderBy: {
        priority: 'desc',
      },
    });

    return rules.map((rule: any): PolicyRule => ({
      id: rule.id,
      workspaceId: rule.workspaceId,
      name: rule.name,
      enabled: rule.enabled,
      action: rule.action,
      priority: rule.priority,
      conditions: rule.conditions as PolicyRule['conditions'],
      version: rule.version,
    }));
  }

  /**
   * Get rules with caching
   */
  private async getRules(workspaceId: string): Promise<PolicyRule[]> {
    if (!this.cacheEnabled) {
      return this.loadRules(workspaceId);
    }

    const now = Date.now();
    const lastUpdate = this.lastCacheUpdate.get(workspaceId) || 0;
    const cacheAge = (now - lastUpdate) / 1000;

    if (cacheAge < this.cacheTTLSeconds && this.ruleCache.has(workspaceId)) {
      return this.ruleCache.get(workspaceId)!;
    }

    const rules = await this.loadRules(workspaceId);
    this.ruleCache.set(workspaceId, rules);
    this.lastCacheUpdate.set(workspaceId, now);

    return rules;
  }

  /**
   * Invalidate cache for a workspace
   */
  invalidateCache(workspaceId: string): void {
    this.ruleCache.delete(workspaceId);
    this.lastCacheUpdate.delete(workspaceId);
  }

  /**
   * Evaluate policies for a given context
   */
  async evaluate(context: PolicyContext): Promise<PolicyEvaluationResult> {
    const rules = await this.getRules(context.workspaceId);
    const result = PolicyEvaluator.evaluate(rules, context, PolicyAction.DENY);

    // Store evaluation result in database for audit trail
    if (context.taskId) {
      await prisma.policyEvaluation.create({
        data: {
          policyRuleId: result.ruleId || '',
          taskId: context.taskId,
          matched: result.matched,
          action: result.action,
          reason: result.reason,
          evaluationMs: Math.round(result.evaluationTimeMs),
        },
      });
    }

    return result;
  }

  /**
   * Simulate policy evaluation (no database write)
   */
  async simulate(context: PolicyContext) {
    const rules = await this.getRules(context.workspaceId);
    return PolicyEvaluator.simulate(rules, context);
  }

  /**
   * Batch evaluate multiple contexts
   */
  async evaluateBatch(contexts: PolicyContext[]): Promise<PolicyEvaluationResult[]> {
    if (contexts.length === 0) {
      return [];
    }

    // Assuming all contexts are for the same workspace (common case)
    const workspaceId = contexts[0].workspaceId;
    const rules = await this.getRules(workspaceId);

    return PolicyEvaluator.evaluateBatch(rules, contexts, PolicyAction.DENY);
  }
}

// Export singleton instance
export const policyEngine = new PolicyEngine();

// Export types and evaluator
export { PolicyEvaluator } from './evaluator';
export * from './types';
