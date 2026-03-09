/**
 * AWS Bedrock Provider — Claude, Titan, Llama, Mistral on Bedrock
 *
 * Uses the AWS Bedrock Runtime API.
 * Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 * Or runs with IAM role credentials automatically.
 *
 * Note: This provider makes raw HTTP requests signed with AWS SigV4.
 * No AWS SDK dependency — keeps the package lightweight.
 */

import { createHmac, createHash } from 'crypto';
import type { ModelProvider, ModelRequest, ModelResponse } from '../index';
import { calculateCost } from '../pricing';

// AWS SigV4 signing (minimal implementation — no sdk dependency)
function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function getSigningKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function signRequest(
  method: string,
  host: string,
  path: string,
  payload: string,
  accessKey: string,
  secretKey: string,
  region: string,
  service = 'bedrock',
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [`AWS4-HMAC-SHA256`, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    'Content-Type': 'application/json',
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class BedrockProvider implements ModelProvider {
  readonly name = 'bedrock';
  readonly supportedModels = [
    'anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic.claude-instant-v1',
    'amazon.titan-text-express-v1',
    'meta.llama3-8b-instruct-v1:0',
    'meta.llama3-70b-instruct-v1:0',
    'mistral.mistral-large-2402-v1:0',
  ];

  private accessKey: string;
  private secretKey: string;
  private region: string;
  private sessionToken?: string;

  constructor(options?: {
    accessKey?: string;
    secretKey?: string;
    region?: string;
    sessionToken?: string;
  }) {
    this.accessKey = options?.accessKey ?? process.env.AWS_ACCESS_KEY_ID ?? '';
    this.secretKey = options?.secretKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '';
    this.region = options?.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.sessionToken = options?.sessionToken ?? process.env.AWS_SESSION_TOKEN;

    if (!this.accessKey || !this.secretKey) {
      throw new Error('BedrockProvider: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required');
    }
  }

  private buildBedrockPayload(modelId: string, request: ModelRequest): Record<string, unknown> {
    if (modelId.startsWith('anthropic.')) {
      const systemMsg = request.messages.find((m) => m.role === 'system');
      return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: request.maxTokens ?? 4096,
        messages: request.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
        ...(systemMsg ? { system: systemMsg.content } : {}),
      };
    }

    if (modelId.startsWith('amazon.titan-')) {
      return {
        inputText: request.messages.map((m) => m.content).join('\n'),
        textGenerationConfig: {
          maxTokenCount: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.7,
        },
      };
    }

    if (modelId.startsWith('meta.llama')) {
      return {
        prompt: request.messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:',
        max_gen_len: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      };
    }

    if (modelId.startsWith('mistral.')) {
      return {
        prompt: request.messages.map((m) => m.content).join('\n'),
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      };
    }

    throw new Error(`Unsupported Bedrock model: ${modelId}`);
  }

  private parseBedrockResponse(modelId: string, data: unknown): { content: string; promptTokens: number; completionTokens: number } {
    const d = data as Record<string, unknown>;

    if (modelId.startsWith('anthropic.')) {
      const content = (d.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const usage = d.usage as { input_tokens: number; output_tokens: number };
      return { content, promptTokens: usage?.input_tokens ?? 0, completionTokens: usage?.output_tokens ?? 0 };
    }

    if (modelId.startsWith('amazon.titan-')) {
      const results = d.results as Array<{ outputText: string; tokenCount: number }>;
      const text = results?.[0]?.outputText ?? '';
      return { content: text, promptTokens: 0, completionTokens: results?.[0]?.tokenCount ?? 0 };
    }

    if (modelId.startsWith('meta.llama')) {
      return { content: (d.generation as string) ?? '', promptTokens: d.prompt_token_count as number ?? 0, completionTokens: d.generation_token_count as number ?? 0 };
    }

    if (modelId.startsWith('mistral.')) {
      const outputs = d.outputs as Array<{ text: string }>;
      return { content: outputs?.[0]?.text ?? '', promptTokens: 0, completionTokens: 0 };
    }

    return { content: JSON.stringify(d), promptTokens: 0, completionTokens: 0 };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startMs = Date.now();
    const modelId = encodeURIComponent(request.model);
    const path = `/model/${modelId}/invoke`;
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;

    const payload = JSON.stringify(this.buildBedrockPayload(request.model, request));
    const headers = signRequest('POST', host, path, payload, this.accessKey, this.secretKey, this.region, 'bedrock');

    if (this.sessionToken) {
      (headers as Record<string, string>)['x-amz-security-token'] = this.sessionToken;
    }

    const res = await fetch(`https://${host}${path}`, {
      method: 'POST',
      headers,
      body: payload,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Bedrock API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const parsed = this.parseBedrockResponse(request.model, data);

    return {
      provider: 'bedrock',
      model: request.model,
      content: parsed.content,
      usage: {
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        totalTokens: parsed.promptTokens + parsed.completionTokens,
      },
      costUsd: calculateCost(request.model, parsed.promptTokens, parsed.completionTokens),
      latencyMs: Date.now() - startMs,
      rawResponse: data,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const host = `bedrock.${this.region}.amazonaws.com`;
      const path = '/foundation-models';
      const headers = signRequest('GET', host, path, '', this.accessKey, this.secretKey, this.region, 'bedrock');
      const res = await fetch(`https://${host}${path}`, { headers });
      return res.ok;
    } catch {
      return false;
    }
  }
}
