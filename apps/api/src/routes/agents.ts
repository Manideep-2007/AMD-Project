import { FastifyPluginAsync } from 'fastify';
import { prisma, AgentStatus, type Prisma } from '@nexusops/db';
import { z } from 'zod';

const createAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string(),
  toolPermissions: z.array(z.string()),
  config: z.record(z.unknown()).optional(),
  maxTokens: z.number().optional(),
  maxCostUsd: z.number().optional(),
  maxExecutionMs: z.number().optional(),
  maxDepth: z.number().default(10),
});

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/agents
   * Register a new agent
   */
  app.post('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const body = createAgentSchema.parse(request.body);

      const agent = await prisma.agent.create({
        data: {
          workspaceId: request.workspaceId!,
          name: body.name,
          description: body.description,
          version: body.version,
          status: AgentStatus.IDLE,
          config: (body.config || {}) as Prisma.InputJsonValue,
          toolPermissions: body.toolPermissions,
          maxTokens: body.maxTokens,
          maxCostUsd: body.maxCostUsd,
          maxExecutionMs: body.maxExecutionMs,
          maxDepth: body.maxDepth,
        },
      });

      // Audit log
      await prisma.auditEvent.create({
        data: {
          workspaceId: request.workspaceId!,
          userId: request.user?.userId,
          eventType: 'agent.created',
          entityType: 'agent',
          entityId: agent.id,
          action: 'CREATE',
          metadata: { agentName: agent.name },
        },
      });

      return {
        data: agent,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/agents
   * List agents
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { page = 1, limit = 50, status } = request.query as any;

      const where = {
        workspaceId: request.workspaceId!,
        ...(status && { status }),
      };

      const [agents, total] = await Promise.all([
        prisma.agent.findMany({
          where,
          take: Math.min(limit, 100),
          skip: (page - 1) * limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.agent.count({ where }),
      ]);

      return {
        data: {
          items: agents,
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
   * GET /api/v1/agents/:id
   * Get agent details
   */
  app.get('/:id', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const agent = await prisma.agent.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
        include: {
          _count: {
            select: {
              tasks: true,
              toolCalls: true,
            },
          },
        },
      });

      if (!agent) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
      }

      return {
        data: agent,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * DELETE /api/v1/agents/:id
   * Deregister agent
   */
  app.delete('/:id', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const agent = await prisma.agent.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
      });

      if (!agent) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        });
      }

      await prisma.agent.update({
        where: { id },
        data: {
          status: AgentStatus.TERMINATED,
          terminatedAt: new Date(),
        },
      });

      // Audit log
      await prisma.auditEvent.create({
        data: {
          workspaceId: request.workspaceId!,
          userId: request.user?.userId,
          eventType: 'agent.terminated',
          entityType: 'agent',
          entityId: agent.id,
          action: 'DELETE',
          metadata: { agentName: agent.name },
        },
      });

      return {
        data: { success: true },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
