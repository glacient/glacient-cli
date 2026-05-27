import fs from "node:fs/promises";
import path from "node:path";
import { ensureFreshAccessToken } from "@/pkg/auth/session.ts";
import { StructuredError, fromHttpError } from "@/pkg/common/error";
import {
  bundleDirPath,
  bundleExists,
  listBundleFiles,
  writeBundleAtomic,
} from "./_cache.ts";
import { extractTarGz } from "./_tar.ts";

export { bundleDirPath, bundleExists, bundleFetchedAt } from "./_cache.ts";

export type CapabilityJson = {
  id: string;
  version: string;
  summary: string;
  related_capabilities: string[];
  deprecated: boolean;
  // RPC-only:
  scopes_required?: string[];
  connect?: { service: string; method: string; path_prefix?: string };
};

export type BundleHandle = {
  path: string;
  files: string[];
  capabilityJson: CapabilityJson;
};

/**
 * Retrieve the capability bundle for `id@version`, fetching from `server` if
 * not already cached.
 *
 * On cache hit: loads `capability.json`, lists files, returns a `BundleHandle`.
 * On cache miss: fetches `GET ${server}/schema/capabilities/${id}@${version}`
 * with a bearer token, streams the gzip response through `extractTarGz` inside
 * an atomic temp-then-rename write, then re-loads.
 */
export async function getCapabilityBundle(
  server: string,
  id: string,
  version: string,
): Promise<BundleHandle> {
  const exists = await bundleExists(id, version);
  if (!exists) {
    await fetchAndExtract(server, id, version);
  }
  return loadCachedBundle(id, version);
}

/**
 * Load a bundle for `id@version` from local disk, without ever fetching.
 * Throws ENOENT (raw fs error) if no such bundle is cached. Callers that want
 * a typed error should check `bundleExists` first.
 */
export async function loadCachedBundle(
  id: string,
  version: string,
): Promise<BundleHandle> {
  const bundlePath = bundleDirPath(id, version);
  const capabilityRaw = await fs.readFile(
    path.join(bundlePath, "capability.json"),
    "utf8",
  );
  const capabilityJson = JSON.parse(capabilityRaw) as CapabilityJson;
  const files = await listBundleFiles(id, version);

  return {
    path: bundlePath,
    files,
    capabilityJson,
  } satisfies BundleHandle;
}

async function fetchAndExtract(
  server: string,
  id: string,
  version: string,
): Promise<void> {
  const url = `${server}/schema/capabilities/${id}@${version}`;
  const token = await ensureFreshAccessToken();

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new StructuredError({
      code: "NETWORK",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!response.ok) {
    throw fromHttpError(response.status, url);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  await writeBundleAtomic(id, version, async (tmpDir) => {
    await extractTarGz(buffer, tmpDir);
  });
}
