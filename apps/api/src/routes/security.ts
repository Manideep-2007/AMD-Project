/**
 * Security API Routes
 * Compliance chain verification, injection scanner, security overview.
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { verifyAuditChain, verifyComplianceChain } from '@nexusops/events';
import { scanText } from '@nexusops/injection';
import { z } from 'zod';

const scanSchema = z.object({
  text: z.string(),
  strict: z.boolean().default(false),
});

export const securityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/security/overview
   * Security dashboard overview
   */
  app.get('/overview', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const workspaceId = request.workspaceId!;
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [
        blockedCalls,
        escalations,
        complianceArtifacts,
        policyViolations,
        totalToolCalls,
      ] = await Promise.all([
        prisma.toolCall.count({
          where: { workspaceId, blocked: true, createdAt: { gt: last24h } },
        }),
        prisma.taskApproval.count({
          where: { task: { workspaceId }, createdAt: { gt: last24h } },
        }),
        prisma.complianceArtifact.count({
          where: { workspaceId, createdAt: { gt: last24h } },
        }),
        prisma.policyEvaluation.count({
          where: {
            task: { workspaceId },
            action: 'DENY',
            createdAt: { gt: last24h },
          },
        }),
        prisma.toolCall.count({
          where: { workspaceId, createdAt: { gt: last24h } },
        }),
      ]);

      return {
        data: {
          last24h: {
            blockedCalls,
            escalations,
            complianceArtifacts,
            policyViolations,
            totalToolCalls,
            blockRate: totalToolCalls > 0
              ? ((blockedCalls / totalToolCalls) * 100).toFixed(2)
              : '0.00',
          },
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/security/chain/audit
   * Verify audit event chain integrity
   */
  app.get('/chain/audit', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const result = await verifyAuditChain(request.workspaceId!);
      return {
        data: result,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/security/chain/compliance
   * Verify compliance artifact chain integrity
   */
  app.get('/chain/compliance', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const result = await verifyComplianceChain(request.workspaceId!);
      return {
        data: result,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/security/chain/nodes
   * Returns the last N audit events with hash chain data for visualization.
   */
  app.get('/chain/nodes', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const wsId = request.workspaceId!;
      const limit = Math.min(Number((request.query as any).limit) || 15, 50);

      const events = await prisma.auditEvent.findMany({
        where: { workspaceId: wsId },
        orderBy: { chainIndex: 'desc' },
        take: limit,
        select: {
          id: true,
          chainIndex: true,
          eventType: true,
          action: true,
          entityType: true,
          entityId: true,
          contentHash: true,
          previousHash: true,
          createdAt: true,
        },
      });

      // Return in ascending order so the client can render left → right
      return {
        data: events.reverse(),
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * POST /api/v1/security/scan
   * Scan text for prompt injection
   */
  app.post('/scan', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const body = scanSchema.parse(request.body);
      const result = scanText(body.text, body.strict);

      return {
        data: result,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/security/compliance-artifacts
   * List compliance artifacts with pagination
   */
  app.get('/compliance-artifacts', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const { page = 1, limit = 25, taskId, agentId } = request.query as any;

      const where: any = { workspaceId: request.workspaceId! };
      if (taskId) where.taskId = taskId;
      if (agentId) where.agentId = agentId;

      const [artifacts, total] = await Promise.all([
        prisma.complianceArtifact.findMany({
          where,
          take: Math.min(Number(limit), 100),
          skip: (Number(page) - 1) * Number(limit),
          orderBy: { createdAt: 'desc' },
        }),
        prisma.complianceArtifact.count({ where }),
      ]);

      return {
        data: {
          items: artifacts,
          total,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
