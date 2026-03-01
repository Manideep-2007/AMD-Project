import { PolicyAction } from '@nexusops/db';
import type {
  PolicyContext,
  PolicyRule,
  PolicyConditions,
  PolicyEvaluationResult,
} from './types';

/**
 * Core policy evaluation engine
 * Pure function - no side effects, fully testable
 * Target: < 5ms p99 evaluation latency
 */
export class PolicyEvaluator {
  /**
   * Evaluate a single policy rule against context
   */
  private static evaluateRule(rule: PolicyRule, context: PolicyContext): boolean {
    if (!rule.enabled) {
      return false;
    }

    const conditions = rule.conditions;

    // Tool type matching
    if (conditions.toolTypes && conditions.toolTypes.length > 0) {
      if (!conditions.toolTypes.includes(context.toolType)) {
        return false;
      }
    }

    // Tool method matching (exact or pattern)
    if (conditions.toolMethods && conditions.toolMethods.length > 0) {
      const methodMatches = conditions.toolMethods.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(context.toolMethod);
        }
        return pattern === context.toolMethod;
      });
      if (!methodMatches) {
        return false;
      }
    }

    // Environment matching
    if (conditions.environments && conditions.environments.length > 0) {
      if (!context.environment || !conditions.environments.includes(context.environment)) {
        return false;
      }
    }

    // User role matching
    if (conditions.userRoles && conditions.userRoles.length > 0) {
      if (!context.userRole || !conditions.userRoles.includes(context.userRole)) {
        return false;
      }
    }

    // Data classification matching
    if (conditions.dataClassifications && conditions.dataClassifications.length > 0) {
      if (
        !context.dataClassification ||
        !conditions.dataClassifications.includes(context.dataClassification)
      ) {
        return false;
      }
    }

    // Time window matching
    if (conditions.timeWindow) {
      const currentTime = context.requestedAt;
      const currentHour = currentTime.getHours();
      const currentMinute = currentTime.getMinutes();
      const currentTimeMinutes = currentHour * 60 + currentMinute;

      const [startHour, startMin] = conditions.timeWindow.start.split(':').map(Number);
      const [endHour, endMin] = conditions.timeWindow.end.split(':').map(Number);
      const startTimeMinutes = startHour * 60 + startMin;
      const endTimeMinutes = endHour * 60 + endMin;

      if (startTimeMinutes <= endTimeMinutes) {
        // Same day window
        if (currentTimeMinutes < startTimeMinutes || currentTimeMinutes > endTimeMinutes) {
          return false;
        }
      } else {
        // Crosses midnight
        if (currentTimeMinutes < startTimeMinutes && currentTimeMinutes > endTimeMinutes) {
          return false;
        }
      }
    }

    // All conditions matched
    return true;
  }

  /**
   * Evaluate all rules and return the first matching rule's action
   * Rules are evaluated in priority order (highest first)
   */
  static evaluate(
    rules: PolicyRule[],
    context: PolicyContext,
    defaultAction: PolicyAction = PolicyAction.DENY
  ): PolicyEvaluationResult {
    const startTime = performance.now();

    // Sort rules by priority (highest first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    // Evaluate each rule
    for (const rule of sortedRules) {
      try {
        const matches = this.evaluateRule(rule, context);

        if (matches) {
          const evaluationTimeMs = performance.now() - startTime;

          return {
            matched: true,
            action: rule.action,
            reason: `Matched policy: ${rule.name}`,
            ruleId: rule.id,
            ruleName: rule.name,
            evaluationTimeMs,
          };
        }
      } catch (error) {
        // Log error but continue evaluating other rules
        console.error(`Error evaluating rule ${rule.id}:`, error);
      }
    }

    // No rule matched - use default action
    const evaluationTimeMs = performance.now() - startTime;

    return {
      matched: false,
      action: defaultAction,
      reason: 'No matching policy found - using default action',
      evaluationTimeMs,
    };
  }

  /**
   * Batch evaluate multiple contexts against the same ruleset
   * More efficient than calling evaluate() in a loop
   */
  static evaluateBatch(
    rules: PolicyRule[],
    contexts: PolicyContext[],
    defaultAction: PolicyAction = PolicyAction.DENY
  ): PolicyEvaluationResult[] {
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    return contexts.map((context) => {
      return this.evaluate(sortedRules, context, defaultAction);
    });
  }

  /**
   * Simulate policy evaluation without actually enforcing
   * Useful for testing and debugging policies
   */
  static simulate(
    rules: PolicyRule[],
    context: PolicyContext
  ): {
    result: PolicyEvaluationResult;
    allMatchedRules: Array<{ rule: PolicyRule; action: PolicyAction }>;
  } {
    const startTime = performance.now();
    const allMatchedRules: Array<{ rule: PolicyRule; action: PolicyAction }> = [];
    let firstMatch: PolicyEvaluationResult | null = null;

    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      const matches = this.evaluateRule(rule, context);

      if (matches) {
        allMatchedRules.push({ rule, action: rule.action });

        if (!firstMatch) {
          firstMatch = {
            matched: true,
            action: rule.action,
            reason: `Matched policy: ${rule.name}`,
            ruleId: rule.id,
            ruleName: rule.name,
            evaluationTimeMs: performance.now() - startTime,
          };
        }
      }
    }

    const result =
      firstMatch ||
      ({
        matched: false,
        action: PolicyAction.DENY,
        reason: 'No matching policy found',
        evaluationTimeMs: performance.now() - startTime,
      } as PolicyEvaluationResult);

    return { result, allMatchedRules };
  }
}
