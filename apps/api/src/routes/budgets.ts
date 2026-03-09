/**
 * Budget API Routes
 * Budget CRUD, real-time remaining, and velocity tracking.
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { getBudgetRemaining, initBudgetCounter, calculateBlastRadius } from '@nexusops/blast-radius';
import { appendAuditEvent } from '@nexusops/events';
import { z } from 'zod';

const createBudgetSchema = z.object({
  agentId: z.string().optional(),
  maxTokens: z.number().optional(),
  maxCostUsd: z.number().optional(),
  velocityLimitUsdPerMinute: z.number().optional(),
  workspaceDailyLimitUsd: z.number().optional(),
  periodStart: z.string().transform((s) => new Date(s)),
  periodEnd: z.string().transform((s) => new Date(s)),
  alertThreshold: z.number().min(0).max(100).optional(),
  autoHalt: z.boolean().default(true),
});

export const budgetsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/budgets
   * Create a new budget
   */
  app.post('/', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request) => {
      const body = createBudgetSchema.parse(request.body);

      const budget = await prisma.budget.create({
        data: {
          workspaceId: request.workspaceId!,
          agentId: body.agentId,
          maxTokens: body.maxTokens,
          maxCostUsd: body.maxCostUsd,
          velocityLimitUsdPerMinute: body.velocityLimitUsdPerMinute,
          workspaceDailyLimitUsd: body.workspaceDailyLimitUsd,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          alertThreshold: body.alertThreshold,
          autoHalt: body.autoHalt,
        },
      });

      // Initialize Redis counter
      if (body.maxCostUsd) {
        const ttlSeconds = Math.floor((body.periodEnd.getTime() - Date.now()) / 1000);
        await initBudgetCounter(
          request.workspaceId!,
          body.agentId,
          body.maxCostUsd,
          Math.max(ttlSeconds, 60),
        );
      }

      await appendAuditEvent({
        workspaceId: request.workspaceId!,
        userId: request.user.userId,
        eventType: 'budget.created',
        entityType: 'budget',
        entityId: budget.id,
        action: 'CREATE',
        metadata: { maxCostUsd: body.maxCostUsd, agentId: body.agentId },
      });

      return {
        data: budget,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/budgets
   * List budgets
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const { agentId } = request.query as any;

      const where: any = { workspaceId: request.workspaceId! };
      if (agentId) where.agentId = agentId;

      const budgets = await prisma.budget.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          agent: { select: { id: true, name: true } },
        },
      });

      // Enrich with real-time Redis remaining
      const enriched = await Promise.all(
        budgets.map(async (b) => {
          const remaining = await getBudgetRemaining(request.workspaceId!, b.agentId ?? undefined);
          return {
            ...b,
            realTimeRemainingUsd: remaining,
            utilizationPercent: b.maxCostUsd
              ? ((b.maxCostUsd - (remaining === Infinity ? b.maxCostUsd : remaining)) / b.maxCostUsd) * 100
              : null,
          };
        }),
      );

      return {
        data: enriched,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/budgets/summary
   * Workspace budget summary for dashboard
   */
  app.get('/summary', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const workspaceId = request.workspaceId!;

      const [budgets, totalSpend, todaySpend] = await Promise.all([
        prisma.budget.findMany({ where: { workspaceId } }),
        prisma.toolCall.aggregate({
          where: { workspaceId },
          _sum: { costUsd: true },
        }),
        prisma.toolCall.aggregate({
          where: {
            workspaceId,
            createdAt: { gt: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
          _sum: { costUsd: true },
        }),
      ]);

      const totalBudgetUsd = budgets.reduce((sum, b) => sum + (b.maxCostUsd ?? 0), 0);
      const totalCurrentSpend = budgets.reduce((sum, b) => sum + b.currentCostUsd, 0);

      return {
        data: {
          totalBudgetUsd,
          totalSpendUsd: totalSpend._sum.costUsd ?? 0,
          todaySpendUsd: todaySpend._sum.costUsd ?? 0,
          budgetCount: budgets.length,
          utilizationPercent: totalBudgetUsd > 0 ? (totalCurrentSpend / totalBudgetUsd) * 100 : 0,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/budgets/blast-radius/:agentId
   * Calculate blast radius for an agent
   */
  app.get('/blast-radius/:agentId', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { agentId } = request.params as any;

      try {
        const result = await calculateBlastRadius(agentId, request.workspaceId!);
        return {
          data: result,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: null,
        };
      } catch (err: any) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'NOT_FOUND', message: err.message },
        });
      }
    },
  });
};
