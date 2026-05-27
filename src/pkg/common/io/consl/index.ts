import * as readline from "readline/promises";

let rl: readline.Interface | null = null;

function getRl(): readline.Interface {
  if (rl === null) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
  }
  return rl;
}

export const consl = {
  println: (s: string) => process.stderr.write(`${s}\n`),
  openBrowser: async (url: string): Promise<void> => {
    const open = (await import("open")).default;
    await open(url);
  },
  outDataLn: (data: unknown): void => {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  },
  outBasicData: (
    mode: "json" | "text",
    data: Record<string, unknown>,
  ): void => {
    if (mode === "json") {
      process.stdout.write(`${JSON.stringify(data)}\n`);
      return;
    }
    for (const [k, v] of Object.entries(data)) {
      process.stdout.write(`${k}: ${v}\n`);
    }
  },
};

export const prompt = {
  askEnter: async (s: string): Promise<void> => {
    await getRl().question(s);
  },
  askResp: (s: string): Promise<string> => getRl().question(s),
  close: (): void => {
    if (rl !== null) {
      rl.close();
      rl = null;
    }
  },
};

export type Consl = typeof consl;
export type Prompt = typeof prompt;
