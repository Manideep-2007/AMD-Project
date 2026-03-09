/**
 * API Client — Axios-based HTTP client with JWT auth and auto-refresh.
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Get token from persisted store
    try {
      const stored = localStorage.getItem('nexusops-auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.state?.accessToken) {
          headers['Authorization'] = `Bearer ${parsed.state.accessToken}`;
        }
      }
    } catch {
      // Ignore parse errors
    }

    return headers;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<{ data: T }> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getHeaders();

    const response = await fetch(url, {
      method,
      headers,
      // Include credentials so httpOnly refresh-token cookie is sent on every request
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      // Try to refresh via httpOnly cookie (no token body needed)
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        // Retry the request with new access token
        const retryHeaders = this.getHeaders();
        const retryResponse = await fetch(url, {
          method,
          headers: retryHeaders,
          credentials: 'include',
          body: body ? JSON.stringify(body) : undefined,
        });
        const retryData = await retryResponse.json();
        if (!retryResponse.ok) throw new ApiError(retryData, retryResponse.status);
        return { data: retryData };
      }

      // Refresh failed — throw so callers can handle gracefully.
      // Never hard-redirect here; let the router/auth-store handle it.
      throw new ApiError({ error: { message: 'Unauthorized' } }, 401);
    }

    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(data, response.status);
    }

    return { data };
  }

  /**
   * POST with explicit credentials:include — used for token refresh.
   * The httpOnly cookie is sent automatically by the browser.
   */
  async postWithCredentials<T = any>(path: string, body?: unknown): Promise<{ data: T }> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getHeaders();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();
    if (!response.ok) throw new ApiError(data, response.status);
    return { data };
  }

  private async tryRefresh(): Promise<boolean> {
    try {
      // Rely solely on the httpOnly cookie — no token body.
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });

      if (!response.ok) return false;

      const data = await response.json();
      // Update only the accessToken in localStorage (never the refreshToken)
      const stored = localStorage.getItem('nexusops-auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        parsed.state.accessToken = data.data.accessToken;
        localStorage.setItem('nexusops-auth', JSON.stringify(parsed));
      }

      return true;
    } catch {
      return false;
    }
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }

  put<T = any>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body);
  }

  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(data: any, status: number) {
    super(data?.error?.message || 'API Error');
    this.status = status;
    this.code = data?.error?.code;
    this.details = data?.error?.details;
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
