import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "./_types.ts";

interface MetaFile {
  server: string;
  etag: string;
}

interface CachedManifest {
  manifest: Manifest;
  etag: string;
  mtimeMs: number; // mtime of meta.json — single source of truth for freshness
}

/**
 * Read the cached manifest. Returns null when:
 * - Either cache file is missing.
 * - The cached server URL doesn't match `server`.
 *
 * JSON parse errors bubble (programmer error / corrupted file).
 */
export async function readCached(server: string): Promise<CachedManifest | null> {
  try {
    const [metaRaw, bodyRaw, metaStat] = await Promise.all([
      fs.readFile(metaPath(), "utf8"),
      fs.readFile(manifestPath(), "utf8"),
      fs.stat(metaPath()),
    ]);

    const meta = JSON.parse(metaRaw) as MetaFile;
    if (meta.server !== server) {
      return null;
    }

    const manifest = JSON.parse(bodyRaw) as Manifest;
    return {
      manifest,
      etag: meta.etag,
      mtimeMs: metaStat.mtimeMs,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

/**
 * Write the manifest body and metadata to disk. `body` is the raw response
 * string — written verbatim to manifest.json.
 */
export async function writeCached(
  server: string,
  body: string,
  etag: string,
): Promise<void> {
  await fs.mkdir(manifestDir(), { recursive: true });
  const meta: MetaFile = { server, etag };
  await Promise.all([
    fs.writeFile(manifestPath(), body, "utf8"),
    fs.writeFile(metaPath(), JSON.stringify(meta), "utf8"),
  ]);
}

/** Bump the mtime on meta.json to mark the cache as fresh (called after a 304). */
export async function touchCached(): Promise<void> {
  const now = new Date();
  await fs.utimes(metaPath(), now, now);
}

function manifestDir(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "glacient.tech", "cli", "manifest");
}

function manifestPath(): string {
  return path.join(manifestDir(), "manifest.json");
}

function metaPath(): string {
  return path.join(manifestDir(), "meta.json");
}
