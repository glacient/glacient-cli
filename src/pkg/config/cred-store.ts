import fs from "fs/promises";
import os from "os";
import path from "path";
import { jwtDecode } from "jwt-decode";
import type { SessionJwtClaims } from "@/pkg/auth/gjwt.ts";

// On-disk serde shape — `claims` isn't stored because it's derivable from
// the access token at construction time, so persisting would just invite
// drift. Producers (login, token refresh) build this and hand it to `save`,
// which constructs the frozen `Credentials` with decoded claims.
//
// Server URL lives in config-store.ts, not here: it isn't a secret and we
// don't want rotating tokens to disturb server selection.
export type CredStore = {
  access_token: string;
  refresh_token: string;
};

// Public credentials. Runtime-frozen and compile-time `readonly` so callers
// can't accidentally mutate fields after `load` or after a refresh — the
// only legal way to update is to construct a new instance via
// `makeCredentials` and pass it back through `save`.
//
// `claims` is eagerly decoded from the access token at construction time
// so callers don't pay a JWT-decode on every read. The `claims` object
// itself is also frozen.
export type Credentials = Readonly<{
  access_token: string;
  refresh_token: string;
  claims: SessionJwtClaims;
}>;

export const ErrNoCreds = new Error("no creds");

export async function load(): Promise<Credentials> {
  if (cached !== undefined) return cached;
  try {
    const raw = await fs.readFile(credentialsPath(), "utf8");
    cached = makeCredentials(JSON.parse(raw) as CredStore);
    return cached;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw ErrNoCreds;
    }
    throw err;
  }
}

export async function save(c: CredStore): Promise<Credentials> {
  const p = credentialsPath();
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  const store: CredStore = {
    access_token: c.access_token,
    refresh_token: c.refresh_token,
  };
  await fs.writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await fs.rename(tmp, p);
  cached = makeCredentials(store);
  return cached;
}

export async function remove(): Promise<void> {
  cached = undefined;
  try {
    await fs.unlink(credentialsPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// In-memory cache populated by load() and save(), cleared by remove().
// Disk I/O is incurred once per process; subsequent load() calls return the
// cached instance until save() replaces it or remove() invalidates it.
let cached: Credentials | undefined;

function makeCredentials(fields: CredStore): Credentials {
  const claims = Object.freeze(
    jwtDecode<SessionJwtClaims>(fields.access_token),
  );
  return Object.freeze({ ...fields, claims });
}

function credentialsPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "glacient.tech", "cli", "credentials.json");
}
