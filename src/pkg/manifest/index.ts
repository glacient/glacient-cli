import fs from "node:fs/promises";
import path from "node:path";
import {
  bundleDirPath,
  bundleExists,
  bundleFetchedAt,
} from "@/pkg/bundles";
import { readCached, writeCached, touchCached } from "./_cache.ts";
import { ensureFreshAccessToken } from "@/pkg/auth/session.ts";
import { consl } from "@/pkg/common/io/consl";
import type { Manifest, CapabilityEntry, CacheStatus } from "./_types.ts";

export type {
  CapabilityEntry,
  CacheStatus,
  ConnectBinding,
  Manifest,
} from "./_types.ts";

const FRESHNESS_MS = 24 * 60 * 60 * 1000;

interface GetManifestOpts {
  server: string;
  refresh?: boolean; // skip freshness check, force unconditional fetch
  signal?: AbortSignal;
}

/**
 * Fetch the capability manifest for `server`.
 *
 * - `refresh:true` → unconditional GET (no If-None-Match), ignore cache freshness.
 * - Fresh cache (mtime within 24h) → return cached, no network.
 * - Stale cache → conditional GET with If-None-Match.
 *   - 304 → touch mtime, return cached.
 *   - 200 → write new cache, return new manifest.
 * - Network failure + stale cache → warn to stderr, return stale.
 * - Network failure + no cache → throw.
 */
export async function getManifest(opts: GetManifestOpts): Promise<Manifest> {
  const { server, refresh = false, signal } = opts;
  const url = `${server}/schema/manifest`;

  const cached = await readCached(server);
  const isFresh =
    cached !== null && Date.now() - cached.mtimeMs < FRESHNESS_MS;

  if (!refresh && isFresh && cached !== null) {
    return cached.manifest;
  }

  let result: FetchResult;
  try {
    const etag = !refresh && cached !== null ? cached.etag : undefined;
    result = await fetchManifest(url, etag, signal);
  } catch (err) {
    if (cached !== null) {
      const reason = err instanceof Error ? err.message : String(err);
      consl.println(
        `WARNING: Using stale capability manifest (network unavailable: ${reason})`,
      );
      return cached.manifest;
    }
    throw new Error(
      `Failed to fetch capability manifest from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.status === "unauthenticated") {
    throw new Error(
      "manifest endpoint rejected credentials — please re-authenticate",
    );
  }

  if (result.status === "same") {
    await touchCached();
    // cached is non-null here (If-None-Match only sent when cached exists)
    return cached!.manifest;
  }

  await writeCached(server, result.body, result.etag);
  return JSON.parse(result.body) as Manifest;
}

/**
 * Compute the local cache status for a manifest entry by inspecting the
 * capabilities bundle directories on disk.
 *
 * - `fresh`   — a bundle for this exact id@version is extracted on disk.
 * - `stale`   — a bundle for a different version is on disk (listing is newer).
 * - `missing` — no bundle for this id exists anywhere.
 */
export async function computeCacheStatus(
  entry: CapabilityEntry,
): Promise<CacheStatus> {
  const exists = await bundleExists(entry.id, entry.version);
  if (exists) {
    const fetchedAt = await bundleFetchedAt(entry.id, entry.version);
    return {
      status: "fresh",
      version: entry.version,
      fetched_at: fetchedAt,
    } satisfies CacheStatus;
  }

  // Check for a stale bundle: scan the parent capabilities dir for any folder
  // matching `<id>@<someOtherVersion>`. Derive the parent from bundleDirPath
  // to avoid duplicating the XDG resolver.
  const thisVersionDir = bundleDirPath(entry.id, entry.version);
  const capabilitiesRoot = path.dirname(thisVersionDir);
  const prefix = `${entry.id}@`;

  let staleVersion: string | undefined;
  let staleFetchedAt: string | undefined;

  try {
    const entries = await fs.readdir(capabilitiesRoot, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      if (!dirent.name.startsWith(prefix)) continue;
      const v = dirent.name.slice(prefix.length);
      if (v === entry.version) continue; // skip the current version (already checked)
      staleVersion = v;
      staleFetchedAt = await bundleFetchedAt(entry.id, v);
      break;
    }
  } catch (err) {
    // If the capabilities root doesn't exist yet, treat as missing.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }

  if (staleVersion !== undefined) {
    return {
      status: "stale",
      version: staleVersion,
      fetched_at: staleFetchedAt,
    } satisfies CacheStatus;
  }

  return { status: "missing" } satisfies CacheStatus;
}

type FetchResult =
  | { status: "ok"; body: string; etag: string }
  | { status: "same" }
  | { status: "unauthenticated" };

async function fetchManifest(
  url: string,
  etag: string | undefined,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  const token = await ensureFreshAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (etag !== undefined) {
    headers["If-None-Match"] = etag;
  }

  const resp = await globalThis.fetch(url, { headers, signal });

  if (resp.status === 304) {
    return { status: "same" };
  }

  if (resp.status === 401) {
    return { status: "unauthenticated" };
  }

  if (resp.status >= 200 && resp.status < 300) {
    const body = await resp.text();
    const respEtag = resp.headers.get("etag") ?? "";
    return { status: "ok", body, etag: respEtag };
  }

  throw new Error(`HTTP ${resp.status} from manifest endpoint`);
}
