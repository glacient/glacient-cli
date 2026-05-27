/**
 * Integration tests for getCapabilityBundle.
 *
 * HTTP stubs: MSW intercepts outbound fetch calls at the network layer.
 * Disk isolation: XDG_CONFIG_HOME is set to a per-test temp directory.
 * Auth isolation: a real credentials.json is written to the temp dir so that
 * `ensureFreshAccessToken` succeeds without any network call.
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { create } from "tar";
import { getCapabilityBundle } from "./index.ts";
import { remove as removeCreds } from "@/pkg/config/cred-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_URL = "https://api.example.com";

function makeJwt(payload: object): string {
  const seg = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "EdDSA" })}.${seg(payload)}.sig`;
}

function makeFreshAccessToken(): string {
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  return makeJwt({
    exp,
    handle: "testuser",
    user_id: "user-1",
    s_id: "session-1",
    scopes: [],
  });
}

function makeFreshRefreshToken(): string {
  const exp = Math.floor((Date.now() + 7_200_000) / 1000);
  return makeJwt({ exp, sub: "user-1" });
}

async function seedCreds(xdgDir: string): Promise<void> {
  const p = path.join(xdgDir, "glacient.tech", "cli", "credentials.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    JSON.stringify({
      access_token: makeFreshAccessToken(),
      refresh_token: makeFreshRefreshToken(),
    }),
  );
}

/**
 * Build an in-memory tar.gz for a capability bundle.
 * Structure: `<id>@<version>/<file>` entries (so strip:1 lands them flat).
 */
async function buildBundleTarGz(
  id: string,
  version: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-stage-"));
  try {
    const prefix = `${id}@${version}`;
    const root = path.join(staging, prefix);
    await fs.mkdir(root, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(root, name), content, "utf8");
    }
    const archivePath = path.join(staging, "bundle.tar.gz");
    await create({ gzip: true, file: archivePath, cwd: staging }, [prefix]);
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

let tmpXdg: string;

beforeEach(async () => {
  tmpXdg = await fs.mkdtemp(
    path.join(os.tmpdir(), "glacient-bundle-test-"),
  );
  process.env["XDG_CONFIG_HOME"] = tmpXdg;
  process.env["GLACIENT_SERVER_URL"] = SERVER_URL;
  await seedCreds(tmpXdg);
});

afterEach(async () => {
  server.resetHandlers();
  await removeCreds();
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["GLACIENT_SERVER_URL"];
  await fs.rm(tmpXdg, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCapabilityBundle", () => {
  const CAP_JSON = JSON.stringify({
    id: "rpc.test",
    version: "1",
    summary: "Test RPC capability",
    related_capabilities: ["skill.test.creation"],
    deprecated: false,
    scopes_required: ["test:read"],
    connect: { service: "TestService", method: "Run" },
  });

  const INPUT_SCHEMA = JSON.stringify({ type: "object", properties: {} });

  test("cache miss: fetches bundle, extracts, returns correct handle", async () => {
    const tarBuf = await buildBundleTarGz("rpc.test", "1", {
      "capability.json": CAP_JSON,
      "input_schema.json": INPUT_SCHEMA,
    });

    server.use(
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () =>
        HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        }),
      ),
    );

    const handle = await getCapabilityBundle(SERVER_URL, "rpc.test", "1");

    expect(handle.capabilityJson.id).toBe("rpc.test");
    expect(handle.capabilityJson.version).toBe("1");
    expect(handle.capabilityJson.summary).toBe("Test RPC capability");
    expect(handle.files).toContain("capability.json");
    expect(handle.files).toContain("input_schema.json");
    expect(handle.path).toContain("rpc.test@1");
  });

  test("cache hit: second call does not issue another HTTP request", async () => {
    const tarBuf = await buildBundleTarGz("rpc.test", "1", {
      "capability.json": CAP_JSON,
      "input_schema.json": INPUT_SCHEMA,
    });

    let requestCount = 0;
    server.use(
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () => {
        requestCount++;
        return HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        });
      }),
    );

    // First call — should fetch
    await getCapabilityBundle(SERVER_URL, "rpc.test", "1");
    expect(requestCount).toBe(1);

    // Second call — should be a cache hit, no new HTTP request
    const handle2 = await getCapabilityBundle(SERVER_URL, "rpc.test", "1");
    expect(requestCount).toBe(1);
    expect(handle2.capabilityJson.id).toBe("rpc.test");
  });

  test("401 response throws StructuredError with code AUTH_REQUIRED", async () => {
    server.use(
      http.get(
        `${SERVER_URL}/schema/capabilities/rpc.test@1`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );

    await expect(
      getCapabilityBundle(SERVER_URL, "rpc.test", "1"),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test("404 response throws StructuredError with code NOT_FOUND", async () => {
    server.use(
      http.get(
        `${SERVER_URL}/schema/capabilities/rpc.test@1`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    await expect(
      getCapabilityBundle(SERVER_URL, "rpc.test", "1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("5xx response throws StructuredError with code UNAVAILABLE", async () => {
    server.use(
      http.get(
        `${SERVER_URL}/schema/capabilities/rpc.test@1`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    await expect(
      getCapabilityBundle(SERVER_URL, "rpc.test", "1"),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
