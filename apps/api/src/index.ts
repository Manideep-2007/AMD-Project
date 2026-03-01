import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
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
import { wsHandler } from './websocket';

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

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: {
      expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m',
    },
  });

  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    redis: process.env.REDIS_URL,
  });

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

  // WebSocket routes
  await app.register(wsHandler, { prefix: '/ws' });

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, '🚀 API server started');
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

start();
