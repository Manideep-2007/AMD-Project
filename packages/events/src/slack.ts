/**
 * Slack Notification Helper — exported from @nexusops/events
 *
 * Sends approval escalation and decision notifications to a Slack Incoming Webhook.
 * Implements deduplication: if ≥10 escalations arrive within 30 seconds they are
 * batched into a single summary message to prevent alert fatigue.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL (required to enable)
 *   SLACK_CHANNEL      — Optional channel override (#nexusops-alerts)
 *   APP_URL            — Base URL for deep-link buttons (e.g. https://app.nexusops.io)
 */

import { createLogger } from '@nexusops/logger';

const logger = createLogger('slack');

const DEDUP_WINDOW_MS = 30_000;   // 30-second deduplication window
const BATCH_THRESHOLD = 10;       // batch if >= this many escalations in window

// Per-process buffer — works for single-process deployments.
// For multi-replica deployments, replace with a shared Redis INCR/EXPIRE counter.
interface EscalationEntry {
  agentName: string;
  taskName: string;
  riskLevel: string;
  blastRadius?: number;
  time: number;
}

const _buffer: EscalationEntry[] = [];
let _batchTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function webhookUrl(): string | undefined {
  return process.env.SLACK_WEBHOOK_URL;
}

async function sendBlocks(blocks: object[]): Promise<void> {
  const url = webhookUrl();
  if (!url) {
    logger.debug('SLACK_WEBHOOK_URL not configured, skipping notification');
    return;
  }
  try {
    const body: Record<string, unknown> = { blocks };
    if (process.env.SLACK_CHANNEL) body.channel = process.env.SLACK_CHANNEL;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, statusText: res.statusText }, 'Slack webhook returned non-OK');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to deliver Slack notification');
  }
}

async function flushBatch(): Promise<void> {
  _batchTimer = null;
  if (_buffer.length === 0) return;
  const count = _buffer.length;
  const entries = _buffer.splice(0);
  const maxBlast = entries.reduce((m, e) => Math.max(m, e.blastRadius ?? 0), 0);
  const appUrl = process.env.APP_URL ?? '';

  await sendBlocks([
    {
      type: 'header',
      text: { type: 'plain_text', text: `⚠️ ${count} Agent Escalations Need Review`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${count} approval requests* queued in the last 30 seconds.\nHighest blast radius: *$${maxBlast.toFixed(2)}*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: entries.slice(0, 8).map((e) =>
          `• *${e.agentName}* → ${e.taskName} (${e.riskLevel.toUpperCase()}${e.blastRadius != null ? `, $${e.blastRadius.toFixed(2)}` : ''})`
        ).join('\n') + (entries.length > 8 ? `\n_…and ${entries.length - 8} more_` : ''),
      },
    },
    ...(appUrl ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📋 Review All Approvals', emoji: true },
        url: `${appUrl}/approvals`,
        style: 'primary',
      }],
    }] : []),
  ]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Notify Slack when a TaskApproval is created (ESCALATE_TO_HUMAN policy action).
 * Call this immediately after `prisma.taskApproval.create()`.
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
}): Promise<void> {
  const entry: EscalationEntry = {
    agentName: params.agentName,
    taskName: params.taskName,
    riskLevel: params.riskLevel,
    blastRadius: params.blastRadius,
    time: Date.now(),
  };

  // Purge stale entries outside the dedup window
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  while (_buffer.length > 0 && _buffer[0].time < cutoff) _buffer.shift();

  _buffer.push(entry);

  if (_buffer.length >= BATCH_THRESHOLD) {
    // Hit threshold — flush immediately as a batch
    if (_batchTimer) { clearTimeout(_batchTimer); _batchTimer = null; }
    await flushBatch();
    return;
  }

  if (_buffer.length === 1) {
    // First event in a quiet period — send immediately as an individual alert
    _buffer.pop();
    const riskEmoji = params.riskLevel === 'critical' ? '🚨'
      : params.riskLevel === 'high' ? '⚠️'
      : params.riskLevel === 'medium' ? '⚡' : 'ℹ️';

    const appUrl = process.env.APP_URL ?? '';
    await sendBlocks([
      {
        type: 'header',
        text: { type: 'plain_text', text: `${riskEmoji} Approval Required — ${params.riskLevel.toUpperCase()}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent*\n${params.agentName}` },
          { type: 'mrkdwn', text: `*Task*\n${params.taskName || params.taskId.slice(0, 12)}` },
          { type: 'mrkdwn', text: `*Risk Level*\n${params.riskLevel.toUpperCase()}` },
          ...(params.blastRadius != null
            ? [{ type: 'mrkdwn', text: `*Blast Radius*\n$${params.blastRadius.toFixed(2)}` }]
            : []),
        ],
      },
      ...(params.reason ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Reason*\n\`\`\`${params.reason.slice(0, 300)}\`\`\`` },
      }] : []),
      ...(appUrl ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '✅ Review', emoji: true },
          url: `${appUrl}/approvals`,
          style: 'primary',
        }],
      }] : []),
    ]);
  } else {
    // Multiple pending — start/reset the dedup batch timer
    if (!_batchTimer) _batchTimer = setTimeout(flushBatch, DEDUP_WINDOW_MS);
  }
}

/**
 * Notify Slack when an operator approves or denies a TaskApproval.
 * Call this after the `prisma.taskApproval.update()` that records the decision.
 * Optional — skip if decision notifications are not desired.
 */
export async function notifyDecision(params: {
  approved: boolean;
  agentName: string;
  taskName: string;
  taskId: string;
  decidedBy: string;
  reason?: string;
}): Promise<void> {
  if (!webhookUrl()) return;

  const emoji = params.approved ? '✅' : '❌';
  const action = params.approved ? 'Approved' : 'Denied';

  await sendBlocks([
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${emoji} *Approval ${action}*`,
          `Agent: *${params.agentName}* | Task: *${params.taskName || params.taskId.slice(0, 12)}*`,
          `By: ${params.decidedBy}`,
          params.reason ? `> ${params.reason}` : '',
        ].filter(Boolean).join('\n'),
      },
    },
  ]);
}
