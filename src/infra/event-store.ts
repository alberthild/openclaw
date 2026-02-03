/**
 * Event Store Integration for OpenClaw
 *
 * Publishes all agent events to NATS JetStream for persistent storage.
 * This enables:
 * - Full audit trail of all interactions
 * - Context rebuild from events (no more forgetting)
 * - Multi-agent event sharing
 * - Time-travel debugging
 */

import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  StringCodec,
  RetentionPolicy,
  StorageType,
} from "nats";
import type { AgentEventPayload } from "./agent-events.js";
import { onAgentEvent } from "./agent-events.js";

const sc = StringCodec();

export type EventStoreConfig = {
  enabled: boolean;
  natsUrl: string;
  streamName: string;
  subjectPrefix: string;
};

export type ClawEvent = {
  id: string;
  timestamp: number;
  agent: string;
  session: string;
  type: EventType;
  visibility: Visibility;
  payload: AgentEventPayload;
  meta: {
    runId: string;
    seq: number;
    stream: string;
  };
};

export type EventType =
  | "conversation.message.in"
  | "conversation.message.out"
  | "conversation.tool_call"
  | "conversation.tool_result"
  | "lifecycle.start"
  | "lifecycle.end"
  | "lifecycle.error";

export type Visibility = "public" | "internal" | "confidential";

let natsConnection: NatsConnection | null = null;
let jetstream: JetStreamClient | null = null;
let unsubscribe: (() => void) | null = null;
let eventStoreConfig: EventStoreConfig | null = null;

/**
 * Generate a ULID-like ID (time-sortable)
 */
function generateEventId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

/**
 * Map agent event stream to our event type
 */
function mapStreamToEventType(stream: string, data: Record<string, unknown>): EventType {
  if (stream === "lifecycle") {
    const phase = data?.phase as string;
    if (phase === "start") {
      return "lifecycle.start";
    }
    if (phase === "end") {
      return "lifecycle.end";
    }
    if (phase === "error") {
      return "lifecycle.error";
    }
    return "lifecycle.start";
  }
  if (stream === "tool") {
    const hasResult = "result" in data || "output" in data;
    return hasResult ? "conversation.tool_result" : "conversation.tool_call";
  }
  if (stream === "assistant") {
    return "conversation.message.out";
  }
  if (stream === "user") {
    return "conversation.message.in";
  }
  if (stream === "error") {
    return "lifecycle.error";
  }
  return "conversation.message.out";
}

/**
 * Extract agent name from session key
 * Format: "main" or "agent-name:session-id"
 */
function extractAgentFromSession(sessionKey?: string): string {
  if (!sessionKey) {
    return "unknown";
  }
  if (sessionKey === "main") {
    return "main";
  }
  const parts = sessionKey.split(":");
  return parts[0] || "unknown";
}

/**
 * Convert AgentEventPayload to ClawEvent
 */
function toClawEvent(evt: AgentEventPayload): ClawEvent {
  return {
    id: generateEventId(),
    timestamp: evt.ts,
    agent: extractAgentFromSession(evt.sessionKey),
    session: evt.sessionKey || "unknown",
    type: mapStreamToEventType(evt.stream, evt.data),
    visibility: "internal",
    payload: evt,
    meta: {
      runId: evt.runId,
      seq: evt.seq,
      stream: evt.stream,
    },
  };
}

/**
 * Publish event to NATS JetStream
 */
async function publishEvent(evt: AgentEventPayload): Promise<void> {
  if (!jetstream || !eventStoreConfig) {
    return;
  }

  try {
    const clawEvent = toClawEvent(evt);
    const subject = `${eventStoreConfig.subjectPrefix}.${clawEvent.agent}.${clawEvent.type.replace(/\./g, "_")}`;
    const payload = sc.encode(JSON.stringify(clawEvent));

    await jetstream.publish(subject, payload);
  } catch (err) {
    // Log but don't throw — event store should never break core functionality
    console.error("[event-store] Failed to publish event:", err);
  }
}

/**
 * Ensure the JetStream stream exists
 */
async function ensureStream(nc: NatsConnection, config: EventStoreConfig): Promise<void> {
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.info(config.streamName);
  } catch {
    // Stream doesn't exist, create it
    await jsm.streams.add({
      name: config.streamName,
      subjects: [`${config.subjectPrefix}.>`],
      retention: RetentionPolicy.Limits,
      max_msgs: -1,
      max_bytes: -1,
      max_age: 0, // Never expire
      storage: StorageType.File,
      num_replicas: 1,
      duplicate_window: 120_000_000_000, // 2 minutes in nanoseconds
    });
    console.log(`[event-store] Created stream: ${config.streamName}`);
  }
}

/**
 * Parse NATS URL and extract connection options
 * Handles: nats://user:pass@host:port or just host:port
 */
function parseNatsUrl(natsUrl: string): { servers: string; user?: string; pass?: string } {
  try {
    // Handle nats:// URLs
    if (natsUrl.startsWith("nats://")) {
      const url = new URL(natsUrl);
      const servers = `${url.hostname}:${url.port || 4222}`;
      const user = url.username ? decodeURIComponent(url.username) : undefined;
      const pass = url.password ? decodeURIComponent(url.password) : undefined;
      return { servers, user, pass };
    }
    // Plain host:port format
    return { servers: natsUrl };
  } catch {
    // Fallback: treat as host:port
    return { servers: natsUrl };
  }
}

/**
 * Initialize the event store connection
 */
export async function initEventStore(config: EventStoreConfig): Promise<void> {
  if (!config.enabled) {
    console.log("[event-store] Disabled by config");
    return;
  }

  try {
    eventStoreConfig = config;

    // Parse NATS URL and extract credentials
    const connOpts = parseNatsUrl(config.natsUrl);

    // Connect to NATS
    natsConnection = await connect(connOpts);
    console.log(`[event-store] Connected to NATS at ${connOpts.servers}`);

    // Get JetStream client
    jetstream = natsConnection.jetstream();

    // Ensure stream exists
    await ensureStream(natsConnection, config);

    // Subscribe to all agent events
    unsubscribe = onAgentEvent((evt) => {
      // Fire and forget — don't await to avoid blocking the event loop
      publishEvent(evt).catch(() => {});
    });

    console.log("[event-store] Event listener registered");
  } catch (err) {
    console.error("[event-store] Failed to initialize:", err);
    // Don't throw — event store failure shouldn't prevent gateway startup
  }
}

/**
 * Shutdown the event store connection
 */
export async function shutdownEventStore(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (natsConnection) {
    await natsConnection.drain();
    natsConnection = null;
    jetstream = null;
  }

  eventStoreConfig = null;
  console.log("[event-store] Shutdown complete");
}

/**
 * Check if event store is connected
 */
export function isEventStoreConnected(): boolean {
  return natsConnection !== null && !natsConnection.isClosed();
}

/**
 * Get event store status
 */
export function getEventStoreStatus(): { connected: boolean; config: EventStoreConfig | null } {
  return {
    connected: isEventStoreConnected(),
    config: eventStoreConfig,
  };
}
