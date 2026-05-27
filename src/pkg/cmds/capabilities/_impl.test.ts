/**
 * Tests for the `glacient capabilities` subcommand tree.
 *
 * HTTP stubs: MSW intercepts outbound fetch calls at the network layer.
 * Disk isolation: XDG_CONFIG_HOME is set to a per-test temp directory.
 * Auth isolation: a real credentials.json is written so ensureFreshAccessToken
 * succeeds without any network call.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { create } from "tar";
import { makeCapabilitiesCommandForTest } from "./_impl.ts";
import type { Manifest } from "@/pkg/manifest";
import type { LocalHandler, LocalHandlerCtx, LocalHandlerResult } from "./_local_handlers";
import { renderError } from "@/pkg/common/io/errors.ts";
import { StructuredError } from "@/pkg/common/error";
import { remove as removeCreds } from "@/pkg/config/cred-store.ts";
import { cacheOutputMode } from "@/pkg/config";

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

// Thin manifest fixture
const THIN_MANIFEST: Manifest = {
  manifest_version: "2026-05-18",
  capabilities: [
    {
      id: "rpc.test",
      summary: "Test RPC capability",
      version: "1",
      related_capabilities: ["skill.test"],
    },
    {
      id: "skill.test",
      summary: "How to use rpc.test",
      version: "1",
      related_capabilities: ["rpc.test"],
    },
  ],
};

const RPC_CAPABILITY_JSON = JSON.stringify({
  id: "rpc.test",
  version: "1",
  summary: "Test RPC capability",
  related_capabilities: ["skill.test"],
  deprecated: false,
  scopes_required: ["test:read"],
  connect: { service: "TestService", method: "Run", path_prefix: "/api" },
});

const SKILL_CAPABILITY_JSON = JSON.stringify({
  id: "skill.test",
  version: "1",
  summary: "How to use rpc.test",
  related_capabilities: ["rpc.test"],
  deprecated: false,
});

const INPUT_SCHEMA_WITH_REQUIRED = JSON.stringify({
  type: "object",
  properties: {
    project_id: { type: "string" },
  },
  required: ["project_id"],
  additionalProperties: false,
});

const OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: { result: { type: "string" } },
});

const LOCAL_CAPABILITY_JSON = JSON.stringify({
  id: "local.test",
  version: "1",
  summary: "Test local capability",
  related_capabilities: [],
  deprecated: false,
});

const LOCAL_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
});

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
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit;
let stdoutBuf: string[];
let stderrBuf: string[];

beforeEach(async () => {
  tmpXdg = await fs.mkdtemp(path.join(os.tmpdir(), "glacient-cap-test-"));
  process.env["XDG_CONFIG_HOME"] = tmpXdg;
  process.env["GLACIENT_SERVER_URL"] = SERVER_URL;
  await seedCreds(tmpXdg);

  // Pin JSON output: getOutputMode() otherwise defaults to "text" when stdout is
  // a TTY, which would make these JSON-parsing assertions fail under an
  // interactive `bun test` (but pass when piped/CI).
  cacheOutputMode("json");

  stdoutBuf = [];
  stderrBuf = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown) => {
    stdoutBuf.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    stderrBuf.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.exit as any) = (code?: number) => {
    const err = new Error(`process.exit(${code ?? 0})`) as ProcessExitError;
    err.__exitCode = code ?? 0;
    throw err;
  };
});

afterEach(async () => {
  server.resetHandlers();
  await removeCreds();
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["GLACIENT_SERVER_URL"];
  await fs.rm(tmpXdg, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessExitError extends Error {
  __exitCode: number;
}

function isExit(err: unknown): err is ProcessExitError {
  return (
    err !== null &&
    typeof err === "object" &&
    "__exitCode" in err &&
    typeof (err as { __exitCode: unknown }).__exitCode === "number"
  );
}

function isCommanderError(err: unknown): err is { exitCode: number; code: string } {
  return (
    err !== null &&
    typeof err === "object" &&
    "exitCode" in err &&
    "code" in err &&
    typeof (err as { exitCode: unknown }).exitCode === "number"
  );
}

// ---------------------------------------------------------------------------
// Drive helper
// ---------------------------------------------------------------------------

interface DriveArgs {
  argv: string[];
  invokeImpl?: (input: unknown) => Promise<unknown>;
  stdin?: string;
  isStdinPiped?: boolean;
  manifestOverride?: Manifest;
  localHandlers?: Record<string, LocalHandler>;
}

async function drive(args: DriveArgs): Promise<{
  invokeCalls: unknown[];
  exitCode: number;
}> {
  const invokeCalls: unknown[] = [];
  const cmd = makeCapabilitiesCommandForTest({
    _invoke: async ({ input }) => {
      invokeCalls.push(input);
      if (args.invokeImpl) return args.invokeImpl(input);
      return { ok: true };
    },
    _readStdin: async () => args.stdin ?? "",
    _isStdinPiped: () => args.isStdinPiped ?? false,
    ...(args.manifestOverride !== undefined
      ? { _getManifest: async () => args.manifestOverride! }
      : {}),
    ...(args.localHandlers !== undefined
      ? { _localHandlers: args.localHandlers }
      : {}),
  });
  const root = new Command("glacient").exitOverride();
  root.addCommand(cmd);

  let exitCode = 0;
  try {
    await root.parseAsync(["node", "glacient", ...args.argv]);
  } catch (err) {
    if (isExit(err)) {
      exitCode = err.__exitCode;
    } else if (isCommanderError(err)) {
      // Commander's exitOverride throws a CommanderError (e.g. commander.helpDisplayed)
      exitCode = err.exitCode;
    } else if (err instanceof StructuredError) {
      renderError(err, "json");
      exitCode = 1;
    } else {
      throw err;
    }
  }
  return { invokeCalls, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("capabilities list", () => {
  test("JSON output: thin shape with cache augmentation per entry", async () => {
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
    );

    const { exitCode } = await drive({ argv: ["capabilities", "list"] });
    expect(exitCode).toBe(0);

    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out.manifest_version).toBe(THIN_MANIFEST.manifest_version);
    expect(Array.isArray(out.capabilities)).toBe(true);
    expect(out.capabilities).toHaveLength(2);

    const rpcEntry = out.capabilities.find(
      (c: { id: string }) => c.id === "rpc.test",
    );
    expect(rpcEntry).toBeDefined();
    expect(rpcEntry.summary).toBe("Test RPC capability");
    expect(rpcEntry.version).toBe("1");
    expect(Array.isArray(rpcEntry.related_capabilities)).toBe(true);
    // cache field is present
    expect(rpcEntry.cache).toBeDefined();
    expect(rpcEntry.cache.status).toBe("missing");

    // No fat fields from the old shape
    expect(rpcEntry.input_schema).toBeUndefined();
    expect(rpcEntry.output_schema).toBeUndefined();
    expect(rpcEntry.connect).toBeUndefined();
  });
});

describe("capabilities show", () => {
  test("show rpc.test: no inlined schemas; schemas appear in files[] for direct disk access", async () => {
    const tarBuf = await buildBundleTarGz("rpc.test", "1", {
      "capability.json": RPC_CAPABILITY_JSON,
      "input_schema.json": INPUT_SCHEMA_WITH_REQUIRED,
      "output_schema.json": OUTPUT_SCHEMA,
    });

    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () =>
        HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        }),
      ),
    );

    const { exitCode } = await drive({ argv: ["capabilities", "show", "rpc.test"] });
    expect(exitCode).toBe(0);

    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out.id).toBe("rpc.test");
    expect(out.version).toBe("1");
    // Schemas are NOT inlined in show output.
    expect(out.input_schema).toBeUndefined();
    expect(out.output_schema).toBeUndefined();
    // Capability.json fields appear directly.
    expect(out.scopes_required).toEqual(["test:read"]);
    expect(out.connect).toEqual({ service: "TestService", method: "Run", path_prefix: "/api" });
    // Disk pointers present.
    expect(typeof out.path).toBe("string");
    expect(out.path).toContain("rpc.test@1");
    expect(Array.isArray(out.files)).toBe(true);
    expect(out.files).toContain("capability.json");
    expect(out.files).toContain("input_schema.json");
    expect(out.files).toContain("output_schema.json");
  });

  test("show skill.test: reports path + files; no scopes_required or connect (skill capability.json has neither)", async () => {
    const tarBuf = await buildBundleTarGz("skill.test", "1", {
      "capability.json": SKILL_CAPABILITY_JSON,
      "SKILL.md": "# How to use rpc.test\n\nSome instructions.",
    });

    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/skill.test@1`, () =>
        HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        }),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "show", "skill.test"],
    });
    expect(exitCode).toBe(0);

    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out.id).toBe("skill.test");
    expect(out.input_schema).toBeUndefined();
    expect(out.output_schema).toBeUndefined();
    expect(out.scopes_required).toBeUndefined();
    expect(out.connect).toBeUndefined();
    expect(typeof out.path).toBe("string");
    expect(out.path).toContain("skill.test@1");
    expect(Array.isArray(out.files)).toBe(true);
    expect(out.files).toContain("capability.json");
    expect(out.files).toContain("SKILL.md");
  });

  test("show --stale-ok: uses cached bundle without any network fetch when fresh", async () => {
    const tarBuf = await buildBundleTarGz("rpc.test", "1", {
      "capability.json": RPC_CAPABILITY_JSON,
      "input_schema.json": INPUT_SCHEMA_WITH_REQUIRED,
      "output_schema.json": OUTPUT_SCHEMA,
    });

    let bundleHits = 0;
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () => {
        bundleHits++;
        return HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        });
      }),
    );

    // Prime the cache via a normal show.
    const first = await drive({ argv: ["capabilities", "show", "rpc.test"] });
    expect(first.exitCode).toBe(0);
    expect(bundleHits).toBe(1);

    // Reset stdout buf for the second drive.
    stdoutBuf = [];

    // --stale-ok with a fresh cache: no additional bundle fetch.
    const second = await drive({
      argv: ["capabilities", "show", "rpc.test", "--stale-ok"],
    });
    expect(second.exitCode).toBe(0);
    expect(bundleHits).toBe(1);

    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out.id).toBe("rpc.test");
    expect(out.version).toBe("1");
  });

  test("show --stale-ok: loads a stale on-disk version when manifest version is newer; no network", async () => {
    // Pre-stage a bundle for rpc.test@0 on disk (an older version).
    const stagedBundle = await buildBundleTarGz("rpc.test", "0", {
      "capability.json": JSON.stringify({
        id: "rpc.test",
        version: "0",
        summary: "Old version",
        related_capabilities: [],
        deprecated: false,
        scopes_required: [],
        connect: { service: "TestService", method: "Run", path_prefix: "/api" },
      }),
      "input_schema.json": "{}",
      "output_schema.json": "{}",
    });
    // Manually extract into the XDG dir.
    const { extractTarGz } = await import("@/pkg/bundles/_tar.ts");
    const targetDir = path.join(
      tmpXdg,
      "glacient.tech",
      "cli",
      "capabilities",
      "rpc.test@0",
    );
    await fs.mkdir(targetDir, { recursive: true });
    await extractTarGz(stagedBundle, targetDir);

    let bundleHits = 0;
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () => {
        bundleHits++;
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "show", "rpc.test", "--stale-ok"],
    });
    expect(exitCode).toBe(0);
    expect(bundleHits).toBe(0); // never touched the network

    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out.id).toBe("rpc.test");
    expect(out.version).toBe("0"); // served the stale version
  });

  test("show --stale-ok: NOT_FOUND when nothing is cached", async () => {
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "show", "rpc.test", "--stale-ok"],
    });
    expect(exitCode).toBe(1);

    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("NOT_FOUND");
    expect(errJson.message).toContain("--stale-ok");
  });
});

describe("capabilities call", () => {
  test("call rpc.test --input '{}' against required-field schema: VALIDATION_FAILED with pointer field and skill hint", async () => {
    const tarBuf = await buildBundleTarGz("rpc.test", "1", {
      "capability.json": RPC_CAPABILITY_JSON,
      "input_schema.json": INPUT_SCHEMA_WITH_REQUIRED,
      "output_schema.json": OUTPUT_SCHEMA,
    });

    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/rpc.test@1`, () =>
        HttpResponse.arrayBuffer(tarBuf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/gzip" },
        }),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "rpc.test", "--input", "{}"],
    });
    expect(exitCode).toBe(1);

    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("VALIDATION_FAILED");
    expect(errJson.details).toBeDefined();
    expect(Array.isArray(errJson.details.errors)).toBe(true);
    expect(errJson.details.errors.length).toBeGreaterThan(0);

    const firstError = errJson.details.errors[0];
    // field is a JSON pointer: "/project_id" (required error with missing property)
    expect(firstError.field).toBe("/project_id");
    expect(firstError.issue).toBe("required");

    // hints include the related skill
    expect(Array.isArray(errJson.hints)).toBe(true);
    const skillHint = errJson.hints.find(
      (h: { command: string }) =>
        typeof h.command === "string" &&
        h.command.startsWith("glacient capabilities show skill."),
    );
    expect(skillHint).toBeDefined();
  });

  test("call skill.test: UNCALLABLE_CAPABILITY", async () => {
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "skill.test"],
    });
    expect(exitCode).toBe(1);

    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("UNCALLABLE_CAPABILITY");
  });
});

describe("capabilities call: local.*", () => {
  const LOCAL_MANIFEST: Manifest = {
    manifest_version: "2026-05-18",
    capabilities: [
      {
        id: "local.test",
        summary: "Test local capability",
        version: "1",
        related_capabilities: [],
      },
    ],
  };

  const setupLocalBundleServer = async () => {
    const tarBuf = await buildBundleTarGz("local.test", "1", {
      "capability.json": LOCAL_CAPABILITY_JSON,
      "input_schema.json": LOCAL_INPUT_SCHEMA,
    });
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(LOCAL_MANIFEST),
      ),
      http.get(`${SERVER_URL}/schema/capabilities/local.test@1`, () =>
        HttpResponse.arrayBuffer(
          tarBuf.buffer.slice(
            tarBuf.byteOffset,
            tarBuf.byteOffset + tarBuf.byteLength,
          ) as ArrayBuffer,
          { headers: { "Content-Type": "application/gzip" } },
        ),
      ),
    );
  };

  test("happy path: dispatches to registered handler and prints result", async () => {
    await setupLocalBundleServer();
    let received: unknown;
    const stubHandler: LocalHandler = async (ctx: LocalHandlerCtx): Promise<LocalHandlerResult> => {
      received = ctx.input;
      return { valid: true, errors: [], hints: [] } satisfies LocalHandlerResult;
    };

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "local.test", "--input", '{"name":"x"}'],
      manifestOverride: LOCAL_MANIFEST,
      localHandlers: { "local.test": stubHandler },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({ name: "x" });
    const out = JSON.parse(stdoutBuf.join("").trim());
    expect(out).toEqual({ valid: true, errors: [], hints: [] });
  });

  test("input fails schema: throws VALIDATION_FAILED before handler runs", async () => {
    await setupLocalBundleServer();
    let handlerCalled = false;
    const stubHandler: LocalHandler = async (): Promise<LocalHandlerResult> => {
      handlerCalled = true;
      return { valid: true, errors: [], hints: [] } satisfies LocalHandlerResult;
    };

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "local.test", "--input", "{}"],
      manifestOverride: LOCAL_MANIFEST,
      localHandlers: { "local.test": stubHandler },
    });

    expect(exitCode).toBe(1);
    expect(handlerCalled).toBe(false);
    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("VALIDATION_FAILED");
  });

  test("unknown local.* id (no handler registered): throws UNKNOWN_CAPABILITY", async () => {
    await setupLocalBundleServer();

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "local.test", "--input", '{"name":"x"}'],
      manifestOverride: LOCAL_MANIFEST,
      localHandlers: {},
    });

    expect(exitCode).toBe(1);
    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("UNKNOWN_CAPABILITY");
    expect(errJson.message).toContain("local.test");
  });

  test("ref.* is uncallable: throws UNCALLABLE_CAPABILITY", async () => {
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "ref.workflow.components"],
    });

    expect(exitCode).toBe(1);
    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("UNCALLABLE_CAPABILITY");
    expect(errJson.details.id).toBe("ref.workflow.components");
  });

  test("skill.* remains uncallable: UNCALLABLE_CAPABILITY regression", async () => {
    server.use(
      http.get(`${SERVER_URL}/schema/manifest`, () =>
        HttpResponse.json(THIN_MANIFEST),
      ),
    );

    const { exitCode } = await drive({
      argv: ["capabilities", "call", "skill.workflow.creation"],
    });

    expect(exitCode).toBe(1);
    const errJson = JSON.parse(stderrBuf.join("").trim());
    expect(errJson.code).toBe("UNCALLABLE_CAPABILITY");
    expect(errJson.details.id).toBe("skill.workflow.creation");
  });
});

describe("capabilities (no subcommand)", () => {
  test("prints help with three subcommand names, exits 0", async () => {
    server.use(
      // No requests expected — help prints without network access.
      // onUnhandledRequest: "error" will catch any stray calls.
    );

    const { exitCode } = await drive({ argv: ["capabilities"] });
    expect(exitCode).toBe(0);

    const out = stdoutBuf.join("") + stderrBuf.join("");
    // Each subcommand appears as its own indented line in Commander's help.
    expect(out).toMatch(/^\s+list\b/m);
    expect(out).toMatch(/^\s+show\b/m);
    expect(out).toMatch(/^\s+call\b/m);
    expect(out).not.toMatch(/^\s+fetch\b/m);
  });
});
