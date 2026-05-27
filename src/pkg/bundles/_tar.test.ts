import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create } from "tar";
import { extractTarGz } from "./_tar.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an in-memory tar.gz containing `files` rooted at `<prefix>/`. */
async function buildTarGz(
  prefix: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "tar-stage-"));
  try {
    const root = path.join(staging, prefix);
    await fs.mkdir(root, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(root, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }
    const archivePath = path.join(staging, "bundle.tar.gz");
    await create({ gzip: true, file: archivePath, cwd: staging }, [prefix]);
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Construct a minimal POSIX tar archive (uncompressed) containing entries with
 * arbitrary header paths, then gzip it. Used to simulate path-traversal.
 */
async function buildUnsafeTarGz(
  entries: Array<{ path: string; content: string }>,
): Promise<Buffer> {
  const { createGzip } = await import("node:zlib");
  const { Readable } = await import("node:stream");

  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const data = Buffer.from(entry.content, "utf8");
    const header = buildTarHeader(entry.path, data.length);
    blocks.push(header);
    // Data block(s) — padded to 512-byte boundary
    const paddedSize = Math.ceil(data.length / 512) * 512;
    const dataBlock = Buffer.alloc(paddedSize);
    data.copy(dataBlock);
    blocks.push(dataBlock);
  }

  // Two 512-byte zero blocks (end-of-archive marker)
  blocks.push(Buffer.alloc(1024));

  const rawTar = Buffer.concat(blocks);

  return new Promise<Buffer>((resolve, reject) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on("data", (c: Buffer) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    Readable.from(rawTar).pipe(gz);
  });
}

/** Build a minimal 512-byte POSIX ustar header block. */
function buildTarHeader(entryPath: string, fileSize: number): Buffer {
  const header = Buffer.alloc(512);

  // name (offset 0, 100 bytes)
  header.write(entryPath.slice(0, 99), 0, "utf8");

  // mode (offset 100, 8 bytes)
  header.write("0000644\0", 100, "ascii");

  // uid/gid (offset 108/116, 8 bytes each)
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");

  // size (offset 124, 12 bytes, octal)
  const sizeStr = fileSize.toString(8).padStart(11, "0") + "\0";
  header.write(sizeStr, 124, "ascii");

  // mtime (offset 136, 12 bytes)
  const mtime = Math.floor(Date.now() / 1000);
  const mtimeStr = mtime.toString(8).padStart(11, "0") + "\0";
  header.write(mtimeStr, 136, "ascii");

  // typeflag (offset 156): '0' = regular file
  header.write("0", 156, "ascii");

  // ustar indicator (offset 257, 6 bytes) + ustar version (offset 263, 2 bytes)
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  // Checksum (offset 148, 8 bytes) — fill with spaces first, compute, write
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  return header;
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-extract-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tmpDirs.splice(0);
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractTarGz", () => {
  test("round-trip: extracts files with correct contents", async () => {
    const tarBuf = await buildTarGz("bundle@1", {
      "capability.json": JSON.stringify({ id: "bundle", version: "1" }),
      "input_schema.json": JSON.stringify({ type: "object" }),
    });
    const dest = await makeTempDir();

    await extractTarGz(tarBuf, dest);

    const capRaw = await fs.readFile(path.join(dest, "capability.json"), "utf8");
    expect(JSON.parse(capRaw)).toEqual({ id: "bundle", version: "1" });

    const schemaRaw = await fs.readFile(
      path.join(dest, "input_schema.json"),
      "utf8",
    );
    expect(JSON.parse(schemaRaw)).toEqual({ type: "object" });
  });

  test("strip-1: top-level directory component is removed", async () => {
    const tarBuf = await buildTarGz("rpc.thing@5", {
      "capability.json": JSON.stringify({ id: "rpc.thing", version: "5" }),
    });
    const dest = await makeTempDir();

    await extractTarGz(tarBuf, dest);

    // File must be directly in dest, not under rpc.thing@5/
    const exists = await fs
      .access(path.join(dest, "capability.json"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    // The top-level directory must NOT appear
    const unwanted = await fs
      .access(path.join(dest, "rpc.thing@5"))
      .then(() => true)
      .catch(() => false);
    expect(unwanted).toBe(false);
  });

  test("path-traversal: entry with '..' segment throws before any file is written", async () => {
    const tarBuf = await buildUnsafeTarGz([
      { path: "../../escape.txt", content: "bad" },
    ]);
    const dest = await makeTempDir();

    await expect(extractTarGz(tarBuf, dest)).rejects.toThrow(
      /path traversal|\.\.|\bUnsafe\b/i,
    );

    // No files should have been written
    const entries = await fs.readdir(dest);
    expect(entries).toHaveLength(0);
  });

  test("path-traversal: absolute path entry throws", async () => {
    const tarBuf = await buildUnsafeTarGz([
      { path: "/etc/abs.txt", content: "bad" },
    ]);
    const dest = await makeTempDir();

    await expect(extractTarGz(tarBuf, dest)).rejects.toThrow(
      /absolute|Unsafe/i,
    );
  });
});
