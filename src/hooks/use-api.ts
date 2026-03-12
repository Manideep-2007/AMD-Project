/**
 * TanStack Query hooks for NexusOps API.
 * Every page uses these hooks instead of direct API calls.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

// ─── Key factories ───────────────────────────
export const queryKeys = {
  agents: {
    all: ['agents'] as const,
    list: (params?: Record<string, unknown>) => ['agents', 'list', params] as const,
    detail: (id: string) => ['agents', 'detail', id] as const,
    blastRadius: (id: string) => ['agents', 'blastRadius', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (params?: Record<string, unknown>) => ['tasks', 'list', params] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
  },
  policies: {
    all: ['policies'] as const,
    list: (params?: Record<string, unknown>) => ['policies', 'list', params] as const,
  },
  tools: {
    all: ['tools'] as const,
    list: (params?: Record<string, unknown>) => ['tools', 'list', params] as const,
  },
  audit: {
    all: ['audit'] as const,
    list: (params?: Record<string, unknown>) => ['audit', 'list', params] as const,
  },
  metrics: {
    all: ['metrics'] as const,
    dashboard: ['metrics', 'dashboard'] as const,
  },
  approvals: {
    all: ['approvals'] as const,
    list: (params?: Record<string, unknown>) => ['approvals', 'list', params] as const,
    stats: ['approvals', 'stats'] as const,
  },
  budgets: {
    all: ['budgets'] as const,
    list: (params?: Record<string, unknown>) => ['budgets', 'list', params] as const,
    summary: ['budgets', 'summary'] as const,
  },
  security: {
    overview: ['security', 'overview'] as const,
    auditChain: ['security', 'auditChain'] as const,
    complianceChain: ['security', 'complianceChain'] as const,
    artifacts: (params?: Record<string, unknown>) => ['security', 'artifacts', params] as const,
  },
  costs: {
    all: ['costs'] as const,
    list: (params?: Record<string, unknown>) => ['costs', 'list', params] as const,
    summary: (period?: string) => ['costs', 'summary', period] as const,
    forecast: ['costs', 'forecast'] as const,
    attribution: (params?: Record<string, unknown>) => ['costs', 'attribution', params] as const,
    anomalies: ['costs', 'anomalies'] as const,
  },
  settings: {
    workspace: ['settings', 'workspace'] as const,
    members: ['settings', 'members'] as const,
    apiKeys: ['settings', 'apiKeys'] as const,
    integrations: ['settings', 'integrations'] as const,
    onboarding: ['settings', 'onboarding'] as const,
  },
};

// ─── Agents ──────────────────────────────────

export function useAgents(params?: { page?: number; limit?: number; status?: string }) {
  return useQuery({
    queryKey: queryKeys.agents.list(params),
    queryFn: () => apiClient.get(`/agents?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: queryKeys.agents.detail(id),
    queryFn: () => apiClient.get(`/agents/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useAgentBlastRadius(id: string) {
  return useQuery({
    queryKey: queryKeys.agents.blastRadius(id),
    queryFn: () => apiClient.get(`/budgets/blast-radius/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.post('/agents', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.agents.all }),
  });
}

export function useEmergencyStopAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => apiClient.post(`/agents/${agentId}/emergency-stop`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all });
    },
  });
}

// ─── Tasks ───────────────────────────────────

export function useTasks(params?: { page?: number; limit?: number; status?: string; agentId?: string }) {
  return useQuery({
    queryKey: queryKeys.tasks.list(params),
    queryFn: () => apiClient.get(`/tasks?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id),
    queryFn: () => apiClient.get(`/tasks/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.post('/tasks', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.all }),
  });
}

// ─── Policies ────────────────────────────────

export function usePolicies(params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.policies.list(params),
    queryFn: () => apiClient.get(`/policies?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useCreatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.post('/policies', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.policies.all }),
  });
}

// ─── Tools ───────────────────────────────────

export function useToolCalls(params?: { page?: number; limit?: number; toolType?: string }) {
  return useQuery({
    queryKey: queryKeys.tools.list(params),
    queryFn: () => apiClient.get(`/tools?${toQuery(params)}`).then((r) => r.data),
  });
}

// ─── Audit ───────────────────────────────────

export function useAuditEvents(params?: { page?: number; limit?: number; eventType?: string; agentId?: string }) {
  return useQuery({
    queryKey: queryKeys.audit.list(params),
    queryFn: () => apiClient.get(`/audit?${toQuery(params)}`).then((r) => r.data),
  });
}

// ─── Metrics ─────────────────────────────────

export function useDashboardMetrics() {
  return useQuery({
    queryKey: queryKeys.metrics.dashboard,
    queryFn: () => apiClient.get('/metrics/dashboard').then((r) => r.data),
    refetchInterval: 30_000, // Refresh every 30s
  });
}

// ─── Approvals ───────────────────────────────

export function useApprovals(params?: { page?: number; limit?: number; pending?: string }) {
  return useQuery({
    queryKey: queryKeys.approvals.list(params),
    queryFn: () => apiClient.get(`/approvals?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useApprovalStats() {
  return useQuery({
    queryKey: queryKeys.approvals.stats,
    queryFn: () => apiClient.get('/approvals/stats').then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; approved: boolean; reason?: string }) =>
      apiClient.post(`/approvals/${id}/decide`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

// ─── Budgets ─────────────────────────────────

export function useBudgets(params?: { agentId?: string }) {
  return useQuery({
    queryKey: queryKeys.budgets.list(params),
    queryFn: () => apiClient.get(`/budgets?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useBudgetSummary() {
  return useQuery({
    queryKey: queryKeys.budgets.summary,
    queryFn: () => apiClient.get('/budgets/summary').then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCreateBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.post('/budgets', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.budgets.all }),
  });
}

// ─── Security ────────────────────────────────

export function useSecurityOverview() {
  return useQuery({
    queryKey: queryKeys.security.overview,
    queryFn: () => apiClient.get('/security/overview').then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useAuditChainVerification() {
  return useQuery({
    queryKey: queryKeys.security.auditChain,
    queryFn: () => apiClient.get('/security/chain/audit').then((r) => r.data),
  });
}

export function useAuditChainNodes(limit = 15) {
  return useQuery({
    queryKey: ['security', 'chain', 'nodes', limit],
    queryFn: () => apiClient.get(`/security/chain/nodes?limit=${limit}`).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useComplianceArtifacts(params?: { page?: number; limit?: number; taskId?: string }) {
  return useQuery({
    queryKey: queryKeys.security.artifacts(params),
    queryFn: () => apiClient.get(`/security/compliance-artifacts?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useScanText() {
  return useMutation({
    mutationFn: (data: { text: string; strict?: boolean }) =>
      apiClient.post('/security/scan', data),
  });
}

// ─── Utils ───────────────────────────────────

function toQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// ─── Costs ───────────────────────────────────

export function useCostEvents(params?: { page?: number; limit?: number; agentId?: string; provider?: string }) {
  return useQuery({
    queryKey: queryKeys.costs.list(params),
    queryFn: () => apiClient.get(`/costs?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useCostSummary(period?: string) {
  return useQuery({
    queryKey: queryKeys.costs.summary(period),
    queryFn: () => apiClient.get(`/costs/summary?period=${period || 'today'}`).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCostForecast() {
  return useQuery({
    queryKey: queryKeys.costs.forecast,
    queryFn: () => apiClient.get('/costs/forecast').then((r) => r.data),
  });
}

export function useCostAttribution(params?: { groupBy?: string; from?: string; to?: string }) {
  return useQuery({
    queryKey: queryKeys.costs.attribution(params),
    queryFn: () => apiClient.get(`/costs/attribution?${toQuery(params)}`).then((r) => r.data),
  });
}

export function useCostAnomalies() {
  return useQuery({
    queryKey: queryKeys.costs.anomalies,
    queryFn: () => apiClient.get('/costs/anomalies').then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useGovernanceRecommendations() {
  return useQuery({
    queryKey: ['costs', 'recommendations'],
    queryFn: () => apiClient.get('/costs/recommendations').then((r) => r.data),
    refetchInterval: 5 * 60_000, // refresh every 5 minutes
  });
}

// ─── Settings ────────────────────────────────

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: queryKeys.settings.workspace,
    queryFn: () => apiClient.get('/settings/workspace').then((r) => r.data),
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.patch('/settings/workspace', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.workspace }),
  });
}

export function useWorkspaceMembers() {
  return useQuery({
    queryKey: queryKeys.settings.members,
    queryFn: () => apiClient.get('/settings/members').then((r) => r.data),
  });
}

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; role: string }) => apiClient.post('/settings/members/invite', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.members }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiClient.delete(`/settings/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.members }),
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      apiClient.patch(`/settings/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.members }),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: () => apiClient.get('/settings/api-keys').then((r) => r.data),
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; expiresInDays?: number }) =>
      apiClient.post('/settings/api-keys', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => apiClient.delete(`/settings/api-keys/${keyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
  });
}

// ─── Onboarding ──────────────────────────────

export function useOnboardingChecklist() {
  return useQuery({
    queryKey: queryKeys.settings.onboarding,
    queryFn: () => apiClient.get('/settings/onboarding').then((r) => r.data),
  });
}

// ─── Sessions ────────────────────────────────

export function useActiveSessions() {
  return useQuery({
    queryKey: ['auth', 'sessions'] as const,
    queryFn: () => apiClient.get('/auth/sessions').then((r) => r.data),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => apiClient.delete(`/auth/sessions/${sessionId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }),
  });
}

export function useRevokeAllSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete('/auth/sessions'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }),
  });
}

// ─── Workspace (Blast Radius + Emergency Stop) ─────────────────────

export function useBlastRadiusSummary() {
  return useQuery({
    queryKey: ['workspace', 'blastRadiusSummary'] as const,
    queryFn: () => apiClient.get('/workspaces/blast-radius-summary').then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useEmergencyStopAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { confirmation: string; reason: string }) =>
      apiClient.post('/workspaces/emergency-stop', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['workspace', 'blastRadiusSummary'] });
    },
  });
}

// ─── Agent Blast Radius (recalculate) ────────

export function useRecalculateBlastRadius() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      apiClient.post(`/agents/${agentId}/blast-radius/recalculate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['workspace', 'blastRadiusSummary'] });
    },
  });
}

// ─── ECC Integration ─────────────────────────

export function useECCStatus() {
  return useQuery({
    queryKey: ['ecc', 'status'] as const,
    queryFn: () => apiClient.get('/ecc/status').then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useECCAgents() {
  return useQuery({
    queryKey: ['ecc', 'agents'] as const,
    queryFn: () => apiClient.get('/ecc/agents').then((r) => r.data),
  });
}

export function useECCCostSummary() {
  return useQuery({
    queryKey: ['ecc', 'costSummary'] as const,
    queryFn: () => apiClient.get('/ecc/cost-summary').then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useECCInstincts() {
  return useQuery({
    queryKey: ['ecc', 'instincts'] as const,
    queryFn: () => apiClient.get('/ecc/instincts').then((r) => r.data),
  });
}

export function useECCSyncAgents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post('/ecc/agents/sync', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ecc', 'agents'] });
      qc.invalidateQueries({ queryKey: ['ecc', 'status'] });
    },
  });
}
