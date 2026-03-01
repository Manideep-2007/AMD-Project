import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/audit
   * Query audit log
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const {
        page = 1,
        limit = 50,
        eventType,
        entityType,
        userId,
        startDate,
        endDate,
      } = request.query as any;

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
};
