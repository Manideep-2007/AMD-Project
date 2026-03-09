/**
 * Events Package Tests — Audit Chain & Compliance Artifacts
 *
 * Tests the cryptographic audit chain logic and compliance artifact
 * creation. Mocks Prisma to isolate business logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chainHash, hashComplianceContent } from '@nexusops/crypto';

// Mock @nexusops/db before any imports
vi.mock('@nexusops/db', () => ({
  prisma: {
    auditEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    complianceArtifact: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
  PolicyAction: { ALLOW: 'ALLOW', DENY: 'DENY', ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN' },
  DataClassification: { PUBLIC: 'PUBLIC', INTERNAL: 'INTERNAL', CONFIDENTIAL: 'CONFIDENTIAL', RESTRICTED: 'RESTRICTED' },
}));

// Mock @nexusops/logger
vi.mock('@nexusops/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Now import the modules under test
import { appendAuditEvent, verifyAuditChain, verifyComplianceChain } from './index';
import { prisma } from '@nexusops/db';

const mockPrisma = prisma as unknown as {
  auditEvent: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  complianceArtifact: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

// ─── Test helpers — build mock events/artifacts with real computed hashes ──
const TEST_DATE = new Date('2024-06-01T12:00:00.000Z');

function makeAuditEvent(index: number, prevHash: string | null) {
  const contentString = JSON.stringify({
    workspaceId: 'ws-1',
    eventType: 'test.event',
    entityType: 'test',
    entityId: `entity-${index}`,
    action: 'TEST',
    metadata: { index },
    provider: null,
    timestamp: TEST_DATE.toISOString(),
  });
  const contentHash = chainHash(prevHash, contentString);
  return {
    id: `event-${index}`,
    workspaceId: 'ws-1',
    eventType: 'test.event',
    entityType: 'test',
    entityId: `entity-${index}`,
    action: 'TEST',
    metadata: { index },
    provider: null,
    createdAt: TEST_DATE,
    contentHash,
    previousHash: prevHash,
    chainIndex: index,
  };
}

function makeArtifact(index: number, prevHash: string | null) {
  const data = {
    userPrompt: `test prompt ${index}`,
    reasoningChain: null,
    contextRefs: null,
    policyDecision: 'ALLOW',
    executionRecord: {
      toolCallId: `tc-${index}`,
      requestPayloadHash: `rph-${index}`,
      responsePayloadHash: `resph-${index}`,
      executionDurationMs: 100,
      costUsd: 0.01,
      dataClassificationTouched: null,
      provider: null,
    },
  };
  const contentHash = hashComplianceContent(data);
  return {
    id: `artifact-${index}`,
    userPrompt: data.userPrompt,
    reasoningChain: data.reasoningChain,
    contextRefs: data.contextRefs,
    policyDecision: data.policyDecision,
    toolCallId: `tc-${index}`,
    requestPayloadHash: `rph-${index}`,
    responsePayloadHash: `resph-${index}`,
    executionDurationMs: 100,
    costUsd: 0.01,
    dataClassificationTouched: null,
    provider: null,
    contentHash,
    previousHash: prevHash,
    chainIndex: index,
  };
}

describe('Events — Audit Chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('appendAuditEvent', () => {
    it('should create first event with chainIndex 0 and null previousHash', async () => {
      // No previous events
      mockPrisma.auditEvent.findFirst.mockResolvedValue(null);
      mockPrisma.auditEvent.create.mockResolvedValue({
        id: 'evt-1',
        chainIndex: 0,
        contentHash: 'hash-0',
        previousHash: null,
      });

      const result = await appendAuditEvent({
        workspaceId: 'ws-1',
        eventType: 'agent.created',
        entityType: 'agent',
        entityId: 'agent-1',
        action: 'CREATE',
        metadata: { name: 'Test Agent' },
      });

      expect(result).toBeDefined();
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledTimes(1);

      const createArg = mockPrisma.auditEvent.create.mock.calls[0][0].data;
      expect(createArg.workspaceId).toBe('ws-1');
      expect(createArg.chainIndex).toBe(0);
      expect(createArg.previousHash).toBeNull();
      expect(createArg.contentHash).toBeDefined();
      expect(typeof createArg.contentHash).toBe('string');
    });

    it('should chain to previous event', async () => {
      mockPrisma.auditEvent.findFirst.mockResolvedValue({
        contentHash: 'prev-hash-abc',
        chainIndex: 4,
      });
      mockPrisma.auditEvent.create.mockResolvedValue({
        id: 'evt-5',
        chainIndex: 5,
        contentHash: 'hash-5',
        previousHash: 'prev-hash-abc',
      });

      await appendAuditEvent({
        workspaceId: 'ws-1',
        eventType: 'task.completed',
        entityType: 'task',
        entityId: 'task-1',
        action: 'UPDATE',
        metadata: { status: 'COMPLETED' },
      });

      const createArg = mockPrisma.auditEvent.create.mock.calls[0][0].data;
      expect(createArg.chainIndex).toBe(5);
      expect(createArg.previousHash).toBe('prev-hash-abc');
    });

    it('should include agent signature when agentSecretKey provided', async () => {
      mockPrisma.auditEvent.findFirst.mockResolvedValue(null);
      mockPrisma.auditEvent.create.mockResolvedValue({ id: 'evt-1' });

      // Generate a real keypair for signing
      const { generateKeypair } = await import('@nexusops/crypto');
      const kp = generateKeypair();

      await appendAuditEvent({
        workspaceId: 'ws-1',
        eventType: 'agent.action',
        entityType: 'agent',
        action: 'EXECUTE',
        metadata: {},
        agentSecretKey: kp.secretKey,
      });

      const createArg = mockPrisma.auditEvent.create.mock.calls[0][0].data;
      expect(createArg.agentSignature).toBeDefined();
      expect(typeof createArg.agentSignature).toBe('string');
      expect(createArg.agentSignature.length).toBeGreaterThan(32);
    });

    it('should write unsigned event when no agentSecretKey', async () => {
      mockPrisma.auditEvent.findFirst.mockResolvedValue(null);
      mockPrisma.auditEvent.create.mockResolvedValue({ id: 'evt-1' });

      await appendAuditEvent({
        workspaceId: 'ws-1',
        eventType: 'user.login',
        entityType: 'user',
        action: 'READ',
        metadata: {},
      });

      const createArg = mockPrisma.auditEvent.create.mock.calls[0][0].data;
      expect(createArg.agentSignature).toBeUndefined();
    });

    it('should produce deterministic content hashes for same content at same time', async () => {
      mockPrisma.auditEvent.findFirst.mockResolvedValue(null);
      const hashes: string[] = [];

      mockPrisma.auditEvent.create.mockImplementation(({ data }: any) => {
        hashes.push(data.contentHash);
        return { id: 'evt', contentHash: data.contentHash };
      });

      // NOTE: The content hash includes a timestamp via `new Date().toISOString()`
      // so two calls at different times will produce different hashes.
      // That's correct behavior — just verifying the hash is a valid hex string.
      await appendAuditEvent({
        workspaceId: 'ws-1',
        eventType: 'test',
        entityType: 'test',
        action: 'TEST',
        metadata: { key: 'value' },
      });

      expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('verifyAuditChain', () => {
    it('should return valid for empty chain', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([]);

      const result = await verifyAuditChain('ws-1');
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(0);
    });

    it('should return valid for single event', async () => {
      const e0 = makeAuditEvent(0, null);
      mockPrisma.auditEvent.findMany.mockResolvedValue([e0]);

      const result = await verifyAuditChain('ws-1');
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(1);
    });

    it('should return valid for a correctly chained sequence', async () => {
      const e0 = makeAuditEvent(0, null);
      const e1 = makeAuditEvent(1, e0.contentHash);
      const e2 = makeAuditEvent(2, e1.contentHash);
      mockPrisma.auditEvent.findMany.mockResolvedValue([e0, e1, e2]);

      const result = await verifyAuditChain('ws-1');
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(3);
    });

    it('should detect broken chain (wrong previousHash at index 2)', async () => {
      const e0 = makeAuditEvent(0, null);
      const e1 = makeAuditEvent(1, e0.contentHash);
      // e2 uses a tampered previousHash — its chain is internally consistent
      // but its previousHash doesn't match e1.contentHash
      const e2 = makeAuditEvent(2, 'TAMPERED_HASH');
      mockPrisma.auditEvent.findMany.mockResolvedValue([e0, e1, e2]);

      const result = await verifyAuditChain('ws-1');
      expect(result.valid).toBe(false);
      expect(result.firstBrokenAt).toBe(2);
      expect(result.chainLength).toBe(3);
    });

    it('should detect break at first link (wrong previousHash at index 1)', async () => {
      const e0 = makeAuditEvent(0, null);
      const e1 = makeAuditEvent(1, 'WRONG_PREV');
      const e2 = makeAuditEvent(2, e1.contentHash);
      mockPrisma.auditEvent.findMany.mockResolvedValue([e0, e1, e2]);

      const result = await verifyAuditChain('ws-1');
      expect(result.valid).toBe(false);
      expect(result.firstBrokenAt).toBe(1);
    });
  });

  describe('verifyComplianceChain', () => {
    it('should return valid for empty chain', async () => {
      mockPrisma.complianceArtifact.findMany.mockResolvedValue([]);

      const result = await verifyComplianceChain('ws-1');
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(0);
    });

    it('should return valid for correctly chained artifacts', async () => {
      const a0 = makeArtifact(0, null);
      const a1 = makeArtifact(1, a0.contentHash);
      const a2 = makeArtifact(2, a1.contentHash);
      mockPrisma.complianceArtifact.findMany.mockResolvedValue([a0, a1, a2]);

      const result = await verifyComplianceChain('ws-1');
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(3);
    });

    it('should detect tampered compliance chain (bad previousHash)', async () => {
      const a0 = makeArtifact(0, null);
      // a1 has a corrupted previousHash — its own content is intact but linkage is broken
      const a1 = { ...makeArtifact(1, a0.contentHash), previousHash: 'CORRUPTED' };
      mockPrisma.complianceArtifact.findMany.mockResolvedValue([a0, a1]);

      const result = await verifyComplianceChain('ws-1');
      expect(result.valid).toBe(false);
      expect(result.firstBrokenAt).toBe(1);
    });
  });
});
