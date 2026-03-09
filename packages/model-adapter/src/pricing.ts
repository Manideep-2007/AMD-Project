/**
 * Model pricing table — as of March 2026.
 * Prices in USD per 1 million tokens.
 *
 * To override without deployment, write to Redis key `pricing:overrides`
 * as a hash of { modelId: JSON.stringify({ inputPerMillion, outputPerMillion }) }.
 */

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ───────────────────────────────────────────────────────────────
  'claude-opus-4-6': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-sonnet-4-6': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet-4-20250514': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-haiku-4-5': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-haiku-20240307': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'claude-3-opus-20240229': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-3-sonnet-20240229': { inputPerMillion: 3.00, outputPerMillion: 15.00 },

  // ── OpenAI ──────────────────────────────────────────────────────────────────
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4-turbo': { inputPerMillion: 10.00, outputPerMillion: 30.00 },
  'gpt-4': { inputPerMillion: 30.00, outputPerMillion: 60.00 },
  'gpt-3.5-turbo': { inputPerMillion: 0.50, outputPerMillion: 1.50 },
  'o1': { inputPerMillion: 15.00, outputPerMillion: 60.00 },
  'o1-mini': { inputPerMillion: 3.00, outputPerMillion: 12.00 },
  'o3-mini': { inputPerMillion: 1.10, outputPerMillion: 4.40 },

  // ── Google ──────────────────────────────────────────────────────────────────
  'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-2.0-flash-exp': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  'gemini-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },

  // ── Mistral ─────────────────────────────────────────────────────────────────
  'mistral-large-latest': { inputPerMillion: 2.00, outputPerMillion: 6.00 },
  'mistral-large': { inputPerMillion: 2.00, outputPerMillion: 6.00 },
  'mistral-medium': { inputPerMillion: 0.40, outputPerMillion: 2.00 },
  'mistral-small-latest': { inputPerMillion: 0.20, outputPerMillion: 0.60 },
  'mistral-tiny': { inputPerMillion: 0.14, outputPerMillion: 0.42 },
  'open-mistral-7b': { inputPerMillion: 0.25, outputPerMillion: 0.25 },
  'open-mixtral-8x7b': { inputPerMillion: 0.70, outputPerMillion: 0.70 },

  // ── AWS Bedrock (model IDs as used in API calls) ────────────────────────────
  'anthropic.claude-3-sonnet-20240229-v1:0': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'anthropic.claude-3-opus-20240229-v1:0': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'amazon.titan-text-express-v1': { inputPerMillion: 0.80, outputPerMillion: 1.60 },
  'amazon.titan-text-lite-v1': { inputPerMillion: 0.30, outputPerMillion: 0.40 },
  'meta.llama2-70b-chat-v1': { inputPerMillion: 1.95, outputPerMillion: 2.56 },
  'ai21.j2-ultra-v1': { inputPerMillion: 18.80, outputPerMillion: 18.80 },
};

/**
 * Compute the USD cost of a model completion.
 *
 * For known models: exact per-token pricing.
 * For unknown models: conservative fallback of $0.01 per 1k tokens
 * (prevents zero-cost abuse while remaining broadly correct).
 *
 * Ollama / local models should NOT call this — return costUsd: 0 directly.
 */
export function calculateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[modelId];

  if (!pricing) {
    // Unknown model: charge a conservative $0.01 per 1 000 tokens to prevent
    // zero-cost abuse and ensure budget enforcement always triggers.
    const totalTokens = promptTokens + completionTokens;
    return (totalTokens / 1_000) * 0.01;
  }

  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}
