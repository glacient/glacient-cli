import { extract } from "tar";

/**
 * Extract a gzip-compressed tar archive from `buffer` into `destDir`.
 *
 * The top-level directory component is stripped (`strip: 1`), so an archive
 * rooted at `rpc.foo@1/` extracts directly into `destDir`.
 *
 * Security: any entry whose path is absolute or contains `..` is rejected.
 * The check runs in `onReadEntry` (before tar writes anything) and the
 * extraction Promise rejects without producing partial output. Conservative
 * by design — also rejects filenames that contain `..` as a substring, which
 * we never expect in legitimate skill bundles.
 */
export async function extractTarGz(
  buffer: Buffer,
  destDir: string,
): Promise<void> {
  let pathError: Error | undefined;

  const unpack = extract({
    cwd: destDir,
    strip: 1,
    strict: true,
    onReadEntry(entry) {
      if (pathError !== undefined) {
        entry.ignore = true;
        return;
      }
      try {
        rejectUnsafePath(entry.path);
      } catch (err) {
        pathError = err instanceof Error ? err : new Error(String(err));
        entry.ignore = true;
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    unpack.on("error", (err) => {
      reject(pathError ?? err);
    });
    unpack.on("close", () => {
      if (pathError !== undefined) {
        reject(pathError);
      } else {
        resolve();
      }
    });

    unpack.end(buffer);
  });
}

function rejectUnsafePath(entryPath: string): void {
  if (entryPath.startsWith("/")) {
    throw new Error(
      `Unsafe tar entry: absolute path "${entryPath}" is not allowed`,
    );
  }
  if (entryPath.includes("..")) {
    throw new Error(
      `Unsafe tar entry: ".." in "${entryPath}" is not allowed`,
    );
  }
}
