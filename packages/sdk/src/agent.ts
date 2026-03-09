/* ──────────────────────────────────────────────────────────────
 * NexusOps SDK — NexusAgent
 *
 * High-level agent class that wraps the HTTP client and event
 * stream into a cohesive interface for AI agent integration.
 *
 * Usage:
 *   const agent = new NexusAgent({
 *     name: "CodeReviewer-v3",
 *     baseUrl: "https://api.nexusops.io",
 *     apiKey: "nxs_...",
 *     workspaceId: "ws_prod",
 *   });
 *
 *   await agent.register();
 *
 *   const result = await agent.callTool({
 *     toolType: "github",
 *     toolMethod: "pull_request.review",
 *     parameters: { repo: "org/repo", pr: 482 },
 *   });
 *
 *   if (result.status === "DENIED") {
 *     console.log("Blocked:", result.policyDecision.reason);
 *   }
 *
 *   await agent.terminate();
 * ────────────────────────────────────────────────────────────── */

import { NexusClient, type NexusClientConfig } from "./client";
import { NexusEventStream } from "./events";
import type {
  AgentRegistration,
  BudgetStatus,
  PolicyDecision,
  ToolCallRequest,
  ToolCallResult,
  EventType,
} from "./types";

export interface NexusAgentConfig extends NexusClientConfig {
  /** Agent display name */
  name: string;
  /** Workspace to register in */
  workspaceId: string;
  /** Optional environment override (default: "production") */
  environment?: string;
  /** Enable real-time event streaming (default: true) */
  enableStreaming?: boolean;
  /** WebSocket URL (default: derived from baseUrl) */
  wsUrl?: string;
  /** Heartbeat interval in ms (default: 15000) */
  heartbeatIntervalMs?: number;
  /** Metadata attached to agent registration */
  metadata?: Record<string, unknown>;
  /** Event types to subscribe to */
  subscribeEvents?: EventType[];
}

export class NexusAgent {
  private client: NexusClient;
  private stream: NexusEventStream | null = null;
  private registration: AgentRegistration | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private config: NexusAgentConfig;

  constructor(config: NexusAgentConfig) {
    this.config = {
      environment: "production",
      enableStreaming: true,
      heartbeatIntervalMs: 15_000,
      ...config,
    };
    this.client = new NexusClient(config);
  }

  /** Agent ID after registration */
  get id(): string | null {
    return this.registration?.id ?? null;
  }

  /** Registration details */
  get info(): AgentRegistration | null {
    return this.registration;
  }

  /** Event stream (null if streaming disabled) */
  get events(): NexusEventStream | null {
    return this.stream;
  }

  /* ── Lifecycle ───────────────────────────────────────── */

  /**
   * Register this agent with the NexusOps platform.
   * Starts heartbeat and optional event streaming.
   */
  async register(): Promise<AgentRegistration> {
    this.registration = await this.client.post<AgentRegistration>("/api/v1/agents", {
      name: this.config.name,
      workspaceId: this.config.workspaceId,
      environment: this.config.environment,
      metadata: this.config.metadata ?? {},
    });

    // Start heartbeat
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.client.post(`/api/v1/agents/${this.registration!.id}/heartbeat`);
      } catch {
        // heartbeat failure is non-fatal
      }
    }, this.config.heartbeatIntervalMs);

    // Start event stream
    if (this.config.enableStreaming) {
      const wsBase = this.config.wsUrl ?? this.config.baseUrl.replace(/^http/, "ws");
      this.stream = new NexusEventStream({
        url: `${wsBase}/ws`,
        accessToken: this.config.accessToken || this.config.apiKey || "",
      });
      this.stream.connect();

      if (this.config.subscribeEvents?.length) {
        // Wait for connection before subscribing
        await new Promise<void>((resolve) => {
          this.stream!.once("connected", () => {
            this.stream!.subscribe(this.config.subscribeEvents!);
            resolve();
          });
          // Timeout after 5s
          setTimeout(resolve, 5000);
        });
      }
    }

    return this.registration;
  }

  /** Pause the agent — stops heartbeat, keeps connection */
  async pause(): Promise<void> {
    if (!this.registration) throw new Error("Agent not registered");
    await this.client.patch(`/api/v1/agents/${this.registration.id}`, { status: "PAUSED" });
    this.stopHeartbeat();
  }

  /** Resume the agent — restarts heartbeat */
  async resume(): Promise<void> {
    if (!this.registration) throw new Error("Agent not registered");
    await this.client.patch(`/api/v1/agents/${this.registration.id}`, { status: "ACTIVE" });
    this.startHeartbeat();
  }

  /** Terminate the agent — cleanup all resources */
  async terminate(): Promise<void> {
    this.stopHeartbeat();
    this.stream?.disconnect();

    if (this.registration) {
      try {
        await this.client.patch(`/api/v1/agents/${this.registration.id}`, { status: "TERMINATED" });
      } catch {
        // best effort
      }
      this.registration = null;
    }
  }

  /* ── Tool Calls ──────────────────────────────────────── */

  /**
   * Execute a governed tool call.
   * The platform evaluates policies before execution.
   * Returns the full result including policy decision.
   */
  async callTool(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.registration) throw new Error("Agent not registered — call register() first");

    return this.client.post<ToolCallResult>("/api/v1/tools/execute", {
      agentId: this.registration.id,
      workspaceId: this.config.workspaceId,
      environment: request.environment ?? this.config.environment,
      ...request,
    });
  }

  /**
   * Pre-flight policy check without executing the tool.
   * Useful for UI hints or conditional branching.
   */
  async checkPolicy(request: Omit<ToolCallRequest, "parameters">): Promise<PolicyDecision> {
    if (!this.registration) throw new Error("Agent not registered");

    return this.client.post<PolicyDecision>("/api/v1/policies/evaluate", {
      agentId: this.registration.id,
      workspaceId: this.config.workspaceId,
      environment: request.environment ?? this.config.environment,
      toolType: request.toolType,
      toolMethod: request.toolMethod,
      sql: request.sql,
    });
  }

  /**
   * Execute a batch of tool calls. Each is independently governed.
   * Returns results in the same order as requests.
   */
  async callToolBatch(requests: ToolCallRequest[]): Promise<ToolCallResult[]> {
    return Promise.all(requests.map((r) => this.callTool(r)));
  }

  /* ── Budget ──────────────────────────────────────────── */

  /** Get current budget status for this agent */
  async getBudgetStatus(): Promise<BudgetStatus> {
    if (!this.registration) throw new Error("Agent not registered");
    return this.client.get<BudgetStatus>(`/api/v1/budgets/blast-radius/${this.registration.id}`);
  }

  /* ── Tasks ───────────────────────────────────────────── */

  /** Create a task for this agent */
  async createTask(task: {
    name: string;
    description?: string;
    toolType: string;
    toolMethod: string;
    parameters: Record<string, unknown>;
    priority?: number;
  }): Promise<{ id: string; status: string }> {
    if (!this.registration) throw new Error("Agent not registered");
    return this.client.post("/api/v1/tasks", {
      ...task,
      agentId: this.registration.id,
      workspaceId: this.config.workspaceId,
    });
  }

  /** Report task completion */
  async completeTask(
    taskId: string,
    result: { output?: unknown; costUsd?: number; inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    await this.client.patch(`/api/v1/tasks/${taskId}`, {
      status: "COMPLETED",
      ...result,
    });
  }

  /** Report task failure */
  async failTask(taskId: string, error: { message: string; stack?: string }): Promise<void> {
    await this.client.patch(`/api/v1/tasks/${taskId}`, {
      status: "FAILED",
      error,
    });
  }

  /* ── Internal ────────────────────────────────────────── */

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.client.post(`/api/v1/agents/${this.registration!.id}/heartbeat`);
      } catch {
        // non-fatal
      }
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
