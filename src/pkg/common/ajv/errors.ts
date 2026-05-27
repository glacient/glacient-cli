import type Ajv from "ajv";

/**
 * Build a JSON-pointer-style field string from an Ajv error.
 *
 * For `required` errors, ajv sets `instancePath` to the parent object and
 * `params.missingProperty` to the missing key name. We construct the full
 * pointer as `instancePath + "/" + missingProperty`, then normalize the
 * leading slash.
 *
 * For all other errors, `instancePath` is already the full pointer.
 *
 * The returned value always starts with `/` (e.g. `/project_id`).
 */
export function buildField(error: Ajv["errors"] extends Array<infer E> | null | undefined ? E : never): string {
  const params = error.params as Record<string, unknown>;
  if (
    error.keyword === "required" &&
    typeof params["missingProperty"] === "string"
  ) {
    const base = error.instancePath ?? "";
    const missing = params["missingProperty"];
    const joined = base === "" ? `/${missing}` : `${base}/${missing}`;
    return joined;
  }
  const ip = error.instancePath ?? "";
  return ip === "" ? "/" : ip;
}

/**
 * Walk a JSON pointer string to retrieve the value at that path in `obj`.
 * Returns `undefined` if any segment is missing or the pointer is invalid.
 *
 * Pointer format: `"/"` is root; `"/foo/bar"` is obj.foo.bar.
 */
export function resolveFieldValue(pointer: string, obj: unknown): unknown {
  if (pointer === "/" || pointer === "") return obj;
  const segments = pointer.replace(/^\//, "").split("/");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}
