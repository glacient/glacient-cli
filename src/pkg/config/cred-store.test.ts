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
  ErrNoCreds,
  type CredStore,
} from "./cred-store.ts";

function makeJwt(payload: object): string {
  const seg = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "EdDSA" })}.${seg(payload)}.sig`;
}

const sample: CredStore = {
  access_token: makeJwt({
    handle: "testuser",
    user_id: "user-123",
    s_id: "session-123",
    exp: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
    scopes: [],
  }),
  refresh_token: "refresh.token.value",
};

describe("cred-store", () => {
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

  test("save then load returns matching tokens and decoded claims", async () => {
    await save(sample);
    const loaded = await load();
    expect(loaded.access_token).toBe(sample.access_token);
    expect(loaded.refresh_token).toBe(sample.refresh_token);
    expect(loaded.claims.handle).toBe("testuser");
    expect(loaded.claims.user_id).toBe("user-123");
  });

  test("on-disk shape excludes claims", async () => {
    await save(sample);
    const credPath = path.join(
      tmpDir,
      "glacient.tech",
      "cli",
      "credentials.json",
    );
    const raw = JSON.parse(await fs.readFile(credPath, "utf8"));
    expect(raw).toEqual({
      access_token: sample.access_token,
      refresh_token: sample.refresh_token,
    });
  });

  test("file mode is 0o600 after save", async () => {
    await save(sample);
    const credPath = path.join(
      tmpDir,
      "glacient.tech",
      "cli",
      "credentials.json",
    );
    const stat = await fs.stat(credPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("remove then load rejects with ErrNoCreds", async () => {
    await save(sample);
    await remove();
    expect(await caught(load)).toBe(ErrNoCreds);
  });

  test("load without prior save rejects with ErrNoCreds", async () => {
    expect(await caught(load)).toBe(ErrNoCreds);
  });

  test("loaded credentials are frozen", async () => {
    await save(sample);
    const loaded = await load();
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.claims)).toBe(true);
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
