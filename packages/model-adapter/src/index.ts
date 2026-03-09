/**
 * @nexusops/model-adapter — Universal Model Adapter
 *
 * Cloud-neutral abstraction over LLM providers.
 * Every provider implements the same interface. The proxy calls the adapter,
 * never the provider directly. This is how we achieve cloud neutrality.
 *
 * Phase 1 providers: OpenAI, Anthropic, AWS Bedrock, Azure OpenAI
 * Phase 2: Google, Mistral, Ollama, on-premise
 */

import { createLogger } from '@nexusops/logger';

const logger = createLogger('model-adapter');

// ─── Core Interface ──────────────────────────

export interface ModelRequest {
  /** Provider-agnostic model identifier */
  model: string;
  /** Messages in OpenAI-compatible format */
  messages: ChatMessage[];
  /** Max tokens to generate */
  maxTokens?: number;
  /** Temperature 0-2 */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /** Tool/function definitions for tool calling */
  tools?: ToolDefinition[];
  /** Streaming response */
  stream?: boolean;
  /** Request metadata */
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool call ID (for tool role messages) */
  toolCallId?: string;
  /** Tool calls requested by assistant */
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelResponse {
  /** Provider identifier */
  provider: string;
  /** Model used */
  model: string;
  /** Generated content */
  content: string;
  /** Tool calls (if any) */
  toolCalls?: ToolCall[];
  /** Token usage */
  usage: TokenUsage;
  /** Estimated cost in USD */
  costUsd: number;
  /** Latency in ms */
  latencyMs: number;
  /** Raw provider response (for debugging) */
  rawResponse?: unknown;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  toolCalls?: ToolCall[];
}

// ─── Provider Interface ──────────────────────

export interface ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];

  /** Complete a chat request */
  complete(request: ModelRequest): Promise<ModelResponse>;

  /** Stream a chat response */
  stream?(request: ModelRequest): AsyncIterable<StreamChunk>;

  /** Check if provider is healthy */
  healthCheck(): Promise<boolean>;
}

// ─── Cost Tables ─────────────────────────────

interface ModelPricing {
  promptPer1k: number;
  completionPer1k: number;
}

const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { promptPer1k: 0.005, completionPer1k: 0.015 },
  'gpt-4o-mini': { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  'gpt-4-turbo': { promptPer1k: 0.01, completionPer1k: 0.03 },
  'gpt-3.5-turbo': { promptPer1k: 0.0005, completionPer1k: 0.0015 },
  // Anthropic
  'claude-sonnet-4-20250514': { promptPer1k: 0.003, completionPer1k: 0.015 },
  'claude-3-5-haiku-20241022': { promptPer1k: 0.001, completionPer1k: 0.005 },
  'claude-3-opus-20240229': { promptPer1k: 0.015, completionPer1k: 0.075 },
  // AWS Bedrock (same models, same pricing)
  'anthropic.claude-3-sonnet': { promptPer1k: 0.003, completionPer1k: 0.015 },
  'amazon.titan-text-express': { promptPer1k: 0.0008, completionPer1k: 0.0016 },
  // Azure OpenAI (same as OpenAI pricing)
  'azure/gpt-4o': { promptPer1k: 0.005, completionPer1k: 0.015 },
  // Google Gemini
  'gemini-1.5-pro': { promptPer1k: 0.00125, completionPer1k: 0.005 },
  'gemini-1.5-flash': { promptPer1k: 0.000075, completionPer1k: 0.0003 },
  'gemini-2.0-flash': { promptPer1k: 0.0001, completionPer1k: 0.0004 },
  // Mistral
  'mistral-large-latest': { promptPer1k: 0.002, completionPer1k: 0.006 },
  'mistral-medium-latest': { promptPer1k: 0.0027, completionPer1k: 0.0081 },
  'mistral-small-latest': { promptPer1k: 0.001, completionPer1k: 0.003 },
  'open-mistral-nemo': { promptPer1k: 0.0003, completionPer1k: 0.0003 },
  // Ollama (local — free, but track tokens)
  'ollama/llama3': { promptPer1k: 0, completionPer1k: 0 },
  'ollama/codellama': { promptPer1k: 0, completionPer1k: 0 },
  'ollama/mistral': { promptPer1k: 0, completionPer1k: 0 },
};

export function estimateCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model];
  if (!pricing) {
    logger.warn({ model }, 'Unknown model pricing — using conservative estimate');
    return (usage.promptTokens * 0.01 + usage.completionTokens * 0.03) / 1000;
  }
  return (
    (usage.promptTokens * pricing.promptPer1k +
      usage.completionTokens * pricing.completionPer1k) /
    1000
  );
}

// ─── Provider Registry ───────────────────────

const providers = new Map<string, ModelProvider>();

export function registerProvider(provider: ModelProvider): void {
  providers.set(provider.name, provider);
  logger.info({ provider: provider.name }, 'Model provider registered');
}

export function getProvider(name: string): ModelProvider | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

// ─── Adapter (main entry) ────────────────────

/**
 * Resolve provider from model name or explicit provider key.
 * Convention: "openai/gpt-4o", "anthropic/claude-3-sonnet", "bedrock/titan"
 */
function resolveProvider(model: string): { provider: ModelProvider; resolvedModel: string } {
  // If model contains '/', the prefix is the provider
  if (model.includes('/')) {
    const [providerName, ...rest] = model.split('/');
    const resolvedModel = rest.join('/');
    const provider = providers.get(providerName!);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not registered. Available: ${listProviders().join(', ')}`);
    }
    return { provider, resolvedModel };
  }

  // Try to find a provider that supports this model
  for (const [, provider] of providers) {
    if (provider.supportedModels.includes(model)) {
      return { provider, resolvedModel: model };
    }
  }

  throw new Error(`No provider found for model "${model}". Available providers: ${listProviders().join(', ')}`);
}

/**
 * Universal model adapter — the single entry point for all LLM calls.
 * Resolves the correct provider, makes the call, computes cost.
 */
export async function complete(request: ModelRequest): Promise<ModelResponse> {
  const startMs = Date.now();
  const { provider, resolvedModel } = resolveProvider(request.model);

  logger.info(
    { provider: provider.name, model: resolvedModel, messageCount: request.messages.length },
    'Model request',
  );

  const response = await provider.complete({
    ...request,
    model: resolvedModel,
  });

  // Compute cost if provider didn't
  if (response.costUsd === 0 && response.usage.totalTokens > 0) {
    response.costUsd = estimateCost(resolvedModel, response.usage);
  }

  response.latencyMs = Date.now() - startMs;

  logger.info(
    {
      provider: provider.name,
      model: resolvedModel,
      tokens: response.usage.totalTokens,
      costUsd: response.costUsd,
      latencyMs: response.latencyMs,
    },
    'Model response',
  );

  return response;
}

// ─── Built-in Stub Provider (for testing) ────

export class StubProvider implements ModelProvider {
  readonly name = 'stub';
  readonly supportedModels = ['stub-model'];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      provider: 'stub',
      model: request.model,
      content: 'This is a stub response for testing.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0,
      latencyMs: 1,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// Register stub provider by default (for tests)
registerProvider(new StubProvider());

// ─── Provider Exports ────────────────────────

export { OpenAIProvider } from './providers/openai';
export { AnthropicProvider } from './providers/anthropic';
export { GeminiProvider } from './providers/gemini';
export { MistralProvider } from './providers/mistral';
export { BedrockProvider } from './providers/bedrock';
export { OllamaProvider } from './providers/ollama';
export { GenericOpenAIProvider } from './providers/generic-openai';

/**
 * Auto-register providers from environment.
 * Call this at application startup to register all configured providers.
 *
 * Providers are only registered if the required env var is present,
 * so missing API keys are safe to omit.
 */
export function autoRegisterProviders(): void {
  if (process.env.OPENAI_API_KEY) {
    const { OpenAIProvider: P } = require('./providers/openai');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { AnthropicProvider: P } = require('./providers/anthropic');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
  if (process.env.GOOGLE_AI_API_KEY) {
    const { GeminiProvider: P } = require('./providers/gemini');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
  if (process.env.MISTRAL_API_KEY) {
    const { MistralProvider: P } = require('./providers/mistral');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    const { BedrockProvider: P } = require('./providers/bedrock');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
  if (process.env.OLLAMA_BASE_URL) {
    const { OllamaProvider: P } = require('./providers/ollama');
    try { registerProvider(new P()); } catch { /* already registered */ }
  }
}
