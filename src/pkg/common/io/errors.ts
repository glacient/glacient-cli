import {
  StructuredError,
  type ErrorCode,
  type ErrorHint,
} from "@/pkg/common/error";
import { consl } from "@/pkg/common/io/consl";

export function renderError(err: unknown, mode: "json" | "text"): void {
  let code: ErrorCode;
  let message: string;
  let details: unknown;
  let hints: ErrorHint[] | undefined;

  if (err instanceof StructuredError) {
    code = err.code;
    message = err.message;
    details = err.details;
    hints = err.hints;

    if (code === "AUTH_REQUIRED" && (!hints || hints.length === 0)) {
      hints = [AUTH_LOGIN_HINT];
    }
  } else if (err instanceof Error) {
    code = "UNKNOWN";
    message = err.message;
  } else {
    code = "UNKNOWN";
    message = String(err);
  }

  if (mode === "json") {
    const obj: Record<string, unknown> = { code, message };
    if (details !== undefined) obj["details"] = details;
    if (hints !== undefined && hints.length > 0) obj["hints"] = hints;
    consl.println(JSON.stringify(obj));
    return;
  }

  const lines: string[] = [`error: ${code}: ${message}`];
  if (details !== undefined) {
    lines.push(`  details: ${JSON.stringify(details)}`);
  }
  if (hints && hints.length > 0) {
    for (const hint of hints) {
      lines.push(`  hint: ${hint.action}`);
      if (hint.command) {
        lines.push(`        $ ${hint.command}`);
      }
    }
  }
  consl.println(lines.join("\n"));
}

const AUTH_LOGIN_HINT: ErrorHint = {
  action: "Authenticate by running glacient login",
  command: "glacient login",
};
