// OpenTelemetry MUST be initialized before any other imports
import { initTelemetry } from '@nexusops/telemetry';
initTelemetry('nexusops-api');

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { createLogger } from '@nexusops/logger';
import { authPlugin } from './plugins/auth';
import { errorHandler } from './plugins/error-handler';
import { agentsRoutes } from './routes/agents';
import { tasksRoutes } from './routes/tasks';
import { policiesRoutes } from './routes/policies';
import { toolsRoutes } from './routes/tools';
import { auditRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { metricsRoutes } from './routes/metrics';
import { approvalsRoutes } from './routes/approvals';
import { budgetsRoutes } from './routes/budgets';
import { securityRoutes } from './routes/security';
import { costsRoutes } from './routes/costs';
import { settingsRoutes } from './routes/settings';
import { onboardingRoutes } from './routes/onboarding';
import { oidcRoutes } from './routes/oidc';
import { workspaceRoutes } from './routes/workspace';
import { eccRoutes } from './routes/ecc';
import { wsHandler } from './websocket';
import { policyEngine } from '@nexusops/policy';
import { prisma } from '@nexusops/db';

// Optional Rust NAPI for policy cache warm-up
let nativePolicy: { loadWorkspacePolicies: (wsId: string, rules: string, schemas: string) => void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativePolicy = require('@nexusops/policy-core');
} catch {
  // Rust NAPI not built — warm-up is a no-op; TS fallback handles evaluation
}

const logger = createLogger('api');

const PORT = parseInt(process.env.API_PORT || '3001', 10);
const HOST = process.env.API_HOST || '0.0.0.0';

async function start() {
  const app = Fastify({
    logger: false, // Use our custom logger
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  // Register plugins
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  const cookieSecret = process.env.COOKIE_SECRET || jwtSecret;
  if (cookieSecret.length < 32) {
    throw new Error('COOKIE_SECRET must be at least 32 characters');
  }

  await app.register(jwt, {
    secret: jwtSecret,
    sign: {
      expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m',
    },
  });

  await app.register(cookie, {
    secret: cookieSecret,
  });

  // Rate limiting — use Redis store in production, in-memory for dev
  const rateLimitOpts: Record<string, unknown> = {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  };

  if (process.env.REDIS_URL && process.env.NODE_ENV === 'production') {
    try {
      const Redis = (await import('ioredis')).default;
      const redisClient = new Redis(process.env.REDIS_URL);
      rateLimitOpts.redis = redisClient;
    } catch {
      logger.warn('Redis unavailable for rate-limit — using in-memory store');
    }
  }

  await app.register(rateLimit, rateLimitOpts);

  await app.register(websocket);

  // Custom plugins
  await app.register(authPlugin);

  // Error handler
  app.setErrorHandler(errorHandler);

  // Health check
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  });

  // API routes
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(agentsRoutes, { prefix: '/api/v1/agents' });
  await app.register(tasksRoutes, { prefix: '/api/v1/tasks' });
  await app.register(policiesRoutes, { prefix: '/api/v1/policies' });
  await app.register(toolsRoutes, { prefix: '/api/v1/tools' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  await app.register(metricsRoutes, { prefix: '/api/v1/metrics' });
  await app.register(approvalsRoutes, { prefix: '/api/v1/approvals' });
  await app.register(budgetsRoutes, { prefix: '/api/v1/budgets' });
  await app.register(securityRoutes, { prefix: '/api/v1/security' });
  await app.register(costsRoutes, { prefix: '/api/v1/costs' });
  await app.register(settingsRoutes, { prefix: '/api/v1' });
  await app.register(onboardingRoutes, { prefix: '/api/v1/settings' });
  await app.register(oidcRoutes, { prefix: '/api/v1/auth/oidc' });
  await app.register(workspaceRoutes, { prefix: '/api/v1/workspaces' });
  await app.register(eccRoutes, { prefix: '/api/v1/ecc' });

  // WebSocket routes
  await app.register(wsHandler, { prefix: '/ws' });

  // Start server
  try {
    // Start Redis pub/sub for cross-instance policy cache invalidation
    policyEngine.startCacheSubscription();

    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, '🚀 API server started');

    // Warm up the Rust NAPI policy cache for all active workspaces.
    // Without this, the first policy evaluation after a restart returns DENY
    // because the DashMap cache is empty on a fresh process start.
    warmupPolicyCache().catch((err) =>
      logger.warn({ err }, 'Policy cache warm-up failed — first evaluations will fall back to TS engine'),
    );
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, closing server...`);
      await app.close();
      process.exit(0);
    });
  });
}

/**
 * Warm up the Rust NAPI policy cache for every active workspace.
 * Called once after server boot so the DashMap is populated before the first
 * agent tool call arrives — preventing spurious DENY on cold start.
 */
async function warmupPolicyCache(): Promise<void> {
  if (!nativePolicy) return; // TS fallback active; no Rust cache to warm

  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  let loaded = 0;

  for (const ws of workspaces) {
    const rules = await prisma.policyRule.findMany({
      where: { workspaceId: ws.id, enabled: true },
    });
    const agents = await prisma.agent.findMany({
      where: { workspaceId: ws.id },
      select: { id: true, safetySchema: true },
    });

    const schemas = agents.map((a) => [a.id, a.safetySchema ?? {}]);
    nativePolicy.loadWorkspacePolicies(ws.id, JSON.stringify(rules), JSON.stringify(schemas));
    loaded++;
  }

  logger.info({ workspacesLoaded: loaded }, 'Rust policy cache warmed up');
}

start();
