import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '@nexusops/db';
import type { JWTPayload } from '@nexusops/types';
import * as crypto from 'crypto';
import Redis from 'ioredis';

/**
 * Redis client for per-API-key rate limiting.
 * Uses a sliding fixed-window counter keyed by keyId + minute bucket.
 * Redis INCR is atomic, so this works correctly across multiple API instances.
 */
let rateLimitRedis: Redis | null = null;
function getRateLimitRedis(): Redis {
  if (!rateLimitRedis) {
    rateLimitRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    rateLimitRedis.on('error', (err) => {
      // Non-fatal: if Redis is down, skip rate limit enforcement rather than
      // blocking all API key requests. Log and continue.
      console.error('[auth] API key rate-limit Redis error:', err.message);
    });
  }
  return rateLimitRedis;
}

const API_KEY_RATE_WINDOW_SEC = 60; // 1-minute fixed window

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    checkRole: (allowedRoles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    checkApiKeyScope: (requiredScopes: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
    apiKeyScope?: string;
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

      // Per-API-key rate limiting (Redis-backed, multi-instance safe)
      if (apiKeyRecord.rateLimit) {
        try {
          const redis = getRateLimitRedis();
          // Key = ratelimit:apikey:{keyId}:{minute-bucket}
          const bucket = Math.floor(Date.now() / 1000 / API_KEY_RATE_WINDOW_SEC);
          const rlKey = `ratelimit:apikey:${apiKeyRecord.id}:${bucket}`;

          const count = await redis.incr(rlKey);
          if (count === 1) {
            // First hit in this window — set expiry
            await redis.expire(rlKey, API_KEY_RATE_WINDOW_SEC * 2);
          }

          if (count > apiKeyRecord.rateLimit) {
            return reply.code(429).send({
              data: null,
              meta: { requestId: request.id, timestamp: new Date().toISOString() },
              error: {
                code: 'RATE_LIMITED',
                message: `API key rate limit exceeded (${apiKeyRecord.rateLimit}/min)`,
              },
            });
          }
        } catch {
          // Redis unavailable — allow the request rather than block all traffic
        }
      }

      request.workspaceId = apiKeyRecord.workspaceId;
      request.apiKeyScope = apiKeyRecord.scope ?? 'full_access';
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

  /**
   * API Key Scope enforcement middleware.
   *
   * Scopes are hierarchical:
   *   full_access > admin > agent_only > read_only
   *
   * If the request was authenticated via JWT (no apiKeyScope), bypass scope check.
   * If authenticated via API key, verify the key's scope is in the allowed set.
   *
   * Scope definitions:
   *   - full_access: unrestricted (all routes)
   *   - admin: workspace management + agent management + reads
   *   - agent_only: agent CRUD + task execution + reads (no workspace settings)
   *   - read_only: GET endpoints only
   */
  const SCOPE_HIERARCHY: Record<string, string[]> = {
    full_access: ['full_access', 'admin', 'agent_only', 'read_only'],
    admin: ['admin', 'agent_only', 'read_only'],
    agent_only: ['agent_only', 'read_only'],
    read_only: ['read_only'],
  };

  app.decorate(
    'checkApiKeyScope',
    (requiredScopes: string[]) =>
      async function (request: FastifyRequest, reply: FastifyReply) {
        // JWT-authenticated requests have no scope restriction
        if (!request.apiKeyScope) return;

        const grantedScopes = SCOPE_HIERARCHY[request.apiKeyScope] ?? [];
        const hasScope = requiredScopes.some((s) => grantedScopes.includes(s));

        if (!hasScope) {
          return reply.code(403).send({
            data: null,
            meta: { requestId: request.id, timestamp: new Date().toISOString() },
            error: {
              code: 'SCOPE_DENIED',
              message: `API key scope "${request.apiKeyScope}" does not permit this action. Required: ${requiredScopes.join(' | ')}`,
            },
          });
        }
      }
  );
};

export const authPlugin = fp(authPluginImpl);
