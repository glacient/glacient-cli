#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { capabilitiesCommand } from "./pkg/cmds/capabilities";
import { configCommand } from "./pkg/cmds/config.ts";
import { loginCommand } from "./pkg/cmds/login.ts";
import { logoutCommand } from "./pkg/cmds/logout.ts";
import { versionCommand } from "./pkg/cmds/version.ts";
import { whoamiCommand } from "./pkg/cmds/whoami.ts";
import { cacheOutputMode, getOutputMode, isValidOutputFlag } from "./pkg/config";
import { renderError } from "./pkg/common/io/errors.ts";

async function main(): Promise<void> {
  const program = new Command()
    .name("glacient")
    .description("CLI for glacient")
    .option(
      "--output <mode>",
      "output mode: json or text (default: auto by TTY)",
      (value) => {
        if (!isValidOutputFlag(value)) {
          throw new InvalidArgumentError(
            `expected "json" or "text", got "${value}"`,
          );
        }
        return value;
      },
    )
    .hook("preAction", (thisCommand) => {
      cacheOutputMode(thisCommand.opts().output);
    });

  program.addCommand(capabilitiesCommand);
  program.addCommand(configCommand);
  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(versionCommand);
  program.addCommand(whoamiCommand);

  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (err) {
  const mode = await getOutputMode().catch(() => "json" as const);
  renderError(err, mode);
  process.exit(1);
}
