/**
 * Google Gemini Provider — Gemini 2.0 Flash, 2.0 Pro
 * Uses Google AI Studio API (Generative Language API).
 * Set GOOGLE_AI_API_KEY in environment.
 */

import type { ModelProvider, ModelRequest, ModelResponse, StreamChunk } from '../index';
import { calculateCost } from '../pricing';

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly supportedModels = [
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

  private apiKey: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env.GOOGLE_AI_API_KEY ?? '';
    this.baseUrl = options?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    if (!this.apiKey) {
      throw new Error('GeminiProvider: GOOGLE_AI_API_KEY is required');
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();

    const systemInstruction = request.messages.find((m) => m.role === 'system');
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 1,
        stopSequences: request.stop ?? [],
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    }

    const url = `${this.baseUrl}/models/${request.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }>; role: string };
        finishReason: string;
      }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };

    const candidate = data.candidates[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

    const content = candidate.content.parts.map((p) => p.text ?? '').join('');

    const usage = {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      provider: 'gemini',
      model: request.model,
      content,
      usage,
      costUsd: calculateCost(request.model, usage.promptTokens, usage.completionTokens),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const body = {
      contents: request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      generationConfig: { maxOutputTokens: request.maxTokens ?? 4096 },
    };

    const url = `${this.baseUrl}/models/${request.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Gemini stream error ${res.status}`);
    if (!res.body) throw new Error('Gemini stream: no body');

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
          const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield { content: text, done: false };
        } catch {
          // skip malformed
        }
      }
    }
    yield { content: '', done: true };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'x-goog-api-key': this.apiKey },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
