import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bundleExists,
  bundleDirPath,
  bundleFetchedAt,
  listBundleFiles,
  writeBundleAtomic,
} from "./_cache.ts";

// ---------------------------------------------------------------------------
// XDG isolation
// ---------------------------------------------------------------------------

let tmpXdg: string;

beforeEach(async () => {
  tmpXdg = await fs.mkdtemp(path.join(os.tmpdir(), "glacient-cache-test-"));
  process.env["XDG_CONFIG_HOME"] = tmpXdg;
});

afterEach(async () => {
  delete process.env["XDG_CONFIG_HOME"];
  await fs.rm(tmpXdg, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// bundleExists
// ---------------------------------------------------------------------------

describe("bundleExists", () => {
  test("returns false when bundle directory does not exist", async () => {
    expect(await bundleExists("rpc.foo", "1")).toBe(false);
  });

  test("returns false when directory exists but capability.json is absent", async () => {
    const dir = bundleDirPath("rpc.foo", "2");
    await fs.mkdir(dir, { recursive: true });
    expect(await bundleExists("rpc.foo", "2")).toBe(false);
  });

  test("returns true after a successful writeBundleAtomic that creates capability.json", async () => {
    await writeBundleAtomic("rpc.foo", "3", async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "capability.json"),
        JSON.stringify({ id: "rpc.foo", version: "3" }),
        "utf8",
      );
    });
    expect(await bundleExists("rpc.foo", "3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeBundleAtomic
// ---------------------------------------------------------------------------

describe("writeBundleAtomic", () => {
  test("extracts to the correct final path and returns it", async () => {
    const result = await writeBundleAtomic("rpc.bar", "1", async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "capability.json"),
        '{"id":"rpc.bar","version":"1"}',
        "utf8",
      );
    });

    const expected = bundleDirPath("rpc.bar", "1");
    expect(result).toBe(expected);

    const raw = await fs.readFile(
      path.join(expected, "capability.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toMatchObject({ id: "rpc.bar" });
  });

  test("failure inside extractFn leaves no partial dir at final path", async () => {
    await expect(
      writeBundleAtomic("rpc.baz", "1", async (_tmpDir) => {
        throw new Error("extract failed");
      }),
    ).rejects.toThrow("extract failed");

    // Final dir must not exist
    const finalPath = bundleDirPath("rpc.baz", "1");
    const exists = await fs
      .access(finalPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("failure inside extractFn leaves no leftover .tmp-* directory", async () => {
    const capabilitiesRoot = path.join(
      tmpXdg,
      "glacient.tech",
      "cli",
      "capabilities",
    );

    await expect(
      writeBundleAtomic("rpc.qux", "1", async (_tmpDir) => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    // No .tmp- directories should remain
    const children = await fs.readdir(capabilitiesRoot).catch(() => []);
    const leftover = children.filter((c) => c.includes(".tmp-"));
    expect(leftover).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listBundleFiles
// ---------------------------------------------------------------------------

describe("listBundleFiles", () => {
  test("returns sorted, dir-relative file paths", async () => {
    await writeBundleAtomic("rpc.list", "1", async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "capability.json"),
        "{}",
        "utf8",
      );
      await fs.writeFile(
        path.join(tmpDir, "input_schema.json"),
        "{}",
        "utf8",
      );
      await fs.writeFile(
        path.join(tmpDir, "output_schema.json"),
        "{}",
        "utf8",
      );
    });

    const files = await listBundleFiles("rpc.list", "1");
    expect(files).toEqual([
      "capability.json",
      "input_schema.json",
      "output_schema.json",
    ]);
  });

  test("returns nested paths relative to the bundle dir", async () => {
    await writeBundleAtomic("skill.deep", "1", async (tmpDir) => {
      await fs.mkdir(path.join(tmpDir, "examples"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "capability.json"), "{}", "utf8");
      await fs.writeFile(
        path.join(tmpDir, "examples", "sample.json"),
        "{}",
        "utf8",
      );
      await fs.writeFile(path.join(tmpDir, "SKILL.md"), "# skill", "utf8");
    });

    const files = await listBundleFiles("skill.deep", "1");
    expect(files).toEqual([
      "SKILL.md",
      "capability.json",
      "examples/sample.json",
    ]);
  });
});

// ---------------------------------------------------------------------------
// bundleFetchedAt
// ---------------------------------------------------------------------------

describe("bundleFetchedAt", () => {
  test("returns undefined when bundle does not exist", async () => {
    expect(await bundleFetchedAt("rpc.absent", "1")).toBeUndefined();
  });

  test("returns an ISO string after a successful write", async () => {
    const before = new Date();
    await writeBundleAtomic("rpc.timed", "1", async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "capability.json"),
        "{}",
        "utf8",
      );
    });
    const after = new Date();

    const fetchedAt = await bundleFetchedAt("rpc.timed", "1");
    expect(fetchedAt).toBeDefined();
    const ts = new Date(fetchedAt!);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});
