import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { MatrixAuth } from "../client.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

export function registerMatrixMonitorEvents(params: {
  client: MatrixClient;
  auth: MatrixAuth;
  logVerboseMessage: (message: string) => void;
  warnedEncryptedRooms: Set<string>;
  warnedCryptoMissingRooms: Set<string>;
  logger: { warn: (meta: Record<string, unknown>, message: string) => void };
  formatNativeDependencyHint: PluginRuntime["system"]["formatNativeDependencyHint"];
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => void | Promise<void>;
}): void {
  const {
    client,
    auth,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    formatNativeDependencyHint,
    onRoomMessage,
  } = params;

  // Track processed event IDs to avoid double-processing from room.message + room.decrypted_event
  const processedEvents = new Set<string>();
  const PROCESSED_EVENTS_MAX = 1000;
  
  const deduplicatedHandler = async (roomId: string, event: MatrixRawEvent, source: string) => {
    const eventId = event?.event_id;
    if (!eventId) {
      logVerboseMessage(`matrix: ${source} event has no id, processing anyway`);
      await onRoomMessage(roomId, event);
      return;
    }
    
    if (processedEvents.has(eventId)) {
      logVerboseMessage(`matrix: ${source} skipping duplicate event id=${eventId}`);
      return;
    }
    
    processedEvents.add(eventId);
    // Prevent memory leak by clearing old entries
    if (processedEvents.size > PROCESSED_EVENTS_MAX) {
      const iterator = processedEvents.values();
      for (let i = 0; i < 100; i++) {
        const next = iterator.next();
        if (next.done) break;
        processedEvents.delete(next.value);
      }
    }
    
    logVerboseMessage(`matrix: ${source} processing event id=${eventId} room=${roomId}`);
    await onRoomMessage(roomId, event);
  };

  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    deduplicatedHandler(roomId, event, "room.message");
  });

  client.on("room.encrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on("room.decrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    const content = event?.content as Record<string, unknown> | undefined;
    const hasFile = content && "file" in content;
    const hasUrl = content && "url" in content;
    // DEBUG: Always log decrypted events with file info
    console.log(`[MATRIX-E2EE-DEBUG] decrypted_event room=${roomId} type=${eventType} id=${eventId} hasFile=${hasFile} hasUrl=${hasUrl}`);
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
    // Process decrypted messages through the deduplicated handler
    deduplicatedHandler(roomId, event, "room.decrypted_event");
  });

  client.on(
    "room.failed_decryption",
    async (roomId: string, event: MatrixRawEvent, error: Error) => {
      // DEBUG: Always log failed decryption
      console.log(`[MATRIX-E2EE-DEBUG] FAILED_DECRYPTION room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`);
      logger.warn(
        { roomId, eventId: event.event_id, error: error.message },
        "Failed to decrypt message",
      );
      logVerboseMessage(
        `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`,
      );
    },
  );

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`,
    );
  });

  client.on("room.join", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    logVerboseMessage(`matrix: join room=${roomId} id=${eventId}`);
  });

  client.on("room.event", (roomId: string, event: MatrixRawEvent) => {
    const eventType = event?.type ?? "unknown";
    if (eventType === EventType.RoomMessageEncrypted) {
      logVerboseMessage(
        `matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`,
      );
      if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
        warnedEncryptedRooms.add(roomId);
        const warning =
          "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt";
        logger.warn({ roomId }, warning);
      }
      if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
        warnedCryptoMissingRooms.add(roomId);
        const hint = formatNativeDependencyHint({
          packageName: "@matrix-org/matrix-sdk-crypto-nodejs",
          manager: "pnpm",
          downloadCommand:
            "node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
        });
        const warning = `matrix: encryption enabled but crypto is unavailable; ${hint}`;
        logger.warn({ roomId }, warning);
      }
      return;
    }
    if (eventType === EventType.RoomMember) {
      const membership = (event?.content as { membership?: string } | undefined)?.membership;
      const stateKey = (event as { state_key?: string }).state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`,
      );
    }
  });
}
