import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';

export const toolsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/tools/calls
   * List tool calls
   */
  app.get('/calls', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { page = 1, limit = 50, toolType, agentId, taskId, blocked } = request.query as any;

      const where = {
        workspaceId: request.workspaceId!,
        ...(toolType && { toolType }),
        ...(agentId && { agentId }),
        ...(taskId && { taskId }),
        ...(blocked !== undefined && { blocked: blocked === 'true' }),
      };

      const [calls, total] = await Promise.all([
        prisma.toolCall.findMany({
          where,
          take: Math.min(limit, 100),
          skip: (page - 1) * limit,
          orderBy: { createdAt: 'desc' },
          include: {
            agent: {
              select: {
                id: true,
                name: true,
              },
            },
            task: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        prisma.toolCall.count({ where }),
      ]);

      return {
        data: {
          items: calls,
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
   * GET /api/v1/tools/stats
   * Get tool usage statistics
   */
  app.get('/stats', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;

      // Get stats for last 24 hours
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [totalCalls, blockedCalls, byTool] = await Promise.all([
        prisma.toolCall.count({
          where: { workspaceId, createdAt: { gte: since } },
        }),
        prisma.toolCall.count({
          where: { workspaceId, blocked: true, createdAt: { gte: since } },
        }),
        prisma.toolCall.groupBy({
          by: ['toolType'],
          where: { workspaceId, createdAt: { gte: since } },
          _count: true,
        }),
      ]);

      return {
        data: {
          totalCalls,
          blockedCalls,
          blockRate: totalCalls > 0 ? (blockedCalls / totalCalls) * 100 : 0,
          byTool: byTool.map((item: any) => ({
            toolType: item.toolType,
            count: item._count,
          })),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
