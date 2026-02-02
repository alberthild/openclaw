import { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "../types.js";
import { getMatrixRuntime } from "../../runtime.js";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";
import { importCredentials } from "../import-mutex.js";

function clean(value?: string): string {
  return value?.trim() ?? "";
}

/**
 * Get account-specific config from channels.matrix.accounts[accountId]
 */
function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): MatrixAccountConfig | undefined {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as MatrixAccountConfig | undefined;
  if (direct) return direct;
  
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeAccountId(key) === normalized
  );
  return matchKey ? (accounts[matchKey] as MatrixAccountConfig | undefined) : undefined;
}

/**
 * Merge base matrix config with account-specific overrides
 */
function mergeMatrixAccountConfig(cfg: CoreConfig, accountId: string): MatrixAccountConfig {
  const base = cfg.channels?.matrix ?? {};
  const { accounts: _ignored, ...baseConfig } = base as MatrixConfig;
  const accountConfig = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...baseConfig, ...accountConfig };
}

export function resolveMatrixConfig(
  cfg: CoreConfig = getMatrixRuntime().config.loadConfig() as CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): MatrixResolvedConfig {
  const normalizedAccountId = normalizeAccountId(accountId);
  const isDefaultAccount = normalizedAccountId === DEFAULT_ACCOUNT_ID || normalizedAccountId === "default";
  
  // Get merged config for this account
  const merged = mergeMatrixAccountConfig(cfg, normalizedAccountId);
  
  // For default account, allow env var fallbacks
  const homeserver = clean(merged.homeserver) || (isDefaultAccount ? clean(env.MATRIX_HOMESERVER) : "");
  const userId = clean(merged.userId) || (isDefaultAccount ? clean(env.MATRIX_USER_ID) : "");
  const accessToken = clean(merged.accessToken) || (isDefaultAccount ? clean(env.MATRIX_ACCESS_TOKEN) : "") || undefined;
  const password = clean(merged.password) || (isDefaultAccount ? clean(env.MATRIX_PASSWORD) : "") || undefined;
  const deviceName = clean(merged.deviceName) || (isDefaultAccount ? clean(env.MATRIX_DEVICE_NAME) : "") || undefined;
  const initialSyncLimit =
    typeof merged.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(merged.initialSyncLimit))
      : undefined;
  const encryption = merged.encryption ?? false;
  
  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceName,
    initialSyncLimit,
    encryption,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string;
}): Promise<MatrixAuth> {
  const cfg = params?.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const accountId = params?.accountId;
  const resolved = resolveMatrixConfig(cfg, env, accountId);
  
  if (!resolved.homeserver) {
    throw new Error(`Matrix homeserver is required for account ${accountId ?? "default"} (matrix.homeserver)`);
  }

  const normalizedAccountId = normalizeAccountId(accountId);
  const isDefaultAccount = normalizedAccountId === DEFAULT_ACCOUNT_ID || normalizedAccountId === "default";

  // Only use cached credentials for default account
  // Use serialized import to prevent race conditions during parallel account startup
  const {
    loadMatrixCredentials,
    saveMatrixCredentials,
    credentialsMatchConfig,
    touchMatrixCredentials,
  } = await importCredentials();

  const cached = isDefaultAccount ? loadMatrixCredentials(env) : null;
  const cachedCredentials =
    cached &&
    credentialsMatchConfig(cached, {
      homeserver: resolved.homeserver,
      userId: resolved.userId || "",
    })
      ? cached
      : null;

  // If we have an access token, we can fetch userId via whoami if not provided
  if (resolved.accessToken) {
    let userId = resolved.userId;
    if (!userId) {
      // Fetch userId from access token via whoami
      ensureMatrixSdkLoggingConfigured();
      const tempClient = new MatrixClient(resolved.homeserver, resolved.accessToken);
      const whoami = await tempClient.getUserId();
      userId = whoami;
      // Only save credentials for default account
      if (isDefaultAccount) {
        saveMatrixCredentials({
          homeserver: resolved.homeserver,
          userId,
          accessToken: resolved.accessToken,
        });
      }
    } else if (isDefaultAccount && cachedCredentials && cachedCredentials.accessToken === resolved.accessToken) {
      touchMatrixCredentials(env);
    }
    return {
      homeserver: resolved.homeserver,
      userId,
      accessToken: resolved.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  // Try cached credentials (only for default account)
  if (isDefaultAccount && cachedCredentials) {
    touchMatrixCredentials(env);
    return {
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (!resolved.userId) {
    throw new Error(
      `Matrix userId is required for account ${accountId ?? "default"} when no access token is configured`,
    );
  }

  if (!resolved.password) {
    throw new Error(
      `Matrix password is required for account ${accountId ?? "default"} when no access token is configured`,
    );
  }

  // Login with password using HTTP API
  const loginResponse = await fetch(`${resolved.homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: resolved.userId },
      password: resolved.password,
      initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
    }),
  });

  if (!loginResponse.ok) {
    const errorText = await loginResponse.text();
    throw new Error(`Matrix login failed for account ${accountId ?? "default"}: ${errorText}`);
  }

  const login = (await loginResponse.json()) as {
    access_token?: string;
    user_id?: string;
    device_id?: string;
  };

  const accessToken = login.access_token?.trim();
  if (!accessToken) {
    throw new Error(`Matrix login did not return an access token for account ${accountId ?? "default"}`);
  }

  const auth: MatrixAuth = {
    homeserver: resolved.homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
  };

  // Only save credentials for default account
  if (isDefaultAccount) {
    saveMatrixCredentials({
      homeserver: auth.homeserver,
      userId: auth.userId,
      accessToken: auth.accessToken,
      deviceId: login.device_id,
    });
  }

  return auth;
}
