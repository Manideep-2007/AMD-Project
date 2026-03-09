/**
 * Costs API — Real-time cost tracking, forecasting, and attribution.
 *
 * Endpoints:
 *   GET  /                   Paginated cost events
 *   GET  /summary            Aggregate cost summary (today, week, month)
 *   GET  /forecast           30/60/90-day cost projection using linear regression
 *   GET  /attribution        Cost breakdown by agent, workspace, provider, tool
 *   GET  /stream             SSE real-time cost feed for live dashboards
 *   GET  /anomalies          Detected cost anomalies (spikes, drift)
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';

interface CostForecast {
  period: string;
  projectedCost: number;
  lowerBound: number;
  upperBound: number;
  confidence: number;
  trend: 'rising' | 'falling' | 'stable';
  dailyRate: number;
}

export const costsRoutes: FastifyPluginAsync = async (app) => {
  // GET / — Paginated cost events
  app.get('/', {
    onRequest: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          agentId: { type: 'string' },
          provider: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const { page = 1, limit = 50, agentId, provider, from, to } = request.query as any;

    const where: Record<string, any> = { workspaceId: request.workspaceId! };
    if (agentId) where.agentId = agentId;
    if (provider) where.provider = provider;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [events, total] = await Promise.all([
      prisma.toolCall.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          agentId: true,
          toolType: true,
          toolMethod: true,
          costUsd: true,
          inputTokens: true,
          outputTokens: true,
          provider: true,
          model: true,
          createdAt: true,
          agent: { select: { name: true } },
          task: { select: { id: true } },
        },
      }),
      prisma.toolCall.count({ where }),
    ]);

    return reply.send({
      data: events.map((e: any) => ({
        id: e.id,
        agentId: e.agentId,
        agentName: e.agent?.name || 'Unknown',
        taskId: e.task?.id || null,
        toolType: e.toolType,
        toolMethod: e.toolMethod,
        provider: e.provider || 'UNKNOWN',
        model: e.model || 'unknown',
        inputTokens: e.inputTokens || 0,
        outputTokens: e.outputTokens || 0,
        costUsd: e.costUsd ? Number(e.costUsd) : 0,
        createdAt: e.createdAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  });

  // GET /summary — Aggregate cost summary
  app.get('/summary', {
    onRequest: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week', 'month', 'quarter'], default: 'today' },
        },
      },
    },
  }, async (request, reply) => {
    const { period = 'today' } = request.query as any;

    const now = new Date();
    let periodStart: Date;

    switch (period) {
      case 'week':
        periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'quarter':
        periodStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default: // today
        periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    const where = {
      workspaceId: request.workspaceId!,
      createdAt: { gte: periodStart },
    };

    const [aggregate, toolCalls] = await Promise.all([
      prisma.toolCall.aggregate({
        where,
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.toolCall.findMany({
        where,
        select: {
          agentId: true,
          costUsd: true,
          inputTokens: true,
          outputTokens: true,
          provider: true,
          model: true,
          createdAt: true,
          agent: { select: { name: true } },
        },
      }),
    ]);

    const totalCost = Number(aggregate._sum.costUsd || 0);
    const totalTokens = (aggregate._sum.inputTokens || 0) + (aggregate._sum.outputTokens || 0);
    const totalRequests = aggregate._count;

    // Agent attribution
    const agentCosts = new Map<string, { name: string; cost: number }>();
    const modelCosts = new Map<string, number>();
    const hourCosts = new Map<string, { cost: number; tokens: number }>();

    for (const tc of toolCalls) {
      const cost = Number(tc.costUsd || 0);
      const tokens = (tc.inputTokens || 0) + (tc.outputTokens || 0);

      // By agent
      const agentEntry = agentCosts.get(tc.agentId) || { name: (tc.agent as any)?.name || 'Unknown', cost: 0 };
      agentEntry.cost += cost;
      agentCosts.set(tc.agentId, agentEntry);

      // By model
      const model = tc.model || 'unknown';
      modelCosts.set(model, (modelCosts.get(model) || 0) + cost);

      // By hour
      const hour = tc.createdAt.toISOString().slice(0, 13) + ':00';
      const hourEntry = hourCosts.get(hour) || { cost: 0, tokens: 0 };
      hourEntry.cost += cost;
      hourEntry.tokens += tokens;
      hourCosts.set(hour, hourEntry);
    }

    const topAgents = [...agentCosts.entries()]
      .map(([agentId, { name, cost }]) => ({
        agentId,
        agentName: name,
        cost: Math.round(cost * 100) / 100,
        percentage: totalCost > 0 ? Math.round((cost / totalCost) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);

    const topModels = [...modelCosts.entries()]
      .map(([model, cost]) => ({
        model,
        cost: Math.round(cost * 100) / 100,
        percentage: totalCost > 0 ? Math.round((cost / totalCost) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    const costByHour = [...hourCosts.entries()]
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return reply.send({
      data: {
        periodStart: periodStart.toISOString(),
        periodEnd: now.toISOString(),
        totalCost: Math.round(totalCost * 100) / 100,
        totalTokens,
        totalRequests,
        avgCostPerRequest: totalRequests > 0 ? Math.round((totalCost / totalRequests) * 10000) / 10000 : 0,
        topAgents,
        topModels,
        costByHour,
      },
    });
  });

  // GET /forecast — 30/60/90-day cost projection via linear regression
  app.get('/forecast', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {

    // Get last 30 days of daily costs for regression
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const recentCalls = await prisma.toolCall.findMany({
      where: {
        workspaceId: request.workspaceId!,
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { costUsd: true, createdAt: true },
    });

    // Aggregate by day
    const dailyCosts = new Map<string, number>();
    for (const tc of recentCalls) {
      const day = tc.createdAt.toISOString().slice(0, 10);
      dailyCosts.set(day, (dailyCosts.get(day) || 0) + Number(tc.costUsd || 0));
    }

    const sortedDays = [...dailyCosts.entries()]
      .sort(([a], [b]) => a.localeCompare(b));

    if (sortedDays.length < 3) {
      return reply.send({
        data: {
          forecasts: [],
          message: 'Insufficient data — need at least 3 days of cost history',
          historicalDays: sortedDays.length,
        },
      });
    }

    // Simple linear regression: y = mx + b
    const n = sortedDays.length;
    const xs = sortedDays.map((_, i) => i);
    const ys = sortedDays.map(([, cost]) => cost);

    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
    const sumXX = xs.reduce((sum, x) => sum + x * x, 0);

    const m = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const b = (sumY - m * sumX) / n;

    // Standard error for confidence intervals
    const predictions = xs.map((x) => m * x + b);
    const residuals = ys.map((y, i) => y - predictions[i]);
    const sse = residuals.reduce((sum, r) => sum + r * r, 0);
    const se = Math.sqrt(sse / (n - 2));

    const avgDaily = sumY / n;
    const trend: 'rising' | 'falling' | 'stable' =
      m > avgDaily * 0.02 ? 'rising' : m < -avgDaily * 0.02 ? 'falling' : 'stable';

    const forecasts: CostForecast[] = [30, 60, 90].map((days) => {
      const endX = n + days;
      const projected = Array.from({ length: days }, (_, i) => Math.max(0, m * (n + i) + b))
        .reduce((a, c) => a + c, 0);

      return {
        period: `${days}d`,
        projectedCost: Math.round(projected * 100) / 100,
        lowerBound: Math.round(Math.max(0, projected - 1.96 * se * Math.sqrt(days)) * 100) / 100,
        upperBound: Math.round((projected + 1.96 * se * Math.sqrt(days)) * 100) / 100,
        confidence: Math.max(0.5, Math.min(0.95, 1 - (se / (avgDaily || 1)))),
        trend,
        dailyRate: Math.round((m * (endX - 1) + b) * 100) / 100,
      };
    });

    return reply.send({
      data: {
        forecasts,
        historicalDays: n,
        dailyAverage: Math.round(avgDaily * 100) / 100,
        regressionSlope: Math.round(m * 10000) / 10000,
        trend,
      },
    });
  });

  // GET /attribution — Cost breakdown by agent, workspace, provider, tool
  app.get('/attribution', {
    onRequest: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          groupBy: { type: 'string', enum: ['agent', 'provider', 'tool', 'model'], default: 'agent' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const { groupBy = 'agent', from, to } = request.query as any;

    const where: Record<string, any> = { workspaceId: request.workspaceId! };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const toolCalls = await prisma.toolCall.findMany({
      where,
      select: {
        agentId: true,
        toolType: true,
        provider: true,
        model: true,
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        agent: { select: { name: true } },
      },
    });

    const buckets = new Map<string, {
      label: string;
      cost: number;
      tokens: number;
      requests: number;
    }>();

    for (const tc of toolCalls) {
      const cost = Number(tc.costUsd || 0);
      const tokens = (tc.inputTokens || 0) + (tc.outputTokens || 0);
      let key: string;
      let label: string;

      switch (groupBy) {
        case 'provider':
          key = tc.provider || 'UNKNOWN';
          label = key;
          break;
        case 'tool':
          key = tc.toolType;
          label = key;
          break;
        case 'model':
          key = tc.model || 'unknown';
          label = key;
          break;
        default: // agent
          key = tc.agentId;
          label = (tc.agent as any)?.name || tc.agentId;
      }

      const bucket = buckets.get(key) || { label, cost: 0, tokens: 0, requests: 0 };
      bucket.cost += cost;
      bucket.tokens += tokens;
      bucket.requests += 1;
      buckets.set(key, bucket);
    }

    const totalCost = [...buckets.values()].reduce((sum, b) => sum + b.cost, 0);
    const breakdown = [...buckets.entries()]
      .map(([key, data]) => ({
        key,
        label: data.label,
        cost: Math.round(data.cost * 100) / 100,
        tokens: data.tokens,
        requests: data.requests,
        percentage: totalCost > 0 ? Math.round((data.cost / totalCost) * 10000) / 100 : 0,
        avgCostPerRequest: data.requests > 0 ? Math.round((data.cost / data.requests) * 10000) / 10000 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    return reply.send({ data: { groupBy, totalCost: Math.round(totalCost * 100) / 100, breakdown } });
  });

  // GET /anomalies — Detected cost anomalies
  app.get('/anomalies', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {

    // Get last 7 days of hourly costs
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toolCalls = await prisma.toolCall.findMany({
      where: {
        workspaceId: request.workspaceId!,
        createdAt: { gte: sevenDaysAgo },
      },
      select: { costUsd: true, createdAt: true, agentId: true, agent: { select: { name: true } } },
    });

    const hourly = new Map<string, number>();
    for (const tc of toolCalls) {
      const hour = tc.createdAt.toISOString().slice(0, 13);
      hourly.set(hour, (hourly.get(hour) || 0) + Number(tc.costUsd || 0));
    }

    const values = [...hourly.values()];
    if (values.length < 10) {
      return reply.send({ data: { anomalies: [], message: 'Insufficient data for anomaly detection' } });
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const threshold = mean + 2 * stdDev; // 2σ anomaly threshold

    const anomalies = [...hourly.entries()]
      .filter(([, cost]) => cost > threshold)
      .map(([hour, cost]) => ({
        hour,
        cost: Math.round(cost * 100) / 100,
        expected: Math.round(mean * 100) / 100,
        deviation: stdDev > 0 ? Math.round(((cost - mean) / stdDev) * 100) / 100 : 0,
        severity: cost > mean + 3 * stdDev ? 'critical' : 'warning',
      }))
      .sort((a, b) => b.deviation - a.deviation);

    return reply.send({
      data: {
        anomalies,
        stats: {
          meanHourlyCost: Math.round(mean * 100) / 100,
          stdDev: Math.round(stdDev * 100) / 100,
          threshold: Math.round(threshold * 100) / 100,
          analysedHours: values.length,
        },
      },
    });
  });

  // GET /stream — SSE real-time cost feed
  app.get('/stream', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial snapshot
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayAggregate = await prisma.toolCall.aggregate({
      where: {
        workspaceId: request.workspaceId!,
        createdAt: { gte: todayStart },
      },
      _sum: { costUsd: true },
      _count: true,
    });

    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'snapshot',
        costToday: Number(todayAggregate._sum.costUsd || 0),
        requestsToday: todayAggregate._count,
        timestamp: new Date().toISOString(),
      })}\n\n`
    );

    // Poll for new costs every 5 seconds
    let lastCheck = new Date();
    const interval = setInterval(async () => {
      try {
        const newCalls = await prisma.toolCall.findMany({
          where: {
            workspaceId: request.workspaceId!,
            createdAt: { gt: lastCheck },
          },
          select: {
            id: true,
            agentId: true,
            costUsd: true,
            toolType: true,
            model: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        if (newCalls.length > 0) {
          for (const call of newCalls) {
            reply.raw.write(
              `data: ${JSON.stringify({
                type: 'cost_event',
                id: call.id,
                agentId: call.agentId,
                costUsd: Number(call.costUsd || 0),
                toolType: call.toolType,
                model: call.model,
                timestamp: call.createdAt.toISOString(),
              })}\n\n`
            );
          }
          lastCheck = new Date();
        }

        // Heartbeat
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(interval);
      }
    }, 5000);

    request.raw.on('close', () => {
      clearInterval(interval);
    });
  });

  // GET /recommendations — Data-driven governance recommendations
  app.get('/recommendations', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;
      const now = new Date();
      const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const recommendations: {
        id: string;
        title: string;
        description: string;
        severity: 'critical' | 'high' | 'medium' | 'low';
        category: string;
        agentId?: string;
        agentName?: string;
      }[] = [];

      // 1. Agents with high budget utilisation
      const budgets = await prisma.budget.findMany({
        where: {
          workspaceId: wsId,
          periodEnd: { gte: now },
          maxCostUsd: { not: null },
        },
        select: {
          id: true,
          maxCostUsd: true,
          currentCostUsd: true,
          agentId: true,
          agent: { select: { id: true, name: true } },
        },
      });
      for (const b of budgets) {
        const limit = b.maxCostUsd ?? 0;
        if (limit <= 0) continue;
        const utilization = (b.currentCostUsd / limit) * 100;
        const agentLabel = b.agent?.name ?? 'workspace';
        if (utilization >= 90) {
          recommendations.push({
            id: `budget-critical-${b.id}`,
            title: `Budget almost exhausted for ${agentLabel}`,
            description: `${utilization.toFixed(0)}% of the $${limit.toFixed(2)} budget has been used. Enable autoHalt or reduce agent activity.`,
            severity: 'critical',
            category: 'Budget',
            agentId: b.agent?.id,
            agentName: b.agent?.name,
          });
        } else if (utilization >= 75) {
          recommendations.push({
            id: `budget-high-${b.id}`,
            title: `High budget utilisation for ${agentLabel}`,
            description: `${utilization.toFixed(0)}% of the $${limit.toFixed(2)} budget used. Consider reviewing agent activity or increasing the budget.`,
            severity: 'high',
            category: 'Budget',
            agentId: b.agent?.id,
            agentName: b.agent?.name,
          });
        }
      }

      // 2. Agents with excessive blocked tool calls in the last 7 days
      const blockedByAgent = await prisma.toolCall.groupBy({
        by: ['agentId'],
        where: { workspaceId: wsId, blocked: true, createdAt: { gte: last7d } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      });
      for (const ba of blockedByAgent) {
        const count = ba._count?.id ?? 0;
        if (count >= 10) {
          const agent = await prisma.agent.findUnique({
            where: { id: ba.agentId },
            select: { name: true },
          });
          recommendations.push({
            id: `violations-${ba.agentId}`,
            title: `Excessive policy blocks for ${agent?.name ?? ba.agentId}`,
            description: `${count} blocked calls in 7 days. Review agent tool permissions or tighten policy rules to reduce noise.`,
            severity: count >= 25 ? 'high' : 'medium',
            category: 'Policy',
            agentId: ba.agentId,
            agentName: agent?.name,
          });
        }
      }

      // 3. No active policy rules configured
      const policyCount = await prisma.policyRule.count({
        where: { workspaceId: wsId, enabled: true },
      });
      const agentCount = await prisma.agent.count({
        where: { workspaceId: wsId, status: { not: 'TERMINATED' } },
      });
      if (policyCount === 0 && agentCount > 0) {
        recommendations.push({
          id: 'no-policies',
          title: 'No active policy rules configured',
          description: `${agentCount} agents are running without any governance rules. Add at least one DENY rule for the production environment.`,
          severity: 'critical',
          category: 'Policy',
        });
      }

      // 4. Approval requests pending for over 1 hour (decidedAt null + old)
      const pendingApprovals = await prisma.taskApproval.count({
        where: {
          task: { workspaceId: wsId },
          decidedAt: null,
          createdAt: { lte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      if (pendingApprovals > 0) {
        recommendations.push({
          id: 'stale-approvals',
          title: `${pendingApprovals} approval request(s) waiting over 1 hour`,
          description: `Unreviewed escalations block agent tasks. Enable Slack notifications or configure auto-deny timeouts to prevent indefinite suspension.`,
          severity: pendingApprovals > 5 ? 'high' : 'medium',
          category: 'Governance',
        });
      }

      // 5. Cost spike in last 24h vs prior 7-day average
      const [costLast24h, costPrior6d] = await Promise.all([
        prisma.toolCall.aggregate({
          where: { workspaceId: wsId, createdAt: { gte: last24h } },
          _sum: { costUsd: true },
        }),
        prisma.toolCall.aggregate({
          where: { workspaceId: wsId, createdAt: { gte: last7d, lt: last24h } },
          _sum: { costUsd: true },
        }),
      ]);
      const dailyCost24h = Number(costLast24h._sum.costUsd ?? 0);
      const avgDailyCost = Number(costPrior6d._sum.costUsd ?? 0) / 6;
      if (avgDailyCost > 0 && dailyCost24h > avgDailyCost * 2.5) {
        recommendations.push({
          id: 'cost-spike',
          title: 'Significant cost spike in last 24 hours',
          description: `$${dailyCost24h.toFixed(2)} spent in 24h vs $${avgDailyCost.toFixed(2)}/day average (${((dailyCost24h / avgDailyCost) * 100).toFixed(0)}%). Check for runaway agents or loops.`,
          severity: 'high',
          category: 'Budget',
        });
      }

      const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      recommendations.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

      return reply.send({
        data: { recommendations },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      });
    },
  });
};
