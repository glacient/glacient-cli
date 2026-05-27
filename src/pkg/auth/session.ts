/**
 * Module-level shared session layer.
 *
 * Provides mutex-guarded, freshness-aware access-token management so that the
 * HTTP client and (future) RPC interceptors share a single refresh path without
 * duplicating the mutex logic.
 *
 * Disk I/O is routed through `src/pkg/config/cred-store.ts` whose path is
 * governed by `XDG_CONFIG_HOME`, making it straightforward to isolate in
 * tests by setting that env var to a temp directory.
 */

import { getServerUrl } from "@/pkg/config";
import { load, save } from "@/pkg/config/cred-store.ts";
import { refreshSessionTokens } from "@/pkg/auth/token-refresh.ts";

const AUTH_EXPIRED_ERROR =
  "authentication expired — please run `glacient login` again";

// Refresh when the access token is within this many ms of expiry.
const FRESHNESS_BEFORE_EXP_MS = 60_000;

// Resolves to the new access token once the in-flight refresh completes.
let refreshFuture: Promise<string> | undefined;

/**
 * Return a valid bearer access token, refreshing transparently if the token
 * is within 60 seconds of expiry.
 *
 * Throws `ErrNoCreds` (re-exported from cred-store.ts) if no credentials are
 * on disk.
 */
export async function ensureFreshAccessToken(): Promise<string> {
  const creds = await load();
  if (creds.claims.exp * 1000 - Date.now() < FRESHNESS_BEFORE_EXP_MS) {
    return mutexedRefresh();
  }
  return creds.access_token;
}

/**
 * Perform a single refresh cycle, guarded by the module-level mutex. If a
 * refresh is already in flight, await and return its result so all concurrent
 * callers share the same new access token.
 */
async function mutexedRefresh(): Promise<string> {
  if (refreshFuture !== undefined) {
    return refreshFuture;
  }

  refreshFuture = doRefresh();
  try {
    return await refreshFuture;
  } finally {
    refreshFuture = undefined;
  }
}

async function doRefresh(): Promise<string> {
  const creds = await load();
  const serverUrl = await getServerUrl();
  let tokens;
  try {
    tokens = await refreshSessionTokens(serverUrl, creds.refresh_token);
  } catch {
    throw new Error(AUTH_EXPIRED_ERROR);
  }
  const updated = await save({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  return updated.access_token;
}
