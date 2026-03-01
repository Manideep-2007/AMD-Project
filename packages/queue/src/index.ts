import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { createLogger } from '@nexusops/logger';
import type { JobType, JobData } from '@nexusops/types';

const logger = createLogger('queue');

/**
 * Redis connection configuration
 */
const getRedisConnection = () => {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
};

/**
 * Queue Manager
 * Handles job queue creation and management
 */
export class QueueManager {
  private queues: Map<string, Queue> = new Map();
  private connection: Redis;

  constructor() {
    this.connection = getRedisConnection();
  }

  /**
   * Get or create a queue
   */
  getQueue<T = JobData>(name: string): Queue<T> {
    if (this.queues.has(name)) {
      return this.queues.get(name) as Queue<T>;
    }

    const queue = new Queue<T>(name, {
      connection: this.connection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600, // 24 hours
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600, // 7 days
        },
      },
    });

    this.queues.set(name, queue as any);
    logger.info({ queueName: name }, 'Queue created');

    return queue;
  }

  /**
   * Add job to queue
   */
  async addJob<T = JobData>(
    queueName: string,
    jobName: string,
    data: T,
    options?: {
      priority?: number;
      delay?: number;
      attempts?: number;
    }
  ) {
    const queue = this.getQueue<T>(queueName);
    
    const job = await queue.add(jobName as any, data as any, {
      priority: options?.priority,
      delay: options?.delay,
      attempts: options?.attempts,
    });

    logger.debug({ jobId: job.id, queueName, jobName }, 'Job added to queue');

    return job;
  }

  /**
   * Create a worker for a queue
   */
  createWorker<T = JobData>(
    queueName: string,
    processor: (job: Job<T>) => Promise<unknown>,
    options?: {
      concurrency?: number;
      limiter?: {
        max: number;
        duration: number;
      };
    }
  ): Worker<T> {
    const connection = getRedisConnection();

    const worker = new Worker<T>(queueName, processor, {
      connection: connection as any,
      concurrency: options?.concurrency || 10,
      limiter: options?.limiter,
    });

    worker.on('completed', (job) => {
      logger.info({ jobId: job.id, queueName }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, queueName, error: err.message }, 'Job failed');
    });

    worker.on('error', (err) => {
      logger.error({ queueName, error: err.message }, 'Worker error');
    });

    logger.info({ queueName, concurrency: options?.concurrency }, 'Worker created');

    return worker;
  }

  /**
   * Create queue events listener
   */
  createQueueEvents(queueName: string): QueueEvents {
    const connection = getRedisConnection();

    const queueEvents = new QueueEvents(queueName, { connection: connection as any });

    queueEvents.on('waiting', ({ jobId }) => {
      logger.debug({ jobId, queueName }, 'Job waiting');
    });

    queueEvents.on('active', ({ jobId }) => {
      logger.debug({ jobId, queueName }, 'Job active');
    });

    queueEvents.on('completed', ({ jobId }) => {
      logger.debug({ jobId, queueName }, 'Job completed');
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.warn({ jobId, queueName, reason: failedReason }, 'Job failed');
    });

    return queueEvents;
  }

  /**
   * Get queue metrics
   */
  async getQueueMetrics(queueName: string) {
    const queue = this.getQueue(queueName);

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
    };
  }

  /**
   * Close all connections
   */
  async close() {
    await Promise.all(
      Array.from(this.queues.values()).map((queue) => queue.close())
    );
    await this.connection.quit();
    logger.info('All queues closed');
  }
}

// Export singleton
export const queueManager = new QueueManager();

// Export BullMQ types
export { Queue, Worker, Job, QueueEvents } from 'bullmq';

// Export job types
export { JobType, JobData } from '@nexusops/types';
