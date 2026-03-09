/* ──────────────────────────────────────────────────────────────
 * NexusOps SDK — Shared Types
 * ────────────────────────────────────────────────────────────── */

/** Policy evaluation result returned by the governance engine */
export interface PolicyDecision {
  allowed: boolean;
  action: "ALLOW" | "DENY" | "ESCALATE_TO_HUMAN";
  reason: string;
  ruleId: string | null;
  ruleName: string | null;
  evaluationTimeUs: number;
}

/** Request payload for a tool call through the governance layer */
export interface ToolCallRequest {
  toolType: string;
  toolMethod: string;
  parameters: Record<string, unknown>;
  /** Optional SQL if this is a database tool call — will be AST-gated */
  sql?: string;
  /** Override environment. Default: config.environment */
  environment?: string;
  /** Idempotency key for exactly-once delivery */
  idempotencyKey?: string;
}

/** Result of a governed tool call */
export interface ToolCallResult {
  id: string;
  status: "ALLOWED" | "DENIED" | "ESCALATED" | "FAILED";
  policyDecision: PolicyDecision;
  output?: unknown;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  hash: string;
}

/** Agent registration payload */
export interface AgentRegistration {
  id: string;
  name: string;
  workspaceId: string;
  status: "ACTIVE" | "PAUSED" | "TERMINATED";
  publicKey: string;
  registeredAt: string;
  metadata: Record<string, unknown>;
}

/** Real-time budget status */
export interface BudgetStatus {
  agentId: string;
  budgetId: string;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  percentUsed: number;
  velocityUsdPerHour: number;
  projectedExhaustionAt: string | null;
  isExceeded: boolean;
  isWarning: boolean;
}

/** WebSocket event types */
export type EventType =
  | "task:created"
  | "task:completed"
  | "task:failed"
  | "task:escalated"
  | "approval:created"
  | "approval:decided"
  | "budget:warning"
  | "budget:exceeded"
  | "policy:violation"
  | "injection:blocked"
  | "chain:broken"
  | "agent:status"
  | "heartbeat";

/** Signed audit event */
export interface SignedEvent {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: string;
  hash: string;
  previousHash: string;
  signature: string;
}
