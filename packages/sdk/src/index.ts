/**
 * @nexusops/sdk — NexusOps TypeScript Agent SDK
 *
 * Production-grade SDK for integrating autonomous AI agents with the NexusOps
 * governance platform. Provides:
 *  • Agent lifecycle management (register, heartbeat, terminate)
 *  • Policy-gated tool call execution with pre-flight checks
 *  • Ed25519 signed audit trail for every action
 *  • Real-time event streaming via WebSocket
 *  • Automatic budget tracking and enforcement
 *  • Retry with exponential back-off
 */

export { NexusAgent, type NexusAgentConfig } from "./agent";
export { NexusClient, type NexusClientConfig } from "./client";
export { NexusEventStream, type NexusEvent } from "./events";
export {
  type PolicyDecision,
  type ToolCallRequest,
  type ToolCallResult,
  type AgentRegistration,
  type BudgetStatus,
} from "./types";
