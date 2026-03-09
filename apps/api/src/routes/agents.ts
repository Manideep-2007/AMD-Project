import { FastifyPluginAsync } from 'fastify';
import { prisma, AgentStatus, TaskStatus, type Prisma } from '@nexusops/db';
import { z } from 'zod';
import { appendAuditEvent } from '@nexusops/events';

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

const listAgentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.nativeEnum(AgentStatus).optional(),
});

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/agents
   * Register a new agent
   */
  app.post('/', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN', 'OPERATOR'])],
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

      // Audit log (SHA-3 chained — never bypass with prisma.auditEvent.create)
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user?.userId,
        eventType: 'agent.created',
        entityType: 'agent',
        entityId: agent.id,
        action: 'CREATE',
        metadata: { agentName: agent.name },
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
      const { page, limit, status } = listAgentsQuerySchema.parse(request.query);

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

      // Audit log (SHA-3 chained — never bypass with prisma.auditEvent.create)
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user?.userId,
        eventType: 'agent.terminated',
        entityType: 'agent',
        entityId: agent.id,
        action: 'DELETE',
        metadata: { agentName: agent.name },
      });

      return {
        data: { success: true },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * POST /api/v1/agents/:id/emergency-stop
   * Emergency kill switch — terminates agent AND cancels all its running tasks.
   * This is the "red button" endpoint the audit requires.
   */
  app.post('/:id/emergency-stop', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN', 'OPERATOR'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const agent = await prisma.agent.findFirst({
        where: { id, workspaceId: request.workspaceId! },
      });

      if (!agent) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'NOT_FOUND', message: 'Agent not found' },
        });
      }

      if (agent.status === AgentStatus.TERMINATED) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'ALREADY_TERMINATED', message: 'Agent is already terminated' },
        });
      }

      // 1. Terminate agent
      await prisma.agent.update({
        where: { id },
        data: {
          status: AgentStatus.TERMINATED,
          terminatedAt: new Date(),
        },
      });

      // 2. Cancel ALL running/pending tasks for this agent
      const cancelledTasks = await prisma.task.updateMany({
        where: {
          agentId: id,
          workspaceId: request.workspaceId!,
          status: { in: [TaskStatus.RUNNING, TaskStatus.PENDING, TaskStatus.PENDING_APPROVAL, TaskStatus.QUEUED] },
        },
        data: {
          status: TaskStatus.CANCELLED,
          completedAt: new Date(),
        },
      });

      // 3. Auto-deny any pending approvals for this agent's tasks
      const pendingApprovals = await prisma.taskApproval.findMany({
        where: {
          decidedAt: null,
          task: { agentId: id, workspaceId: request.workspaceId! },
        },
      });

      for (const approval of pendingApprovals) {
        await prisma.taskApproval.update({
          where: { id: approval.id },
          data: {
            approved: false,
            userId: request.user?.userId ?? null,
            reason: 'Agent emergency-stopped',
            decidedAt: new Date(),
          },
        });
      }

      // 4. Audit event (cryptographic chain)
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user?.userId,
        eventType: 'agent.emergency_stop',
        entityType: 'agent',
        entityId: id,
        action: 'EMERGENCY_STOP',
        metadata: {
          agentName: agent.name,
          cancelledTaskCount: cancelledTasks.count,
          cancelledApprovalCount: pendingApprovals.length,
        },
      });

      return {
        data: {
          success: true,
          cancelledTasks: cancelledTasks.count,
          cancelledApprovals: pendingApprovals.length,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
