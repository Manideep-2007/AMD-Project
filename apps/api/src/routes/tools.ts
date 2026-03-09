import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { z } from 'zod';
import { appendAuditEvent } from '@nexusops/events';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('routes:tools');

const executeToolSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  toolType: z.enum([
    'GITHUB', 'JIRA', 'DATABASE',
    'CLOUD_DEPLOY', 'SLACK', 'HTTP_EXTERNAL',
    'LLM_API',
  ]),
  toolMethod: z.string().min(1),
  input: z.record(z.unknown()),
  traceId: z.string().optional(),
  signature: z.string().min(1),
  timestamp: z.number().int().positive(),
});

export const toolsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/tools/execute
   * Primary agent tool execution endpoint — every SDK callTool() hits this.
   * Validates ownership, prevents replay attacks, then forwards to proxy pipeline.
   */
  app.post('/execute', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const parseResult = executeToolSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: parseResult.error.flatten(),
          },
        });
      }

      const body = parseResult.data;
      const workspaceId = request.workspaceId!;

      // Verify agent belongs to this workspace and is not terminated
      const agent = await prisma.agent.findFirst({
        where: {
          id: body.agentId,
          workspaceId,
          status: { not: 'TERMINATED' },
        },
      });

      if (!agent) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found or terminated',
          },
        });
      }

      // Verify task belongs to this workspace and agent and is in a runnable state
      const task = await prisma.task.findFirst({
        where: {
          id: body.taskId,
          workspaceId,
          agentId: body.agentId,
          status: { in: ['RUNNING', 'PENDING', 'QUEUED'] },
        },
      });

      if (!task) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'TASK_NOT_FOUND',
            message: 'Task not found or not in runnable state',
          },
        });
      }

      // Timestamp replay attack prevention (30-second window)
      const now = Date.now();
      if (Math.abs(now - body.timestamp) > 30000) {
        return reply.code(401).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'TIMESTAMP_REPLAY_ATTACK',
            message: 'Request timestamp outside 30-second window',
          },
        });
      }

      // Forward to proxy enforcement pipeline
      // The proxy handles: identity, injection, policy, SQL gate, budget, anomaly, execution, audit
      const proxyUrl = process.env.PROXY_INTERNAL_URL || 'http://localhost:3003';
      const proxySecret = process.env.PROXY_INTERNAL_SECRET;

      if (!proxySecret) {
        logger.error('PROXY_INTERNAL_SECRET not configured');
        return reply.code(500).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'CONFIGURATION_ERROR',
            message: 'Proxy not configured',
          },
        });
      }

      try {
        const proxyResponse = await fetch(`${proxyUrl}/proxy/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-proxy-secret': proxySecret,
            'x-agent-signature': body.signature,
            'x-timestamp': body.timestamp.toString(),
          },
          body: JSON.stringify({
            workspaceId,
            agentId: body.agentId,
            taskId: body.taskId,
            toolType: body.toolType,
            toolMethod: body.toolMethod,
            input: body.input,
            traceId: body.traceId || task.traceId,
            userId: request.user?.userId,
            userRole: request.user?.role,
          }),
        });

        const proxyResult = await proxyResponse.json();

        // Surface proxy decisions clearly to SDK
        return reply.code(proxyResponse.status).send({
          data: proxyResult,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: proxyResponse.ok ? null : proxyResult,
        });
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to reach proxy');
        return reply.code(502).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'PROXY_UNREACHABLE',
            message: 'Tool execution proxy is unreachable',
          },
        });
      }
    },
  });

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
