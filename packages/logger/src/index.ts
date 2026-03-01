import pino from 'pino';

/**
 * Create structured logger with pino
 * Production: JSON output
 * Development: Pretty formatted output
 */
export const createLogger = (name: string) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const logLevel = process.env.LOG_LEVEL || 'info';

  return pino({
    name,
    level: logLevel,
    ...(isDevelopment && process.env.PRETTY_LOGS !== 'false'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  });
};

// Default logger
export const logger = createLogger('nexusops');

export default createLogger;
