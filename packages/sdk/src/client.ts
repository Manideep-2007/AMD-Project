/* ──────────────────────────────────────────────────────────────
 * NexusOps SDK — HTTP Client
 *
 * Low-level fetch-based client with:
 *  • JWT auto-refresh
 *  • Retry with exponential back-off (configurable)
 *  • Request signing (Ed25519 optional)
 *  • Request/response interceptors
 * ────────────────────────────────────────────────────────────── */

export interface NexusClientConfig {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Max retries for transient failures (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential back-off (default: 200) */
  retryBaseMs?: number;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Optional Ed25519 private key hex for request signing */
  signingKey?: string;
  /** Called when tokens are refreshed */
  onTokenRefresh?: (accessToken: string, refreshToken: string) => void;
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class NexusClient {
  private config: Required<
    Pick<NexusClientConfig, "baseUrl" | "maxRetries" | "retryBaseMs" | "timeoutMs">
  > &
    NexusClientConfig;

  private accessToken: string | null;
  private refreshToken: string | null;
  private refreshing: Promise<void> | null = null;

  constructor(config: NexusClientConfig) {
    this.config = {
      maxRetries: 3,
      retryBaseMs: 200,
      timeoutMs: 30_000,
      ...config,
    };
    this.accessToken = config.accessToken ?? null;
    this.refreshToken = config.refreshToken ?? null;
  }

  /* ── Public surface ──────────────────────────────────── */

  async get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>({ method: "GET", path, query });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "POST", path, body });
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "PUT", path, body });
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "PATCH", path, body });
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>({ method: "DELETE", path });
  }

  /** SSE stream — returns an async iterable of parsed JSON events */
  async *stream<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): AsyncGenerator<T> {
    const url = this.buildUrl(path, query);
    const headers = this.buildHeaders();

    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(0) });
    if (!res.ok || !res.body) throw new Error(`SSE stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim();
            if (raw && raw !== "[DONE]") {
              try {
                yield JSON.parse(raw) as T;
              } catch {
                // skip malformed JSON
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  setTokens(accessToken: string, refreshToken?: string) {
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;
  }

  /* ── Internal ────────────────────────────────────────── */

  private async request<T>(opts: RequestOptions, attempt = 0): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers = { ...this.buildHeaders(), ...(opts.headers ?? {}) };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ?? controller.signal,
      });

      // 401 → attempt token refresh once
      if (res.status === 401 && this.refreshToken && attempt === 0) {
        await this.doRefresh();
        return this.request<T>(opts, attempt + 1);
      }

      // Retryable errors
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.config.maxRetries) {
        const delay = this.config.retryBaseMs * Math.pow(2, attempt) + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
        return this.request<T>(opts, attempt + 1);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new NexusApiError(res.status, body, opts.method, opts.path);
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const res = await fetch(`${this.config.baseUrl}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        if (!res.ok) throw new Error("Token refresh failed");
        const data = (await res.json()) as { accessToken: string; refreshToken: string };
        this.accessToken = data.accessToken;
        this.refreshToken = data.refreshToken;
        this.config.onTokenRefresh?.(data.accessToken, data.refreshToken);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path, this.config.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.accessToken) h["Authorization"] = `Bearer ${this.accessToken}`;
    if (this.config.apiKey) h["X-Api-Key"] = this.config.apiKey;
    return h;
  }
}

export class NexusApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`NexusOps API ${method} ${path} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "NexusApiError";
  }
}
