import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('api:error');

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  logger.error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
      },
      request: {
        id: request.id,
        method: request.method,
        url: request.url,
      },
    },
    'Request error'
  );

  // Validation errors
  if (error.validation) {
    return reply.code(400).send({
      data: null,
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.validation,
      },
    });
  }

  // Rate limit errors
  if (error.statusCode === 429) {
    return reply.code(429).send({
      data: null,
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
      },
    });
  }

  // Default error response
  const statusCode = error.statusCode || 500;

  return reply.code(statusCode).send({
    data: null,
    meta: { requestId: request.id, timestamp: new Date().toISOString() },
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
    },
  });
}
