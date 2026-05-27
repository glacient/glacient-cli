import { Command } from "commander";
import { type CredStore, save as saveCreds } from "@/pkg/config/cred-store.ts";
import { getServerUrl } from "@/pkg/config";
import { consl, prompt } from "@/pkg/common/io/consl";
import { StructuredError } from "@/pkg/common/error";

type InitResponse = {
  cli_init_token: string;
  verification_url: string;
  expires_at: string;
};

type PollResponse = {
  status: "done" | "missing_code" | "invalid_code" | "expired";
  access_token?: string;
  refresh_token?: string;
  handle?: string;
};

const MAX_ATTEMPTS = 3;

export const loginCommand = new Command("login")
  .description("authenticate with the glacient server")
  .action(async () => {
    const server = await getServerUrl();
    const partial = await interactLogin(server);
    const creds = await saveCreds(partial);
    consl.println(
      `Authentication successful, signed in as ${creds.claims.handle}`,
    );
  });

async function interactLogin(serverUrl: string): Promise<CredStore> {
  try {
    const initUrl = `${serverUrl}/auth/cli/init`;
    let initResp: Response;
    try {
      initResp = await fetch(initUrl, { method: "POST" });
    } catch (err) {
      throw new StructuredError({
        code: "NETWORK",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (!initResp.ok) {
      const body = await initResp.text().catch(() => "");
      throw new StructuredError({
        code: "SERVER_ERROR",
        message: `failed to start login: POST ${initUrl} returned ${initResp.status} ${initResp.statusText}`,
        details: {
          initUrl,
          status: initResp.status,
          statusText: initResp.statusText,
          body: body.slice(0, 500),
        },
      });
    }
    const init = (await initResp.json()) as InitResponse;

    consl.println("Open this URL to sign in:\n  " + init.verification_url);
    await prompt.askEnter("Press Enter to open it in your browser... ");
    await consl.openBrowser(init.verification_url);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; ) {
      if (Date.parse(init.expires_at) <= Date.now()) {
        throw new StructuredError({
          code: "AUTH_REQUIRED",
          message: "session expired, please run `glacient login` again",
        });
      }

      const code = (
        await prompt.askResp(
          "Enter the confirmation code shown in the browser: ",
        )
      ).trim();

      if (code === "") {
        consl.println("Code can't be empty.");
        continue;
      }

      const pollResp = await fetch(`${serverUrl}/auth/cli/poll`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${init.cli_init_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation_code: code }),
      });
      const poll = (await pollResp.json()) as PollResponse;

      switch (poll.status) {
        case "done":
          return {
            access_token: poll.access_token!,
            refresh_token: poll.refresh_token!,
          } satisfies CredStore;
        case "invalid_code":
          consl.println("That code didn't match. Try again.");
          attempt++;
          continue;
        case "missing_code":
          consl.println("Code can't be empty.");
          continue;
        case "expired":
          throw new Error(
            "session expired, please run `glacient login` again",
          );
      }
    }

    throw new StructuredError({
      code: "AUTH_REQUIRED",
      message: "too many incorrect code attempts",
    });
  } finally {
    prompt.close();
  }
}
