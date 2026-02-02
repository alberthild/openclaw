import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfig } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials.js";

export type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  config: MatrixAccountConfig;
};

/**
 * List account IDs explicitly configured in channels.matrix.accounts
 */
function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) continue;
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

/**
 * List account IDs referenced in bindings for matrix channel
 */
function listBoundAccountIds(cfg: CoreConfig): string[] {
  const bindings = cfg.bindings;
  if (!Array.isArray(bindings)) return [];
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (binding.match?.channel === "matrix" && binding.match?.accountId) {
      ids.add(normalizeAccountId(binding.match.accountId));
    }
  }
  return [...ids];
}

/**
 * List all Matrix account IDs (configured + bound)
 */
export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = Array.from(
    new Set([
      DEFAULT_ACCOUNT_ID,
      ...listConfiguredAccountIds(cfg),
      ...listBoundAccountIds(cfg),
    ]),
  );
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
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
  // Extract base config without 'accounts' key
  const { accounts: _ignored, ...baseConfig } = base as MatrixConfig;
  const accountConfig = resolveAccountConfig(cfg, accountId) ?? {};
  
  // Account config overrides base config
  return { ...baseConfig, ...accountConfig };
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeMatrixAccountConfig(params.cfg, accountId);
  
  // Check if this is a non-default account - use account-specific auth
  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID || accountId === "default";
  
  // For non-default accounts, use account-specific credentials
  // For default account, use base config or env
  let homeserver = merged.homeserver;
  let userId = merged.userId;
  let accessToken = merged.accessToken;
  
  if (isDefaultAccount) {
    // Default account can fall back to env vars
    const resolved = resolveMatrixConfig(params.cfg, process.env);
    homeserver = homeserver || resolved.homeserver;
    userId = userId || resolved.userId;
    accessToken = accessToken || resolved.accessToken;
  }
  
  const baseEnabled = params.cfg.channels?.matrix?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  
  const hasHomeserver = Boolean(homeserver);
  const hasAccessToken = Boolean(accessToken);
  const hasPassword = Boolean(merged.password);
  const hasUserId = Boolean(userId);
  const hasPasswordAuth = hasUserId && hasPassword;
  
  // Check for stored credentials (only for default account)
  const stored = isDefaultAccount ? loadMatrixCredentials(process.env) : null;
  const hasStored =
    stored && homeserver
      ? credentialsMatchConfig(stored, {
          homeserver: homeserver,
          userId: userId || "",
        })
      : false;
  
  const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
  
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    configured,
    homeserver: homeserver || undefined,
    userId: userId || undefined,
    accessToken: accessToken || undefined,
    config: merged,
  };
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
