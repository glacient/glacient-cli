import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { renderError } from "./errors.ts";
import { StructuredError } from "@/pkg/common/error";

const origStderrWrite = process.stderr.write.bind(process.stderr);
let stderrBuf: string[];

beforeEach(() => {
  stderrBuf = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    stderrBuf.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
});

describe("renderError json mode", () => {
  test("emits {code,message} only when details/hints absent", () => {
    renderError(
      new StructuredError({ code: "NOT_FOUND", message: "missing" }),
      "json",
    );
    expect(stderrBuf.join("")).toBe(
      `${JSON.stringify({ code: "NOT_FOUND", message: "missing" })}\n`,
    );
  });

  test("includes details and hints when set", () => {
    renderError(
      new StructuredError({
        code: "VALIDATION_FAILED",
        message: "bad input",
        details: [{ path: "/id", reason: "required" }],
        hints: [{ action: "add id", command: "echo" }],
      }),
      "json",
    );
    const parsed = JSON.parse(stderrBuf.join("").trim());
    expect(parsed).toEqual({
      code: "VALIDATION_FAILED",
      message: "bad input",
      details: [{ path: "/id", reason: "required" }],
      hints: [{ action: "add id", command: "echo" }],
    });
  });

  test("AUTH_REQUIRED without hints synthesizes the login hint", () => {
    renderError(
      new StructuredError({ code: "AUTH_REQUIRED", message: "not logged in" }),
      "json",
    );
    const parsed = JSON.parse(stderrBuf.join("").trim());
    expect(parsed["hints"]).toEqual([
      {
        action: "Authenticate by running glacient login",
        command: "glacient login",
      },
    ]);
  });

  test("non-StructuredError Error becomes UNKNOWN with its message", () => {
    renderError(new Error("boom"), "json");
    expect(JSON.parse(stderrBuf.join("").trim())).toEqual({
      code: "UNKNOWN",
      message: "boom",
    });
  });

  test("non-error primitive becomes UNKNOWN with stringified value", () => {
    renderError("oops", "json");
    expect(JSON.parse(stderrBuf.join("").trim())).toEqual({
      code: "UNKNOWN",
      message: "oops",
    });
  });
});

describe("renderError text mode", () => {
  test("formats code/message and details/hints", () => {
    renderError(
      new StructuredError({
        code: "VALIDATION_FAILED",
        message: "bad input",
        details: { key: "x" },
        hints: [{ action: "fix it", command: "glacient fix" }],
      }),
      "text",
    );
    expect(stderrBuf.join("")).toBe(
      `error: VALIDATION_FAILED: bad input\n` +
        `  details: ${JSON.stringify({ key: "x" })}\n` +
        `  hint: fix it\n` +
        `        $ glacient fix\n`,
    );
  });

  test("AUTH_REQUIRED text mode synthesizes login hint", () => {
    renderError(
      new StructuredError({ code: "AUTH_REQUIRED", message: "not logged in" }),
      "text",
    );
    expect(stderrBuf.join("")).toBe(
      `error: AUTH_REQUIRED: not logged in\n` +
        `  hint: Authenticate by running glacient login\n` +
        `        $ glacient login\n`,
    );
  });
});
