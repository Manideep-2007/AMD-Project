/**
 * ECC Integration Route Tests
 *
 * Validates the ECC integration endpoints — event ingestion, agent sync,
 * cost summary, instincts, status, and HMAC security.
 *
 * Auth Strategy:
 *   - POST /events, POST /session/cost, GET /instincts, POST /instincts/refresh
 *     use API key auth (x-api-key header)
 *   - GET /agents, POST /agents/sync, GET /status, GET /cost-summary
 *     use JWT auth (Bearer token)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { createHmac } from 'crypto';

// ─── Mock Prisma ─────────────────────────────

const mockECCSession = {
  id: 'ecc-sess-1',
  workspaceId: 'ws-test-1',
  sessionId: 'claude-session-abc',
  agentId: null,
  startedAt: new Date(),
  endedAt: null,
  status: 'active',
  projectHash: 'abc123',
  hookProfile: 'standard',
  eventCount: 5,
  totalCostUsd: 0.045,
  lastEventAt: new Date(),
  createdAt: new Date(),
};

const mockAgent = {
  id: 'agent-ecc-1',
  workspaceId: 'ws-test-1',
  name: 'ecc-code-reviewer',
  description: 'ECC code-reviewer agent — development governance',
  version: '1.8.0',
  status: 'IDLE',
  config: { eccAgent: true, environment: 'DEVELOPMENT', model: 'claude-sonnet-4-6' },
  toolPermissions: ['GITHUB'],
  maxTokens: 200000,
  maxCostUsd: 0.5,
  blastRadiusScore: 0.0,
  safetySchema: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const prismaMock = {
  eCCSession: {
    upsert: vi.fn().mockResolvedValue(mockECCSession),
    findMany: vi.fn().mockResolvedValue([mockECCSession]),
    findFirst: vi.fn().mockResolvedValue(mockECCSession),
    count: vi.fn().mockResolvedValue(3),
    update: vi.fn().mockResolvedValue(mockECCSession),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  agent: {
    findMany: vi.fn().mockResolvedValue([mockAgent]),
    upsert: vi.fn().mockResolvedValue(mockAgent),
    count: vi.fn().mockResolvedValue(1),
  },
  policyRule: {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'policy-1' }),
  },
  budget: {
    create: vi.fn().mockResolvedValue({ id: 'budget-1' }),
  },
  auditEvent: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 }),
    count: vi.fn().mockResolvedValue(12),
  },
  toolCall: {
    aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 8.25 }, _count: { id: 15 } }),
  },
  workspace: {
    findFirst: vi.fn().mockResolvedValue({ id: 'ws-test-1', name: 'Test Workspace' }),
  },
  user: {
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      id: 'user-1',
      workspaces: [{ workspaceId: 'ws-test-1', role: 'OWNER' }],
    }),
  },
  workspaceUser: {
    findFirst: vi.fn().mockResolvedValue({ workspaceId: 'ws-test-1', role: 'OWNER' }),
  },
  apiKey: {
    findUnique: vi.fn().mockResolvedValue({
      id: 'k-1',
      workspaceId: 'ws-test-1',
      scope: 'full_access',
      revokedAt: null,
      expiresAt: null,
      rateLimit: null,
    }),
    update: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('@nexusops/db', () => ({
  prisma: prismaMock,
  Prisma: { InputJsonValue: {} },
  UserRole: { OWNER: 'OWNER', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' },
  AgentStatus: { IDLE: 'IDLE', ACTIVE: 'ACTIVE', STALLED: 'STALLED', ZOMBIE: 'ZOMBIE', TERMINATED: 'TERMINATED' },
  PolicyAction: { ALLOW: 'ALLOW', DENY: 'DENY', ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN' },
  ToolType: { GITHUB: 'GITHUB', JIRA: 'JIRA', DATABASE: 'DATABASE', CLOUD_DEPLOY: 'CLOUD_DEPLOY', CUSTOM: 'CUSTOM' },
  Environment: { DEVELOPMENT: 'DEVELOPMENT', STAGING: 'STAGING', PRODUCTION: 'PRODUCTION' },
  Provider: { OPENAI: 'OPENAI', ANTHROPIC: 'ANTHROPIC' },
}));

vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('@nexusops/events', () => ({
  appendAuditEvent: vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 }),
  createComplianceArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
  verifyAuditChain: vi.fn().mockResolvedValue({ valid: true, items: [], chainLength: 0 }),
}));

vi.mock('@nexusops/policy', () => ({
  policyEngine: {
    evaluate: vi.fn().mockResolvedValue({ action: 'ALLOW', matched: false }),
    invalidateCache: vi.fn(),
    startCacheSubscription: vi.fn(),
    getWorkspacePolicies: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@nexusops/queue', () => ({
  queueManager: {
    addJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    getQueueMetrics: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 }),
  },
}));

vi.mock('@nexusops/blast-radius', () => ({
  atomicBudgetDeduct: vi.fn().mockResolvedValue({ allowed: true }),
  calculateAnomalyScore: vi.fn().mockResolvedValue({ score: 10 }),
}));

// ─── Helpers ─────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-characters-long';
const API_KEY = 'test-api-key-for-ecc-integration';
const WEBHOOK_SECRET = 'test-webhook-secret-32chars-min';

function generateTestToken(
  app: FastifyInstance,
  overrides: Partial<{ userId: string; workspaceId: string; role: string }> = {},
) {
  return app.jwt.sign({
    userId: overrides.userId || 'user-1',
    workspaceId: overrides.workspaceId || 'ws-test-1',
    role: overrides.role || 'OWNER',
    type: 'access',
  });
}

function hmacSign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

// ─── Build Test App ──────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: JWT_SECRET });

  const { authPlugin } = await import('../plugins/auth');
  await app.register(authPlugin);

  const { eccRoutes } = await import('../routes/ecc');
  await app.register(eccRoutes, { prefix: '/api/v1/ecc' });

  await app.ready();
  return app;
}

// ─── Tests ───────────────────────────────────

describe('ECC Integration Routes', () => {
  let app: FastifyInstance;
  let jwtToken: string;

  beforeAll(async () => {
    app = await buildApp();
    jwtToken = generateTestToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ────────────────────────────────────────────
  // Authentication
  // ────────────────────────────────────────────

  describe('Authentication', () => {
    it('should reject unauthenticated GET /status (no JWT)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/ecc/status' });
      expect(res.statusCode).toBe(401);
    });

    it('should accept JWT-authenticated GET /status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ecc/status',
        headers: { authorization: `Bearer ${jwtToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject POST /events without API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/events',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it('should accept POST /events with valid API key', async () => {
      const payload = {
        workspaceId: 'ws-test-1',
        eventType: 'ECC_SESSION_STARTED',
        source: 'ecc-hook',
        agentId: 'ecc-session',
        sessionId: 'claude-session-abc',
        metadata: {},
        timestamp: new Date().toISOString(),
      };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/events',
        headers: { 'x-api-key': API_KEY },
        payload,
      });
      expect(res.statusCode).toBe(202);
    });
  });

  // ────────────────────────────────────────────
  // POST /events
  // ────────────────────────────────────────────

  describe('POST /events', () => {
    it('should accept a valid ECC event and return 202', async () => {
      const payload = {
        workspaceId: 'ws-test-1',
        eventType: 'ECC_TOOL_EXECUTED',
        source: 'ecc-hook',
        agentId: 'ecc-code-reviewer',
        sessionId: 'claude-session-abc',
        metadata: { toolName: 'Read', outputHash: 'deadbeef', success: true },
        timestamp: new Date().toISOString(),
      };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/events',
        headers: { 'x-api-key': API_KEY },
        payload,
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.received).toBe(true);
      expect(body.eventType).toBe('ECC_TOOL_EXECUTED');
    });

    it('should reject events without required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/events',
        headers: { 'x-api-key': API_KEY },
        payload: { eventType: 'ECC_TOOL_EXECUTED' },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should reject workspace mismatch', async () => {
      const payload = {
        workspaceId: 'ws-WRONG',
        eventType: 'ECC_SESSION_STARTED',
        source: 'ecc-hook',
        agentId: 'ecc-session',
        metadata: {},
        timestamp: new Date().toISOString(),
      };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/events',
        headers: { 'x-api-key': API_KEY },
        payload,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ────────────────────────────────────────────
  // POST /session/cost
  // ────────────────────────────────────────────

  describe('POST /session/cost', () => {
    it('should accept cost event data (snake_case fields)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/session/cost',
        headers: { 'x-api-key': API_KEY },
        payload: {
          timestamp: new Date().toISOString(),
          session_id: 'claude-session-abc',
          model: 'claude-sonnet-4-20250514',
          input_tokens: 1000,
          output_tokens: 500,
          estimated_cost_usd: 0.0225,
        },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().recorded).toBe(true);
    });

    it('should reject cost event missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/session/cost',
        headers: { 'x-api-key': API_KEY },
        payload: { model: 'claude-sonnet-4-20250514' },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should reject negative cost values', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/session/cost',
        headers: { 'x-api-key': API_KEY },
        payload: {
          timestamp: new Date().toISOString(),
          session_id: 'ses-1',
          model: 'claude-sonnet-4-20250514',
          input_tokens: 100,
          output_tokens: 50,
          estimated_cost_usd: -1.0,
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  // ────────────────────────────────────────────
  // GET /agents
  // ────────────────────────────────────────────

  describe('GET /agents', () => {
    it('should return ECC agents list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ecc/agents',
        headers: { authorization: `Bearer ${jwtToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('agents');
      expect(Array.isArray(body.data.agents)).toBe(true);
      expect(body.data).toHaveProperty('total');
    });
  });

  // ────────────────────────────────────────────
  // POST /agents/sync
  // ────────────────────────────────────────────

  describe('POST /agents/sync', () => {
    it('should sync ECC agents and return count', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/agents/sync',
        headers: { authorization: `Bearer ${jwtToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('synced');
      expect(typeof body.data.synced).toBe('number');
      expect(body.data.synced).toBe(17); // 17 ECC agents
    });
  });

  // ────────────────────────────────────────────
  // GET /instincts
  // ────────────────────────────────────────────

  describe('GET /instincts', () => {
    it('should return instincts list via API key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ecc/instincts',
        headers: { 'x-api-key': API_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('instincts');
      expect(body.data).toHaveProperty('format', 'ecc-instinct-v1');
      expect(body.data).toHaveProperty('generatedAt');
    });
  });

  // ────────────────────────────────────────────
  // POST /instincts/refresh
  // ────────────────────────────────────────────

  describe('POST /instincts/refresh', () => {
    it('should enqueue instinct refresh job', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ecc/instincts/refresh',
        headers: { 'x-api-key': API_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.queued).toBe(true);
    });
  });

  // ────────────────────────────────────────────
  // GET /status
  // ────────────────────────────────────────────

  describe('GET /status', () => {
    it('should return ECC integration status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ecc/status',
        headers: { authorization: `Bearer ${jwtToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('connected');
      expect(body.data).toHaveProperty('sessionsLast24h');
      expect(body.data).toHaveProperty('totalSessions');
      expect(body.data).toHaveProperty('registeredAgents');
      expect(body.data).toHaveProperty('recentEvents');
      expect(body.data).toHaveProperty('eccVersion', '1.8.0');
    });
  });

  // ────────────────────────────────────────────
  // GET /cost-summary
  // ────────────────────────────────────────────

  describe('GET /cost-summary', () => {
    it('should return cost summary with dev/prod split', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ecc/cost-summary',
        headers: { authorization: `Bearer ${jwtToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('development');
      expect(body.data).toHaveProperty('production');
      expect(body.data).toHaveProperty('combined');
      expect(body.data.development).toHaveProperty('totalUsd');
      expect(body.data.production).toHaveProperty('totalUsd');
      expect(body.data.combined).toHaveProperty('totalUsd');
      expect(body.data).toHaveProperty('period', '30d');
    });
  });
});
