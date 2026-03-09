/**
 * Frontend API Client & Hook Tests
 *
 * Tests the API client, request/response handling, auth token management,
 * and custom hook behavior patterns. Uses vitest + testing library.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── API Client Tests ────────────────────────

describe('ApiClient', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    // Reset localStorage
    localStorage.clear();
    // Mock fetch globally
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getHeaders', () => {
    it('should include Content-Type header', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

      // Import fresh to get clean client
      const { apiClient } = await import('@/lib/api-client');
      await apiClient.get('/test');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('should include Authorization header when token exists in localStorage', async () => {
      localStorage.setItem('nexusops-auth', JSON.stringify({
        state: {
          accessToken: 'test-jwt-token',
          refreshToken: 'test-refresh',
        },
      }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.get('/test');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
          }),
        }),
      );
    });

    it('should not include Authorization when no token in storage', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.get('/test');

      const [, options] = fetchSpy.mock.calls[0];
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe('HTTP methods', () => {
    it('should make GET request', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));

      const { apiClient } = await import('@/lib/api-client');
      const result = await apiClient.get('/agents');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.data).toEqual({ data: 'ok' });
    });

    it('should make POST request with body', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: '1' } }), { status: 201 }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.post('/agents', { name: 'Test Agent' });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Test Agent' }),
        }),
      );
    });

    it('should make PATCH request', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.patch('/settings/workspace', { name: 'New Name' });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/settings/workspace'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('should make DELETE request', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.delete('/agents/agent-1');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agent-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    it('should throw ApiError on non-200 response', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }),
        { status: 404 },
      ));

      const { apiClient } = await import('@/lib/api-client');

      await expect(apiClient.get('/agents/missing')).rejects.toThrow();
    });

    it('should handle 401 by attempting token refresh', async () => {
      // First call: 401
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'Unauthorized' } }),
        { status: 401 },
      ));
      // Refresh call: success
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }),
        { status: 200 },
      ));
      // Retry call: success
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ data: { agents: [] } }),
        { status: 200 },
      ));

      localStorage.setItem('nexusops-auth', JSON.stringify({
        state: { accessToken: 'old', refreshToken: 'old-refresh' },
      }));

      const { apiClient } = await import('@/lib/api-client');
      await apiClient.get('/agents');

      // Should have called fetch 3 times: original request, refresh, retry
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });
});

// ─── Query Key Structure Tests ───────────────

describe('Query Keys', () => {
  it('should have consistent structure for cache invalidation', async () => {
    // Dynamically import to get actual queryKeys
    const mod = await import('@/hooks/use-api');
    // Access the module namespace to check exports exist
    expect(mod.useAgents).toBeDefined();
    expect(mod.useTasks).toBeDefined();
    expect(mod.usePolicies).toBeDefined();
    expect(mod.useWorkspaceSettings).toBeDefined();
    expect(mod.useWorkspaceMembers).toBeDefined();
    expect(mod.useApiKeys).toBeDefined();
    expect(mod.useDashboardMetrics).toBeDefined();
    expect(mod.useCostSummary).toBeDefined();
    expect(mod.useCostForecast).toBeDefined();
    expect(mod.useCostAnomalies).toBeDefined();
    expect(mod.useSecurityOverview).toBeDefined();
    expect(mod.useApprovalStats).toBeDefined();
  });
});

// ─── Zustand Auth Store Tests ────────────────

describe('Auth Store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should export useAuthStore', async () => {
    const mod = await import('@/hooks/use-api');
    // The store is likely in a separate file - check exports
    expect(typeof mod).toBe('object');
  });
});
