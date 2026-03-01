import { FastifyPluginAsync } from 'fastify';
import { prisma, UserRole, type Prisma } from '@nexusops/db';
import { z } from 'zod';
import * as bcrypt from 'bcrypt';

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

    const refreshToken = app.jwt.sign(
      {
        userId: user.id,
        workspaceId: userWorkspace.workspaceId,
        role: userWorkspace.role,
        type: 'refresh',
      },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      data: {
        accessToken,
        refreshToken,
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

    // Hash password
    const passwordHash = await bcrypt.hash(body.password, 10);

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

    const refreshToken = app.jwt.sign(
      {
        userId: result.user.id,
        workspaceId: result.workspace.id,
        role: UserRole.OWNER,
        type: 'refresh',
      },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );

    await prisma.refreshToken.create({
      data: {
        userId: result.user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      data: {
        accessToken,
        refreshToken,
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
    const { refreshToken } = request.body as { refreshToken: string };

    if (!refreshToken) {
      return reply.code(400).send({
        data: null,
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
        error: {
          code: 'MISSING_TOKEN',
          message: 'Refresh token required',
        },
      });
    }

    // Verify and decode token
    try {
      const decoded = app.jwt.verify(refreshToken) as any;

      // Check if token exists and is not revoked
      const tokenRecord = await prisma.refreshToken.findUnique({
        where: { token: refreshToken },
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

      // Generate new access token
      const accessToken = app.jwt.sign({
        userId: decoded.userId,
        workspaceId: decoded.workspaceId,
        role: decoded.role,
        type: 'access',
      });

      return {
        data: { accessToken },
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
    const { refreshToken } = request.body as { refreshToken: string };

    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revokedAt: new Date() },
      });
    }

    return {
      data: { success: true },
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: null,
    };
  });
};
