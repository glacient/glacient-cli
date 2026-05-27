export type ErrorCode =
  | "AUTH_REQUIRED"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NETWORK"
  | "UNAVAILABLE"
  | "SERVER_ERROR"
  | "MANIFEST_UNAVAILABLE"
  | "UNKNOWN_CAPABILITY"
  | "UNCALLABLE_CAPABILITY"
  | "UNKNOWN";

export interface ErrorHint {
  action: string;
  command?: string;
  code?: string;
}

export class StructuredError extends Error {
  code: ErrorCode;
  details?: unknown;
  hints?: ErrorHint[];

  constructor(args: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    hints?: ErrorHint[];
  }) {
    super(args.message);
    this.name = "StructuredError";
    this.code = args.code;
    this.details = args.details;
    this.hints = args.hints;
  }
}

export function fromConnectError(connErr: unknown): StructuredError {
  if (connErr instanceof StructuredError) {
    return connErr;
  }

  if (
    connErr !== null &&
    typeof connErr === "object" &&
    "code" in connErr &&
    "message" in connErr &&
    typeof (connErr as Record<string, unknown>)["code"] === "string" &&
    typeof (connErr as Record<string, unknown>)["message"] === "string"
  ) {
    const envelope = connErr as { code: string; message: string };
    let code: ErrorCode;
    switch (envelope.code) {
      case "unauthenticated":
        code = "AUTH_REQUIRED";
        break;
      case "permission_denied":
        code = "FORBIDDEN";
        break;
      case "not_found":
        code = "NOT_FOUND";
        break;
      case "invalid_argument":
        code = "VALIDATION_FAILED";
        break;
      case "unavailable":
        code = "UNAVAILABLE";
        break;
      case "internal":
      default:
        code = "SERVER_ERROR";
        break;
    }
    return new StructuredError({ code, message: envelope.message });
  }

  if (connErr instanceof Error) {
    return new StructuredError({ code: "NETWORK", message: connErr.message });
  }

  return new StructuredError({ code: "UNKNOWN", message: String(connErr) });
}

export function fromHttpError(status: number, url: string): StructuredError {
  if (status === 401) {
    return new StructuredError({
      code: "AUTH_REQUIRED",
      message: `unauthenticated request to ${url} — please re-authenticate`,
    });
  }
  if (status === 403) {
    return new StructuredError({
      code: "FORBIDDEN",
      message: `access denied to ${url}`,
    });
  }
  if (status === 404) {
    return new StructuredError({
      code: "NOT_FOUND",
      message: `not found: ${url}`,
    });
  }
  if (status >= 500) {
    return new StructuredError({
      code: "UNAVAILABLE",
      message: `server error ${status} from ${url}`,
    });
  }
  return new StructuredError({
    code: "SERVER_ERROR",
    message: `unexpected HTTP ${status} from ${url}`,
  });
}
