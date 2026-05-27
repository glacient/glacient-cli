import fs from "fs/promises";
import os from "os";
import path from "path";

// Non-secret CLI configuration. Stored separately from credentials so that
// rotating tokens doesn't disturb server selection, and so the file can have
// less-restrictive permissions if we ever need to share it.
export type Config = Readonly<{
  "server-url"?: string;
  "output-mode"?: "json" | "text";
}>;

export const ErrNoConfig = new Error("no config");

let cached: Config | undefined;

export async function load(): Promise<Config> {
  if (cached !== undefined) return cached;
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    cached = Object.freeze(JSON.parse(raw) as Config);
    return cached;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw ErrNoConfig;
    }
    throw err;
  }
}

export async function save(c: Config): Promise<Config> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  const next: Config = Object.freeze({
    "server-url": c["server-url"],
    "output-mode": c["output-mode"],
  });
  await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
  await fs.rename(tmp, p);
  cached = next;
  return cached;
}

export async function remove(): Promise<void> {
  cached = undefined;
  try {
    await fs.unlink(configPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function configPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "glacient.tech", "cli", "config.json");
}
