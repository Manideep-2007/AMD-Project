/**
 * Approvals API Routes
 * Human-in-the-loop approval workflow for escalated tasks.
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma, TaskStatus } from '@nexusops/db';
import { queueManager, JobType } from '@nexusops/queue';
import { appendAuditEvent, notifyDecision } from '@nexusops/events';
import { z } from 'zod';

const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const approvalsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/approvals
   * List pending approvals for the workspace
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const { page = 1, limit = 50, pending } = request.query as { page?: number; limit?: number; pending?: string };

      const where: any = {
        task: {
          workspaceId: request.workspaceId!,
        },
      };

      if (pending === 'true') {
        where.decidedAt = null;
        where.OR = [
          { timeoutAt: null },
          { timeoutAt: { gt: new Date() } },
        ];
      }

      const [approvals, total] = await Promise.all([
        prisma.taskApproval.findMany({
          where,
          take: Math.min(Number(limit), 100),
          skip: (Number(page) - 1) * Number(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            task: {
              select: {
                id: true,
                name: true,
                agentId: true,
                status: true,
                agent: { select: { name: true } },
              },
            },
            user: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.taskApproval.count({ where }),
      ]);

      return {
        data: {
          items: approvals,
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

  /**
   * POST /api/v1/approvals/:id/decide
   * Approve or deny a pending approval
   */
  app.post('/:id/decide', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN', 'OPERATOR'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = approvalDecisionSchema.parse(request.body);

      const approval = await prisma.taskApproval.findUnique({
        where: { id },
        include: { task: { include: { agent: true } } },
      });

      if (!approval) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'NOT_FOUND', message: 'Approval not found' },
        });
      }

      if (approval.task.workspaceId !== request.workspaceId) {
        return reply.code(403).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'FORBIDDEN', message: 'Not authorized' },
        });
      }

      if (approval.decidedAt) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'ALREADY_DECIDED', message: 'Approval already decided' },
        });
      }

      // Check timeout
      if (approval.timeoutAt && approval.timeoutAt < new Date()) {
        return reply.code(400).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'TIMED_OUT', message: 'Approval has timed out' },
        });
      }

      // Record decision
      const updated = await prisma.taskApproval.update({
        where: { id },
        data: {
          approved: body.approved,
          reason: body.reason,
          userId: request.user.userId,
          decidedAt: new Date(),
        },
      });

      if (body.approved) {
        // Re-queue the task for execution
        await prisma.task.update({
          where: { id: approval.taskId },
          data: { status: TaskStatus.QUEUED },
        });

        await queueManager.addJob('tasks', `re-execute-${approval.taskId}`, {
          type: JobType.EXECUTE_TASK,
          workspaceId: request.workspaceId!,
          payload: { taskId: approval.taskId },
        });
      } else {
        // Deny — cancel the task
        await prisma.task.update({
          where: { id: approval.taskId },
          data: {
            status: TaskStatus.CANCELLED,
            completedAt: new Date(),
          },
        });
      }

      // Audit event
      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user.userId,
        eventType: body.approved ? 'approval.granted' : 'approval.denied',
        entityType: 'taskApproval',
        entityId: id,
        action: body.approved ? 'APPROVE' : 'DENY',
        metadata: {
          taskId: approval.taskId,
          reason: body.reason,
        },
      });

      // Notify Slack about the decision (best-effort, non-blocking)
      notifyDecision({
        approved: body.approved,
        agentName: approval.task.agent?.name ?? approval.task.agentId,
        taskName: approval.task.name ?? approval.taskId,
        taskId: approval.taskId,
        decidedBy: request.user.userId,
        reason: body.reason,
      }).catch(() => { /* fire-and-forget */ });

      return {
        data: updated,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/approvals/stats
   * Approval statistics for dashboard
   */
  app.get('/stats', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const workspaceId = request.workspaceId!;

      const [pending, approved, denied, timedOut] = await Promise.all([
        prisma.taskApproval.count({
          where: {
            task: { workspaceId },
            decidedAt: null,
            OR: [{ timeoutAt: null }, { timeoutAt: { gt: new Date() } }],
          },
        }),
        prisma.taskApproval.count({
          where: { task: { workspaceId }, approved: true },
        }),
        prisma.taskApproval.count({
          where: { task: { workspaceId }, approved: false, decidedAt: { not: null } },
        }),
        prisma.taskApproval.count({
          where: {
            task: { workspaceId },
            decidedAt: null,
            timeoutAt: { lt: new Date() },
          },
        }),
      ]);

      return {
        data: { pending, approved, denied, timedOut },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
