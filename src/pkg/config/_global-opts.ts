import { ErrNoConfig, load as loadConfig } from "./config-store.ts";

const DEFAULT_SERVER_URL = "https://auth.glacient.tech";

let cachedServerUrl: string | undefined;
let cachedOutputMode: "json" | "text" | undefined;

/**
 * Resolve and cache the server URL for this process.
 *
 * Precedence:
 *   1. GLACIENT_SERVER_URL environment variable (explicit override)
 *   2. server-url from on-disk config (written by `glacient config set`)
 *   3. Built-in default
 *
 * The resolved value is memoized; subsequent calls return the cached string
 * without re-reading env or disk.
 */
export async function getServerUrl(): Promise<string> {
  if (cachedServerUrl !== undefined) return cachedServerUrl;

  const fromEnv = process.env["GLACIENT_SERVER_URL"];
  if (fromEnv && fromEnv.length > 0) {
    cachedServerUrl = fromEnv;
    return cachedServerUrl;
  }

  try {
    const cfg = await loadConfig();
    if (cfg["server-url"]) {
      cachedServerUrl = cfg["server-url"];
      return cachedServerUrl;
    }
  } catch (err) {
    if (err !== ErrNoConfig) throw err;
  }

  cachedServerUrl = DEFAULT_SERVER_URL;
  return cachedServerUrl;
}

/**
 * Type guard for raw `--output` flag values. Used by the commander option
 * parser at the call site to convert into an `InvalidArgumentError`.
 */
export function isValidOutputFlag(value: string): value is "json" | "text" {
  return value === "json" || value === "text";
}

/**
 * Seed the output-mode cache with the parsed `--output` flag value. No-op
 * when `flagValue` is undefined; resolution from config/TTY happens lazily
 * inside `getOutputMode`.
 */
export function cacheOutputMode(flagValue: "json" | "text" | undefined): void {
  if (flagValue !== undefined) {
    cachedOutputMode = flagValue;
  }
}

/**
 * Resolve and cache the output mode for this process.
 *
 * Precedence:
 *   1. Cached value (seeded by `cacheOutputMode` from the `--output` flag)
 *   2. output-mode from on-disk config
 *   3. Auto by TTY: `text` when stdout is a TTY, otherwise `json`
 */
export async function getOutputMode(): Promise<"json" | "text"> {
  if (cachedOutputMode !== undefined) return cachedOutputMode;

  try {
    const cfg = await loadConfig();
    const mode = cfg["output-mode"];
    if (mode !== undefined) {
      if (mode !== "json" && mode !== "text") {
        throw new Error(
          `invalid output-mode in config: ${mode} (expected "json" or "text")`,
        );
      }
      cachedOutputMode = mode;
      return cachedOutputMode;
    }
  } catch (err) {
    if (err !== ErrNoConfig) throw err;
  }

  cachedOutputMode = process.stdout.isTTY ? "text" : "json";
  return cachedOutputMode;
}

/** Reset module-level cache between tests. Production code must not call this. */
export function __resetForTests(): void {
  cachedServerUrl = undefined;
  cachedOutputMode = undefined;
}
