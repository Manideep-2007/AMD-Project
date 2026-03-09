/**
 * Slack Notification Helper
 *
 * Sends approval escalation and decision notifications to Slack.
 * Implements deduplication: if ≥10 escalations arrive within 30 seconds,
 * they are batched into a single summary message to prevent alert fatigue.
 *
 * Configuration (env vars):
 *   SLACK_WEBHOOK_URL  — Incoming Webhook URL
 *   SLACK_CHANNEL      — Optional channel override (e.g. #nexusops-alerts)
 */

import { createLogger } from '@nexusops/logger';

const logger = createLogger('slack');

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DEDUP_WINDOW_MS = 30_000; // 30 seconds
const BATCH_THRESHOLD = 10; // if ≥ this many escalations in window, batch

// In-memory deduplication buffer (shared within the same process)
interface EscalationEntry {
  agentName: string;
  taskName: string;
  riskLevel: string;
  blastRadius?: number;
  time: number;
}

const escalationBuffer: EscalationEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** Flush all buffered escalations as a single summary Slack message */
async function flushBatch() {
  batchTimer = null;
  if (escalationBuffer.length === 0) return;
  const count = escalationBuffer.length;
  const entries = escalationBuffer.splice(0);
  const maxBlast = entries.reduce((m, e) => Math.max(m, e.blastRadius ?? 0), 0);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `⚠️ ${count} Agent Escalations Require Attention`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${count} approval requests* have queued up in the last 30 seconds.\nMax blast radius in batch: *$${maxBlast.toFixed(2)}*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: entries.slice(0, 8).map((e) =>
          `• *${e.agentName}* → ${e.taskName} (${e.riskLevel.toUpperCase()}${e.blastRadius ? `, $${e.blastRadius.toFixed(2)}` : ''})`
        ).join('\n') + (entries.length > 8 ? `\n_…and ${entries.length - 8} more_` : ''),
      },
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📋 Review Approvals', emoji: true },
        url: process.env.APP_URL ? `${process.env.APP_URL}/approvals` : '#',
        style: 'primary',
      }],
    },
  ];

  await sendBlocks(blocks);
}

/** Send raw blocks to Slack */
async function sendBlocks(blocks: object[]) {
  if (!WEBHOOK_URL) {
    logger.warn('SLACK_WEBHOOK_URL not set — skipping Slack notification');
    return;
  }
  try {
    const body: Record<string, unknown> = { blocks };
    if (process.env.SLACK_CHANNEL) body.channel = process.env.SLACK_CHANNEL;

    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'Slack webhook returned non-OK status');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to send Slack notification');
  }
}

/**
 * notifyEscalation — call when a TaskApproval is created (ESCALATE_TO_HUMAN)
 */
export async function notifyEscalation(params: {
  agentName: string;
  agentId: string;
  taskName: string;
  taskId: string;
  riskLevel: string;
  blastRadius?: number;
  reason?: string;
  workspaceId: string;
}) {
  const entry: EscalationEntry = {
    agentName: params.agentName,
    taskName: params.taskName,
    riskLevel: params.riskLevel,
    blastRadius: params.blastRadius,
    time: Date.now(),
  };

  // Purge stale entries outside the dedup window
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  while (escalationBuffer.length > 0 && escalationBuffer[0].time < cutoff) {
    escalationBuffer.shift();
  }

  escalationBuffer.push(entry);

  if (escalationBuffer.length >= BATCH_THRESHOLD) {
    // Threshold reached — flush immediately
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    await flushBatch();
    return;
  }

  // For smaller bursts, schedule a batch flush after the dedup window
  // (first escalation in a quiet period sends immediately)
  if (escalationBuffer.length === 1) {
    // Only one pending — send immediately as an individual alert
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

    const riskEmoji = params.riskLevel === 'critical' ? '🚨'
      : params.riskLevel === 'high' ? '⚠️'
      : params.riskLevel === 'medium' ? '⚡'
      : 'ℹ️';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${riskEmoji} Approval Required — ${params.riskLevel.toUpperCase()} Risk`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent*\n${params.agentName}` },
          { type: 'mrkdwn', text: `*Task*\n${params.taskName || params.taskId.slice(0, 12)}` },
          params.blastRadius != null
            ? { type: 'mrkdwn', text: `*Blast Radius*\n$${params.blastRadius.toFixed(2)}` }
            : { type: 'mrkdwn', text: `*Workspace*\n${params.workspaceId.slice(0, 12)}` },
          { type: 'mrkdwn', text: `*Risk Level*\n${params.riskLevel.toUpperCase()}` },
        ],
      },
      ...(params.reason ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Reason*\n\`\`\`${params.reason.slice(0, 300)}\`\`\`` },
      }] : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Review', emoji: true },
            url: process.env.APP_URL ? `${process.env.APP_URL}/approvals` : '#',
            style: 'primary',
          },
        ],
      },
    ];

    await sendBlocks(blocks);
    // Pop the single entry we just sent since it was handled independently
    escalationBuffer.pop();
  } else {
    // Multiple pending — start/reset a dedup timer
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, DEDUP_WINDOW_MS);
    }
  }
}

/**
 * notifyDecision — call when a human approves or denies a TaskApproval
 */
export async function notifyDecision(params: {
  approved: boolean;
  agentName: string;
  taskName: string;
  taskId: string;
  decidedBy: string;
  reason?: string;
}) {
  if (!WEBHOOK_URL) return;

  const emoji = params.approved ? '✅' : '❌';
  const action = params.approved ? 'Approved' : 'Denied';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *Approval ${action}*\nAgent: *${params.agentName}* | Task: *${params.taskName || params.taskId.slice(0, 12)}*\nBy: ${params.decidedBy}${params.reason ? `\n> ${params.reason}` : ''}`,
      },
    },
  ];

  await sendBlocks(blocks);
}
