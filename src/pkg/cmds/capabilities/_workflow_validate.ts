import fs from "node:fs/promises";
import type { ErrorHint } from "@/pkg/common/error";
import { ajv } from "@/pkg/common/ajv";
import { buildField, resolveFieldValue } from "@/pkg/common/ajv/errors";
import type {
  LocalHandler,
  LocalHandlerResult,
} from "./_local_handlers";

type ValidateError = LocalHandlerResult["errors"][number];

type Catalog = {
  operators: Array<{ id: string; aliases?: string[] }>;
  fields: Array<{ id: string }>;
  collections: Array<{ id: string; fields?: string[] }>;
  transformers: Array<{ id: string; args?: Array<{ name: string; required?: boolean }> }>;
  actions: Array<{
    id: string;
    input_args?: Array<{ name: string; required?: boolean }>;
  }>;
};

type Input = {
  catalogUri: string;
  schemaUri: string;
  workflow_data: unknown;
};

export const workflowValidateHandler: LocalHandler = async (ctx) => {
  const params = ctx.input as Input;
  const errors: ValidateError[] = [];
  const hints: ErrorHint[] = [];

  // Reject remote URIs — this iteration only supports local file paths.
  let badUri = false;
  if (params.catalogUri.includes("://")) {
    errors.push({
      field: "/catalogUri",
      issue: "invalid_uri",
      got: params.catalogUri,
    });
    addHint(hints, {
      action: "Use a local file path; only local paths are supported in this iteration.",
    });
    badUri = true;
  }
  if (params.schemaUri.includes("://")) {
    errors.push({
      field: "/schemaUri",
      issue: "invalid_uri",
      got: params.schemaUri,
    });
    addHint(hints, {
      action: "Use a local file path; only local paths are supported in this iteration.",
    });
    badUri = true;
  }
  if (badUri) return { valid: false, errors, hints };

  let catalog: Catalog;
  let schema: object;
  try {
    const raw = await fs.readFile(params.catalogUri, "utf8");
    catalog = JSON.parse(raw) as Catalog;
  } catch {
    errors.push({ field: "/catalogUri", issue: "unreadable", got: params.catalogUri });
    addHint(hints, {
      action: "Fetch ref.workflow.components bundle and use its catalog.json / schema.json",
      command: "glacient capabilities show ref.workflow.components",
    });
    return { valid: false, errors, hints };
  }
  try {
    const raw = await fs.readFile(params.schemaUri, "utf8");
    schema = JSON.parse(raw) as object;
  } catch {
    errors.push({ field: "/schemaUri", issue: "unreadable", got: params.schemaUri });
    addHint(hints, {
      action: "Fetch ref.workflow.components bundle and use its catalog.json / schema.json",
      command: "glacient capabilities show ref.workflow.components",
    });
    return { valid: false, errors, hints };
  }

  let workflow_data: unknown = params.workflow_data;
  if (typeof workflow_data === "string") {
    try {
      workflow_data = JSON.parse(workflow_data);
    } catch {
      errors.push({
        field: "/workflow_data",
        issue: "invalid_json",
        got: params.workflow_data,
      });
      return { valid: false, errors, hints };
    }
  }

  const validate = ajv.compile(schema);
  if (!validate(workflow_data)) {
    for (const e of validate.errors ?? []) {
      const field = buildField(e);
      const got = resolveFieldValue(field, workflow_data);
      errors.push({
        field,
        issue: e.keyword,
        expected: e.params as unknown,
        ...(got !== undefined ? { got } : {}),
      });
    }
  }

  // Catalog cross-checks only run when workflow_data has the expected shape.
  if (workflow_data !== null && typeof workflow_data === "object") {
    crossCheckCatalog(workflow_data, catalog, errors, hints);
  }

  return { valid: errors.length === 0, errors, hints };
};

// --- internal helpers below ---

function crossCheckCatalog(
  workflow: unknown,
  catalog: Catalog,
  errors: ValidateError[],
  hints: ErrorHint[],
): void {
  if (workflow === null || typeof workflow !== "object") return;
  const c = workflow as Record<string, unknown>;

  const collectionIds = (catalog.collections ?? []).map((x) => x.id);
  const fieldIds = (catalog.fields ?? []).map((x) => x.id);
  const transformerIds = (catalog.transformers ?? []).map((x) => x.id);
  const actionIds = (catalog.actions ?? []).map((x) => x.id);
  // Operators may be referenced by canonical id or by any alias; flatten both
  // into a single set, but suggestions only list canonical ids.
  const operatorCanonical = (catalog.operators ?? []).map((x) => x.id);
  const operatorMatch = new Set<string>();
  for (const op of catalog.operators ?? []) {
    operatorMatch.add(op.id);
    for (const a of op.aliases ?? []) operatorMatch.add(a);
  }

  const transformerById = new Map(catalog.transformers?.map((t) => [t.id, t]) ?? []);
  const actionById = new Map(catalog.actions?.map((a) => [a.id, a]) ?? []);

  // Collections
  const collections = asArray(c["Collections"]);
  collections.forEach((coll, i) => {
    if (coll === null || typeof coll !== "object") return;
    const from = (coll as Record<string, unknown>)["From"];
    if (typeof from === "string" && !collectionIds.includes(from)) {
      pushUnknown(
        errors, hints,
        `/Collections/${i}/From`,
        "unknown_collection", from, "collection", collectionIds,
      );
    }
    const conds = asArray((coll as Record<string, unknown>)["Conditions"]);
    conds.forEach((cond, j) => {
      checkCondition(
        cond,
        `/Collections/${i}/Conditions/${j}`,
        fieldIds, operatorMatch, operatorCanonical,
        errors, hints,
      );
    });
  });

  // Transformers
  const transformers = asArray(c["Transformers"]);
  // A transformer's `From` points at the *label* of an upstream node — either a
  // declared collection or another transformer. Nodes wire together into a DAG,
  // so resolve `From` against the set of declared labels, not catalog collection
  // ids (a collection's own `From` is the catalog id; a transformer's is not).
  const declaredLabels = new Set<string>();
  for (const node of [...collections, ...transformers]) {
    if (node !== null && typeof node === "object") {
      const label = (node as Record<string, unknown>)["Label"];
      if (typeof label === "string") declaredLabels.add(label);
    }
  }
  const declaredLabelList = [...declaredLabels];
  transformers.forEach((tf, i) => {
    if (tf === null || typeof tf !== "object") return;
    const o = tf as Record<string, unknown>;
    const fromArr = asArray(o["From"]);
    fromArr.forEach((src, j) => {
      if (typeof src === "string" && !declaredLabels.has(src)) {
        pushUnknown(
          errors, hints,
          `/Transformers/${i}/From/${j}`,
          "unknown_label", src, "upstream label", declaredLabelList,
        );
      }
    });
    const typeId = o["Type"];
    let matchedTransformer: Catalog["transformers"][number] | undefined;
    if (typeof typeId === "string") {
      if (!transformerIds.includes(typeId)) {
        pushUnknown(
          errors, hints,
          `/Transformers/${i}/Type`,
          "unknown_transformer", typeId, "transformer", transformerIds,
        );
      } else {
        matchedTransformer = transformerById.get(typeId);
      }
    }
    const args = asArray(o["Args"]);
    const argNames = new Set<string>();
    args.forEach((arg, k) => {
      if (arg === null || typeof arg !== "object") return;
      const name = (arg as Record<string, unknown>)["Name"];
      if (typeof name !== "string") return;
      argNames.add(name);
      if (matchedTransformer) {
        const allowed = (matchedTransformer.args ?? []).map((a) => a.name);
        if (!allowed.includes(name)) {
          pushUnknown(
            errors, hints,
            `/Transformers/${i}/Args/${k}/Name`,
            "unknown_transformer_arg", name, "transformer arg", allowed,
          );
        }
      }
    });
    if (matchedTransformer) {
      for (const a of matchedTransformer.args ?? []) {
        if (a.required && !argNames.has(a.name)) {
          errors.push({
            field: `/Transformers/${i}/Args`,
            issue: "missing_required_arg",
            expected: a.name,
          });
          addHint(hints, { action: "Provide the required arg" });
        }
      }
    }
  });

  // Actions
  const actions = asArray(c["Actions"]);
  actions.forEach((act, i) => {
    if (act === null || typeof act !== "object") return;
    const o = act as Record<string, unknown>;
    const name = o["Name"];
    let matchedAction: Catalog["actions"][number] | undefined;
    if (typeof name === "string") {
      if (!actionIds.includes(name)) {
        pushUnknown(
          errors, hints,
          `/Actions/${i}/Name`,
          "unknown_action", name, "action", actionIds,
        );
      } else {
        matchedAction = actionById.get(name);
      }
    }
    const args = asArray(o["Args"]);
    const argNames = new Set<string>();
    args.forEach((arg, k) => {
      if (arg === null || typeof arg !== "object") return;
      const aName = (arg as Record<string, unknown>)["Name"];
      if (typeof aName !== "string") return;
      argNames.add(aName);
      if (matchedAction) {
        const allowed = (matchedAction.input_args ?? []).map((a) => a.name);
        if (!allowed.includes(aName)) {
          pushUnknown(
            errors, hints,
            `/Actions/${i}/Args/${k}/Name`,
            "unknown_action_arg", aName, "action arg", allowed,
          );
        }
      }
    });
    if (matchedAction) {
      for (const a of matchedAction.input_args ?? []) {
        if (a.required && !argNames.has(a.name)) {
          errors.push({
            field: `/Actions/${i}/Args`,
            issue: "missing_required_arg",
            expected: a.name,
          });
          addHint(hints, { action: "Provide the required arg" });
        }
      }
    }
  });
}

function checkCondition(
  cond: unknown,
  base: string,
  fieldIds: string[],
  operatorMatch: Set<string>,
  operatorCanonical: string[],
  errors: ValidateError[],
  hints: ErrorHint[],
): void {
  if (cond === null || typeof cond !== "object") return;
  const o = cond as Record<string, unknown>;
  const f = o["Field"];
  if (typeof f === "string" && !fieldIds.includes(f)) {
    pushUnknown(
      errors, hints,
      `${base}/Field`,
      "unknown_field", f, "field", fieldIds,
    );
  }
  const op = o["Op"];
  if (typeof op === "string" && !operatorMatch.has(op)) {
    pushUnknown(
      errors, hints,
      `${base}/Op`,
      "unknown_operator", op, "operator", operatorCanonical,
    );
  }
}

function pushUnknown(
  errors: ValidateError[],
  hints: ErrorHint[],
  field: string,
  issue: string,
  got: string,
  kind: string,
  candidates: string[],
): void {
  errors.push({ field, issue, got });
  const suggestions = nearest(got, candidates);
  const hint: ErrorHint = {
    action: `Use one of the available ${kind} ids`,
    ...(suggestions.length > 0 ? { code: suggestions.join(", ") } : {}),
  };
  addHint(hints, hint);
}

// Dedup key is (action, code) — same suggestion list for the same kind of
// mistake should only print once even if it happens at multiple paths.
function addHint(hints: ErrorHint[], hint: ErrorHint): void {
  const code = hint.code;
  const key = `${hint.action} ${typeof code === "string" ? code : ""}`;
  for (const existing of hints) {
    const ec = existing.code;
    const ek = `${existing.action} ${typeof ec === "string" ? ec : ""}`;
    if (ek === key) return;
  }
  hints.push(hint);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// Simple deterministic ranking: substring matches first, then prefix matches,
// then alphabetical proximity. Caps at n results.
function nearest(target: string, candidates: string[], n = 3): string[] {
  const t = target.toLowerCase();
  const scored = candidates.map((c) => {
    const lc = c.toLowerCase();
    let score = 0;
    if (lc === t) score = 0;
    else if (lc.startsWith(t) || t.startsWith(lc)) score = 1;
    else if (lc.includes(t) || t.includes(lc)) score = 2;
    else score = 3;
    return { c, score };
  });
  scored.sort((a, b) => a.score - b.score || a.c.localeCompare(b.c));
  return scored.slice(0, n).map((s) => s.c);
}
