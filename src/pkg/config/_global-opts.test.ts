import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { __resetForTests, getServerUrl } from "./_global-opts.ts";
import {
  save as saveConfig,
  remove as removeConfig,
} from "./config-store.ts";

const DEFAULT_SERVER_URL = "https://auth.glacient.tech";

describe("global-opts.getServerUrl", () => {
  let tmpDir: string;
  let origXdg: string | undefined;
  let origServer: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gctl-test-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    origServer = process.env["GLACIENT_SERVER_URL"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterAll(async () => {
    if (origXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = origXdg;
    if (origServer === undefined) delete process.env["GLACIENT_SERVER_URL"];
    else process.env["GLACIENT_SERVER_URL"] = origServer;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    delete process.env["GLACIENT_SERVER_URL"];
    await removeConfig();
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
  });

  test("env var wins over config and default", async () => {
    process.env["GLACIENT_SERVER_URL"] = "https://env.example";
    await saveConfig({ "server-url": "https://config.example" });
    expect(await getServerUrl()).toBe("https://env.example");
  });

  test("config file used when env is unset", async () => {
    await saveConfig({ "server-url": "https://config.example" });
    expect(await getServerUrl()).toBe("https://config.example");
  });

  test("falls back to default when no env and no config", async () => {
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL);
  });

  test("empty env var is treated as unset", async () => {
    process.env["GLACIENT_SERVER_URL"] = "";
    await saveConfig({ "server-url": "https://config.example" });
    expect(await getServerUrl()).toBe("https://config.example");
  });

  test("memoizes resolved value across calls", async () => {
    process.env["GLACIENT_SERVER_URL"] = "https://first.example";
    const first = await getServerUrl();
    process.env["GLACIENT_SERVER_URL"] = "https://second.example";
    const second = await getServerUrl();
    expect(first).toBe("https://first.example");
    expect(second).toBe("https://first.example");
  });

  test("__resetForTests clears the memoized value", async () => {
    process.env["GLACIENT_SERVER_URL"] = "https://first.example";
    expect(await getServerUrl()).toBe("https://first.example");
    __resetForTests();
    process.env["GLACIENT_SERVER_URL"] = "https://second.example";
    expect(await getServerUrl()).toBe("https://second.example");
  });
});
