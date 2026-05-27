import { Command } from "commander";
import { ErrNoCreds, load } from "@/pkg/config/cred-store.ts";
import { getOutputMode, getServerUrl } from "@/pkg/config";
import { consl } from "@/pkg/common/io/consl";
import { StructuredError } from "@/pkg/common/error";

export const whoamiCommand = new Command("whoami")
  .description("print the currently signed-in handle")
  .option("--verbose", "also print user_id")
  .action(async (opts: { verbose?: boolean }) => {
    let creds;
    try {
      creds = await load();
    } catch (err) {
      if (err === ErrNoCreds) {
        throw new StructuredError({
          code: "AUTH_REQUIRED",
          message: "not logged in",
        });
      }
      throw err;
    }

    const output = await getOutputMode();
    const data: Record<string, unknown> = {
      server: await getServerUrl(),
      handle: creds.claims.handle,
    };
    if (output === "json" || opts.verbose) {
      data["user_id"] = creds.claims.user_id;
    }
    consl.outBasicData(output, data);
  });
