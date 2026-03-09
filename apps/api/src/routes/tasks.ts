import { FastifyPluginAsync } from 'fastify';
import { prisma, TaskStatus, type Prisma } from '@nexusops/db';
import { queueManager, JobType } from '@nexusops/queue';
import { appendAuditEvent } from '@nexusops/events';
import { z } from 'zod';
import { nanoid } from 'nanoid';

const createTaskSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  input: z.record(z.unknown()),
});

const listTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.nativeEnum(TaskStatus).optional(),
  agentId: z.string().optional(),
});

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/tasks
   * Submit a new task
   */
  app.post('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const body = createTaskSchema.parse(request.body);

      // Verify agent exists and belongs to workspace
      const agent = await prisma.agent.findFirst({
        where: {
          id: body.agentId,
          workspaceId: request.workspaceId!,
        },
      });

      if (!agent) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found',
          },
        });
      }

      // Create task
      const task = await prisma.task.create({
        data: {
          workspaceId: request.workspaceId!,
          agentId: body.agentId,
          name: body.name,
          description: body.description,
          status: TaskStatus.PENDING,
          traceId: nanoid(),
          input: body.input as Prisma.InputJsonValue,
        },
      });

      // Queue task for execution
      await queueManager.addJob('tasks', 'execute-task', {
        type: JobType.EXECUTE_TASK,
        workspaceId: request.workspaceId!,
        payload: { taskId: task.id },
      });

      // Update task status
      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.QUEUED },
      });

      return {
        data: task,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/tasks
   * List tasks
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { page, limit, status, agentId } = listTasksQuerySchema.parse(request.query);

      const where = {
        workspaceId: request.workspaceId!,
        ...(status && { status }),
        ...(agentId && { agentId }),
      };

      const [tasks, total] = await Promise.all([
        prisma.task.findMany({
          where,
          take: Math.min(limit, 100),
          skip: (page - 1) * limit,
          orderBy: { createdAt: 'desc' },
          include: {
            agent: {
              select: {
                id: true,
                name: true,
                version: true,
              },
            },
          },
        }),
        prisma.task.count({ where }),
      ]);

      return {
        data: {
          items: tasks,
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
   * GET /api/v1/tasks/:id
   * Get task details
   */
  app.get('/:id', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const task = await prisma.task.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
        include: {
          agent: true,
          toolCalls: {
            orderBy: { createdAt: 'asc' },
          },
          policyEvals: {
            include: { policyRule: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!task) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
          },
        });
      }

      return {
        data: task,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * POST /api/v1/tasks/:id/cancel
   * Cancel a running task
   */
  app.post('/:id/cancel', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN', 'OPERATOR'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const task = await prisma.task.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
      });

      if (!task) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
          },
        });
      }

      if (
        task.status !== TaskStatus.PENDING &&
        task.status !== TaskStatus.QUEUED &&
        task.status !== TaskStatus.RUNNING
      ) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'INVALID_STATUS',
            message: 'Task cannot be cancelled in current status',
          },
        });
      }

      await prisma.task.update({
        where: { id },
        data: {
          status: TaskStatus.CANCELLED,
          completedAt: new Date(),
        },
      });

      // Audit log (SHA-3 chained — never bypass with prisma.auditEvent.create)
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user?.userId,
        eventType: 'task.cancelled',
        entityType: 'task',
        entityId: task.id,
        action: 'UPDATE',
        metadata: { taskName: task.name },
      });

      return {
        data: { success: true },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * POST /api/v1/tasks/:id/approve
   * Approve an escalated task action
   */
  app.post('/:id/approve', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN', 'OPERATOR'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const approveSchema = z.object({
        approved: z.boolean(),
        reason: z.string().min(1).max(1000).optional(),
      });
      const { approved, reason } = approveSchema.parse(request.body);

      const task = await prisma.task.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
      });

      if (!task) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
          },
        });
      }

      if (task.status !== TaskStatus.ESCALATED) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'INVALID_STATUS',
            message: 'Task is not in escalated status',
          },
        });
      }

      // Record approval
      await prisma.taskApproval.create({
        data: {
          taskId: task.id,
          userId: request.user!.userId,
          approved,
          reason,
        },
      });

      // Update task status
      if (approved) {
        await prisma.task.update({
          where: { id },
          data: { status: TaskStatus.QUEUED },
        });

        // Re-queue task
        await queueManager.addJob('tasks', 'execute-task', {
          type: JobType.EXECUTE_TASK,
          workspaceId: request.workspaceId!,
          payload: { taskId: task.id },
        });
      } else {
        await prisma.task.update({
          where: { id },
          data: {
            status: TaskStatus.CANCELLED,
            completedAt: new Date(),
          },
        });
      }

      // Audit log (SHA-3 chained — never bypass with prisma.auditEvent.create)
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user?.userId,
        eventType: approved ? 'task.approved' : 'task.rejected',
        entityType: 'task',
        entityId: task.id,
        action: 'UPDATE',
        metadata: { taskName: task.name, reason },
      });

      return {
        data: { success: true, approved },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
