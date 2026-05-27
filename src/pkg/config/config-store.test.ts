import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  load,
  save,
  remove,
  ErrNoConfig,
  type Config,
} from "./config-store.ts";

const sample: Config = { "server-url": "https://auth.example.test" };

describe("config-store", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gctl-test-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterAll(async () => {
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await remove();
  });

  test("save then load round-trips", async () => {
    await save(sample);
    const loaded = await load();
    expect(loaded).toEqual(sample);
  });

  test("file mode is 0o600 after save", async () => {
    await save(sample);
    const cfgPath = path.join(tmpDir, "glacient.tech", "cli", "config.json");
    const stat = await fs.stat(cfgPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("remove then load rejects with ErrNoConfig", async () => {
    await save(sample);
    await remove();
    expect(await caught(load)).toBe(ErrNoConfig);
  });

  test("load without prior save rejects with ErrNoConfig", async () => {
    expect(await caught(load)).toBe(ErrNoConfig);
  });

  test("loaded config is frozen", async () => {
    await save(sample);
    const loaded = await load();
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test("save returns a frozen instance", async () => {
    const saved = await save(sample);
    expect(Object.isFrozen(saved)).toBe(true);
  });
});

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}
