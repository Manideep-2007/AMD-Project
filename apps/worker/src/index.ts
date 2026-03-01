import { queueManager, Job } from '@nexusops/queue';
import { prisma, TaskStatus, AgentStatus } from '@nexusops/db';
import { policyEngine } from '@nexusops/policy';
import { createLogger } from '@nexusops/logger';
import type { JobData, JobType } from '@nexusops/types';

const logger = createLogger('worker');

class AgentWorker {
  private isShuttingDown = false;

  async start() {
    logger.info('🚀 Agent worker starting...');

    const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '10', 10);

    // Create worker for task execution
    const worker = queueManager.createWorker<JobData>(
      'tasks',
      this.processJob.bind(this),
      { concurrency }
    );

    worker.on('completed', (job) => {
      logger.info({ jobId: job.id }, 'Job completed successfully');
    });

    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, error: err.message }, 'Job failed');
    });

    logger.info({ concurrency }, '✅ Worker started');

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info(`Received ${signal}, shutting down worker...`);
        
        await worker.close();
        await queueManager.close();
        
        logger.info('Worker shut down gracefully');
        process.exit(0);
      });
    });
  }

  /**
   * Process a job from the queue
   */
  private async processJob(job: Job<JobData>): Promise<any> {
    const { type, workspaceId, payload } = job.data;

    logger.info({ jobId: job.id, type, workspaceId }, 'Processing job');

    switch (type) {
      case 'execute_task':
        return this.executeTask(workspaceId, (payload as any).taskId);
      
      case 'proxy_tool_call':
        return this.proxyToolCall(workspaceId, payload as any);
      
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(workspaceId: string, taskId: string) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      include: { agent: true },
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    logger.info({ taskId, agentId: task.agentId }, 'Executing task');

    try {
      // Update task status to RUNNING
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.RUNNING,
          startedAt: new Date(),
        },
      });

      // Update agent status
      await prisma.agent.update({
        where: { id: task.agentId },
        data: {
          status: AgentStatus.ACTIVE,
          heartbeatAt: new Date(),
        },
      });

      // Simulate task execution (in production, this would be actual agent logic)
      // For MVP, we'll just simulate success after a delay
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const tokenCount = Math.floor(Math.random() * 5000) + 1000;
      const costUsd = tokenCount * 0.00002; // Simulate cost

      // Complete task
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.COMPLETED,
          completedAt: new Date(),
          output: { result: 'Task completed successfully' },
          tokenCount,
          costUsd,
        },
      });

      // Update agent status back to IDLE
      await prisma.agent.update({
        where: { id: task.agentId },
        data: {
          status: AgentStatus.IDLE,
          heartbeatAt: new Date(),
        },
      });

      // Record metrics
      await prisma.metric.create({
        data: {
          workspaceId,
          agentId: task.agentId,
          metricName: 'token_usage',
          value: tokenCount,
        },
      });

      await prisma.metric.create({
        data: {
          workspaceId,
          agentId: task.agentId,
          metricName: 'cost',
          value: costUsd,
        },
      });

      logger.info({ taskId, tokenCount, costUsd }, 'Task completed successfully');

      return { success: true, taskId };
    } catch (error: any) {
      logger.error({ taskId, error: error.message }, 'Task execution failed');

      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.FAILED,
          completedAt: new Date(),
          error: {
            message: error.message,
            stack: error.stack,
          },
        },
      });

      await prisma.agent.update({
        where: { id: task.agentId },
        data: {
          status: AgentStatus.IDLE,
        },
      });

      throw error;
    }
  }

  /**
   * Proxy a tool call through policy evaluation
   */
  private async proxyToolCall(workspaceId: string, payload: any) {
    // This would evaluate policies and execute the tool call
    logger.info({ workspaceId, payload }, 'Proxying tool call');
    
    // Placeholder for tool proxy logic
    return { success: true };
  }
}

// Start worker
const worker = new AgentWorker();
worker.start();
