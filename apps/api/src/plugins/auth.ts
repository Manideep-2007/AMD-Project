import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '@nexusops/db';
import type { JWTPayload } from '@nexusops/types';
import * as crypto from 'crypto';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    checkRole: (allowedRoles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JWTPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    workspaceId?: string;
  }
}

/**
 * Authentication plugin
 * Provides JWT verification and API key authentication
 */
const authPluginImpl: FastifyPluginAsync = async (app) => {
  /**
   * Verify JWT token
   */
  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      // After jwtVerify, request.user is populated by @fastify/jwt with type JWTPayload
      request.workspaceId = request.user.workspaceId;
    } catch (err) {
      reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
        },
      });
    }
  });

  /**
   * Verify API key
   */
  app.decorate('authenticateApiKey', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      const apiKey = request.headers['x-api-key'] as string;

      if (!apiKey) {
        return reply.code(401).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'UNAUTHORIZED',
            message: 'API key required',
          },
        });
      }

      // Hash the provided key
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

      // Lookup key in database
      const apiKeyRecord = await prisma.apiKey.findUnique({
        where: { keyHash },
        include: { workspace: true },
      });

      if (!apiKeyRecord || apiKeyRecord.revokedAt) {
        return reply.code(401).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid API key',
          },
        });
      }

      if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
        return reply.code(401).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'UNAUTHORIZED',
            message: 'API key expired',
          },
        });
      }

      // Update last used timestamp
      await prisma.apiKey.update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      });

      request.workspaceId = apiKeyRecord.workspaceId;
    } catch (err) {
      reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key authentication failed',
        },
      });
    }
  });

  /**
   * Check user role
   */
  app.decorate(
    'checkRole',
    (allowedRoles: string[]) =>
      async function (request: FastifyRequest, reply: FastifyReply) {
        if (!request.user) {
          return reply.code(401).send({
            data: null,
            meta: { requestId: request.id, timestamp: new Date().toISOString() },
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authentication required',
            },
          });
        }

        if (!allowedRoles.includes(request.user.role)) {
          return reply.code(403).send({
            data: null,
            meta: { requestId: request.id, timestamp: new Date().toISOString() },
            error: {
              code: 'FORBIDDEN',
              message: 'Insufficient permissions',
            },
          });
        }
      }
  );
};

export const authPlugin = fp(authPluginImpl);
