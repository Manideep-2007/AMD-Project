/**
 * Workspace Routes — Blast Radius Summary + Emergency Stop
 *
 * Endpoints:
 *   GET  /api/v1/workspaces/blast-radius-summary  — aggregate dashboard headline
 *   POST /api/v1/workspaces/emergency-stop        — kill all running agents (OWNER/ADMIN)
 */

import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { createLogger } from '@nexusops/logger';
import { appendAuditEvent } from '@nexusops/events';

const logger = createLogger('api:workspace');

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/v1/workspaces/blast-radius-summary
   *
   * Aggregate blast radius across all active agents in the workspace.
   * This is the "NexusOps is protecting $X" headline on the dashboard.
   *
   * Returns:
   *   totalProtectedValueUsd — max damage minus governed damage (the headline)
   *   workspaceMaxDamageUsd  — absolute worst-case damage
   *   workspaceGovernedDamageUsd — after governance constraints
   *   agentCount             — total registered agents
   *   highRiskAgentCount     — agents with blastRadiusScore > 60
   *   agents                 — per-agent risk rankings (sorted by score DESC)
   */
  app.get('/blast-radius-summary', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;

      const agents = await prisma.agent.findMany({
        where: {
          workspaceId: wsId,
          status: { not: 'TERMINATED' },
        },
        select: {
          id: true,
          name: true,
          status: true,
          blastRadiusScore: true,
          blastRadiusMaxDamageUsd: true,
          blastRadiusGovernedDamageUsd: true,
          toolPermissions: true,
        },
        orderBy: { blastRadiusScore: 'desc' },
      });

      const totalMaxDamage = agents.reduce(
        (sum, a) => sum + (a.blastRadiusMaxDamageUsd ?? 0),
        0,
      );
      const totalGovernedDamage = agents.reduce(
        (sum, a) => sum + (a.blastRadiusGovernedDamageUsd ?? 0),
        0,
      );
      const totalProtected = totalMaxDamage - totalGovernedDamage;
      const highRiskCount = agents.filter((a) => (a.blastRadiusScore ?? 0) > 60).length;

      return reply.send({
        data: {
          totalProtectedValueUsd: Math.max(0, totalProtected),
          workspaceMaxDamageUsd: totalMaxDamage,
          workspaceGovernedDamageUsd: totalGovernedDamage,
          agentCount: agents.length,
          highRiskAgentCount: highRiskCount,
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            blastRadiusScore: a.blastRadiusScore ?? 0,
            maxDamageUsd: a.blastRadiusMaxDamageUsd ?? 0,
            governedDamageUsd: a.blastRadiusGovernedDamageUsd ?? 0,
            protectedValueUsd: Math.max(
              0,
              (a.blastRadiusMaxDamageUsd ?? 0) - (a.blastRadiusGovernedDamageUsd ?? 0),
            ),
          })),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  });

  /**
   * POST /api/v1/workspaces/emergency-stop
   *
   * Immediately terminate all active agents and cancel all running/queued tasks.
   * Requires OWNER or ADMIN role.
   * Requires body: { confirmation: "STOP ALL AGENTS", reason: string }
   *
   * Returns the count of agents terminated and tasks cancelled.
   */
  app.post('/emergency-stop', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;
      const userId = request.user?.userId;
      const body = request.body as { confirmation?: string; reason?: string };

      // Safety check: must type the exact confirmation phrase
      if (body.confirmation !== 'STOP ALL AGENTS') {
        return reply.code(400).send({
          error:
            'confirmation must be exactly "STOP ALL AGENTS" to execute emergency stop',
        });
      }

      if (!body.reason || String(body.reason).trim().length < 5) {
        return reply.code(400).send({ error: 'reason is required (min 5 characters)' });
      }

      const reason = String(body.reason).trim();

      // 1. Terminate all non-terminated agents
      const agentResult = await prisma.agent.updateMany({
        where: {
          workspaceId: wsId,
          status: { notIn: ['TERMINATED'] },
        },
        data: { status: 'TERMINATED' },
      });

      // 2. Cancel all active/queued tasks
      const taskResult = await prisma.task.updateMany({
        where: {
          workspaceId: wsId,
          status: { in: ['PENDING', 'QUEUED', 'RUNNING', 'PENDING_APPROVAL'] },
        },
        data: {
          status: 'CANCELLED',
          error: `Emergency stop by ${userId ?? 'unknown'}: ${reason}`,
        },
      });

      // 3. Audit the emergency stop action
      appendAuditEvent({
        workspaceId: wsId,
        eventType: 'workspace.emergency_stop',
        entityType: 'workspace',
        entityId: wsId,
        action: 'EMERGENCY_STOP',
        userId,
        metadata: {
          agentsTerminated: agentResult.count,
          tasksCancelled: taskResult.count,
          reason,
          triggeredBy: userId,
        },
      }).catch((err) =>
        logger.error({ err }, 'Failed to write emergency-stop audit event'),
      );

      logger.warn(
        { wsId, agentsTerminated: agentResult.count, tasksCancelled: taskResult.count, reason },
        '🚨 EMERGENCY STOP executed',
      );

      return reply.send({
        data: {
          agentsTerminated: agentResult.count,
          tasksCancelled: taskResult.count,
          reason,
          executedAt: new Date().toISOString(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  });
};
