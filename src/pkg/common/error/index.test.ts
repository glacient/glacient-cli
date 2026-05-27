import { describe, test, expect } from "bun:test";
import { fromConnectError, StructuredError } from "./index.ts";

describe("fromConnectError", () => {
  test("passes StructuredError through unchanged", () => {
    const original = new StructuredError({
      code: "NOT_FOUND",
      message: "x",
    });
    expect(fromConnectError(original)).toBe(original);
  });

  test("maps each documented Connect code", () => {
    const cases: Array<[string, string]> = [
      ["unauthenticated", "AUTH_REQUIRED"],
      ["permission_denied", "FORBIDDEN"],
      ["not_found", "NOT_FOUND"],
      ["invalid_argument", "VALIDATION_FAILED"],
      ["unavailable", "UNAVAILABLE"],
      ["internal", "SERVER_ERROR"],
      ["something_else", "SERVER_ERROR"],
    ];
    for (const [wire, expected] of cases) {
      const out = fromConnectError({ code: wire, message: "m" });
      expect(out.code).toBe(expected as StructuredError["code"]);
      expect(out.message).toBe("m");
    }
  });

  test("plain Error → NETWORK", () => {
    const out = fromConnectError(new TypeError("fetch failed"));
    expect(out.code).toBe("NETWORK");
    expect(out.message).toBe("fetch failed");
  });

  test("non-error primitives → UNKNOWN", () => {
    expect(fromConnectError(null).code).toBe("UNKNOWN");
    expect(fromConnectError(undefined).code).toBe("UNKNOWN");
    expect(fromConnectError("oops").code).toBe("UNKNOWN");
    expect(fromConnectError(42).code).toBe("UNKNOWN");
  });
});
