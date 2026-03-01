import { FastifyPluginAsync } from 'fastify';
import { prisma, PolicyAction, type Prisma } from '@nexusops/db';
import { policyEngine } from '@nexusops/policy';
import { z } from 'zod';

const createPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  action: z.nativeEnum(PolicyAction),
  priority: z.number().default(50),
  conditions: z.record(z.unknown()),
});

export const policiesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/policies
   * Create a new policy rule
   */
  app.post('/', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const body = createPolicySchema.parse(request.body);

      const policy = await prisma.policyRule.create({
        data: {
          workspaceId: request.workspaceId!,
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          action: body.action,
          priority: body.priority,
          conditions: body.conditions as Prisma.InputJsonValue as Prisma.InputJsonValue,
          createdBy: request.user?.userId,
        },
      });

      // Invalidate policy cache
      policyEngine.invalidateCache(request.workspaceId!);

      // Audit log
      await prisma.auditEvent.create({
        data: {
          workspaceId: request.workspaceId!,
          userId: request.user?.userId,
          eventType: 'policy.created',
          entityType: 'policy',
          entityId: policy.id,
          action: 'CREATE',
          metadata: { policyName: policy.name },
        },
      });

      return {
        data: policy,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * GET /api/v1/policies
   * List policy rules
   */
  app.get('/', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { page = 1, limit = 50, enabled } = request.query as any;

      const where = {
        workspaceId: request.workspaceId!,
        ...(enabled !== undefined && { enabled: enabled === 'true' }),
      };

      const [policies, total] = await Promise.all([
        prisma.policyRule.findMany({
          where,
          take: Math.min(limit, 100),
          skip: (page - 1) * limit,
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        }),
        prisma.policyRule.count({ where }),
      ]);

      return {
        data: {
          items: policies,
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
   * GET /api/v1/policies/:id
   * Get policy details
   */
  app.get('/:id', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const policy = await prisma.policyRule.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
        include: {
          _count: {
            select: {
              evaluations: true,
            },
          },
        },
      });

      if (!policy) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Policy not found',
          },
        });
      }

      return {
        data: policy,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * PUT /api/v1/policies/:id
   * Update policy rule (creates new version)
   */
  app.put('/:id', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = createPolicySchema.partial().parse(request.body);

      const policy = await prisma.policyRule.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
      });

      if (!policy) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Policy not found',
          },
        });
      }

      const updated = await prisma.policyRule.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          action: body.action,
          priority: body.priority,
          conditions: body.conditions as Prisma.InputJsonValue,
          version: policy.version + 1,
          updatedAt: new Date(),
        },
      });

      // Invalidate policy cache
      policyEngine.invalidateCache(request.workspaceId!);

      // Audit log
      await prisma.auditEvent.create({
        data: {
          workspaceId: request.workspaceId!,
          userId: request.user?.userId,
          eventType: 'policy.updated',
          entityType: 'policy',
          entityId: policy.id,
          action: 'UPDATE',
          metadata: {
            policyName: policy.name,
            newVersion: updated.version,
          },
        },
      });

      return {
        data: updated,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * DELETE /api/v1/policies/:id
   * Soft delete policy
   */
  app.delete('/:id', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const policy = await prisma.policyRule.findFirst({
        where: {
          id,
          workspaceId: request.workspaceId!,
        },
      });

      if (!policy) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'NOT_FOUND',
            message: 'Policy not found',
          },
        });
      }

      await prisma.policyRule.update({
        where: { id },
        data: { enabled: false },
      });

      // Invalidate policy cache
      policyEngine.invalidateCache(request.workspaceId!);

      // Audit log
      await prisma.auditEvent.create({
        data: {
          workspaceId: request.workspaceId!,
          userId: request.user?.userId,
          eventType: 'policy.deleted',
          entityType: 'policy',
          entityId: policy.id,
          action: 'DELETE',
          metadata: { policyName: policy.name },
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
