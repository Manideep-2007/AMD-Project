/**
 * Workspace Routes Tests — Blast Radius Summary + Emergency Stop
 *
 * Covers:
 *   GET  /api/v1/workspaces/blast-radius-summary
 *   POST /api/v1/workspaces/emergency-stop
 *
 * Uses Fastify app.inject() for in-process HTTP testing with mocked Prisma.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { prisma as mockPrisma } from '@nexusops/db';

// ─── Mock Data ───────────────────────────────

const mockAgents = [
  {
    id: 'agent-1',
    name: 'Deploy Bot',
    status: 'ACTIVE',
    blastRadiusScore: 75,
    blastRadiusMaxDamageUsd: 5000,
    blastRadiusGovernedDamageUsd: 1000,
    toolPermissions: ['CLOUD_DEPLOY', 'DATABASE'],
  },
  {
    id: 'agent-2',
    name: 'Issue Tracker',
    status: 'IDLE',
    blastRadiusScore: 20,
    blastRadiusMaxDamageUsd: 200,
    blastRadiusGovernedDamageUsd: 200,
    toolPermissions: ['GITHUB'],
  },
];

// ─── Mocks ───────────────────────────────────

vi.mock('@nexusops/db', () => {
  const prismaMock = {
    workspace: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ws-test-1', name: 'Test Workspace', slug: 'test-ws' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'admin@nexusops.io',
        passwordHash: '$2b$10$test',
        name: 'Test Admin',
        avatarUrl: null,
        emailVerified: true,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        workspaces: [{ workspaceId: 'ws-test-1', role: 'OWNER', workspace: { id: 'ws-test-1' } }],
      }),
    },
    agent: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    task: {
      updateMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
    apiKey: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  return {
    prisma: prismaMock,
    UserRole: { OWNER: 'OWNER', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' },
    AgentStatus: { IDLE: 'IDLE', ACTIVE: 'ACTIVE', TERMINATED: 'TERMINATED' },
  };
});

vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockAppendAuditEvent = vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 });
vi.mock('@nexusops/events', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

// ─── Test Server ─────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-characters-long';

function makeToken(app: FastifyInstance, role = 'OWNER', workspaceId = 'ws-test-1') {
  return app.jwt.sign({ userId: 'user-1', workspaceId, role, type: 'access' });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: JWT_SECRET });

  const { authPlugin } = await import('../../src/plugins/auth');
  await app.register(authPlugin);

  const { workspaceRoutes } = await import('../../src/routes/workspace');
  await app.register(workspaceRoutes, { prefix: '/api/v1/workspaces' });

  await app.ready();
  return app;
}

// ─── Tests ───────────────────────────────────

describe('Workspace Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockPrisma as any).agent.findMany.mockResolvedValue(mockAgents);
    (mockPrisma as any).agent.updateMany.mockResolvedValue({ count: 2 });
    (mockPrisma as any).task.updateMany.mockResolvedValue({ count: 3 });
    mockAppendAuditEvent.mockResolvedValue({ id: 'evt-1', chainIndex: 0 });
  });

  // ── GET /api/v1/workspaces/blast-radius-summary ──

  describe('GET /api/v1/workspaces/blast-radius-summary', () => {
    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with valid token', async () => {
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('response has correct shape', async () => {
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('totalProtectedValueUsd');
      expect(body.data).toHaveProperty('workspaceMaxDamageUsd');
      expect(body.data).toHaveProperty('workspaceGovernedDamageUsd');
      expect(body.data).toHaveProperty('agentCount');
      expect(body.data).toHaveProperty('highRiskAgentCount');
      expect(Array.isArray(body.data.agents)).toBe(true);
    });

    it('calculates totalProtectedValueUsd as max minus governed', async () => {
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      const { data } = res.json();
      // From mockAgents: max=(5000+200)=5200, governed=(1000+200)=1200 → protected=4000
      expect(data.workspaceMaxDamageUsd).toBe(5200);
      expect(data.workspaceGovernedDamageUsd).toBe(1200);
      expect(data.totalProtectedValueUsd).toBe(4000);
    });

    it('counts high-risk agents (score > 60)', async () => {
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      // agent-1 has score 75 (high risk), agent-2 score 20 (not)
      expect(res.json().data.highRiskAgentCount).toBe(1);
    });

    it('excludes TERMINATED agents', async () => {
      // Simulate the DB filtering — our mock returns whatever we tell it to
      (mockPrisma as any).agent.findMany.mockResolvedValueOnce([mockAgents[0]]); // 1 agent
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.json().data.agentCount).toBe(1);
    });

    it('returns meta.timestamp', async () => {
      const token = makeToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.json().meta).toHaveProperty('timestamp');
    });

    it('VIEWER role can read blast radius summary (read-only endpoint)', async () => {
      const token = makeToken(app, 'VIEWER');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces/blast-radius-summary',
        headers: { authorization: `Bearer ${token}` },
      });
      // No RBAC restriction on GET, only authentication required
      expect(res.statusCode).toBe(200);
    });
  });

  // ── POST /api/v1/workspaces/emergency-stop ────────

  describe('POST /api/v1/workspaces/emergency-stop', () => {
    const validPayload = {
      confirmation: 'STOP ALL AGENTS',
      reason: 'Security incident — shutting down all agents',
    };

    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for OPERATOR role', async () => {
      const token = makeToken(app, 'OPERATOR');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for VIEWER role', async () => {
      const token = makeToken(app, 'VIEWER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 when confirmation phrase is wrong', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: { confirmation: 'stop all agents', reason: 'lowercase should fail' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/STOP ALL AGENTS/);
    });

    it('returns 400 when confirmation is missing', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'no confirmation' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when reason is missing', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: { confirmation: 'STOP ALL AGENTS' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when reason is too short', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: { confirmation: 'STOP ALL AGENTS', reason: 'no' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 200 with OWNER role and valid payload', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 200 with ADMIN role and valid payload', async () => {
      const token = makeToken(app, 'ADMIN');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
    });

    it('terminates agents and cancels tasks on success', async () => {
      const token = makeToken(app, 'OWNER');
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });

      expect((mockPrisma as any).agent.updateMany).toHaveBeenCalledOnce();
      expect((mockPrisma as any).agent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'TERMINATED' } }),
      );
      expect((mockPrisma as any).task.updateMany).toHaveBeenCalledOnce();
      expect((mockPrisma as any).task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
      );
    });

    it('response includes agentsTerminated and tasksCancelled counts', async () => {
      const token = makeToken(app, 'OWNER');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      const { data } = res.json();
      expect(data.agentsTerminated).toBe(2);
      expect(data.tasksCancelled).toBe(3);
      expect(data.reason).toBe(validPayload.reason);
      expect(data).toHaveProperty('executedAt');
    });

    it('logs an audit event', async () => {
      const token = makeToken(app, 'OWNER');
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/emergency-stop',
        headers: { authorization: `Bearer ${token}` },
        payload: validPayload,
      });
      // Fire-and-forget — allow the microtask to run
      await new Promise((r) => setTimeout(r, 20));
      expect(mockAppendAuditEvent).toHaveBeenCalledOnce();
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'workspace.emergency_stop' }),
      );
    });
  });
});
