/**
 * API Route Integration Tests
 * 
 * Tests the Fastify API endpoints by building a real (but in-memory) Fastify
 * instance and using app.inject() for HTTP-level testing. This validates:
 * - Route registration and URL matching
 * - Request/response schemas
 * - Authentication enforcement (JWT, API Key)
 * - RBAC (Role-Based Access Control)
 * - Error handling and edge cases
 * 
 * NOTE: These tests mock Prisma and Redis to avoid external dependencies.
 * For true end-to-end tests, run against Docker Compose.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// ─── Mock Prisma ─────────────────────────────

const mockWorkspace = {
  id: 'ws-test-1',
  name: 'Test Workspace',
  slug: 'test-workspace',
  plan: 'enterprise',
  dataRegion: 'US',
  financialExposureConfig: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockUser = {
  id: 'user-1',
  email: 'admin@nexusops.io',
  passwordHash: '$2b$10$test', // bcrypt hash
  name: 'Test Admin',
  avatarUrl: null,
  emailVerified: true,
  lastLoginAt: new Date(),
  createdAt: new Date(),
  workspaces: [{ workspaceId: 'ws-test-1', role: 'OWNER', workspace: mockWorkspace }],
};

const mockAgent = {
  id: 'agent-1',
  workspaceId: 'ws-test-1',
  name: 'Test Agent',
  version: '1.0.0',
  status: 'ACTIVE',
  toolPermissions: ['GITHUB', 'DATABASE'],
  maxTokens: 100000,
  maxCostUsd: 10.0,
  blastRadiusScore: 0.3,
  safetySchema: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { tasks: 5, toolCalls: 20 },
};

const mockPolicyRule = {
  id: 'policy-1',
  workspaceId: 'ws-test-1',
  name: 'Deny Prod Writes',
  enabled: true,
  version: 1,
  action: 'DENY',
  priority: 100,
  conditions: { toolTypes: ['DATABASE'], environments: ['PRODUCTION'] },
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock Prisma client
vi.mock('@nexusops/db', () => {
  const prismaMock = {
    workspace: {
      findFirst: vi.fn().mockResolvedValue(mockWorkspace),
      findMany: vi.fn().mockResolvedValue([mockWorkspace]),
      update: vi.fn().mockResolvedValue({ ...mockWorkspace, name: 'Updated' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(mockUser),
      findUniqueOrThrow: vi.fn().mockResolvedValue(mockUser),
    },
    agent: {
      findMany: vi.fn().mockResolvedValue([mockAgent]),
      findUnique: vi.fn().mockResolvedValue(mockAgent),
      create: vi.fn().mockResolvedValue(mockAgent),
      count: vi.fn().mockResolvedValue(3),
    },
    task: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(50),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 42.50 } }),
      create: vi.fn().mockResolvedValue({ id: 'task-new' }),
    },
    policyRule: {
      findMany: vi.fn().mockResolvedValue([mockPolicyRule]),
      findUnique: vi.fn().mockResolvedValue(mockPolicyRule),
      create: vi.fn().mockResolvedValue(mockPolicyRule),
      update: vi.fn().mockResolvedValue(mockPolicyRule),
    },
    policyEvaluation: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(100),
    },
    toolCall: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _count: 20 }),
      count: vi.fn().mockResolvedValue(20),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    auditEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(10),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'evt-new', chainIndex: 0 }),
    },
    workspaceUser: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'wu-1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(1),
    },
    workspaceInvitation: {
      create: vi.fn().mockResolvedValue({ id: 'inv-1', email: 'test@example.com', role: 'VIEWER', expiresAt: new Date() }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: 'k-1', workspaceId: 'ws-test-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'k-new',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'nxo_sk_test',
        expiresAt: null,
        createdAt: new Date(),
      }),
      update: vi.fn().mockResolvedValue({ id: 'k-1', revokedAt: new Date() }),
    },
    taskApproval: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(2),
    },
    budget: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'budget-1' }),
    },
    refreshToken: {
      create: vi.fn().mockResolvedValue({ id: 'rt-1' }),
    },
    metric: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    complianceArtifact: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  };

  return {
    prisma: prismaMock,
    UserRole: { OWNER: 'OWNER', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' },
    TaskStatus: {
      PENDING: 'PENDING', QUEUED: 'QUEUED', RUNNING: 'RUNNING',
      PENDING_APPROVAL: 'PENDING_APPROVAL', COMPLETED: 'COMPLETED',
      FAILED: 'FAILED', ESCALATED: 'ESCALATED', CANCELLED: 'CANCELLED',
    },
    AgentStatus: { IDLE: 'IDLE', ACTIVE: 'ACTIVE', STALLED: 'STALLED', ZOMBIE: 'ZOMBIE', TERMINATED: 'TERMINATED' },
    PolicyAction: { ALLOW: 'ALLOW', DENY: 'DENY', ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN' },
    ToolType: { GITHUB: 'GITHUB', JIRA: 'JIRA', DATABASE: 'DATABASE', CLOUD_DEPLOY: 'CLOUD_DEPLOY', CUSTOM: 'CUSTOM' },
    Environment: { DEVELOPMENT: 'DEVELOPMENT', STAGING: 'STAGING', PRODUCTION: 'PRODUCTION' },
    DataClassification: { PUBLIC: 'PUBLIC', INTERNAL: 'INTERNAL', CONFIDENTIAL: 'CONFIDENTIAL', RESTRICTED: 'RESTRICTED' },
    Provider: { OPENAI: 'OPENAI', ANTHROPIC: 'ANTHROPIC' },
  };
});

// Mock logger
vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock events package (imported by agentsRoutes and policiesRoutes)
vi.mock('@nexusops/events', () => ({
  appendAuditEvent: vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 }),
  createComplianceArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
  verifyAuditChain: vi.fn().mockResolvedValue({ valid: true, items: [], chainLength: 0 }),
}));

// Mock policy engine (imported as singleton by policiesRoutes)
vi.mock('@nexusops/policy', () => ({
  policyEngine: {
    evaluate: vi.fn().mockResolvedValue({ action: 'ALLOW', matched: false }),
    invalidateCache: vi.fn(),
    startCacheSubscription: vi.fn(),
    getWorkspacePolicies: vi.fn().mockResolvedValue([]),
  },
}));

// Mock queue
vi.mock('@nexusops/queue', () => ({
  queueManager: {
    addJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    getQueueMetrics: vi.fn().mockResolvedValue({ waiting: 5, active: 2, completed: 100, failed: 1 }),
  },
}));

// ─── Helpers ─────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-characters-long';

function generateTestToken(app: FastifyInstance, overrides: Partial<{ userId: string; workspaceId: string; role: string }> = {}) {
  return app.jwt.sign({
    userId: overrides.userId || 'user-1',
    workspaceId: overrides.workspaceId || 'ws-test-1',
    role: overrides.role || 'OWNER',
    type: 'access',
  });
}

// ─── Build Test App ──────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(jwt, { secret: JWT_SECRET });

  // Import and register auth plugin
  const { authPlugin } = await import('../plugins/auth');
  await app.register(authPlugin);

  // Register routes
  const { settingsRoutes } = await import('../routes/settings');
  const { metricsRoutes } = await import('../routes/metrics');
  const { agentsRoutes } = await import('../routes/agents');
  const { policiesRoutes } = await import('../routes/policies');

  await app.register(settingsRoutes, { prefix: '/api/v1' });
  await app.register(metricsRoutes, { prefix: '/api/v1/metrics' });
  await app.register(agentsRoutes, { prefix: '/api/v1/agents' });
  await app.register(policiesRoutes, { prefix: '/api/v1/policies' });

  // Health check
  app.get('/health', async () => ({ status: 'healthy' }));

  await app.ready();
  return app;
}

// ─── Tests ───────────────────────────────────

describe('API Route Integration Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Health Check ──

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'healthy' });
    });
  });

  // ── Authentication Enforcement ──

  describe('Authentication', () => {
    it('should reject unauthenticated requests to protected routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with invalid JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
        headers: { authorization: 'Bearer invalid-token' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with expired JWT', async () => {
      // Set exp to 60 seconds in the past — definitively expired, no timing race.
      // fast-jwt (used by @fastify/jwt) respects a pre-set exp claim in the payload
      // when no expiresIn option is passed alongside it.
      const expired = app.jwt.sign({
        userId: 'user-1',
        workspaceId: 'ws-test-1',
        role: 'OWNER',
        type: 'access',
        exp: Math.floor(Date.now() / 1000) - 60, // expired 60 seconds ago
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${expired}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should accept requests with valid JWT', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── RBAC Enforcement ──

  describe('RBAC — Role-Based Access Control', () => {
    it('should allow OWNER to update workspace settings', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated Name' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should allow ADMIN to update workspace settings', async () => {
      const token = generateTestToken(app, { role: 'ADMIN' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Admin Update' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should DENY OPERATOR from updating workspace settings', async () => {
      const token = generateTestToken(app, { role: 'OPERATOR' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Operator Attempt' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should DENY VIEWER from updating workspace settings', async () => {
      const token = generateTestToken(app, { role: 'VIEWER' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Viewer Attempt' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should DENY OPERATOR from inviting members', async () => {
      const token = generateTestToken(app, { role: 'OPERATOR' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite',
        headers: { authorization: `Bearer ${token}` },
        payload: { email: 'new@test.com', role: 'VIEWER' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should DENY VIEWER from creating API keys', async () => {
      const token = generateTestToken(app, { role: 'VIEWER' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Viewer Key' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should allow OWNER to create policies', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/policies',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Test Policy',
          action: 'DENY',
          priority: 100,
          conditions: { toolTypes: ['DATABASE'] },
        },
      });
      // Should succeed (200/201)
      expect([200, 201]).toContain(res.statusCode);
    });

    it('should DENY VIEWER from creating policies', async () => {
      const token = generateTestToken(app, { role: 'VIEWER' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/policies',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Viewer Policy',
          action: 'DENY',
          priority: 100,
          conditions: { toolTypes: ['DATABASE'] },
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should DENY OPERATOR from deleting policies', async () => {
      const token = generateTestToken(app, { role: 'OPERATOR' });
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/policies/policy-1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Settings Routes ──

  describe('Settings — Workspace', () => {
    it('GET /settings/workspace should return workspace data', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
      expect(body.data).toHaveProperty('slug');
      expect(body.meta).toHaveProperty('timestamp');
    });

    it('PATCH /settings/workspace should validate data region', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
        payload: { dataRegion: 'INVALID' },
      });
      // Zod validation should fail
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('PATCH /settings/workspace should accept valid data regions', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      for (const region of ['US', 'EU', 'APAC']) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/settings/workspace',
          headers: { authorization: `Bearer ${token}` },
          payload: { dataRegion: region },
        });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  // ── Settings — API Keys ──

  describe('Settings — API Keys', () => {
    it('GET /settings/api-keys should return keys list', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/api-keys',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toBeInstanceOf(Array);
    });

    it('POST /settings/api-keys should require name', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('POST /settings/api-keys should return raw key once', async () => {
      const token = generateTestToken(app, { role: 'OWNER' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/api-keys',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'CI Key' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.key).toMatch(/^nxo_sk_/);
      expect(body.warning).toBeTruthy();
    });

    it('DELETE /settings/api-keys/:id should require OWNER/ADMIN', async () => {
      const token = generateTestToken(app, { role: 'VIEWER' });
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/settings/api-keys/k-1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Metrics ──

  describe('Metrics — Dashboard', () => {
    it('GET /metrics/dashboard should return aggregated metrics', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/dashboard',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('activeAgents');
      expect(body.data).toHaveProperty('costToday');
      expect(body.data).toHaveProperty('policyViolations');
      expect(body.data).toHaveProperty('tasksPerHour');
      expect(body.data).toHaveProperty('agentChange');
      expect(body.data).toHaveProperty('taskRateChange');
    });

    it('GET /metrics/dashboard should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/dashboard',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Agents ──

  describe('Agents', () => {
    it('GET /agents should return agents list', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/agents',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /agents should require auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Response Format ──

  describe('Response Format — Standard Envelope', () => {
    it('should include data and meta in success responses', async () => {
      const token = generateTestToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('timestamp');
    });

    it('should include error in failure responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/workspace',
      });
      const body = res.json();
      expect(body).toHaveProperty('error');
    });
  });
});
