/**
 * Generic OpenAI-Compatible Provider
 *
 * Supports any server implementing the OpenAI Chat Completions API:
 * - Azure OpenAI
 * - LM Studio
 * - vLLM
 * - LocalAI
 * - Together AI
 * - Perplexity AI
 * - Groq
 *
 * Usage:
 *   new GenericOpenAIProvider({
 *     baseUrl: 'https://groq-api.example.com/v1',
 *     apiKey: 'your-key',
 *     providerName: 'groq',
 *   })
 */

import type { ModelProvider, ModelRequest, ModelResponse, StreamChunk } from '../index';
import { calculateCost } from '../pricing';

export class GenericOpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly supportedModels: string[];

  private apiKey: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(options: {
    providerName: string;
    baseUrl: string;
    apiKey?: string;
    supportedModels?: string[];
    extraHeaders?: Record<string, string>;
  }) {
    this.name = options.providerName;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? '';
    this.supportedModels = options.supportedModels ?? [];
    this.extraHeaders = options.extraHeaders ?? {};
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stop,
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      model?: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error(`${this.name} returned no choices`);

    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      provider: this.name,
      model: data.model ?? request.model,
      content: choice.message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      costUsd: calculateCost(data.model ?? request.model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true }),
    });

    if (!res.ok) throw new Error(`${this.name} stream error ${res.status}`);
    if (!res.body) throw new Error(`${this.name} stream: no body`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { yield { content: '', done: true }; return; }
        try {
          const chunk = JSON.parse(raw);
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { content: delta, done: false };
        } catch {
          // skip
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.buildHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }
}
