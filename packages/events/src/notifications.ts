/**
 * @nexusops/events — Webhook / Slack Notification Dispatcher with Deduplication
 *
 * Prevents duplicate notifications using a time-window + event-hash dedup strategy:
 *   1. Each notification is keyed by SHA-256(eventType + entityId + workspaceId)
 *   2. If the same key was dispatched within DEDUP_WINDOW_MS, the duplicate is suppressed.
 *   3. Uses Redis when available; falls back to an in-memory LRU cache.
 *
 * HMAC-SHA256 signing is applied when a webhook secret is configured so the
 * receiving end (Slack, PagerDuty, custom) can verify payload integrity.
 */

import * as crypto from 'crypto';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('notifications');

// ─── Configuration ───────────────────────────

const DEDUP_WINDOW_MS = parseInt(process.env.NOTIFICATION_DEDUP_WINDOW_MS || '300000', 10); // 5 min
const MAX_MEMORY_CACHE = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

// ─── In-memory dedup cache (LRU approximation) ─────

const memoryCache = new Map<string, number>(); // key → expireAt timestamp

function pruneMemoryCache() {
  if (memoryCache.size <= MAX_MEMORY_CACHE) return;
  const now = Date.now();
  for (const [key, expiry] of memoryCache) {
    if (expiry < now || memoryCache.size > MAX_MEMORY_CACHE) {
      memoryCache.delete(key);
    }
  }
}

// ─── Redis dedup (optional) ────────────────

let redisClient: any = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    redisClient.connect().catch(() => {
      redisClient = null;
    });
  }
} catch {
  // Redis not available — in-memory dedup only
}

// ─── Types ───────────────────────────────────

export interface WebhookPayload {
  eventType: string;
  entityId?: string;
  workspaceId: string;
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface WebhookConfig {
  url: string;
  secret?: string; // HMAC-SHA256 signing secret
}

// ─── Core ────────────────────────────────────

function dedupKey(payload: WebhookPayload): string {
  const raw = `${payload.workspaceId}:${payload.eventType}:${payload.entityId ?? ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Check whether this notification was already dispatched within the dedup window.
 * Returns `true` if the notification is a duplicate and should be suppressed.
 */
async function isDuplicate(key: string): Promise<boolean> {
  // Try Redis first
  if (redisClient) {
    try {
      const exists = await redisClient.exists(`notif:dedup:${key}`);
      return exists === 1;
    } catch {
      /* fall through */
    }
  }

  // In-memory fallback
  const expiry = memoryCache.get(key);
  if (expiry && expiry > Date.now()) return true;

  return false;
}

/**
 * Mark this notification key as dispatched so future duplicates are suppressed.
 */
async function markDispatched(key: string): Promise<void> {
  const ttlSeconds = Math.ceil(DEDUP_WINDOW_MS / 1000);

  if (redisClient) {
    try {
      await redisClient.setex(`notif:dedup:${key}`, ttlSeconds, '1');
      return;
    } catch {
      /* fall through */
    }
  }

  memoryCache.set(key, Date.now() + DEDUP_WINDOW_MS);
  pruneMemoryCache();
}

/**
 * Sign a payload using HMAC-SHA256.
 */
function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Send a webhook notification with deduplication.
 *
 * Returns `true` if the notification was dispatched, `false` if suppressed as duplicate.
 * Throws on network/HTTP errors (caller should handle retries).
 */
export async function sendWebhookNotification(
  config: WebhookConfig,
  payload: WebhookPayload,
): Promise<boolean> {
  const key = dedupKey(payload);

  if (await isDuplicate(key)) {
    logger.debug({ key, eventType: payload.eventType }, 'Notification suppressed (dedup)');
    return false;
  }

  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'NexusOps-Webhook/1.0',
  };

  if (config.secret) {
    headers['X-NexusOps-Signature'] = `sha256=${signPayload(body, config.secret)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, url: config.url, eventType: payload.eventType },
        'Webhook delivery failed',
      );
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }

    await markDispatched(key);
    logger.info({ eventType: payload.eventType, url: config.url }, 'Webhook delivered');
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience wrapper for Slack-formatted notifications.
 * Converts a WebhookPayload into a Slack Block Kit message.
 */
export async function sendSlackNotification(
  webhookUrl: string,
  payload: WebhookPayload,
  secret?: string,
): Promise<boolean> {
  const key = dedupKey(payload);

  if (await isDuplicate(key)) {
    logger.debug({ key, eventType: payload.eventType }, 'Slack notification suppressed (dedup)');
    return false;
  }

  const severityEmoji: Record<string, string> = {
    info: ':information_source:',
    warning: ':warning:',
    critical: ':rotating_light:',
  };

  const slackBody = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji[payload.severity ?? 'info']} ${payload.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: payload.message,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Event:* \`${payload.eventType}\` | *Workspace:* \`${payload.workspaceId}\` | *Time:* ${payload.timestamp}`,
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(slackBody);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'NexusOps-Webhook/1.0',
  };

  if (secret) {
    headers['X-NexusOps-Signature'] = `sha256=${signPayload(body, secret)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error({ status: response.status, eventType: payload.eventType }, 'Slack delivery failed');
      throw new Error(`Slack webhook returned HTTP ${response.status}`);
    }

    await markDispatched(key);
    logger.info({ eventType: payload.eventType }, 'Slack notification delivered');
    return true;
  } finally {
    clearTimeout(timer);
  }
}
