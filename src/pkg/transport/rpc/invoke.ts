/**
 * Minimal Connect HTTP/JSON unary invoker.
 *
 * Implements the Connect unary-request wire protocol directly via `fetch`
 * without importing @connectrpc/connect or any Connect runtime package.
 *
 * Connect protocol reference:
 *   https://connectrpc.com/docs/protocol#unary-request
 *
 * Auth is provided by `src/pkg/auth/session.ts`. We rely on
 * `ensureFreshAccessToken`'s 60s-near-expiry refresh; no in-line retry on 401.
 */

import { ensureFreshAccessToken } from "@/pkg/auth/session.ts";
import type { ConnectBinding } from "@/pkg/manifest";
import { fromConnectError, StructuredError } from "@/pkg/common/error";

export interface InvokeOpts {
  /** Base server URL, e.g. "https://auth.glacient.tech" */
  server: string;
  /** Connect service + method from the capability manifest. */
  connect: ConnectBinding;
  /** Request JSON (will be JSON.stringify'd). */
  input: unknown;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Execute a unary Connect call. Returns the parsed response JSON on success.
 *
 * On Connect wire errors (non-2xx with `{code,message}` JSON body) throws a
 * `StructuredError` mapped from the Connect envelope. Transport failures
 * surface as `NETWORK`; non-Connect HTTP responses surface as `SERVER_ERROR`.
 */
export async function invoke(opts: InvokeOpts): Promise<unknown> {
  const { server, connect, input, signal } = opts;
  const prefix = connect.path_prefix ?? "";
  const url = `${server}${prefix}/${connect.service}/${connect.method}`;
  const token = await ensureFreshAccessToken();

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal,
    });
  } catch (err) {
    throw new StructuredError({
      code: "NETWORK",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (response.ok) {
    if (!isJson) return null;
    const text = await response.text();
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  }

  if (isJson) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new StructuredError({
        code: "SERVER_ERROR",
        message: `HTTP ${response.status} (non-Connect response)`,
      });
    }
    if (isConnectEnvelope(parsed)) {
      throw fromConnectError(parsed);
    }
  }

  throw new StructuredError({
    code: "SERVER_ERROR",
    message: `HTTP ${response.status} (non-Connect response)`,
  });
}

interface ConnectEnvelope {
  code: string;
  message: string;
}

function isConnectEnvelope(v: unknown): v is ConnectEnvelope {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>)["code"] === "string" &&
    typeof (v as Record<string, unknown>)["message"] === "string"
  );
}
