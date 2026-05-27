import { Command } from "commander";
import {
  type Config,
  ErrNoConfig,
  load,
  save,
} from "@/pkg/config/config-store.ts";
import { getOutputMode, isValidOutputFlag } from "@/pkg/config";
import { consl } from "@/pkg/common/io/consl";
import { StructuredError } from "@/pkg/common/error";

export const configCommand = new Command("config")
  .description("inspect and modify persisted CLI config")
  .action(async () => {
    const cfg = await loadOrEmpty();
    const data: Record<string, unknown> = {};
    if (cfg["server-url"] !== undefined) data["server-url"] = cfg["server-url"];
    if (cfg["output-mode"] !== undefined) data["output-mode"] = cfg["output-mode"];
    consl.outBasicData(await getOutputMode(), data);
  })
  .addCommand(
    new Command("set")
      .description("persist a config value")
      .argument("<key>", "server-url | output-mode")
      .argument("<value>")
      .action(async (key: string, value: string) => {
        const current = await loadOrEmpty();
        const next: Config = await applySet(current, key, value);
        await save(next);
        const mode = await getOutputMode();
        const written: Record<string, unknown> = {};
        if (next["server-url"] !== undefined) written["server-url"] = next["server-url"];
        if (next["output-mode"] !== undefined) written["output-mode"] = next["output-mode"];
        consl.outBasicData(mode, written);
      }),
  );

async function loadOrEmpty(): Promise<Config> {
  try {
    return await load();
  } catch (err) {
    if (err === ErrNoConfig) return {};
    throw err;
  }
}

async function applySet(
  current: Config,
  key: string,
  value: string,
): Promise<Config> {
  switch (key) {
    case "server-url": {
      const trimmed = value.trim();
      if (trimmed === "") {
        throw new StructuredError({
          code: "VALIDATION_FAILED",
          message: "server-url cannot be empty",
          details: { key, value },
        });
      }
      return { ...current, "server-url": trimmed };
    }
    case "output-mode": {
      if (!isValidOutputFlag(value)) {
        throw new StructuredError({
          code: "VALIDATION_FAILED",
          message: `invalid output-mode: ${value} (expected "json" or "text")`,
          details: { key, value },
        });
      }
      return { ...current, "output-mode": value };
    }
    default:
      throw new StructuredError({
        code: "VALIDATION_FAILED",
        message: `unknown key: ${key} (expected server-url | output-mode)`,
        details: { key, value },
      });
  }
}
