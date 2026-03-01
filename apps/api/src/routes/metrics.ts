import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { queueManager } from '@nexusops/queue';

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/metrics/cost
   * Cost metrics dashboard data
   */
  app.get('/cost', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;
      const { period = '24h' } = request.query as any;

      let since: Date;
      switch (period) {
        case '1h':
          since = new Date(Date.now() - 60 * 60 * 1000);
          break;
        case '24h':
          since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      }

      const tasks = await prisma.task.findMany({
        where: {
          workspaceId,
          createdAt: { gte: since },
        },
        select: {
          costUsd: true,
          tokenCount: true,
          agentId: true,
          agent: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const totalCost = tasks.reduce((sum: number, t: any) => sum + t.costUsd, 0);
      const totalTokens = tasks.reduce((sum: number, t: any) => sum + t.tokenCount, 0);

      // Group by agent
      const byAgent = tasks.reduce((acc: Record<string, any>, task: any) => {
        const key = task.agentId;
        if (!acc[key]) {
          acc[key] = {
            agentId: task.agent.id,
            agentName: task.agent.name,
            costUsd: 0,
            tokenCount: 0,
            taskCount: 0,
          };
        }
        acc[key].costUsd += task.costUsd;
        acc[key].tokenCount += task.tokenCount;
        acc[key].taskCount += 1;
        return acc;
      }, {} as Record<string, any>);

      const topAgents = Object.values(byAgent)
        .sort((a: any, b: any) => b.costUsd - a.costUsd)
        .slice(0, 10);

      return {
        data: {
          totalCostUsd: totalCost,
          totalTokens,
          avgCostPerTask: tasks.length > 0 ? totalCost / tasks.length : 0,
          taskCount: tasks.length,
          topAgentsByCost: topAgents,
          period,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/metrics/usage
   * Token usage time series
   */
  app.get('/usage', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;

      // Get metrics from the last 24 hours
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const metrics = await prisma.metric.findMany({
        where: {
          workspaceId,
          metricName: { in: ['token_usage', 'cost'] },
          timestamp: { gte: since },
        },
        orderBy: { timestamp: 'asc' },
      });

      return {
        data: metrics,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/metrics/health
   * System health metrics
   */
  app.get('/health', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;

      // Get queue metrics
      const queueMetrics = await queueManager.getQueueMetrics('tasks');

      // Get recent policy evaluations
      const since = new Date(Date.now() - 60 * 60 * 1000); // Last hour
      const policyEvals = await prisma.policyEvaluation.findMany({
        where: {
          createdAt: { gte: since },
          policyRule: { workspaceId },
        },
        select: { evaluationMs: true },
      });

      const avgPolicyLatency =
        policyEvals.length > 0
          ? policyEvals.reduce((sum: number, e: any) => sum + e.evaluationMs, 0) / policyEvals.length
          : 0;

      // Get error rate
      const totalTasks = await prisma.task.count({
        where: {
          workspaceId,
          createdAt: { gte: since },
        },
      });

      const failedTasks = await prisma.task.count({
        where: {
          workspaceId,
          status: 'FAILED',
          createdAt: { gte: since },
        },
      });

      const errorRate = totalTasks > 0 ? (failedTasks / totalTasks) * 100 : 0;

      return {
        data: {
          status: avgPolicyLatency < 5 && errorRate < 5 ? 'healthy' : 'degraded',
          services: {
            api: true,
            worker: true,
            proxy: true,
            policy: true,
            database: true,
            redis: true,
          },
          metrics: {
            queueDepth: queueMetrics.waiting + queueMetrics.active,
            avgPolicyLatencyMs: avgPolicyLatency,
            errorRate,
          },
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
