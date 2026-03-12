/**
 * API Response Wrapper
 */
export interface ApiResponse<T = unknown> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
  error: null | {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Pagination
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * JWT Token Payload
 */
export interface JWTPayload {
  userId: string;
  workspaceId: string;
  role: string;
  type: 'access' | 'refresh';
}

/**
 * API Key Payload
 */
export interface ApiKeyPayload {
  keyId: string;
  workspaceId: string;
}

/**
 * WebSocket Events
 */
export enum WSEvent {
  TASK_CREATED = 'task:created',
  TASK_UPDATED = 'task:updated',
  TASK_COMPLETED = 'task:completed',
  TASK_FAILED = 'task:failed',
  TASK_ESCALATED = 'task:escalated',
  
  AGENT_REGISTERED = 'agent:registered',
  AGENT_STATUS_CHANGED = 'agent:status_changed',
  AGENT_TERMINATED = 'agent:terminated',
  
  POLICY_VIOLATED = 'policy:violated',
  POLICY_UPDATED = 'policy:updated',
  
  TOOL_CALL_BLOCKED = 'tool:call_blocked',
  
  SYSTEM_ALERT = 'system:alert',
}

/**
 * WebSocket Message
 */
export interface WSMessage<T = unknown> {
  event: WSEvent;
  data: T;
  workspaceId: string;
  timestamp: string;
}

/**
 * Task Queue Jobs
 */
export enum JobType {
  EXECUTE_TASK = 'execute_task',
  PROXY_TOOL_CALL = 'proxy_tool_call',
  EVALUATE_POLICY = 'evaluate_policy',
  UPDATE_METRICS = 'update_metrics',
  SEND_NOTIFICATION = 'send_notification',
  ECC_INSTINCT_REFRESH = 'ecc_instinct_refresh',
}

export interface JobData {
  type: JobType;
  workspaceId: string;
  payload: unknown;
}

/**
 * Agent SDK Types
 */
export interface AgentConfig {
  name: string;
  description?: string;
  version: string;
  toolPermissions: string[];
  maxTokens?: number;
  maxCostUsd?: number;
  maxExecutionMs?: number;
  maxDepth?: number;
}

export interface AgentTask {
  id: string;
  name: string;
  description?: string;
  input: Record<string, unknown>;
}

export interface AgentTaskResult {
  taskId: string;
  status: string;
  output?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
  tokenCount: number;
  costUsd: number;
}

/**
 * Tool Call Types
 */
export interface ToolCallRequest {
  toolType: string;
  toolMethod: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ToolCallResponse {
  success: boolean;
  output?: unknown;
  error?: {
    message: string;
    code?: string;
  };
  blocked?: boolean;
  blockReason?: string;
  durationMs: number;
}

/**
 * Metric Types
 */
export interface MetricData {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp?: Date;
}

export interface CostMetrics {
  totalCostUsd: number;
  tokenCount: number;
  avgCostPerTask: number;
  topAgentsByCost: Array<{
    agentId: string;
    agentName: string;
    costUsd: number;
  }>;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  services: {
    api: boolean;
    worker: boolean;
    proxy: boolean;
    policy: boolean;
    database: boolean;
    redis: boolean;
  };
  metrics: {
    queueDepth: number;
    avgPolicyLatencyMs: number;
    errorRate: number;
  };
}
