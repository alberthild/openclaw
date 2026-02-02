import { LogService } from "@vector-im/matrix-bot-sdk";
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import type { CoreConfig } from "../types.js";
import { createMatrixClient } from "./create-client.js";
import { resolveMatrixAuth } from "./config.js";
import { DEFAULT_ACCOUNT_KEY } from "./storage.js";
import type { MatrixAuth } from "./types.js";

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
};

// Multi-account support: Map of accountKey -> client state
const sharedClients = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();
const sharedClientStartPromises = new Map<string, Promise<void>>();

// Legacy single-client references (for backwards compatibility)
let sharedClientState: SharedMatrixClientState | null = null;
let sharedClientPromise: Promise<SharedMatrixClientState> | null = null;
let sharedClientStartPromise: Promise<void> | null = null;

function buildSharedClientKey(auth: MatrixAuth, accountId?: string | null): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    accountId ?? DEFAULT_ACCOUNT_KEY,
  ].join("|");
}

function getAccountKey(accountId?: string | null): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
  accountId?: string;
}): Promise<SharedMatrixClientState> {
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  return {
    client,
    key: buildSharedClientKey(params.auth, params.accountId),
    started: false,
    cryptoReady: false,
  };
}

async function ensureSharedClientStarted(params: {
  state: SharedMatrixClientState;
  timeoutMs?: number;
  initialSyncLimit?: number;
  encryption?: boolean;
  accountId?: string | null;
}): Promise<void> {
  if (params.state.started) return;
  
  const accountKey = getAccountKey(params.accountId);
  const existingPromise = sharedClientStartPromises.get(accountKey);
  if (existingPromise) {
    await existingPromise;
    return;
  }
  
  // Legacy compatibility
  if (sharedClientStartPromise && !params.accountId) {
    await sharedClientStartPromise;
    return;
  }
  
  const startPromise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await client.crypto.prepare(joinedRooms);
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start();
    params.state.started = true;
  })();
  
  sharedClientStartPromises.set(accountKey, startPromise);
  if (!params.accountId) {
    sharedClientStartPromise = startPromise;
  }
  
  try {
    await startPromise;
  } finally {
    sharedClientStartPromises.delete(accountKey);
    if (!params.accountId) {
      sharedClientStartPromise = null;
    }
  }
}

export async function resolveSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
  } = {},
): Promise<MatrixClient> {
  const auth = params.auth ?? (await resolveMatrixAuth({ cfg: params.cfg, env: params.env, accountId: params.accountId ?? undefined }));
  const key = buildSharedClientKey(auth, params.accountId);
  const accountKey = getAccountKey(params.accountId);
  const shouldStart = params.startClient !== false;

  // Check if we already have this client in the multi-account map
  const existingClient = sharedClients.get(accountKey);
  if (existingClient?.key === key) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existingClient,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
        accountId: params.accountId,
      });
    }
    // Update legacy reference for default account
    if (!params.accountId || params.accountId === DEFAULT_ACCOUNT_KEY) {
      sharedClientState = existingClient;
    }
    return existingClient.client;
  }

  // Legacy compatibility: check old single-client state
  if (!params.accountId && sharedClientState?.key === key) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: sharedClientState,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
        accountId: params.accountId,
      });
    }
    return sharedClientState.client;
  }

  // Check for pending creation promise for this account
  const pendingPromise = sharedClientPromises.get(accountKey);
  if (pendingPromise) {
    const pending = await pendingPromise;
    if (pending.key === key) {
      if (shouldStart) {
        await ensureSharedClientStarted({
          state: pending,
          timeoutMs: params.timeoutMs,
          initialSyncLimit: auth.initialSyncLimit,
          encryption: auth.encryption,
          accountId: params.accountId,
        });
      }
      return pending.client;
    }
    // Key mismatch - stop old client
    pending.client.stop();
    sharedClients.delete(accountKey);
  }

  // Legacy: check old single-client promise
  if (!params.accountId && sharedClientPromise) {
    const pending = await sharedClientPromise;
    if (pending.key === key) {
      if (shouldStart) {
        await ensureSharedClientStarted({
          state: pending,
          timeoutMs: params.timeoutMs,
          initialSyncLimit: auth.initialSyncLimit,
          encryption: auth.encryption,
          accountId: params.accountId,
        });
      }
      return pending.client;
    }
    pending.client.stop();
    sharedClientState = null;
    sharedClientPromise = null;
  }

  // Create new client
  const createPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId ?? undefined,
  });
  
  sharedClientPromises.set(accountKey, createPromise);
  if (!params.accountId || params.accountId === DEFAULT_ACCOUNT_KEY) {
    sharedClientPromise = createPromise;
  }
  
  try {
    const created = await createPromise;
    sharedClients.set(accountKey, created);
    if (!params.accountId || params.accountId === DEFAULT_ACCOUNT_KEY) {
      sharedClientState = created;
    }
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
        accountId: params.accountId,
      });
    }
    return created.client;
  } finally {
    sharedClientPromises.delete(accountKey);
    if (!params.accountId || params.accountId === DEFAULT_ACCOUNT_KEY) {
      sharedClientPromise = null;
    }
  }
}

export async function waitForMatrixSync(_params: {
  client: MatrixClient;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  // @vector-im/matrix-bot-sdk handles sync internally in start()
  // This is kept for API compatibility but is essentially a no-op now
}

export function stopSharedClient(accountId?: string | null): void {
  if (accountId) {
    // Stop specific account
    const accountKey = getAccountKey(accountId);
    const client = sharedClients.get(accountKey);
    if (client) {
      client.client.stop();
      sharedClients.delete(accountKey);
    }
    // Also clear legacy reference if it matches
    if (sharedClientState?.key === client?.key) {
      sharedClientState = null;
    }
  } else {
    // Stop all clients (legacy behavior + all multi-account clients)
    for (const [key, client] of sharedClients) {
      client.client.stop();
      sharedClients.delete(key);
    }
    if (sharedClientState) {
      sharedClientState.client.stop();
      sharedClientState = null;
    }
  }
}
