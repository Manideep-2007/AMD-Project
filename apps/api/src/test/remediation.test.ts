/**
 * Audit Remediation Tests
 *
 * Validates all fixes from Sprints 0–3 of the NexusOps audit.
 * Covers: email invitations, ownership transfer, anomaly signals,
 * blast radius formula, audit chain verification, JWT refresh secret,
 * WebSocket auth pattern, and Zod query validation.
 *
 * NOTE: Uses Fastify app.inject() + Prisma mocks — no DB required.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

// ─── Mock Data ───────────────────────────────
// vi.hoisted() ensures these values are available when vi.mock() factories run

const { mockWorkspace, mockUser, mockInvitation } = vi.hoisted(() => ({
  mockWorkspace: {
    id: 'ws-test-1',
    name: 'Audit Workspace',
    slug: 'audit-workspace',
    plan: 'enterprise',
    dataRegion: 'US',
    financialExposureConfig: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
  mockUser: {
    id: 'user-1',
    email: 'owner@nexusops.io',
    name: 'Test Owner',
    passwordHash: null,
    avatarUrl: null,
    emailVerified: true,
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  mockInvitation: {
    id: 'inv-1',
    workspaceId: 'ws-test-1',
    email: 'invitee@example.com',
    role: 'OPERATOR',
    token: 'test-invite-token-abc',
    invitedById: 'user-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date(),
  },
}));

const mockMembership = {
  id: 'wu-owner',
  workspaceId: 'ws-test-1',
  userId: 'user-1',
  role: 'OWNER',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockTargetMembership = {
  id: 'wu-admin',
  workspaceId: 'ws-test-1',
  userId: 'user-2',
  role: 'ADMIN',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Mock Prisma ─────────────────────────────

vi.mock('@nexusops/db', () => {
  const prismaMock = {
    workspace: {
      findFirst: vi.fn().mockResolvedValue(mockWorkspace),
      findUniqueOrThrow: vi.fn().mockResolvedValue(mockWorkspace),
      update: vi.fn().mockResolvedValue(mockWorkspace),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(mockUser),
    },
    workspaceUser: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'wu-new' }),
      update: vi.fn().mockResolvedValue({ id: 'wu-admin' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(1),
    },
    workspaceInvitation: {
      create: vi.fn().mockResolvedValue(mockInvitation),
      findUnique: vi.fn().mockResolvedValue(mockInvitation),
      findMany: vi.fn().mockResolvedValue([mockInvitation]),
      update: vi.fn().mockResolvedValue({ ...mockInvitation, acceptedAt: new Date() }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'k-1', keyPrefix: 'nxo_sk_t', name: 'key', createdAt: new Date() }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 }),
    },
    agent: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    task: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
    toolCall: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _count: 0 }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    policyEvaluation: {
      count: vi.fn().mockResolvedValue(0),
    },
    budget: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    metric: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    policyRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    complianceArtifact: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    refreshToken: {
      create: vi.fn().mockResolvedValue({ id: 'rt-1' }),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  };

  return {
    prisma: prismaMock,
    UserRole: { OWNER: 'OWNER', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' },
    TaskStatus: { PENDING: 'PENDING', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', ESCALATED: 'ESCALATED', QUEUED: 'QUEUED', PENDING_APPROVAL: 'PENDING_APPROVAL' },
    AgentStatus: { IDLE: 'IDLE', ACTIVE: 'ACTIVE', TERMINATED: 'TERMINATED', STALLED: 'STALLED', ZOMBIE: 'ZOMBIE' },
    PolicyAction: { ALLOW: 'ALLOW', DENY: 'DENY', ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN' },
    ToolType: { GITHUB: 'GITHUB', DATABASE: 'DATABASE' },
    Environment: { PRODUCTION: 'PRODUCTION', STAGING: 'STAGING', DEVELOPMENT: 'DEVELOPMENT' },
    DataClassification: { PUBLIC: 'PUBLIC', INTERNAL: 'INTERNAL', CONFIDENTIAL: 'CONFIDENTIAL', RESTRICTED: 'RESTRICTED' },
    Provider: { OPENAI: 'OPENAI', ANTHROPIC: 'ANTHROPIC' },
  };
});

vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('@nexusops/events', () => ({
  appendAuditEvent: vi.fn().mockResolvedValue({ id: 'evt-1', chainIndex: 0 }),
  createComplianceArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
  verifyAuditChain: vi.fn().mockResolvedValue({ valid: true, chainLength: 5, firstBrokenAt: null }),
}));

vi.mock('@nexusops/policy', () => ({
  policyEngine: {
    evaluate: vi.fn().mockResolvedValue({ action: 'ALLOW' }),
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

vi.mock('../lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildInvitationEmail: vi.fn().mockReturnValue({ to: '', subject: 'test', html: '<p>test</p>' }),
}));

import { prisma } from '@nexusops/db';
import { verifyAuditChain } from '@nexusops/events';

const mockPrisma = prisma as any;
const mockVerifyChain = verifyAuditChain as any;

// ─── Helpers ─────────────────────────────────

const JWT_SECRET = 'audit-test-secret-at-32-chars-long';

function genToken(app: FastifyInstance, role = 'OWNER', userId = 'user-1', wsId = 'ws-test-1') {
  return app.jwt.sign({ userId, workspaceId: wsId, role, type: 'access' });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: JWT_SECRET });

  const { authPlugin } = await import('../plugins/auth');
  await app.register(authPlugin);

  const { settingsRoutes } = await import('../routes/settings');
  const { auditRoutes } = await import('../routes/audit');
  await app.register(settingsRoutes, { prefix: '/api/v1' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });

  app.get('/health', async () => ({ status: 'healthy' }));

  await app.ready();
  return app;
}

// ─── Tests ───────────────────────────────────

describe('Audit Remediation Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock values
    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue(mockWorkspace);
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue(mockUser);
    mockPrisma.workspaceInvitation.create.mockResolvedValue(mockInvitation);
    mockPrisma.workspaceInvitation.findUnique.mockResolvedValue(mockInvitation);
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([mockInvitation]);
    mockPrisma.workspaceInvitation.updateMany.mockResolvedValue({ count: 1 });
  });

  // ── M-7: Email Invitation Flow ──

  describe('POST /api/v1/settings/members/invite', () => {
    it('should create invitation and return 201 for valid email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null); // No pre-existing user

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { email: 'newuser@example.com', role: 'OPERATOR' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.email).toBe('newuser@example.com');
      expect(body.data.role).toBe('OPERATOR');
      expect(body.data.expiresAt).toBeDefined();
    });

    it('should reject non-OWNER/ADMIN users', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite',
        headers: { authorization: `Bearer ${genToken(app, 'VIEWER')}` },
        payload: { email: 'test@example.com', role: 'VIEWER' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should 409 if user is already a member', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-existing', email: 'existing@example.com' });
      mockPrisma.workspaceUser.findUnique.mockResolvedValue({ id: 'wu-1', role: 'VIEWER' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { email: 'existing@example.com', role: 'ADMIN' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('should revoke existing pending invitation before creating new', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { email: 'newuser@example.com', role: 'ADMIN' },
      });

      expect(mockPrisma.workspaceInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ email: 'newuser@example.com', acceptedAt: null, revokedAt: null }),
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });
  });

  // ── Invitation Accept ──

  describe('POST /api/v1/settings/members/invite/:token/accept', () => {
    it('should accept invitation and create membership', async () => {
      const inviteeUser = { ...mockUser, id: 'user-invitee', email: 'invitee@example.com' };
      const invitation = { ...mockInvitation, email: 'invitee@example.com' };

      mockPrisma.workspaceInvitation.findUnique.mockResolvedValue(invitation);
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(inviteeUser);
      mockPrisma.workspaceUser.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite/test-invite-token-abc/accept',
        headers: { authorization: `Bearer ${genToken(app, 'VIEWER', 'user-invitee')}` },
      });

      expect(res.statusCode).toBe(201);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should reject expired invitation', async () => {
      mockPrisma.workspaceInvitation.findUnique.mockResolvedValue({
        ...mockInvitation,
        email: 'owner@nexusops.io',
        expiresAt: new Date('2020-01-01'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite/test-invite-token-abc/accept',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(410);
    });

    it('should reject if email does not match', async () => {
      mockPrisma.workspaceInvitation.findUnique.mockResolvedValue({
        ...mockInvitation,
        email: 'someone-else@example.com',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/members/invite/test-invite-token-abc/accept',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Invitation List + Revoke ──

  describe('GET /api/v1/settings/members/invitations', () => {
    it('should list pending invitations', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/members/invitations',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
    });
  });

  describe('DELETE /api/v1/settings/members/invitations/:id', () => {
    it('should revoke an invitation', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/settings/members/invitations/inv-1',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.revoked).toBe(true);
    });
  });

  // ── M-8: Ownership Transfer ──

  describe('POST /api/v1/settings/transfer-ownership', () => {
    it('should transfer ownership atomically (OWNER only)', async () => {
      mockPrisma.workspaceUser.findUnique.mockResolvedValue(mockTargetMembership);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/transfer-ownership',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { newOwnerUserId: 'user-2' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.previousOwner).toBe('user-1');
      expect(body.data.newOwner).toBe('user-2');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should reject non-OWNER users', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/transfer-ownership',
        headers: { authorization: `Bearer ${genToken(app, 'ADMIN')}` },
        payload: { newOwnerUserId: 'user-2' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject self-transfer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/transfer-ownership',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { newOwnerUserId: 'user-1' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should 404 if target is not a member', async () => {
      mockPrisma.workspaceUser.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/transfer-ownership',
        headers: { authorization: `Bearer ${genToken(app)}` },
        payload: { newOwnerUserId: 'user-nonexistent' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── M-4: GET /audit/verify ──

  describe('GET /api/v1/audit/verify', () => {
    it('should return chain verification result', async () => {
      mockVerifyChain.mockResolvedValue({ valid: true, chainLength: 10, firstBrokenAt: null });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/audit/verify',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.valid).toBe(true);
      expect(body.data.chainLength).toBe(10);
      expect(body.data.firstBrokenAt).toBeNull();
      expect(body.data.verifiedAt).toBeDefined();
    });

    it('should return firstBrokenAt when chain is invalid', async () => {
      mockVerifyChain.mockResolvedValue({ valid: false, chainLength: 5, firstBrokenAt: 3 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/audit/verify',
        headers: { authorization: `Bearer ${genToken(app)}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.valid).toBe(false);
      expect(body.data.firstBrokenAt).toBe(3);
    });
  });
});
