/**
 * OpenAI Model Provider — GPT-4o, GPT-4o-mini, o1, o3, gpt-3.5-turbo
 *
 * Uses the official OpenAI REST API.
 * Set OPENAI_API_KEY in environment.
 */

import type { ModelProvider, ModelRequest, ModelResponse } from '../index';
import { calculateCost } from '../pricing';

export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  readonly supportedModels = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
    'o1',
    'o1-mini',
    'o3',
    'o3-mini',
  ];

  private apiKey: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = options?.baseUrl ?? 'https://api.openai.com/v1';
    if (!this.apiKey) {
      throw new Error('OpenAIProvider: OPENAI_API_KEY is required');
    }
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      model: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');

    const content = choice.message.content ?? '';
    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    const usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    return {
      provider: 'openai',
      model: data.model,
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage,
      costUsd: calculateCost(data.model, usage.promptTokens, usage.completionTokens),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest) {
    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`OpenAI stream error ${res.status}`);
    if (!res.body) throw new Error('OpenAI stream: no body');

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
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { content: '', done: true };
          return;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { content: delta, done: false };
        } catch {
          // skip malformed chunks
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
