import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';

/**
 * Onboarding checklist endpoint.
 *
 * Returns a list of setup milestones and whether the current workspace
 * has completed each one.  The frontend renders this as a checklist
 * that guides new users through initial configuration.
 */
export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/onboarding', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const workspaceId = request.workspaceId!;

      const [
        agentCount,
        policyCount,
        memberCount,
        apiKeyCount,
        taskCount,
        budgetCount,
      ] = await Promise.all([
        prisma.agent.count({ where: { workspaceId } }),
        prisma.policyRule.count({ where: { workspaceId } }),
        prisma.workspaceUser.count({ where: { workspaceId } }),
        prisma.apiKey.count({ where: { workspaceId, revokedAt: null } }),
        prisma.task.count({ where: { workspaceId } }),
        prisma.budget.count({ where: { workspaceId } }),
      ]);

      const steps = [
        {
          id: 'create_agent',
          title: 'Create your first agent',
          description: 'Deploy an AI agent to start automating tasks.',
          completed: agentCount > 0,
        },
        {
          id: 'add_policy',
          title: 'Define a governance policy',
          description: 'Set guardrails that control what agents can do.',
          completed: policyCount > 0,
        },
        {
          id: 'invite_team',
          title: 'Invite a team member',
          description: 'Collaborate with your team on agent operations.',
          completed: memberCount > 1, // >1 because the creator is always member #1
        },
        {
          id: 'create_api_key',
          title: 'Generate an API key',
          description: 'Enable programmatic access via the SDK.',
          completed: apiKeyCount > 0,
        },
        {
          id: 'run_task',
          title: 'Execute a task',
          description: 'Run your first agent task end-to-end.',
          completed: taskCount > 0,
        },
        {
          id: 'set_budget',
          title: 'Configure a budget',
          description: 'Set spending limits to control costs.',
          completed: budgetCount > 0,
        },
      ];

      const completedCount = steps.filter((s) => s.completed).length;

      return {
        data: {
          steps,
          completedCount,
          totalSteps: steps.length,
          overallProgress: Math.round((completedCount / steps.length) * 100),
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
