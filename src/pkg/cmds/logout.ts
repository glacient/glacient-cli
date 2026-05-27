import { Command } from "commander";
import { ErrNoCreds, load, remove } from "@/pkg/config/cred-store.ts";
import { getServerUrl } from "@/pkg/config";
import { consl } from "@/pkg/common/io/consl";

export const logoutCommand = new Command("logout")
  .description("sign out and remove local credentials")
  .action(async () => {
    let creds;
    try {
      creds = await load();
    } catch (err) {
      if (err === ErrNoCreds) {
        consl.println("Not logged in.");
        return;
      }
      throw err;
    }

    const server = await getServerUrl();
    try {
      await fetch(`${server}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.access_token}` },
      });
    } catch {
      // best-effort
    }

    await remove();
    consl.println("Signed out.");
  });
