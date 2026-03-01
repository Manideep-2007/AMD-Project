import { FastifyPluginAsync } from 'fastify';
import { WebSocket } from 'ws';
import { WSEvent, WSMessage } from '@nexusops/types';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('websocket');

// Store active connections by workspace
const connections = new Map<string, Set<WebSocket>>();

export const wsHandler: FastifyPluginAsync = async (app) => {
  /**
   * WebSocket: /ws/tasks
   * Real-time task updates
   */
  app.get('/tasks', { websocket: true }, (socket, request) => {
    const workspaceId = (request.query as any).workspaceId;

    if (!workspaceId) {
      socket.close(1008, 'workspaceId required');
      return;
    }

    // Add connection to workspace set
    if (!connections.has(workspaceId)) {
      connections.set(workspaceId, new Set());
    }
    connections.get(workspaceId)!.add(socket);

    logger.info({ workspaceId }, 'WebSocket connection established');

    socket.on('close', () => {
      const workspaceConnections = connections.get(workspaceId);
      if (workspaceConnections) {
        workspaceConnections.delete(socket);
        if (workspaceConnections.size === 0) {
          connections.delete(workspaceId);
        }
      }
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
  app.get('/agents', { websocket: true }, (socket, request) => {
    const workspaceId = (request.query as any).workspaceId;

    if (!workspaceId) {
      socket.close(1008, 'workspaceId required');
      return;
    }

    if (!connections.has(`${workspaceId}:agents`)) {
      connections.set(`${workspaceId}:agents`, new Set());
    }
    connections.get(`${workspaceId}:agents`)!.add(socket);

    socket.on('close', () => {
      const key = `${workspaceId}:agents`;
      const workspaceConnections = connections.get(key);
      if (workspaceConnections) {
        workspaceConnections.delete(socket);
        if (workspaceConnections.size === 0) {
          connections.delete(key);
        }
      }
    });
  });
};

/**
 * Broadcast message to all connected clients in a workspace
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

  const message: WSMessage<T> = {
    event,
    data,
    workspaceId,
    timestamp: new Date().toISOString(),
  };

  const messageStr = JSON.stringify(message);

  for (const socket of workspaceConnections) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(messageStr);
    }
  }

  logger.debug(
    { workspaceId, event, recipients: workspaceConnections.size },
    'Broadcast message sent'
  );
}
