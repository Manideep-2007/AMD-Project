import { queueManager, Job } from '@nexusops/queue';
import { prisma, TaskStatus, AgentStatus } from '@nexusops/db';
import { policyEngine } from '@nexusops/policy';
import { createLogger } from '@nexusops/logger';
import { appendAuditEvent, createComplianceArtifact } from '@nexusops/events';
import { atomicBudgetDeduct, calculateAnomalyScore } from '@nexusops/blast-radius';
import { scanText } from '@nexusops/injection';
import type { JobData, JobType } from '@nexusops/types';
import { createServer } from 'http';

const logger = createLogger('worker');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3003';
const PROXY_INTERNAL_SECRET = process.env.PROXY_INTERNAL_SECRET;
if (!PROXY_INTERNAL_SECRET) {
  logger.error('PROXY_INTERNAL_SECRET is not set — worker cannot authenticate with proxy');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

class AgentWorker {
  private isShuttingDown = false;

  async start() {
    logger.info('Agent worker starting...');

    // Minimal health check HTTP server — used by Docker / Kubernetes liveness probes
    const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '3004', 10);
    const healthServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'worker', timestamp: new Date().toISOString() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
      logger.info({ port: HEALTH_PORT }, 'Worker health server listening');
    });

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

    logger.info({ concurrency }, 'Worker started');

    // Start approval timeout checker
    this.startApprovalTimeoutChecker();

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info(`Received ${signal}, shutting down worker...`);

        healthServer.close();
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

      case 'update_metrics':
        return this.updateMetrics(workspaceId, payload as any);
      
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  }

  /**
   * Execute a task — the real execution engine
   */
  private async executeTask(workspaceId: string, taskId: string) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      include: { agent: true },
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Don't execute if task was cancelled or already completed
    if (([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED] as TaskStatus[]).includes(task.status)) {
      logger.warn({ taskId, status: task.status }, 'Skipping task — already terminal');
      return { success: false, reason: 'Task in terminal state' };
    }

    logger.info({ taskId, agentId: task.agentId }, 'Executing task');

    try {
      // Step 1: Injection scan on task input
      const inputStr = JSON.stringify(task.input);
      const injectionResult = scanText(inputStr, true);

      if (!injectionResult.safe && injectionResult.riskLevel === 'CRITICAL') {
        await prisma.task.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.FAILED,
            completedAt: new Date(),
            error: { message: 'Prompt injection detected in task input', findings: injectionResult.findings },
          },
        });

        await appendAuditEvent({
          workspaceId,
          eventType: 'task.injection_blocked',
          entityType: 'task',
          entityId: taskId,
          action: 'BLOCK',
          metadata: { riskLevel: injectionResult.riskLevel, findings: injectionResult.findings },
        });

        return { success: false, reason: 'Injection detected' };
      }

      // Step 2: Update task status to RUNNING
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

      // Step 3: Budget pre-check
      const estimatedCost = (task.agent.maxCostUsd ?? 10) * 0.01; // 1% of max budget per task
      const budgetResult = await atomicBudgetDeduct(workspaceId, task.agentId, estimatedCost);

      if (!budgetResult.allowed) {
        await prisma.task.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.FAILED,
            completedAt: new Date(),
            error: { message: budgetResult.reason },
          },
        });
        return { success: false, reason: 'Budget exceeded' };
      }

      // Step 4: Anomaly detection
      const anomalyResult = await calculateAnomalyScore(
        task.agentId,
        workspaceId,
        'CUSTOM',
        estimatedCost,
      );
      const anomalyScore = anomalyResult.score;

      if (anomalyScore > 75) {
        // Escalate to human
        await prisma.task.update({
          where: { id: taskId },
          data: { status: TaskStatus.PENDING_APPROVAL },
        });

        await prisma.taskApproval.create({
          data: {
            taskId,
            riskScore: anomalyScore,
            timeoutAt: new Date(Date.now() + 30 * 60 * 1000),
          },
        });

        // Refund budget
        await atomicBudgetDeduct(workspaceId, task.agentId, -estimatedCost);

        await appendAuditEvent({
          workspaceId,
          eventType: 'task.escalated',
          entityType: 'task',
          entityId: taskId,
          action: 'ESCALATE',
          metadata: { anomalyScore, agentId: task.agentId },
        });

        return { success: false, reason: 'Escalated for human approval' };
      }

      // Step 5: Execute the task
      // In production this would call the model adapter and tool proxy.
      // For now, we simulate the execution with proxy calls.
      const executionStart = Date.now();

      // Forward task execution to proxy (via HTTP call to proxy server)
      const taskInput = task.input as Record<string, unknown>;
      const toolCalls = (taskInput.toolCalls as any[]) ?? [];

      let totalTokens = 0;
      let totalCost = estimatedCost;

      for (const call of toolCalls) {
        try {
          const response = await fetch(`${PROXY_URL}/proxy/execute`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(PROXY_INTERNAL_SECRET ? { 'x-proxy-secret': PROXY_INTERNAL_SECRET } : {}),
            },
            body: JSON.stringify({
              workspaceId,
              agentId: task.agentId,
              taskId,
              toolType: call.toolType ?? 'CUSTOM',
              toolMethod: call.toolMethod ?? 'execute',
              input: call.input ?? {},
              environment: call.environment ?? 'DEVELOPMENT',
            }),
          });

          const result = await response.json() as any;

          if (result.blocked) {
            logger.warn({ taskId, reason: result.reason }, 'Tool call blocked during execution');
          }

          totalCost += result.costUsd ?? 0;
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Tool call failed during task execution');
        }
      }

      // If no tool calls, no tokens consumed and no cost incurred
      if (toolCalls.length === 0) {
        totalTokens = 0;
        totalCost = estimatedCost; // keep estimated budget deduction only
      }

      const durationMs = Date.now() - executionStart;

      // Step 6: Complete task
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.COMPLETED,
          completedAt: new Date(),
          output: { result: 'Task completed successfully', toolCallCount: toolCalls.length },
          tokenCount: totalTokens,
          costUsd: totalCost,
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

      // Step 7: Record metrics
      await Promise.all([
        prisma.metric.create({
          data: {
            workspaceId,
            agentId: task.agentId,
            metricName: 'token_usage',
            value: totalTokens,
          },
        }),
        prisma.metric.create({
          data: {
            workspaceId,
            agentId: task.agentId,
            metricName: 'cost',
            value: totalCost,
          },
        }),
        prisma.metric.create({
          data: {
            workspaceId,
            agentId: task.agentId,
            metricName: 'execution_duration_ms',
            value: durationMs,
          },
        }),
      ]);

      // Step 8: Audit event
      await appendAuditEvent({
        workspaceId,
        eventType: 'task.completed',
        entityType: 'task',
        entityId: taskId,
        action: 'COMPLETE',
        metadata: {
          agentId: task.agentId,
          tokenCount: totalTokens,
          costUsd: totalCost,
          durationMs,
          anomalyScore,
        },
      });

      logger.info({ taskId, tokenCount: totalTokens, costUsd: totalCost, durationMs }, 'Task completed');

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
        data: { status: AgentStatus.IDLE },
      });

      await appendAuditEvent({
        workspaceId,
        eventType: 'task.failed',
        entityType: 'task',
        entityId: taskId,
        action: 'FAIL',
        metadata: { error: error.message },
      }).catch(() => {});

      throw error;
    }
  }

  /**
   * Proxy a tool call through the proxy server
   */
  private async proxyToolCall(workspaceId: string, payload: any) {
    const response = await fetch(`${PROXY_URL}/proxy/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PROXY_INTERNAL_SECRET ? { 'x-proxy-secret': PROXY_INTERNAL_SECRET } : {}),
      },
      body: JSON.stringify({ workspaceId, ...payload }),
    });

    return response.json();
  }

  /**
   * Update aggregate metrics (called periodically)
   */
  private async updateMetrics(workspaceId: string, payload: any) {
    // Aggregate daily metrics
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [tokenUsage, cost, taskCount] = await Promise.all([
      prisma.metric.aggregate({
        where: { workspaceId, metricName: 'token_usage', timestamp: { gte: today } },
        _sum: { value: true },
      }),
      prisma.metric.aggregate({
        where: { workspaceId, metricName: 'cost', timestamp: { gte: today } },
        _sum: { value: true },
      }),
      prisma.task.count({
        where: { workspaceId, createdAt: { gte: today } },
      }),
    ]);

    logger.info({
      workspaceId,
      dailyTokens: tokenUsage._sum.value ?? 0,
      dailyCost: cost._sum.value ?? 0,
      dailyTasks: taskCount,
    }, 'Daily metrics updated');

    return { success: true };
  }

  /**
   * Check for approval timeouts and auto-deny expired approvals
   */
  private startApprovalTimeoutChecker() {
    const CHECK_INTERVAL_MS = 60_000; // 1 minute

    const check = async () => {
      if (this.isShuttingDown) return;

      try {
        const timedOut = await prisma.taskApproval.findMany({
          where: {
            decidedAt: null,
            timeoutAt: { lt: new Date() },
          },
          include: { task: true },
        });

        for (const approval of timedOut) {
          await prisma.taskApproval.update({
            where: { id: approval.id },
            data: {
              approved: false,
              reason: 'Auto-denied: approval timeout exceeded',
              decidedAt: new Date(),
            },
          });

          await prisma.task.update({
            where: { id: approval.taskId },
            data: {
              status: TaskStatus.CANCELLED,
              completedAt: new Date(),
            },
          });

          await appendAuditEvent({
            workspaceId: approval.task.workspaceId,
            eventType: 'approval.timeout',
            entityType: 'taskApproval',
            entityId: approval.id,
            action: 'AUTO_DENY',
            metadata: { taskId: approval.taskId, timeoutAt: approval.timeoutAt },
          }).catch(() => {});

          logger.info({ approvalId: approval.id, taskId: approval.taskId }, 'Approval auto-denied (timeout)');
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Approval timeout check failed');
      }

      setTimeout(check, CHECK_INTERVAL_MS);
    };

    setTimeout(check, CHECK_INTERVAL_MS);
  }
}

// Start worker
const worker = new AgentWorker();
worker.start();
