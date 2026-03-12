import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '@nexusops/db';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { sendEmail, buildInvitationEmail } from '../lib/email';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('settings');

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // ─── Workspace Settings ────────────────────

  app.get('/settings/workspace', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;

      const workspace = await prisma.workspace.findFirst({
        where: { id: wsId },
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          dataRegion: true,
          financialExposureConfig: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!workspace) {
        return reply.code(404).send({ error: 'Workspace not found' });
      }

      return {
        data: workspace,
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });

  app.patch('/settings/workspace', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;

      const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        dataRegion: z.enum(['US', 'EU', 'APAC']).optional(),
        financialExposureConfig: z.record(z.unknown()).optional(),
      });

      const body = schema.parse(request.body);

      const workspace = await prisma.workspace.update({
        where: { id: wsId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.dataRegion !== undefined && { dataRegion: body.dataRegion }),
          ...(body.financialExposureConfig !== undefined && {
            financialExposureConfig: body.financialExposureConfig as object,
          }),
        },
      });

      return {
        data: workspace,
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });

  // ─── Team Members ──────────────────────────

  app.get('/settings/members', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const wsId = request.workspaceId!;

      const members = await prisma.workspaceUser.findMany({
        where: { workspaceId: wsId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              avatarUrl: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return {
        data: members.map((m) => ({
          id: m.id,
          userId: m.userId,
          email: m.user.email,
          name: m.user.name || m.user.email.split('@')[0],
          avatarUrl: m.user.avatarUrl,
          role: m.role,
          lastLoginAt: m.user.lastLoginAt,
          joinedAt: m.createdAt,
        })),
        meta: { total: members.length, timestamp: new Date().toISOString() },
      };
    },
  });

  app.post('/settings/members/invite', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;
      const inviterId = request.user.userId;

      const schema = z.object({
        email: z.string().email(),
        role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
      });

      const { email, role } = schema.parse(request.body);

      // Prevent inviting someone who is already a member
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        const existingMember = await prisma.workspaceUser.findUnique({
          where: { workspaceId_userId: { workspaceId: wsId, userId: existingUser.id } },
        });
        if (existingMember) {
          return reply.code(409).send({ error: 'User is already a workspace member' });
        }
      }

      // Revoke any pending invitation for the same email + workspace
      await prisma.workspaceInvitation.updateMany({
        where: { workspaceId: wsId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const invitation = await prisma.workspaceInvitation.create({
        data: {
          workspaceId: wsId,
          email,
          role: role as 'ADMIN' | 'OPERATOR' | 'VIEWER',
          token,
          invitedById: inviterId,
          expiresAt,
        },
      });

      // Build and send email
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } });
      const inviter = await prisma.user.findUniqueOrThrow({ where: { id: inviterId } });

      const emailPayload = buildInvitationEmail({
        inviterName: inviter.name || inviter.email,
        workspaceName: workspace.name,
        token,
        role,
      });
      emailPayload.to = email;

      try {
        await sendEmail(emailPayload);
      } catch {
        logger.warn({ email }, 'Failed to send invitation email — invitation still created');
      }

      return reply.code(201).send({
        data: { id: invitation.id, email, role, expiresAt: invitation.expiresAt },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  });

  // ─── List pending invitations ──────────────
  app.get('/settings/members/invitations', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request) => {
      const wsId = request.workspaceId!;
      const invitations = await prisma.workspaceInvitation.findMany({
        where: { workspaceId: wsId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
      return { data: invitations, meta: { total: invitations.length, timestamp: new Date().toISOString() } };
    },
  });

  // ─── Revoke invitation ─────────────────────
  app.delete('/settings/members/invitations/:id', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const wsId = request.workspaceId!;
      const result = await prisma.workspaceInvitation.updateMany({
        where: { id, workspaceId: wsId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) {
        return reply.code(404).send({ error: 'Invitation not found or already resolved' });
      }
      return { data: { revoked: true }, meta: { timestamp: new Date().toISOString() } };
    },
  });

  // ─── Accept invitation (public, requires auth) ─
  app.post('/settings/members/invite/:token/accept', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { token } = request.params as { token: string };
      const userId = request.user.userId;

      const invitation = await prisma.workspaceInvitation.findUnique({ where: { token } });

      if (!invitation || invitation.revokedAt || invitation.acceptedAt) {
        return reply.code(404).send({ error: 'Invitation not found or already used' });
      }
      if (invitation.expiresAt < new Date()) {
        return reply.code(410).send({ error: 'Invitation has expired' });
      }

      // Verify the accepting user's email matches the invitation
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.email !== invitation.email) {
        return reply.code(403).send({ error: 'This invitation was sent to a different email address' });
      }

      // Check if already a member
      const existing = await prisma.workspaceUser.findUnique({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
      });
      if (existing) {
        // Mark invitation accepted and return success
        await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
        return reply.code(200).send({ data: { alreadyMember: true }, meta: { timestamp: new Date().toISOString() } });
      }

      // Create membership + mark invitation accepted in a transaction
      await prisma.$transaction([
        prisma.workspaceUser.create({
          data: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
        }),
        prisma.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        }),
      ]);

      return reply.code(201).send({
        data: { workspaceId: invitation.workspaceId, role: invitation.role },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  });

  app.patch('/settings/members/:userId', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const wsId = request.workspaceId!;

      const schema = z.object({
        role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
      });

      const { role } = schema.parse(request.body);

      // Last-owner protection: prevent demoting the last OWNER
      const target = await prisma.workspaceUser.findFirst({
        where: { workspaceId: wsId, userId },
      });
      if (target?.role === 'OWNER') {
        const ownerCount = await prisma.workspaceUser.count({
          where: { workspaceId: wsId, role: 'OWNER' },
        });
        if (ownerCount <= 1) {
          return reply.code(400).send({
            data: null,
            meta: { timestamp: new Date().toISOString() },
            error: { code: 'LAST_OWNER', message: 'Cannot demote the last workspace owner' },
          });
        }
      }

      const member = await prisma.workspaceUser.updateMany({
        where: { workspaceId: wsId, userId },
        data: { role: role as 'ADMIN' | 'OPERATOR' | 'VIEWER' },
      });

      return {
        data: { updated: member.count },
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });

  app.delete('/settings/members/:userId', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const wsId = request.workspaceId!;

      if (request.user.userId === userId) {
        return reply.code(400).send({
          data: null,
          meta: { timestamp: new Date().toISOString() },
          error: { code: 'SELF_REMOVAL', message: 'Cannot remove yourself from the workspace' },
        });
      }

      // Last-owner protection: prevent removing the last OWNER
      const target = await prisma.workspaceUser.findFirst({
        where: { workspaceId: wsId, userId },
      });
      if (target?.role === 'OWNER') {
        const ownerCount = await prisma.workspaceUser.count({
          where: { workspaceId: wsId, role: 'OWNER' },
        });
        if (ownerCount <= 1) {
          return reply.code(400).send({
            data: null,
            meta: { timestamp: new Date().toISOString() },
            error: { code: 'LAST_OWNER', message: 'Cannot remove the last workspace owner' },
          });
        }
      }

      await prisma.workspaceUser.deleteMany({
        where: { workspaceId: wsId, userId },
      });

      return {
        data: { deleted: true },
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });

  // ─── Ownership Transfer ────────────────────
  app.post('/settings/transfer-ownership', {
    onRequest: [app.authenticate, app.checkRole(['OWNER'])],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;
      const currentOwnerId = request.user.userId;

      const schema = z.object({
        newOwnerUserId: z.string().min(1),
      });

      const { newOwnerUserId } = schema.parse(request.body);

      if (newOwnerUserId === currentOwnerId) {
        return reply.code(400).send({ error: 'You are already the owner' });
      }

      // New owner must be an existing member
      const newOwnerMembership = await prisma.workspaceUser.findUnique({
        where: { workspaceId_userId: { workspaceId: wsId, userId: newOwnerUserId } },
      });
      if (!newOwnerMembership) {
        return reply.code(404).send({ error: 'Target user is not a member of this workspace' });
      }

      // Atomic swap: promote new owner + demote current to ADMIN
      await prisma.$transaction([
        prisma.workspaceUser.update({
          where: { id: newOwnerMembership.id },
          data: { role: 'OWNER' },
        }),
        prisma.workspaceUser.updateMany({
          where: { workspaceId: wsId, userId: currentOwnerId },
          data: { role: 'ADMIN' },
        }),
      ]);

      logger.info({ wsId, from: currentOwnerId, to: newOwnerUserId }, 'Workspace ownership transferred');

      return {
        data: { previousOwner: currentOwnerId, newOwner: newOwnerUserId },
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });

  // ─── API Keys ──────────────────────────────

  app.get('/settings/api-keys', {
    onRequest: [app.authenticate],
    handler: async (request) => {
      const wsId = request.workspaceId!;

      const keys = await prisma.apiKey.findMany({
        where: { workspaceId: wsId, revokedAt: null },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          lastUsedAt: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        data: keys,
        meta: { total: keys.length, timestamp: new Date().toISOString() },
      };
    },
  });

  app.post('/settings/api-keys', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request, reply) => {
      const wsId = request.workspaceId!;

      const schema = z.object({
        name: z.string().min(1).max(100),
        expiresInDays: z.number().int().positive().optional(),
      });

      const { name, expiresInDays } = schema.parse(request.body);

      const rawKey = `nxo_sk_${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      const keyPrefix = rawKey.slice(0, 12);

      const apiKey = await prisma.apiKey.create({
        data: {
          workspaceId: wsId,
          name,
          keyHash,
          keyPrefix,
          expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null,
        },
      });

      return reply.code(201).send({
        data: {
          id: apiKey.id,
          name: apiKey.name,
          key: rawKey,
          keyPrefix,
          expiresAt: apiKey.expiresAt,
          createdAt: apiKey.createdAt,
        },
        meta: { timestamp: new Date().toISOString() },
        warning: 'Store this key securely. It will not be shown again.',
      });
    },
  });

  app.delete('/settings/api-keys/:keyId', {
    onRequest: [app.authenticate, app.checkRole(['OWNER', 'ADMIN'])],
    handler: async (request) => {
      const { keyId } = request.params as { keyId: string };
      const wsId = request.workspaceId!;

      const key = await prisma.apiKey.findFirst({
        where: { id: keyId, workspaceId: wsId },
      });

      if (!key) {
        return { error: 'API key not found' };
      }

      await prisma.apiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      });

      return {
        data: { revoked: true },
        meta: { timestamp: new Date().toISOString() },
      };
    },
  });
};

export default settingsRoutes;
