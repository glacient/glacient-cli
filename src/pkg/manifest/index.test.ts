/**
 * Tests for src/pkg/manifest/index.ts
 *
 * Covers: thin-shape parse + computeCacheStatus against a temp XDG_CONFIG_HOME
 * with various bundle dirs present/absent.
 *
 * Disk isolation: XDG_CONFIG_HOME is set to a per-test temp directory.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeCacheStatus } from "./index.ts";
import type { CapabilityEntry } from "./index.ts";

let tmpXdg: string;

beforeEach(async () => {
  tmpXdg = await fs.mkdtemp(path.join(os.tmpdir(), "glacient-manifest-test-"));
  process.env["XDG_CONFIG_HOME"] = tmpXdg;
});

afterEach(async () => {
  delete process.env["XDG_CONFIG_HOME"];
  await fs.rm(tmpXdg, { recursive: true, force: true });
});

const entry = (
  id: string,
  version: string,
): CapabilityEntry => ({
  id,
  summary: `${id} summary`,
  version,
  related_capabilities: [],
});

describe("computeCacheStatus", () => {
  test("missing: no bundle dir on disk", async () => {
    const status = await computeCacheStatus(entry("rpc.test", "1"));
    expect(status.status).toBe("missing");
    expect(status.version).toBeUndefined();
    expect(status.fetched_at).toBeUndefined();
  });

  test("fresh: bundle dir for this version exists with capability.json", async () => {
    const bundleDir = path.join(
      tmpXdg,
      "glacient.tech",
      "cli",
      "capabilities",
      "rpc.test@1",
    );
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "capability.json"),
      JSON.stringify({ id: "rpc.test", version: "1" }),
    );

    const status = await computeCacheStatus(entry("rpc.test", "1"));
    expect(status.status).toBe("fresh");
    expect(status.version).toBe("1");
    expect(typeof status.fetched_at).toBe("string");
  });

  test("stale: bundle exists for a different (older) version", async () => {
    // Only version "0" exists on disk; manifest says version "1"
    const staleDir = path.join(
      tmpXdg,
      "glacient.tech",
      "cli",
      "capabilities",
      "rpc.test@0",
    );
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(
      path.join(staleDir, "capability.json"),
      JSON.stringify({ id: "rpc.test", version: "0" }),
    );

    const status = await computeCacheStatus(entry("rpc.test", "1"));
    expect(status.status).toBe("stale");
    expect(status.version).toBe("0");
    expect(typeof status.fetched_at).toBe("string");
  });

  test("fresh wins over stale: if exact version present, reports fresh", async () => {
    const capabilitiesRoot = path.join(
      tmpXdg,
      "glacient.tech",
      "cli",
      "capabilities",
    );
    // Both version "0" (stale) and "1" (fresh) exist
    const staleDir = path.join(capabilitiesRoot, "rpc.test@0");
    const freshDir = path.join(capabilitiesRoot, "rpc.test@1");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(
      path.join(staleDir, "capability.json"),
      JSON.stringify({ id: "rpc.test", version: "0" }),
    );
    await fs.writeFile(
      path.join(freshDir, "capability.json"),
      JSON.stringify({ id: "rpc.test", version: "1" }),
    );

    const status = await computeCacheStatus(entry("rpc.test", "1"));
    expect(status.status).toBe("fresh");
    expect(status.version).toBe("1");
  });

  test("works for skill. prefix too", async () => {
    const status = await computeCacheStatus(entry("skill.workflow.creation", "1"));
    expect(status.status).toBe("missing");
  });
});
