import { Command } from "commander";
import { getOutputMode } from "@/pkg/config";
import { consl } from "@/pkg/common/io/consl";
// Inlined at build time by the bundler, so it matches the published version.
// eslint-disable-next-line no-restricted-imports -- repo-root package.json has no `@/` alias
import pkg from "../../../package.json" with { type: "json" };

export const versionCommand = new Command("version")
  .description("print the CLI version")
  .action(async () => {
    const output = await getOutputMode();
    consl.outBasicData(output, { version: pkg.version });
  });
