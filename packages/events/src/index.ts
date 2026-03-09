/**
 * @nexusops/events — Immutable Audit Trail & Compliance Artifact Assembly
 *
 * Two core responsibilities:
 * 1. appendAuditEvent()  — SHA-3 chained, Ed25519 signed audit events
 * 2. createComplianceArtifact() — 6-component evidence vault entry
 *
 * Both are append-only. Database triggers enforce immutability.
 * Signature is ASYNC via BullMQ — the event is written immediately with contentHash,
 * then a background job signs it within 100ms.
 */

import { prisma, PolicyAction, DataClassification, type Prisma } from '@nexusops/db';
import { hashSha3, chainHash, signPayload, hashComplianceContent } from '@nexusops/crypto';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('events');

// ─── Redis chain head cache for O(1) chain append ───
let redisClient: any = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    redisClient.connect().catch(() => { redisClient = null; });
  }
} catch {
  // Redis not available — fall back to DB query for chain head
}

const CHAIN_HEAD_KEY = (ws: string, type: string) => `chain:${type}:${ws}:head`;

async function getChainHead(workspaceId: string, type: 'audit' | 'compliance') {
  // Try Redis cache first
  if (redisClient) {
    try {
      const cached = await redisClient.get(CHAIN_HEAD_KEY(workspaceId, type));
      if (cached) return JSON.parse(cached) as { contentHash: string; chainIndex: number };
    } catch { /* fall through to DB */ }
  }

  // Fall back to database
  const model = type === 'audit' ? prisma.auditEvent : prisma.complianceArtifact;
  const latest = await (model as any).findFirst({
    where: { workspaceId },
    orderBy: { chainIndex: 'desc' },
    select: { contentHash: true, chainIndex: true },
  });

  if (latest && redisClient) {
    await redisClient.set(
      CHAIN_HEAD_KEY(workspaceId, type),
      JSON.stringify({ contentHash: latest.contentHash, chainIndex: latest.chainIndex }),
      'EX', 3600,
    ).catch(() => {});
  }

  return latest;
}

async function updateChainHead(workspaceId: string, type: 'audit' | 'compliance', contentHash: string, chainIndex: number) {
  if (redisClient) {
    await redisClient.set(
      CHAIN_HEAD_KEY(workspaceId, type),
      JSON.stringify({ contentHash, chainIndex }),
      'EX', 3600,
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// AUDIT EVENTS — SHA-3 chained, append-only
// ─────────────────────────────────────────────

export interface AuditEventInput {
  workspaceId: string;
  userId?: string;
  eventType: string;       // e.g., "agent.created", "task.cancelled"
  entityType: string;       // e.g., "agent", "task", "policy"
  entityId?: string;
  action: string;           // CRUD operation
  metadata: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  provider?: string;        // OPENAI, ANTHROPIC, etc.
  agentSecretKey?: string;  // If agent-originated, sign immediately
}

/**
 * Append an immutable audit event to the chain.
 *
 * 1. Fetch the latest chain state for the workspace (chainIndex + previousHash)
 * 2. Compute SHA-3-256 content hash
 * 3. Chain hash = SHA-3(previousHash + ':' + contentHash)
 * 4. Write event atomically with chain metadata
 * 5. If agentSecretKey provided, sign synchronously (< 50μs in Rust)
 */
export async function appendAuditEvent(input: AuditEventInput) {
  const {
    workspaceId,
    userId,
    eventType,
    entityType,
    entityId,
    action,
    metadata,
    ipAddress,
    userAgent,
    provider,
    agentSecretKey,
  } = input;

  // Pin the timestamp BEFORE hashing so the stored createdAt matches exactly
  // what was included in the chain hash. This allows the verifier to recompute
  // contentHash from stored fields without needing a separate timestamp column.
  const createdAt = new Date();

  // Serialize the content deterministically for hashing
  const contentString = JSON.stringify({
    workspaceId,
    eventType,
    entityType,
    entityId,
    action,
    metadata,
    provider,
    timestamp: createdAt.toISOString(),
  });

  // Get the latest chain state for this workspace (Redis-cached)
  const latest = await getChainHead(workspaceId, 'audit');

  const previousHash = latest?.contentHash ?? null;
  const chainIndex = (latest?.chainIndex ?? -1) + 1;
  const contentHash = chainHash(previousHash, contentString);

  // Sign if agent key provided (inline — Rust napi is fast enough)
  let agentSignature: string | undefined;
  if (agentSecretKey) {
    try {
      agentSignature = signPayload(contentHash, agentSecretKey);
    } catch (err) {
      logger.warn({ err }, 'Failed to sign audit event — writing unsigned');
    }
  }

  const event = await prisma.auditEvent.create({
    data: {
      workspaceId,
      userId,
      eventType,
      entityType,
      entityId,
      action,
      metadata: metadata as Prisma.InputJsonValue,
      ipAddress,
      userAgent,
      contentHash,
      previousHash,
      chainIndex,
      agentSignature,
      provider,
      // Must match the timestamp we hashed above so the verifier can recompute
      createdAt,
    },
  });

  logger.info(
    { eventId: event.id, eventType, chainIndex, workspaceId },
    'Audit event appended',
  );

  // Update Redis chain head cache
  await updateChainHead(workspaceId, 'audit', contentHash, chainIndex);

  return event;
}

/**
 * Verify the integrity of the audit chain for a workspace.
 * Recomputes every hash from GENESIS and checks for breaks.
 */
export async function verifyAuditChain(workspaceId: string): Promise<{
  valid: boolean;
  chainLength: number;
  firstBrokenAt?: number;
}> {
  // Fetch full content fields so we can RECOMPUTE each hash from raw data.
  // Verifying only stored hash linkage (previousHash === prev.contentHash) is
  // insufficient — a tampered event could preserve chain linkage while corrupting
  // the content. We must re-derive contentHash and compare against the stored value.
  const events = await prisma.auditEvent.findMany({
    where: { workspaceId },
    orderBy: { chainIndex: 'asc' },
    select: {
      id: true,
      workspaceId: true,
      eventType: true,
      entityType: true,
      entityId: true,
      action: true,
      metadata: true,
      provider: true,
      createdAt: true,
      contentHash: true,
      previousHash: true,
      chainIndex: true,
    },
  });

  if (events.length === 0) {
    return { valid: true, chainLength: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // Recompute the chain hash from the stored content fields.
    // The canonical contentString must match exactly what appendAuditEvent wrote.
    const contentString = JSON.stringify({
      workspaceId: ev.workspaceId,
      eventType: ev.eventType,
      entityType: ev.entityType,
      entityId: ev.entityId,
      action: ev.action,
      metadata: ev.metadata,
      provider: ev.provider,
      timestamp: ev.createdAt.toISOString(),
    });

    const expectedHash = chainHash(ev.previousHash, contentString);
    if (expectedHash !== ev.contentHash) {
      logger.error(
        { workspaceId, firstBrokenAt: i, eventId: ev.id, expectedHash, storedHash: ev.contentHash },
        'Audit chain content integrity violation — event data was tampered',
      );
      return { valid: false, chainLength: events.length, firstBrokenAt: i };
    }

    // Also verify cross-event linkage (previousHash === prev event's contentHash)
    if (i > 0) {
      const prevStored = events[i - 1].contentHash;
      if (prevStored !== ev.previousHash) {
        logger.error(
          { workspaceId, firstBrokenAt: i, prevStored, storedPreviousHash: ev.previousHash },
          'Audit chain linkage violation — previousHash does not match prior event',
        );
        return { valid: false, chainLength: events.length, firstBrokenAt: i };
      }
    }
  }

  return { valid: true, chainLength: events.length };
}

// ─────────────────────────────────────────────
// COMPLIANCE ARTIFACTS — 6-component evidence vault
// ─────────────────────────────────────────────

export interface ComplianceArtifactInput {
  workspaceId: string;
  taskId: string;
  agentId: string;

  // Component 1: User Intent
  userPrompt: string;
  submittedByUserId?: string;
  submittedAt: Date;

  // Component 2: Agent Reasoning Chain
  reasoningChain?: Array<{
    step: number;
    thought: string;
    action: string;
  }>;

  // Component 3: Context Retrieved
  contextRefs?: Array<{
    source: string;
    contentHash: string;
    classification: string;
  }>;

  // Component 4: Policy Evaluation Record
  policyDecision: PolicyAction;
  policyRuleId?: string;
  policyVersion?: number;

  // Component 5: System Execution Record
  toolCallId?: string;
  requestPayloadHash?: string;
  responsePayloadHash?: string;
  executionDurationMs?: number;
  costUsd?: number;
  dataClassificationTouched?: DataClassification;
  provider?: string;

  // Signing (optional — async via BullMQ if not provided)
  agentSecretKey?: string;
}

/**
 * Create a 6-component Compliance Artifact with integrity seal.
 *
 * 1. Hash components 1-5 into a canonical content hash (SHA-3-256)
 * 2. Chain to previous artifact for this workspace
 * 3. Sign with agent key if available
 * 4. Write atomically as immutable record
 */
export async function createComplianceArtifact(input: ComplianceArtifactInput) {
  const {
    workspaceId,
    taskId,
    agentId,
    userPrompt,
    submittedByUserId,
    submittedAt,
    reasoningChain,
    contextRefs,
    policyDecision,
    policyRuleId,
    policyVersion = 1,
    toolCallId,
    requestPayloadHash,
    responsePayloadHash,
    executionDurationMs,
    costUsd = 0,
    dataClassificationTouched = DataClassification.PUBLIC,
    provider,
    agentSecretKey,
  } = input;

  // Build policy input hash for tamper detection
  const policyInputHash = hashSha3(
    JSON.stringify({ policyDecision, policyRuleId, policyVersion }),
  );

  // Component 1-5 canonical content hash
  const contentHash = hashComplianceContent({
    userPrompt,
    reasoningChain,
    contextRefs,
    policyDecision,
    executionRecord: {
      toolCallId,
      requestPayloadHash,
      responsePayloadHash,
      executionDurationMs,
      costUsd,
      dataClassificationTouched,
      provider,
    },
  });

  // Chain to previous artifact (Redis-cached)
  const latest = await getChainHead(workspaceId, 'compliance');

  const previousHash = latest?.contentHash ?? null;
  const chainIndex = (latest?.chainIndex ?? -1) + 1;

  // Sign if key available
  let agentSignature: string | undefined;
  if (agentSecretKey) {
    try {
      agentSignature = signPayload(contentHash, agentSecretKey);
    } catch (err) {
      logger.warn({ err }, 'Failed to sign compliance artifact — writing unsigned');
    }
  }

  const artifact = await prisma.complianceArtifact.create({
    data: {
      workspaceId,
      taskId,
      agentId,
      userPrompt,
      submittedByUserId,
      submittedAt,
      reasoningChain: (reasoningChain as Prisma.InputJsonValue) ?? undefined,
      reasoningCapturedAt: reasoningChain ? new Date() : undefined,
      contextRefs: (contextRefs as Prisma.InputJsonValue) ?? undefined,
      policyDecision,
      policyRuleId,
      policyVersion,
      policyInputHash,
      toolCallId,
      requestPayloadHash,
      responsePayloadHash,
      executionDurationMs,
      costUsd,
      dataClassificationTouched,
      provider,
      contentHash,
      previousHash,
      chainIndex,
      agentSignature,
    },
  });

  logger.info(
    { artifactId: artifact.id, taskId, chainIndex, workspaceId },
    'Compliance artifact created',
  );

  // Update Redis chain head cache
  await updateChainHead(workspaceId, 'compliance', contentHash, chainIndex);

  return artifact;
}

/**
 * Verify compliance artifact chain integrity for a workspace.
 */
export async function verifyComplianceChain(workspaceId: string): Promise<{
  valid: boolean;
  chainLength: number;
  firstBrokenAt?: number;
}> {
  // Fetch full content fields so the verifier can RECOMPUTE each content hash
  // from raw data rather than trusting the stored value (same approach as
  // verifyAuditChain). An attacker who tampers with data AND updates contentHash
  // in storage would be detected only if we recompute from first principles.
  const artifacts = await prisma.complianceArtifact.findMany({
    where: { workspaceId },
    orderBy: { chainIndex: 'asc' },
    select: {
      id: true,
      userPrompt: true,
      reasoningChain: true,
      contextRefs: true,
      policyDecision: true,
      toolCallId: true,
      requestPayloadHash: true,
      responsePayloadHash: true,
      executionDurationMs: true,
      costUsd: true,
      dataClassificationTouched: true,
      provider: true,
      contentHash: true,
      previousHash: true,
      chainIndex: true,
    },
  });

  if (artifacts.length === 0) {
    return { valid: true, chainLength: 0 };
  }

  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];

    // Recompute the content hash from stored fields
    const expectedContentHash = hashComplianceContent({
      userPrompt: a.userPrompt,
      reasoningChain: a.reasoningChain,
      contextRefs: a.contextRefs,
      policyDecision: a.policyDecision,
      executionRecord: {
        toolCallId: a.toolCallId,
        requestPayloadHash: a.requestPayloadHash,
        responsePayloadHash: a.responsePayloadHash,
        executionDurationMs: a.executionDurationMs,
        costUsd: a.costUsd,
        dataClassificationTouched: a.dataClassificationTouched,
        provider: a.provider,
      },
    });

    if (expectedContentHash !== a.contentHash) {
      logger.error(
        { workspaceId, firstBrokenAt: i, artifactId: a.id, expectedContentHash, storedHash: a.contentHash },
        'Compliance chain content integrity violation — artifact data was tampered',
      );
      return { valid: false, chainLength: artifacts.length, firstBrokenAt: i };
    }

    // Verify cross-artifact linkage
    if (i > 0) {
      const prevStored = artifacts[i - 1].contentHash;
      if (prevStored !== a.previousHash) {
        logger.error(
          { workspaceId, firstBrokenAt: i, prevStored, storedPreviousHash: a.previousHash },
          'Compliance chain linkage violation — previousHash does not match prior artifact',
        );
        return { valid: false, chainLength: artifacts.length, firstBrokenAt: i };
      }
    }
  }

  return { valid: true, chainLength: artifacts.length };
}

// Re-export webhook/Slack notification service
export {
  sendWebhookNotification,
  sendSlackNotification,
  type WebhookPayload,
  type WebhookConfig,
} from './notifications';

export { notifyEscalation, notifyDecision } from './slack';
