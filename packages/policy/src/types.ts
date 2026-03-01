import { PolicyAction, ToolType, Environment } from '@nexusops/db';

/**
 * Policy evaluation context
 * Contains all information needed to evaluate a policy
 */
export interface PolicyContext {
  workspaceId: string;
  agentId: string;
  taskId: string;
  toolType: ToolType;
  toolMethod: string;
  environment?: Environment;
  dataClassification?: string;
  requestedAt: Date;
  userId?: string;
  userRole?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Policy rule conditions
 * Defines matching criteria for policy rules
 */
export interface PolicyConditions {
  toolTypes?: ToolType[];
  toolMethods?: string[];
  environments?: Environment[];
  userRoles?: string[];
  dataClassifications?: string[];
  timeWindow?: {
    start: string; // HH:MM format
    end: string;
  };
  customRules?: Record<string, unknown>;
}

/**
 * Policy rule definition
 */
export interface PolicyRule {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  action: PolicyAction;
  priority: number;
  conditions: PolicyConditions;
  version: number;
}

/**
 * Policy evaluation result
 */
export interface PolicyEvaluationResult {
  matched: boolean;
  action: PolicyAction;
  reason: string;
  ruleId?: string;
  ruleName?: string;
  evaluationTimeMs: number;
}

/**
 * Policy Engine Configuration
 */
export interface PolicyEngineConfig {
  defaultAction: PolicyAction;
  evaluationTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTTLSeconds: number;
}
