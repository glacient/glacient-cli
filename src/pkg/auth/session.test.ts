/**
 * Tests for src/pkg/auth/session.ts
 *
 * Disk isolation: each test sets XDG_CONFIG_HOME to a unique temp dir and
 * writes a credentials.json there. No disk mocking needed — real fs calls
 * on throwaway directories.
 *
 * Network isolation: MSW intercepts outbound requests at the network layer
 * via `setupServer` from `msw/node`, so `globalThis.fetch` is never
 * reassigned and its type doesn't need to be cast. Per-test handlers are
 * registered with `server.use(...)`.
 */

import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ensureFreshAccessToken } from "./session.ts";
import { remove as removeCreds } from "@/pkg/config/cred-store.ts";

const SERVER_URL = "https://api.example.com";
const REFRESH_URL = `${SERVER_URL}/auth/token-refresh`;

function makeJwt(payload: object): string {
  const seg = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "EdDSA" })}.${seg(payload)}.sig`;
}

function makeAccessToken(exp: number): string {
  return makeJwt({
    exp,
    handle: "testuser",
    user_id: "user-1",
    s_id: "session-1",
    scopes: [],
  });
}

function makeRefreshToken(exp: number): string {
  return makeJwt({ exp, sub: "user-1" });
}

let tmpDir: string;
let origXdg: string | undefined;
let origServerUrlEnv: string | undefined;

const server = setupServer();

async function seedCreds(opts: {
  accessExp: number;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = makeAccessToken(opts.accessExp);
  const refreshToken = makeRefreshToken(opts.accessExp + 86_400);
  const p = path.join(tmpDir, "glacient.tech", "cli", "credentials.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
    }),
  );
  return { accessToken, refreshToken };
}

async function readPersistedTokens(): Promise<{
  access_token: string;
  refresh_token: string;
}> {
  const p = path.join(tmpDir, "glacient.tech", "cli", "credentials.json");
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as { access_token: string; refresh_token: string };
}

/**
 * Register a /auth/token-refresh handler that returns the given tokens and
 * counts invocations. Optional `barrier` lets concurrency tests force
 * overlapping in-flight calls.
 */
function handleRefresh(
  newAccessToken: string,
  newRefreshToken: string,
  opts?: { barrier?: Promise<void> },
): { refreshCallCount: () => number } {
  let count = 0;
  server.use(
    http.post(REFRESH_URL, async () => {
      count++;
      if (opts?.barrier) await opts.barrier;
      return HttpResponse.json({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      });
    }),
  );
  return { refreshCallCount: () => count };
}

beforeAll(() => {
  // `error` makes any request without a matching handler fail the test, so a
  // stray call to a different endpoint can never silently pass.
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glacient-session-test-"));
  origXdg = process.env["XDG_CONFIG_HOME"];
  origServerUrlEnv = process.env["GLACIENT_SERVER_URL"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
  process.env["GLACIENT_SERVER_URL"] = SERVER_URL;
  await removeCreds();
});

afterEach(async () => {
  server.resetHandlers();
  await removeCreds();
  if (origXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = origXdg;
  }
  if (origServerUrlEnv === undefined) {
    delete process.env["GLACIENT_SERVER_URL"];
  } else {
    process.env["GLACIENT_SERVER_URL"] = origServerUrlEnv;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ensureFreshAccessToken", () => {
  test("fresh token — returns existing token, no refresh call", async () => {
    const futureExp = Math.floor((Date.now() + 3_600_000) / 1000);
    const { accessToken } = await seedCreds({ accessExp: futureExp });

    // No handler registered — `onUnhandledRequest: "error"` ensures any
    // outbound request would fail loudly.
    const token = await ensureFreshAccessToken();

    expect(token).toBe(accessToken);
  });

  test("stale token — triggers refresh, persists new creds, returns new token", async () => {
    const staleExp = Math.floor((Date.now() + 30_000) / 1000); // within 60s window
    await seedCreds({ accessExp: staleExp });

    const newExp = Math.floor((Date.now() + 3_600_000) / 1000);
    const newAccessToken = makeAccessToken(newExp);
    const newRefreshToken = makeRefreshToken(newExp + 86_400);

    const { refreshCallCount } = handleRefresh(newAccessToken, newRefreshToken);

    const token = await ensureFreshAccessToken();

    expect(token).toBe(newAccessToken);
    expect(refreshCallCount()).toBe(1);

    const persisted = await readPersistedTokens();
    expect(persisted.access_token).toBe(newAccessToken);
    expect(persisted.refresh_token).toBe(newRefreshToken);
  });

  test("concurrent stale callers — single refresh issued, all get new token", async () => {
    const staleExp = Math.floor((Date.now() + 30_000) / 1000);
    await seedCreds({ accessExp: staleExp });

    const newExp = Math.floor((Date.now() + 3_600_000) / 1000);
    const newAccessToken = makeAccessToken(newExp);
    const newRefreshToken = makeRefreshToken(newExp + 86_400);

    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((res) => {
      resolveBarrier = res;
    });

    const { refreshCallCount } = handleRefresh(newAccessToken, newRefreshToken, {
      barrier,
    });

    const p1 = ensureFreshAccessToken();
    const p2 = ensureFreshAccessToken();

    resolveBarrier();

    const [t1, t2] = await Promise.all([p1, p2]);

    expect(refreshCallCount()).toBe(1);
    expect(t1).toBe(newAccessToken);
    expect(t2).toBe(newAccessToken);
  });

  test("refresh failure — surfaces auth-expired error", async () => {
    const staleExp = Math.floor((Date.now() + 30_000) / 1000);
    await seedCreds({ accessExp: staleExp });

    server.use(
      http.post(REFRESH_URL, () =>
        HttpResponse.text("nope", { status: 401 }),
      ),
    );

    let caught: unknown;
    try {
      await ensureFreshAccessToken();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("authentication expired");
  });
});
