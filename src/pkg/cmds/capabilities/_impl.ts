/**
 * Package-private implementation of the `glacient capabilities` command.
 *
 * Lives in an underscore-prefixed file so only same-folder siblings can reach
 * it (see eslint.config.js). Cross-folder code consumes `capabilitiesCommand`
 * from `./capabilities.ts`; tests in this folder use `makeCapabilitiesCommandForTest`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getManifest, computeCacheStatus } from "@/pkg/manifest";
import type { CapabilityEntry } from "@/pkg/manifest";
import { getOutputMode, getServerUrl } from "@/pkg/config";
import { invoke } from "@/pkg/transport/rpc/invoke";
import { getCapabilityBundle, loadCachedBundle } from "@/pkg/bundles";
import type { BundleHandle } from "@/pkg/bundles";
import { consl } from "@/pkg/common/io/consl";
import { StructuredError } from "@/pkg/common/error";
import type { ErrorHint } from "@/pkg/common/error";
import { ajv } from "@/pkg/common/ajv";
import { buildField, resolveFieldValue } from "@/pkg/common/ajv/errors";
import { localHandlers as productionLocalHandlers } from "./_local_handlers";
import type { LocalHandler } from "./_local_handlers";

export interface CapabilitiesDeps {
  _getManifest?: typeof getManifest;
  _getBundle?: typeof getCapabilityBundle;
  _loadCachedBundle?: typeof loadCachedBundle;
  _invoke?: typeof invoke;
  _readStdin?: () => Promise<string>;
  _isStdinPiped?: () => boolean;
  _localHandlers?: Record<string, LocalHandler>;
}

/**
 * Test-facing constructor. Functionally identical to `makeCapabilitiesCommand`
 * but the explicit name documents intent at the call site and lets us track
 * test-only consumers separately if we ever need to.
 */
export function makeCapabilitiesCommandForTest(
  deps: CapabilitiesDeps,
): Command {
  return makeCapabilitiesCommand(deps);
}

/**
 * Build the Commander command tree for `glacient capabilities`. Accepts
 * optional dependency overrides; production callers pass nothing.
 */
export function makeCapabilitiesCommand(deps: CapabilitiesDeps = {}): Command {
  const fetchManifest = deps._getManifest ?? getManifest;
  const fetchBundle = deps._getBundle ?? getCapabilityBundle;
  const loadCached = deps._loadCachedBundle ?? loadCachedBundle;
  const callInvoke = deps._invoke ?? invoke;
  const readStdin = deps._readStdin ?? readStdinDefault;
  const isStdinPiped = deps._isStdinPiped ?? isStdinPipedDefault;
  const localHandlersDep = deps._localHandlers ?? productionLocalHandlers;

  const cmd = new Command("capabilities")
    .description("list and interact with server capabilities");

  // Attach .action so that `glacient capabilities` (no subcommand) prints help
  // instead of silently doing nothing.
  cmd.action(function (this: Command) {
    this.help();
  });

  cmd.addCommand(
    new Command("list")
      .description("list all capabilities with local cache status")
      .option("--refresh", "force a fresh manifest fetch")
      .action(async (opts: { refresh?: boolean }) => {
        const server = await getServerUrl();
        const manifest = await fetchManifest({ server, refresh: !!opts.refresh });
        const mode = await getOutputMode();

        const augmentedCapabilities = await Promise.all(
          manifest.capabilities.map(async (entry) => ({
            ...entry,
            cache: await computeCacheStatus(entry),
          })),
        );
        const augmented = { ...manifest, capabilities: augmentedCapabilities };

        if (mode === "json") {
          consl.outDataLn(augmented);
        } else {
          for (const cap of augmentedCapabilities) {
            process.stdout.write(
              `${cap.id}  ${cap.summary}  [cache: ${cap.cache.status}]\n`,
            );
          }
        }
      }),
  );

  cmd.addCommand(
    new Command("show")
      .description("show full detail for a capability, auto-fetching bundle if needed")
      .argument("<id>", "capability id (e.g. rpc.workflow.list)")
      .option(
        "--stale-ok",
        "do not fetch a new bundle; use whatever (possibly stale) bundle is on disk",
      )
      .action(async (id: string, opts: { staleOk?: boolean }) => {
        const server = await getServerUrl();
        const manifest = await fetchManifest({ server });
        const entry = resolveEntry(manifest.capabilities, id);

        let handle: BundleHandle;
        if (opts.staleOk) {
          const status = await computeCacheStatus(entry);
          if (status.status === "missing") {
            throw new StructuredError({
              code: "NOT_FOUND",
              message: `--stale-ok set but no bundle is cached for ${id}`,
              details: { id },
            });
          }
          const versionToLoad =
            status.status === "fresh" ? entry.version : status.version!;
          handle = await loadCached(id, versionToLoad);
        } else {
          handle = await fetchBundle(server, id, entry.version);
        }

        consl.outDataLn(buildShowOutput(handle));
      }),
  );

  cmd.addCommand(
    new Command("call")
      .description("execute an RPC capability")
      .argument("<id>", "capability id (rpc.* or local.*)")
      .option("--input <json>", "request body as JSON object; reads stdin if omitted")
      .action(async (id: string, opts: { input?: string }) => {
        if (!id.startsWith("rpc.") && !id.startsWith("local.")) {
          const reason =
            id.startsWith("skill.")
              ? "skill capabilities are reference material, not RPCs"
              : id.startsWith("ref.")
              ? "ref capabilities ship reference data, not callable RPCs"
              : "only rpc.* and local.* capabilities are callable";
          throw new StructuredError({
            code: "UNCALLABLE_CAPABILITY",
            message: `capability ${id} is not callable (${reason})`,
            details: { id },
          });
        }

        const server = await getServerUrl();
        const manifest = await fetchManifest({ server });
        const entry = resolveEntry(manifest.capabilities, id);
        const handle = await fetchBundle(server, id, entry.version);

        const schemaRaw = await fs.readFile(
          path.join(handle.path, "input_schema.json"),
          "utf8",
        );
        const inputSchema = JSON.parse(schemaRaw) as object;
        const validate = ajv.compile(inputSchema);

        const input = await parseJsonInput(opts.input, readStdin, isStdinPiped);

        if (!validate(input)) {
          const errors = (validate.errors ?? []).map((e) => {
            const field = buildField(e);
            const got = resolveFieldValue(field, input);
            return {
              field,
              issue: e.keyword,
              expected: e.params as unknown,
              ...(got !== undefined ? { got } : {}),
            };
          });

          const skillHints: ErrorHint[] = entry.related_capabilities
            .filter((rc) => rc.startsWith("skill."))
            .map((skillId) => ({
              action: "Read the skill for this capability",
              command: `glacient capabilities show ${skillId}`,
            }));

          throw new StructuredError({
            code: "VALIDATION_FAILED",
            message: `input failed schema validation for ${id}`,
            details: { errors } satisfies ValidationDetails,
            hints: skillHints,
          });
        }

        if (id.startsWith("local.")) {
          const handler = localHandlersDep[id];
          if (handler === undefined) {
            throw new StructuredError({
              code: "UNKNOWN_CAPABILITY",
              message: `no local handler registered for ${id}`,
              details: { id },
            });
          }
          const result = await handler({ input, handle, server });
          consl.outDataLn(result);
          return;
        }

        const connect = handle.capabilityJson.connect;
        if (connect === undefined) {
          throw new StructuredError({
            code: "SERVER_ERROR",
            message: `capability ${id} has no connect binding in its bundle`,
          });
        }

        const result = await callInvoke({ server, connect, input });
        consl.outDataLn(result);
      }),
  );

  return cmd;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ValidationDetails = {
  errors: Array<{
    field: string;
    issue: string;
    expected?: unknown;
    got?: unknown;
  }>;
};

// ---------------------------------------------------------------------------
// Exported helpers (none currently needed outside this file)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unexported helpers
// ---------------------------------------------------------------------------

function resolveEntry(
  capabilities: CapabilityEntry[],
  id: string,
): CapabilityEntry {
  const entry = capabilities.find((c) => c.id === id);
  if (entry === undefined) {
    throw new StructuredError({
      code: "UNKNOWN_CAPABILITY",
      message: `unknown capability: ${id}`,
      details: { id },
    });
  }
  return entry;
}

function buildShowOutput(handle: BundleHandle): Record<string, unknown> {
  // Spread capability.json (so RPC-only fields like scopes_required / connect
  // appear for RPCs and are absent for skills) and append the on-disk pointers.
  // Schemas are NOT inlined — agents read input_schema.json / output_schema.json
  // directly from `path` when they need them.
  return {
    ...handle.capabilityJson,
    path: handle.path,
    files: handle.files,
  } satisfies Record<string, unknown>;
}

async function parseJsonInput(
  raw: string | undefined,
  readStdin: () => Promise<string>,
  isStdinPiped: () => boolean,
): Promise<unknown> {
  let text: string;
  if (raw !== undefined) {
    text = raw;
  } else if (isStdinPiped()) {
    text = (await readStdin()).trim();
  } else {
    text = "";
  }

  if (text === "") return {};

  try {
    return JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StructuredError({
      code: "VALIDATION_FAILED",
      message: `input is not valid JSON: ${reason}`,
      details: { parsedtext: text },
    });
  }
}

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isStdinPipedDefault(): boolean {
  return process.stdin.isTTY === false || process.stdin.isTTY === undefined;
}
