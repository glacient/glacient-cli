import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Caller-supplied function that populates the given temp directory.
export type ExtractFn = (tmpDir: string) => Promise<void>;

/**
 * Absolute path to the versioned bundle directory.
 * The directory may or may not exist yet.
 */
export function bundleDirPath(id: string, version: string): string {
  return path.join(bundlesRoot(), `${id}@${version}`);
}

/**
 * Returns true iff a `capability.json` exists inside the bundle directory,
 * indicating a fully extracted bundle for this id@version.
 */
export async function bundleExists(
  id: string,
  version: string,
): Promise<boolean> {
  const capabilityPath = path.join(bundleDirPath(id, version), "capability.json");
  try {
    await fs.access(capabilityPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically extract a bundle into its versioned directory.
 *
 * Creates a temp directory adjacent to the final destination, calls
 * `extractFn(tmpDir)` to populate it, then renames the temp directory into the
 * final path. On any failure, removes the temp directory and rethrows.
 *
 * Returns the final bundle directory path.
 *
 * Mirrors the temp-then-rename pattern from `src/pkg/config/config-store.ts`.
 */
export async function writeBundleAtomic(
  id: string,
  version: string,
  extractFn: ExtractFn,
): Promise<string> {
  const root = bundlesRoot();
  await fs.mkdir(root, { recursive: true });

  const finalPath = bundleDirPath(id, version);
  const rand = Math.random().toString(36).slice(2);
  const tmpDir = `${finalPath}.tmp-${rand}`;

  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await extractFn(tmpDir);
    await fs.rename(tmpDir, finalPath);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return finalPath;
}

/**
 * Recursively lists all files inside the bundle directory.
 * Returns paths relative to the bundle dir root, sorted ascending.
 */
export async function listBundleFiles(
  id: string,
  version: string,
): Promise<string[]> {
  const dir = bundleDirPath(id, version);
  const results: string[] = [];
  await collectFiles(dir, dir, results);
  return results.sort();
}

/**
 * Returns the folder's mtime as an ISO string, or `undefined` if the bundle
 * directory does not exist.
 */
export async function bundleFetchedAt(
  id: string,
  version: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.stat(bundleDirPath(id, version));
    return stat.mtime.toISOString();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw err;
  }
}

async function collectFiles(
  root: string,
  dir: string,
  out: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, out);
    } else {
      out.push(path.relative(root, fullPath));
    }
  }
}

function bundlesRoot(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "glacient.tech", "cli", "capabilities");
}
