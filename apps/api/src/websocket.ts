import { FastifyPluginAsync } from 'fastify';
import { WebSocket } from 'ws';
import { WSEvent, WSMessage } from '@nexusops/types';
import { createLogger } from '@nexusops/logger';

/**
 * Verify JWT token from WebSocket query parameter.
 * Returns decoded payload or null on failure.
 */
async function verifyWsToken(app: any, token: string | undefined): Promise<{ workspaceId: string; sub: string; role: string; exp?: number } | null> {
  if (!token) return null;
  try {
    const decoded = app.jwt.verify(token) as any;
    return decoded?.workspaceId ? decoded : null;
  } catch {
    return null;
  }
}

const logger = createLogger('websocket');

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 10_000;  // 10 seconds for pong response

// Store active connections by workspace
const connections = new Map<string, Set<WebSocket>>();
// Per-client event subscriptions
const subscriptions = new WeakMap<WebSocket, Set<string>>();
// Track heartbeat state per socket
const heartbeats = new WeakMap<WebSocket, { alive: boolean; timer: ReturnType<typeof setInterval> }>();
// Global sequence counter for deduplication
let globalSeq = 0;

function addConnection(key: string, socket: WebSocket): void {
  if (!connections.has(key)) {
    connections.set(key, new Set());
  }
  connections.get(key)!.add(socket);
}

function removeConnection(key: string, socket: WebSocket): void {
  const set = connections.get(key);
  if (set) {
    set.delete(socket);
    if (set.size === 0) connections.delete(key);
  }
  // Clean up heartbeat timer
  const hb = heartbeats.get(socket);
  if (hb) {
    clearInterval(hb.timer);
    heartbeats.delete(socket);
  }
}

/**
 * Start server-side heartbeat for a WebSocket connection.
 * Sends ping every 30s; if no pong within 10s, terminates.
 */
function startHeartbeat(socket: WebSocket): void {
  const hb = { alive: true, timer: setInterval(() => {
    if (!hb.alive) {
      // Client didn't respond to last ping — terminate
      socket.terminate();
      return;
    }
    hb.alive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS) };

  socket.on('pong', () => { hb.alive = true; });
  heartbeats.set(socket, hb);
}

/**
 * Authenticate WebSocket connection — accepts token via first message { type: 'auth', token: '...' }
 * or via query param (legacy). Returns workspaceId or closes socket with 1008.
 */
async function authenticateWs(
  app: any,
  socket: WebSocket,
  request: any,
): Promise<string | null> {
  const query = request.query as any;

  // Try query param first (legacy path)
  let tokenPayload = await verifyWsToken(app, query.token);

  // If no query param token, wait for auth message (up to 5s)
  if (!tokenPayload) {
    tokenPayload = await new Promise<{ workspaceId: string; sub: string; role: string; exp?: number } | null>((resolve) => {
      const timeout = setTimeout(() => {
        socket.close(1008, 'Authentication timeout — send { type: "auth", token: "..." } within 5 seconds');
        resolve(null);
      }, 5000);

      const onMessage = async (data: any) => {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.token) {
            const payload = await verifyWsToken(app, msg.token);
            resolve(payload);
          } else {
            socket.close(1008, 'First message must be { type: "auth", token: "..." }');
            resolve(null);
          }
        } catch {
          socket.close(1008, 'Invalid auth message');
          resolve(null);
        }
      };
      socket.on('message', onMessage);
    });
  }

  if (!tokenPayload?.workspaceId) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1008, 'Valid JWT token required — unauthenticated connections are not allowed');
    }
    return null;
  }

  // Schedule auto-close when token expires
  if (tokenPayload.exp) {
    const ttlMs = tokenPayload.exp * 1000 - Date.now();
    if (ttlMs > 0) {
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(4001, 'Token expired — please reconnect with a fresh token');
        }
      }, ttlMs);
    } else {
      socket.close(4001, 'Token already expired');
      return null;
    }
  }

  return tokenPayload.workspaceId;
}

export const wsHandler: FastifyPluginAsync = async (app) => {
  /**
   * WebSocket: /ws/tasks
   * Real-time task updates
   */
  app.get('/tasks', { websocket: true }, async (socket, request) => {
    const workspaceId = await authenticateWs(app, socket, request);
    if (!workspaceId) return;

    addConnection(workspaceId, socket);
    startHeartbeat(socket);
    logger.info({ workspaceId }, 'WebSocket connection established');

    socket.on('message', (raw: Buffer) => {
      handleClientMessage(socket, raw, workspaceId);
    });

    socket.on('close', () => {
      removeConnection(workspaceId, socket);
      logger.info({ workspaceId }, 'WebSocket connection closed');
    });

    socket.on('error', (error: Error) => {
      logger.error({ workspaceId, error: error.message }, 'WebSocket error');
    });
  });

  /**
   * WebSocket: /ws/agents
   * Real-time agent status updates
   */
  app.get('/agents', { websocket: true }, async (socket, request) => {
    const workspaceId = await authenticateWs(app, socket, request);
    if (!workspaceId) return;

    const key = `${workspaceId}:agents`;
    addConnection(key, socket);
    startHeartbeat(socket);

    socket.on('message', (raw: Buffer) => {
      handleClientMessage(socket, raw, workspaceId);
    });

    socket.on('close', () => {
      removeConnection(key, socket);
    });
  });

  /**
   * WebSocket: /ws/governance
   * Real-time governance events — approvals, budget alerts, security events
   */
  app.get('/governance', { websocket: true }, async (socket, request) => {
    const workspaceId = await authenticateWs(app, socket, request);
    if (!workspaceId) return;

    const key = `${workspaceId}:governance`;
    addConnection(key, socket);
    startHeartbeat(socket);
    logger.info({ workspaceId }, 'Governance WebSocket connection established');

    socket.on('message', (raw: Buffer) => {
      handleClientMessage(socket, raw, workspaceId);
    });

    socket.on('close', () => {
      removeConnection(key, socket);
    });
  });
};

/**
 * Handle incoming client messages: ping, subscribe, unsubscribe
 */
function handleClientMessage(socket: WebSocket, raw: Buffer, workspaceId: string): void {
  try {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong', seq: ++globalSeq, timestamp: new Date().toISOString() }));
        break;

      case 'subscribe': {
        const types = msg.payload?.eventTypes as string[] | undefined;
        if (types?.length) {
          if (!subscriptions.has(socket)) subscriptions.set(socket, new Set());
          types.forEach((t: string) => subscriptions.get(socket)!.add(t));
          logger.debug({ workspaceId, eventTypes: types }, 'Client subscribed to events');
        }
        break;
      }

      case 'unsubscribe': {
        const types = msg.payload?.eventTypes as string[] | undefined;
        if (types?.length) {
          const subs = subscriptions.get(socket);
          if (subs) types.forEach((t: string) => subs.delete(t));
        }
        break;
      }

      default:
        logger.debug({ workspaceId, type: msg.type }, 'Unknown WS message type');
    }
  } catch {
    // ignore malformed messages
  }
}

/**
 * Broadcast message to all connected clients in a workspace.
 * Respects per-client event subscriptions.
 */
export function broadcastToWorkspace<T = unknown>(
  workspaceId: string,
  event: WSEvent,
  data: T,
  channel: string = ''
) {
  const key = channel ? `${workspaceId}:${channel}` : workspaceId;
  const workspaceConnections = connections.get(key);

  if (!workspaceConnections || workspaceConnections.size === 0) {
    return;
  }

  const seq = ++globalSeq;
  const message: WSMessage<T> & { seq: number } = {
    event,
    data,
    workspaceId,
    timestamp: new Date().toISOString(),
    seq,
  };

  const messageStr = JSON.stringify(message);
  let sent = 0;

  for (const socket of workspaceConnections) {
    if (socket.readyState !== WebSocket.OPEN) continue;

    // If client has subscriptions, only send matching events
    const subs = subscriptions.get(socket);
    if (subs && subs.size > 0 && !subs.has(event)) continue;

    socket.send(messageStr);
    sent++;
  }

  logger.debug(
    { workspaceId, event, recipients: sent },
    'Broadcast message sent'
  );
}

/* ── Governance-specific broadcast helpers ──────────── */

/** Broadcast a budget warning event (> 80% spent) */
export function emitBudgetWarning(workspaceId: string, data: {
  agentId: string;
  budgetId: string;
  spentUsd: number;
  limitUsd: number;
  percentUsed: number;
}) {
  broadcastToWorkspace(workspaceId, 'budget:warning' as WSEvent, data, 'governance');
  // Also send on main channel for dashboard
  broadcastToWorkspace(workspaceId, 'budget:warning' as WSEvent, data);
}

/** Broadcast a budget exceeded event (100%+ spent) */
export function emitBudgetExceeded(workspaceId: string, data: {
  agentId: string;
  budgetId: string;
  spentUsd: number;
  limitUsd: number;
  action: 'PAUSED' | 'TERMINATED';
}) {
  broadcastToWorkspace(workspaceId, 'budget:exceeded' as WSEvent, data, 'governance');
  broadcastToWorkspace(workspaceId, 'budget:exceeded' as WSEvent, data);
}

/** Broadcast an approval request creation */
export function emitApprovalCreated(workspaceId: string, data: {
  approvalId: string;
  agentId: string;
  agentName: string;
  toolType: string;
  toolMethod: string;
  blastRadiusUsd: number;
}) {
  broadcastToWorkspace(workspaceId, 'approval:created' as WSEvent, data, 'governance');
  broadcastToWorkspace(workspaceId, 'approval:created' as WSEvent, data);
}

/** Broadcast an approval decision */
export function emitApprovalDecided(workspaceId: string, data: {
  approvalId: string;
  decision: 'APPROVED' | 'REJECTED';
  decidedBy: string;
}) {
  broadcastToWorkspace(workspaceId, 'approval:decided' as WSEvent, data, 'governance');
  broadcastToWorkspace(workspaceId, 'approval:decided' as WSEvent, data);
}

/** Broadcast an injection attempt blocked */
export function emitInjectionBlocked(workspaceId: string, data: {
  agentId: string;
  toolType: string;
  injectionType: string;
  input: string;
}) {
  broadcastToWorkspace(workspaceId, 'injection:blocked' as WSEvent, data, 'governance');
}

/** Broadcast a hash chain integrity failure */
export function emitChainBroken(workspaceId: string, data: {
  eventId: string;
  expectedHash: string;
  actualHash: string;
  position: number;
}) {
  broadcastToWorkspace(workspaceId, 'chain:broken' as WSEvent, data, 'governance');
  broadcastToWorkspace(workspaceId, 'chain:broken' as WSEvent, data);
}

/** Broadcast a policy violation */
export function emitPolicyViolation(workspaceId: string, data: {
  agentId: string;
  policyId: string;
  policyName: string;
  toolType: string;
  toolMethod: string;
  reason: string;
}) {
  broadcastToWorkspace(workspaceId, 'policy:violation' as WSEvent, data, 'governance');
  broadcastToWorkspace(workspaceId, 'policy:violation' as WSEvent, data);
}
