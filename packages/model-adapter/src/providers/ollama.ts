/**
 * Ollama Provider — any locally running model via Ollama
 *
 * Requires Ollama running at OLLAMA_BASE_URL (default: http://localhost:11434).
 * No API key required — local only.
 */

import type { ModelProvider, ModelRequest, ModelResponse, StreamChunk } from '../index';

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly supportedModels: string[] = []; // dynamic — any model pulled in Ollama

  private baseUrl: string;

  constructor(options?: { baseUrl?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        options: {
          num_predict: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.7,
          stop: request.stop ?? [],
        },
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      model: string;
      message: { role: string; content: string };
      done_reason: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      provider: 'ollama',
      model: data.model,
      content: data.message.content,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      costUsd: 0, // local model — no API cost
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!res.ok) throw new Error(`Ollama stream error ${res.status}`);
    if (!res.body) throw new Error('Ollama stream: no body');

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
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            yield { content: chunk.message.content, done: false };
          }
          if (chunk.done) {
            yield { content: '', done: true };
            return;
          }
        } catch {
          // skip
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
