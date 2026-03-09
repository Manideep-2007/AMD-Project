/* ──────────────────────────────────────────────────────────────
 * NexusOps SDK — Real-time Event Stream
 *
 * Auto-reconnecting WebSocket client with:
 *  • Typed event handlers
 *  • Exponential back-off reconnection
 *  • Heartbeat keep-alive
 *  • Event deduplication via sequence ID
 * ────────────────────────────────────────────────────────────── */

import EventEmitter from "eventemitter3";
import type { EventType, SignedEvent } from "./types";

export interface NexusEvent {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface EventStreamConfig {
  url: string;
  accessToken: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
}

export class NexusEventStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<EventStreamConfig>;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeqId = 0;
  private _connected = false;

  constructor(config: EventStreamConfig) {
    super();
    this.config = {
      autoReconnect: true,
      maxReconnectDelay: 30_000,
      heartbeatInterval: 30_000,
      ...config,
    };
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Open the WebSocket connection */
  connect(): void {
    if (this.ws) return;

    const url = new URL(this.config.url);
    url.searchParams.set("token", this.config.accessToken);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.emit("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        // Deduplicate by sequence ID
        if (data.seq && data.seq <= this.lastSeqId) return;
        if (data.seq) this.lastSeqId = data.seq;

        if (data.type === "pong") return; // heartbeat response

        const nexusEvent: NexusEvent = {
          id: data.id || crypto.randomUUID(),
          type: data.type,
          payload: data.payload || data,
          timestamp: data.timestamp || new Date().toISOString(),
        };

        this.emit("event", nexusEvent);
        this.emit(nexusEvent.type, nexusEvent);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (event) => {
      this._connected = false;
      this.stopHeartbeat();
      this.emit("disconnected", { code: event.code, reason: event.reason });

      if (this.config.autoReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.emit("error", new Error("WebSocket connection error"));
    };
  }

  /** Gracefully close the connection */
  disconnect(): void {
    this.config.autoReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
  }

  /** Send a typed message to the server */
  send(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  }

  /** Subscribe to specific event types only */
  subscribe(eventTypes: EventType[]): void {
    this.send("subscribe", { eventTypes });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt) + Math.random() * 500,
      this.config.maxReconnectDelay,
    );
    this.reconnectAttempt++;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.ws = null;
      this.connect();
    }, delay);
  }
}
