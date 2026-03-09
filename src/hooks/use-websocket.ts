/**
 * WebSocket hook for real-time updates.
 * Connects to the API server's /ws endpoint with JWT auth.
 * Dispatches events to TanStack Query cache invalidation.
 * Supports governance events: budgets, approvals, security.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth-store';
import { queryKeys } from './use-api';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

interface WSMessage {
  event: string;
  data: unknown;
  workspaceId: string;
  timestamp: string;
  seq?: number;
}

type EventHandler = (data: unknown) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const qc = useQueryClient();
  const { accessToken, isAuthenticated } = useAuthStore();
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const reconnectAttempt = useRef(0);
  const lastSeq = useRef(0);
  const eventHandlers = useRef<Map<string, Set<EventHandler>>>(new Map());
  const heartbeatTimer = useRef<ReturnType<typeof setInterval>>();

  /** Subscribe to a specific event type */
  const on = useCallback((event: string, handler: EventHandler) => {
    if (!eventHandlers.current.has(event)) {
      eventHandlers.current.set(event, new Set());
    }
    eventHandlers.current.get(event)!.add(handler);
    return () => {
      eventHandlers.current.get(event)?.delete(handler);
    };
  }, []);

  const connect = useCallback(() => {
    if (!isAuthenticated || !accessToken) return;

    // Connect without token in URL — tokens in URLs leak via logs, Referer headers, and browser history
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Authenticate via first message instead of query param
      ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
      setConnected(true);
      reconnectAttempt.current = 0;

      // Start heartbeat ping every 25s
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);

        // Heartbeat response — ignore
        if ((msg as any).type === 'pong') return;

        // Deduplicate by sequence
        if (msg.seq && msg.seq <= lastSeq.current) return;
        if (msg.seq) lastSeq.current = msg.seq;

        // Dispatch to registered event handlers
        const handlers = eventHandlers.current.get(msg.event);
        if (handlers) {
          for (const handler of handlers) {
            try { handler(msg.data); } catch { /* ignore */ }
          }
        }

        // Invalidate relevant queries based on event type
        switch (msg.event) {
          case 'task:created':
          case 'task:updated':
          case 'task:completed':
          case 'task:failed':
          case 'task:escalated':
            qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
            qc.invalidateQueries({ queryKey: queryKeys.metrics.dashboard });
            break;

          case 'agent:registered':
          case 'agent:status_changed':
          case 'agent:terminated':
            qc.invalidateQueries({ queryKey: queryKeys.agents.all });
            qc.invalidateQueries({ queryKey: queryKeys.metrics.dashboard });
            break;

          case 'policy:violated':
          case 'policy:violation':
          case 'policy:updated':
            qc.invalidateQueries({ queryKey: queryKeys.policies.all });
            qc.invalidateQueries({ queryKey: queryKeys.security.overview });
            qc.invalidateQueries({ queryKey: queryKeys.audit.all });
            break;

          case 'tool:call_blocked':
            qc.invalidateQueries({ queryKey: queryKeys.tools.all });
            qc.invalidateQueries({ queryKey: queryKeys.security.overview });
            break;

          // Governance events
          case 'approval:created':
          case 'approval:decided':
            qc.invalidateQueries({ queryKey: queryKeys.approvals.all });
            qc.invalidateQueries({ queryKey: queryKeys.approvals.stats });
            qc.invalidateQueries({ queryKey: queryKeys.metrics.dashboard });
            break;

          case 'budget:warning':
          case 'budget:exceeded':
            qc.invalidateQueries({ queryKey: queryKeys.budgets.all });
            qc.invalidateQueries({ queryKey: queryKeys.budgets.summary });
            qc.invalidateQueries({ queryKey: queryKeys.costs.summary() });
            qc.invalidateQueries({ queryKey: queryKeys.costs.anomalies });
            qc.invalidateQueries({ queryKey: queryKeys.metrics.dashboard });
            break;

          case 'injection:blocked':
            qc.invalidateQueries({ queryKey: queryKeys.security.overview });
            qc.invalidateQueries({ queryKey: queryKeys.audit.all });
            break;

          case 'chain:broken':
            qc.invalidateQueries({ queryKey: queryKeys.security.overview });
            qc.invalidateQueries({ queryKey: queryKeys.security.auditChain });
            break;

          case 'system:alert':
            qc.invalidateQueries({ queryKey: queryKeys.metrics.dashboard });
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      setConnected(false);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);

      // Don't reconnect on intentional close
      if (event.code === 1000) return;

      // Exponential back-off reconnect (cap at 30s)
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current) + Math.random() * 500, 30_000);
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [isAuthenticated, accessToken, qc]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      wsRef.current?.close(1000, 'Component unmounting');
    };
  }, [connect]);

  return { connected, on };
}
