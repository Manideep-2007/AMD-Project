import { FastifyPluginAsync } from 'fastify';
import '@fastify/cookie';
import { prisma, UserRole, type Prisma } from '@nexusops/db';
import { z } from 'zod';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  workspaceName: z.string().min(1),
  workspaceSlug: z.string().regex(/^[a-z0-9-]+$/),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

/** Hash refresh token for storage — never store JWT plaintext */
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Dedicated refresh token secret — MUST differ from JWT_SECRET */
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
if (!JWT_REFRESH_SECRET) {
  throw new Error('JWT_REFRESH_SECRET must be set — refresh tokens require a separate signing key from JWT_SECRET');
}

function signRefreshToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET!, { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as jwt.SignOptions['expiresIn'] });
}

function verifyRefreshToken(token: string): Record<string, unknown> {
  return jwt.verify(token, JWT_REFRESH_SECRET!) as Record<string, unknown>;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/auth/login
   * User login
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: {
        workspaces: {
          include: { workspace: true },
        },
      },
    });

    if (!user) {
      return reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    if (!user.passwordHash) {
      return reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    const passwordMatch = await bcrypt.compare(body.password, user.passwordHash);

    if (!passwordMatch) {
      return reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    // Use first workspace (in production, user would select)
    const userWorkspace = user.workspaces[0];

    if (!userWorkspace) {
      return reply.code(400).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'NO_WORKSPACE',
          message: 'User has no associated workspace',
        },
      });
    }

    // Generate tokens
    const accessToken = app.jwt.sign({
      userId: user.id,
      workspaceId: userWorkspace.workspaceId,
      role: userWorkspace.role,
      type: 'access',
    });

    const refreshToken = signRefreshToken({
      userId: user.id,
      workspaceId: userWorkspace.workspaceId,
      role: userWorkspace.role,
      type: 'refresh',
    });

    // Store refresh token hash — never store JWT plaintext
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Set refresh token as httpOnly cookie
    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
    });

    return {
      data: {
        accessToken,
        // refreshToken is delivered exclusively via httpOnly cookie — not in the
        // response body. Exposing it in the body would defeat the httpOnly protection
        // (proxy logs, CDN access logs, etc. would capture it).
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        workspace: {
          id: userWorkspace.workspace.id,
          name: userWorkspace.workspace.name,
          slug: userWorkspace.workspace.slug,
          role: userWorkspace.role,
        },
      },
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: null,
    };
  });

  /**
   * POST /api/v1/auth/register
   * User registration with workspace creation
   */
  app.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // Check if user or workspace exists
    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      return reply.code(400).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'USER_EXISTS',
          message: 'User with this email already exists',
        },
      });
    }

    const existingWorkspace = await prisma.workspace.findUnique({
      where: { slug: body.workspaceSlug },
    });

    if (existingWorkspace) {
      return reply.code(400).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'WORKSPACE_EXISTS',
          message: 'Workspace with this slug already exists',
        },
      });
    }

    // Hash password — 12 rounds matches seed.ts and provides good brute-force resistance
    const passwordHash = await bcrypt.hash(body.password, 12);

    // Create user and workspace in transaction
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const workspace = await tx.workspace.create({
        data: {
          name: body.workspaceName,
          slug: body.workspaceSlug,
        },
      });

      const user = await tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          name: body.name,
          emailVerified: false,
        },
      });

      await tx.workspaceUser.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: UserRole.OWNER,
        },
      });

      return { user, workspace };
    });

    // Generate tokens
    const accessToken = app.jwt.sign({
      userId: result.user.id,
      workspaceId: result.workspace.id,
      role: UserRole.OWNER,
      type: 'access',
    });

    const refreshToken = signRefreshToken({
      userId: result.user.id,
      workspaceId: result.workspace.id,
      role: UserRole.OWNER,
      type: 'refresh',
    });

    await prisma.refreshToken.create({
      data: {
        userId: result.user.id,
        token: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Set refresh token as httpOnly cookie
    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    });

    return {
      data: {
        accessToken,
        // refreshToken is in the httpOnly cookie only — not in the body.
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
        },
        workspace: {
          id: result.workspace.id,
          name: result.workspace.name,
          slug: result.workspace.slug,
          role: UserRole.OWNER,
        },
      },
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: null,
    };
  });

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token
   */
  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    // Accept from body or httpOnly cookie
    const refreshToken = body.refreshToken || (request.cookies as any)?.refresh_token;

    if (!refreshToken) {
      return reply.code(400).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'MISSING_TOKEN',
          message: 'Refresh token required (via body or cookie)',
        },
      });
    }

    // Verify and decode token
    try {
      const decoded = verifyRefreshToken(refreshToken) as any;

      // Look up by hash — we never store plaintext
      const tokenHash = hashRefreshToken(refreshToken);
      const tokenRecord = await prisma.refreshToken.findFirst({
        where: { token: tokenHash, userId: decoded.userId },
      });

      if (!tokenRecord || tokenRecord.revokedAt) {
        return reply.code(401).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or revoked refresh token',
          },
        });
      }

      // Rotate: revoke old token, issue new pair
      await prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: { revokedAt: new Date() },
      });

      const newAccessToken = app.jwt.sign({
        userId: decoded.userId,
        workspaceId: decoded.workspaceId,
        role: decoded.role,
        type: 'access',
      });

      const newRefreshToken = signRefreshToken({
        userId: decoded.userId,
        workspaceId: decoded.workspaceId,
        role: decoded.role,
        type: 'refresh',
      });

      await prisma.refreshToken.create({
        data: {
          userId: decoded.userId,
          token: hashRefreshToken(newRefreshToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Set new refresh token as httpOnly cookie
      reply.setCookie('refresh_token', newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60,
      });

      return {
        data: { accessToken: newAccessToken, refreshToken: newRefreshToken },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    } catch (err) {
      return reply.code(401).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid refresh token',
        },
      });
    }
  });

  /**
   * POST /api/v1/auth/logout
   * Logout (revoke refresh token)
   */
  app.post('/logout', async (request, reply) => {
    // Prefer reading the token from the httpOnly cookie; accept body as fallback
    // for clients that can't send cookies (e.g. server-side SDKs).
    const cookieToken = (request.cookies as any)?.refresh_token as string | undefined;
    const bodyToken = (request.body as { refreshToken?: string })?.refreshToken;
    const rawToken = cookieToken || bodyToken;

    if (rawToken) {
      // BUG FIX: tokens are stored as SHA-256 hashes — must hash before lookup.
      // The previous code compared raw JWT against the hash, so revocation never worked.
      const tokenHash = hashRefreshToken(rawToken);
      await prisma.refreshToken.updateMany({
        where: { token: tokenHash },
        data: { revokedAt: new Date() },
      });
    }

    // Clear the httpOnly cookie regardless of whether a token was provided.
    reply.clearCookie('refresh_token', { path: '/api/v1/auth' });

    return {
      data: { success: true },
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: null,
    };
  });

  /**
   * GET /api/v1/auth/sessions
   * List active sessions (non-revoked, non-expired refresh tokens) for the current user.
   */
  app.get('/sessions', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const userId = request.user.userId;

      const sessions = await prisma.refreshToken.findMany({
        where: {
          userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        data: sessions,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * DELETE /api/v1/auth/sessions/:id
   * Revoke a specific session (refresh token) for the current user.
   */
  app.delete('/sessions/:id', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user.userId;

      const session = await prisma.refreshToken.findFirst({
        where: { id, userId, revokedAt: null },
      });

      if (!session) {
        return reply.code(404).send({
          data: null,
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
          error: { code: 'NOT_FOUND', message: 'Session not found' },
        });
      }

      await prisma.refreshToken.update({
        where: { id },
        data: { revokedAt: new Date() },
      });

      return {
        data: { success: true },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });

  /**
   * DELETE /api/v1/auth/sessions
   * Revoke ALL sessions except the current one.
   */
  app.delete('/sessions', {
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const userId = request.user.userId;

      // Extract the current refresh token so we can exclude it
      const currentRefreshCookie = (request as any).cookies?.refresh_token;
      let currentTokenHash: string | null = null;
      if (currentRefreshCookie) {
        currentTokenHash = hashRefreshToken(currentRefreshCookie);
      }

      const where: Record<string, unknown> = {
        userId,
        revokedAt: null,
      };

      if (currentTokenHash) {
        where.token = { not: currentTokenHash };
      }

      const result = await prisma.refreshToken.updateMany({
        where: where as any,
        data: { revokedAt: new Date() },
      });

      return {
        data: { revokedCount: result.count },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: null,
      };
    },
  });
};
