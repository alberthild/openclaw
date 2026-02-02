import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

const DEFAULT_ACCOUNT_KEY = "default";

// Multi-account: Map of accountId -> client
const activeClients = new Map<string, MatrixClient>();

function normalizeAccountKey(accountId?: string | null): string {
  return accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_KEY;
}

export function setActiveMatrixClient(
  client: MatrixClient | null,
  accountId?: string | null,
): void {
  const key = normalizeAccountKey(accountId);
  if (client) {
    activeClients.set(key, client);
  } else {
    activeClients.delete(key);
  }
}

export function getActiveMatrixClient(accountId?: string | null): MatrixClient | null {
  const key = normalizeAccountKey(accountId);
  const client = activeClients.get(key);
  if (client) {
    return client;
  }
  // Fallback: if specific account not found, try default
  if (key !== DEFAULT_ACCOUNT_KEY) {
    return activeClients.get(DEFAULT_ACCOUNT_KEY) ?? null;
  }
  return null;
}

export function listActiveMatrixClients(): Array<{ accountId: string; client: MatrixClient }> {
  return Array.from(activeClients.entries()).map(([accountId, client]) => ({ accountId, client }));
}
