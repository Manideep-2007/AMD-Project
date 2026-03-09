import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { z } from 'zod';
import { verifyAuditChain } from '@nexusops/events';

/** Hard ceiling on export rows to prevent memory/bandwidth abuse */
const MAX_EXPORT_ROWS = 10_000;

const listAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  eventType: z.string().optional(),
  entityType: z.string().optional(),
  userId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const exportAuditQuerySchema = z.object({
  eventType: z.string().optional(),
  entityType: z.string().optional(),
  userId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EXPORT_ROWS).optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/audit
   * Query audit log
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const {
        page,
        limit,
        eventType,
        entityType,
        userId,
        startDate,
        endDate,
      } = listAuditQuerySchema.parse(request.query);

      const where = {
        workspaceId: request.workspaceId!,
        ...(eventType && { eventType }),
        ...(entityType && { entityType }),
        ...(userId && { userId }),
        ...(startDate &&
          endDate && {
            createdAt: {
              gte: new Date(startDate),
              lte: new Date(endDate),
            },
          }),
      };

      const [events, total] = await Promise.all([
        prisma.auditEvent.findMany({
          where,
          take: Math.min(limit, 100),
          skip: (page - 1) * limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
          },
        }),
        prisma.auditEvent.count({ where }),
      ]);

      return {
        data: {
          items: events,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/audit/stats
   * Audit statistics
   */
  app.get('/stats', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [totalEvents, byEventType, byUser] = await Promise.all([
        prisma.auditEvent.count({
          where: { workspaceId, createdAt: { gte: since } },
        }),
        prisma.auditEvent.groupBy({
          by: ['eventType'],
          where: { workspaceId, createdAt: { gte: since } },
          _count: true,
        }),
        prisma.auditEvent.groupBy({
          by: ['userId'],
          where: { workspaceId, createdAt: { gte: since }, userId: { not: null } },
          _count: true,
          orderBy: { _count: { userId: 'desc' } },
          take: 10,
        }),
      ]);

      return {
        data: {
          totalEvents,
          byEventType: byEventType.map((item: any) => ({
            eventType: item.eventType,
            count: item._count,
          })),
          topUsers: byUser.map((item: any) => ({
            userId: item.userId,
            count: item._count,
          })),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/audit/export
   * Export audit events as JSON (OWNER / ADMIN only, capped at MAX_EXPORT_ROWS)
   */
  app.get('/export', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const {
        eventType,
        entityType,
        userId,
        startDate,
        endDate,
        limit: rawLimit,
      } = exportAuditQuerySchema.parse(request.query);

      const cappedLimit = Math.min(rawLimit ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);

      const where = {
        workspaceId: request.workspaceId!,
        ...(eventType && { eventType }),
        ...(entityType && { entityType }),
        ...(userId && { userId }),
        ...(startDate &&
          endDate && {
            createdAt: {
              gte: new Date(startDate),
              lte: new Date(endDate),
            },
          }),
      };

      const [events, total] = await Promise.all([
        prisma.auditEvent.findMany({
          where,
          take: cappedLimit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: { id: true, email: true, name: true },
            },
          },
        }),
        prisma.auditEvent.count({ where }),
      ]);

      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="audit-export-${new Date().toISOString().slice(0, 10)}.json"`,
      );

      return {
        data: {
          items: events,
          exported: events.length,
          totalAvailable: total,
          capped: total > cappedLimit,
          maxExportRows: MAX_EXPORT_ROWS,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/audit/verify
   * Verify integrity of the SHA-3 audit chain for the workspace.
   * Recomputes every hash from GENESIS and reports the first broken link.
   */
  app.get('/verify', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const result = await verifyAuditChain(workspaceId);

      return {
        data: {
          valid: result.valid,
          chainLength: result.chainLength,
          firstBrokenAt: result.firstBrokenAt ?? null,
          verifiedAt: new Date().toISOString(),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
