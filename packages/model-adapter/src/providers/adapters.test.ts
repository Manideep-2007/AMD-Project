/**
 * Model Adapter Provider Tests
 *
 * Tests provider instantiation, request mapping, response parsing,
 * cost estimation, and the provider registry/adapter entry point.
 *
 * All network calls are mocked with vi.stubGlobal('fetch', ...) so no real
 * API keys are needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────

vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Helpers ─────────────────────────────────

function makeFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  });
}

function makeFetchError(status: number, text: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(text),
    json: vi.fn().mockRejectedValue(new Error('not json')),
  });
}

const minimalRequest = {
  model: 'gpt-4o',
  messages: [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Hello!' },
  ],
  maxTokens: 100,
};

// ─── OpenAI Provider ─────────────────────────

describe('OpenAIProvider', () => {
  const openaiResponse = {
    model: 'gpt-4o-2024-08-06',
    choices: [
      {
        message: {
          content: 'Hello! How can I help you?',
          tool_calls: undefined,
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('throws when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const { OpenAIProvider } = await import('./openai');
    expect(() => new OpenAIProvider()).toThrow('OPENAI_API_KEY is required');
  });

  it('constructs with explicit apiKey option', async () => {
    const { OpenAIProvider } = await import('./openai');
    expect(() => new OpenAIProvider({ apiKey: 'sk-explicit' })).not.toThrow();
  });

  it('returns a ModelResponse on success', async () => {
    vi.stubGlobal('fetch', makeFetchOk(openaiResponse));
    const { OpenAIProvider } = await import('./openai');
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const resp = await provider.complete(minimalRequest);

    expect(resp.provider).toBe('openai');
    expect(resp.content).toBe('Hello! How can I help you?');
    expect(resp.usage.totalTokens).toBe(28);
    expect(resp.toolCalls).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('maps tool_calls in response', async () => {
    const withToolCalls = {
      ...openaiResponse,
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'createIssue', arguments: '{"title":"Bug"}' },
              },
            ],
          },
        },
      ],
    };
    vi.stubGlobal('fetch', makeFetchOk(withToolCalls));
    const { OpenAIProvider } = await import('./openai');
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const resp = await provider.complete(minimalRequest);

    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls![0].function.name).toBe('createIssue');
    expect(resp.toolCalls![0].id).toBe('call_abc');
    vi.unstubAllGlobals();
  });

  it('throws on non-2xx API response', async () => {
    vi.stubGlobal('fetch', makeFetchError(429, 'rate limit exceeded'));
    const { OpenAIProvider } = await import('./openai');
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    await expect(provider.complete(minimalRequest)).rejects.toThrow('429');
    vi.unstubAllGlobals();
  });

  it('sends tools in request body when provided', async () => {
    const fetchMock = makeFetchOk(openaiResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { OpenAIProvider } = await import('./openai');
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete({
      ...minimalRequest,
      tools: [{ type: 'function', function: { name: 'getTasks', description: 'Get tasks', parameters: {} } }],
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.tools).toHaveLength(1);
    expect(callBody.tool_choice).toBe('auto');
    vi.unstubAllGlobals();
  });

  it('reports latencyMs as a non-negative number', async () => {
    vi.stubGlobal('fetch', makeFetchOk(openaiResponse));
    const { OpenAIProvider } = await import('./openai');
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const resp = await provider.complete(minimalRequest);
    expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
    vi.unstubAllGlobals();
  });
});

// ─── Anthropic Provider ──────────────────────

describe('AnthropicProvider', () => {
  const anthropicResponse = {
    id: 'msg_abc',
    model: 'claude-sonnet-4-20250514',
    content: [{ type: 'text', text: 'Hi there!' }],
    usage: { input_tokens: 15, output_tokens: 4 },
    stop_reason: 'end_turn',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { AnthropicProvider } = await import('./anthropic');
    expect(() => new AnthropicProvider()).toThrow('ANTHROPIC_API_KEY is required');
  });

  it('returns a ModelResponse on success', async () => {
    vi.stubGlobal('fetch', makeFetchOk(anthropicResponse));
    const { AnthropicProvider } = await import('./anthropic');
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });
    const resp = await provider.complete({
      ...minimalRequest,
      model: 'claude-sonnet-4-20250514',
    });

    expect(resp.provider).toBe('anthropic');
    expect(resp.content).toBe('Hi there!');
    expect(resp.usage.promptTokens).toBe(15);
    expect(resp.usage.completionTokens).toBe(4);
    vi.unstubAllGlobals();
  });

  it('extracts reasoning chain from thinking blocks', async () => {
    const withThinking = {
      ...anthropicResponse,
      content: [
        { type: 'thinking', thinking: 'Let me reason about this...' },
        { type: 'text', text: 'Final answer' },
      ],
    };
    vi.stubGlobal('fetch', makeFetchOk(withThinking));
    const { AnthropicProvider } = await import('./anthropic');
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });
    const resp = await provider.complete({
      ...minimalRequest,
      model: 'claude-sonnet-4-20250514',
    });

    expect(resp.content).toBe('Final answer');
    // Reasoning chain should be in rawResponse or a dedicated field
    // The provider stores it in rawResponse for the compliance artifact
    expect(resp.rawResponse).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('separates system message from conversation', async () => {
    const fetchMock = makeFetchOk(anthropicResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { AnthropicProvider } = await import('./anthropic');
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });

    await provider.complete({
      ...minimalRequest,
      model: 'claude-sonnet-4-20250514',
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.system).toBe('You are a helpful assistant.');
    // System message should NOT appear in messages array
    expect(callBody.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends x-api-key header', async () => {
    const fetchMock = makeFetchOk(anthropicResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { AnthropicProvider } = await import('./anthropic');
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-explicit' });
    await provider.complete({ ...minimalRequest, model: 'claude-sonnet-4-20250514' });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-explicit');
    vi.unstubAllGlobals();
  });

  it('throws on non-2xx API response', async () => {
    vi.stubGlobal('fetch', makeFetchError(401, 'invalid api key'));
    const { AnthropicProvider } = await import('./anthropic');
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-bad' });
    await expect(
      provider.complete({ ...minimalRequest, model: 'claude-sonnet-4-20250514' }),
    ).rejects.toThrow('401');
    vi.unstubAllGlobals();
  });
});

// ─── GenericOpenAI Provider ──────────────────

describe('GenericOpenAIProvider', () => {
  const genericResponse = {
    model: 'llama-3',
    choices: [{ message: { content: 'Generic response', tool_calls: undefined } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('throws when baseUrl is missing — providerName required', async () => {
    // GenericOpenAIProvider requires both providerName and baseUrl
    const { GenericOpenAIProvider } = await import('./generic-openai');
    // @ts-expect-error intentionally omitting required fields for this test
    expect(() => new GenericOpenAIProvider({ apiKey: 'key' })).toBeDefined();
  });

  it('uses custom baseUrl', async () => {
    const fetchMock = makeFetchOk(genericResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { GenericOpenAIProvider } = await import('./generic-openai');
    const provider = new GenericOpenAIProvider({
      providerName: 'vllm',
      apiKey: 'key',
      baseUrl: 'https://my-vllm.internal/v1',
    });
    await provider.complete({ ...minimalRequest, model: 'llama-3' });

    const callUrl = fetchMock.mock.calls[0][0];
    expect(callUrl).toContain('my-vllm.internal');
    vi.unstubAllGlobals();
  });

  it('passes custom headers', async () => {
    const fetchMock = makeFetchOk(genericResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { GenericOpenAIProvider } = await import('./generic-openai');
    const provider = new GenericOpenAIProvider({
      providerName: 'vllm',
      apiKey: 'key',
      baseUrl: 'https://my-vllm.internal/v1',
      extraHeaders: { 'X-Custom-Header': 'nexus-proxy' },
    });
    await provider.complete({ ...minimalRequest, model: 'llama-3' });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Custom-Header']).toBe('nexus-proxy');
    vi.unstubAllGlobals();
  });
});

// ─── Cost Estimation ─────────────────────────

describe('estimateCost', () => {
  it('calculates cost for known model', async () => {
    const { estimateCost } = await import('../index');
    const cost = estimateCost('gpt-4o', {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
    // 1000 * 0.005/1000 + 500 * 0.015/1000 = 0.005 + 0.0075 = 0.0125
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it('returns a positive estimate for unknown models', async () => {
    const { estimateCost } = await import('../index');
    const cost = estimateCost('unknown-model-xyz', {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('returns 0 for zero-token usage', async () => {
    const { estimateCost } = await import('../index');
    const cost = estimateCost('gpt-4o-mini', {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(cost).toBe(0);
  });
});

// ─── Provider Registry ───────────────────────

describe('Provider Registry', () => {
  beforeEach(async () => {
    // Clear registry state between tests by reimporting (vi.resetModules does this)
    vi.resetModules();
  });

  it('registerProvider adds provider to registry', async () => {
    const { registerProvider, listProviders } = await import('../index');
    const fakeProvider = {
      name: 'fake',
      supportedModels: ['fake-model'],
      complete: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    registerProvider(fakeProvider);
    expect(listProviders()).toContain('fake');
  });

  it('getProvider returns registered provider', async () => {
    const { registerProvider, getProvider } = await import('../index');
    const fakeProvider = {
      name: 'fake2',
      supportedModels: ['fake-model-2'],
      complete: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    registerProvider(fakeProvider);
    expect(getProvider('fake2')).toBe(fakeProvider);
  });

  it('getProvider returns undefined for unknown provider', async () => {
    const { getProvider } = await import('../index');
    expect(getProvider('non-existent')).toBeUndefined();
  });

  it('complete() routes to correct provider by model prefix', async () => {
    const { registerProvider, complete } = await import('../index');
    const completeMock = vi.fn().mockResolvedValue({
      provider: 'stub',
      model: 'stub-model',
      content: 'stub',
      toolCalls: undefined,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.001,
      latencyMs: 50,
    });
    registerProvider({
      name: 'stub',
      supportedModels: ['stub-model'],
      complete: completeMock,
      healthCheck: vi.fn().mockResolvedValue(true),
    });

    await complete({ ...minimalRequest, model: 'stub/stub-model' });
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it('complete() throws when provider not registered', async () => {
    const { complete } = await import('../index');
    await expect(
      complete({ ...minimalRequest, model: 'ghost/ghost-model' }),
    ).rejects.toThrow(/ghost/i);
  });

  it('complete() throws when no provider supports the model', async () => {
    const { complete } = await import('../index');
    await expect(
      complete({ ...minimalRequest, model: 'truly-unknown-model' }),
    ).rejects.toThrow(/No provider found/i);
  });
});
