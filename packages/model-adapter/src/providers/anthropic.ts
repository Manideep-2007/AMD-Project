/**
 * Anthropic Model Provider — Claude Sonnet 4.6, Haiku 4.5, Opus 4
 *
 * Uses the Anthropic Messages API v1.
 * Set ANTHROPIC_API_KEY in environment.
 *
 * Extracts chain-of-thought reasoning from text blocks in tool-use responses
 * per the Evidence Vault specification.
 */

import type { ModelProvider, ModelRequest, ModelResponse, StreamChunk } from '../index';
import { calculateCost } from '../pricing';

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly supportedModels = [
    'claude-sonnet-4-20250514',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-haiku-20240307',
    'claude-3-sonnet-20240229',
  ];

  private apiKey: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.baseUrl = options?.baseUrl ?? 'https://api.anthropic.com';
    if (!this.apiKey) {
      throw new Error('AnthropicProvider: ANTHROPIC_API_KEY is required');
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();

    // Anthropic separates system from messages
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const conversationMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      messages: conversationMessages,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      id: string;
      model: string;
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      >;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    // Extract text blocks — these contain chain-of-thought for tool-use responses
    const textContent = data.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    // Extract tool calls from tool_use blocks
    const toolCalls = data.content
      .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }));

    const usage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };

    return {
      provider: 'anthropic',
      model: data.model,
      content: textContent,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage,
      costUsd: calculateCost(data.model, usage.promptTokens, usage.completionTokens),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const conversationMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      messages: conversationMessages,
      stream: true,
    };

    if (systemMessage) body.system = systemMessage.content;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Anthropic stream error ${res.status}`);
    if (!res.body) throw new Error('Anthropic stream: no body');

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
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield { content: event.delta.text, done: false };
          }
          if (event.type === 'message_stop') {
            yield { content: '', done: true };
            return;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return res.status !== 401;
    } catch {
      return false;
    }
  }
}
