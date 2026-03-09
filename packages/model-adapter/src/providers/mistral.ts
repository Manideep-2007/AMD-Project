/**
 * Mistral AI Provider — Mistral Large, Medium, Small, Codestral
 * Uses the Mistral AI API.
 * Set MISTRAL_API_KEY in environment.
 */

import type { ModelProvider, ModelRequest, ModelResponse, StreamChunk } from '../index';
import { calculateCost } from '../pricing';

export class MistralProvider implements ModelProvider {
  readonly name = 'mistral';
  readonly supportedModels = [
    'mistral-large-latest',
    'mistral-medium-latest',
    'mistral-small-latest',
    'codestral-latest',
    'open-mistral-7b',
    'open-mixtral-8x7b',
  ];

  private apiKey: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env.MISTRAL_API_KEY ?? '';
    this.baseUrl = options?.baseUrl ?? 'https://api.mistral.ai/v1';
    if (!this.apiKey) {
      throw new Error('MistralProvider: MISTRAL_API_KEY is required');
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Mistral API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      model: string;
      choices: Array<{
        message: {
          content: string;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error('Mistral returned no choices');

    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      provider: 'mistral',
      model: data.model,
      content: choice.message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      costUsd: calculateCost(data.model, data.usage.prompt_tokens, data.usage.completion_tokens),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true }),
    });

    if (!res.ok) throw new Error(`Mistral stream error ${res.status}`);
    if (!res.body) throw new Error('Mistral stream: no body');

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
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
