import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BundleHandle } from "@/pkg/bundles";
import { workflowValidateHandler } from "./_workflow_validate";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const catalogFixture = {
  schema_version: "1",
  value_types: ["string", "number"],
  operators: [
    { id: "gte", aliases: [">="], arity: 2 },
    { id: "eq", aliases: ["==", "="], arity: 2 },
  ],
  fields: [
    { id: "user.age", value_type: "number" },
    { id: "user.country", value_type: "string" },
    { id: "user.email", value_type: "string" },
  ],
  collections: [
    { id: "users", fields: ["user.age", "user.country", "user.email"] },
    { id: "orders", fields: [] },
  ],
  transformers: [
    {
      id: "by_country",
      args: [
        { name: "country", type: "string", required: true },
        { name: "limit", type: "number", required: false },
      ],
    },
  ],
  actions: [
    {
      id: "notify",
      input_args: [
        { name: "message", type: "string", required: true },
        { name: "channel", type: "string", required: false },
      ],
    },
    {
      id: "tag",
      input_args: [{ name: "label", type: "string", required: false }],
    },
  ],
};

// Minimal schema mirroring the generator output: a flat Workflow object with
// Collections / Transformers / Actions arrays. Collections is marked required
// so the schema-failure test has something to assert against.
const schemaFixture = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["Collections"],
  properties: {
    Collections: { type: "array" },
    Transformers: { type: "array" },
    Actions: { type: "array" },
  },
};

const minimalWorkflow = {
  Collections: [],
  Transformers: [],
  Actions: [],
};

let tmpdir: string;
let catalogPath: string;
let schemaPath: string;

// stub handle: the handler doesn't actually read from it (only uses ctx.input)
const stubHandle = {
  path: "",
  files: [],
  capabilityJson: {
    id: "local.workflow.validate",
    version: "1",
    summary: "",
    related_capabilities: [],
    deprecated: false,
  },
} satisfies BundleHandle;

beforeAll(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "glacient-wfval-"));
  catalogPath = path.join(tmpdir, "catalog.json");
  schemaPath = path.join(tmpdir, "schema.json");
  await fs.writeFile(catalogPath, JSON.stringify(catalogFixture));
  await fs.writeFile(schemaPath, JSON.stringify(schemaFixture));
});

afterAll(async () => {
  await fs.rm(tmpdir, { recursive: true, force: true });
});

async function run(input: unknown) {
  return workflowValidateHandler({
    input,
    handle: stubHandle,
    server: "http://test",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflowValidateHandler", () => {
  test("happy path: minimal valid workflow", async () => {
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: minimalWorkflow,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.hints).toEqual([]);
  });

  test("schema-only failure: missing required Collections", async () => {
    const bad = { ...minimalWorkflow };
    // Drop Collections key entirely
    delete (bad as Record<string, unknown>)["Collections"];
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: bad,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "/Collections");
    expect(err).toBeDefined();
    expect(err?.issue).toBe("required");
  });

  test("unknown field in Condition", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [
        {
          Label: "c1",
          From: "users",
          Conditions: [{ Field: "user.zip", Op: "eq", Value: "12345" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.field === "/Collections/0/Conditions/0/Field",
    );
    expect(err).toBeDefined();
    expect(err?.issue).toBe("unknown_field");
    const hint = result.hints.find((h) =>
      h.action.includes("field"),
    ) as { action: string; code?: string } | undefined;
    expect(hint).toBeDefined();
    expect(hint?.code).toBeDefined();
    // Should list catalog fields as candidates
    expect(hint?.code).toContain("user.");
  });

  test("unknown operator (canonical, no alias match)", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [
        {
          Label: "c1",
          From: "users",
          Conditions: [{ Field: "user.age", Op: "~~~", Value: "1" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.field === "/Collections/0/Conditions/0/Op",
    );
    expect(err?.issue).toBe("unknown_operator");
    const hint = result.hints.find((h) =>
      h.action.includes("operator"),
    ) as { action: string; code?: string } | undefined;
    expect(hint?.code).toBeDefined();
  });

  test("operator alias is accepted", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [
        {
          Label: "c1",
          From: "users",
          Conditions: [{ Field: "user.age", Op: ">=", Value: "18" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("unknown transformer type", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [{ Label: "users", From: "users", Conditions: [] }],
      Transformers: [
        { Label: "t1", From: ["users"], Type: "no_such_transformer", Args: [] },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "/Transformers/0/Type");
    expect(err?.issue).toBe("unknown_transformer");
    const hint = result.hints.find((h) =>
      h.action.includes("transformer"),
    ) as { action: string; code?: string } | undefined;
    expect(hint).toBeDefined();
  });

  test("unknown transformer arg", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [{ Label: "users", From: "users", Conditions: [] }],
      Transformers: [
        {
          Label: "t1",
          From: ["users"],
          Type: "by_country",
          Args: [
            { Name: "country", Value: "US" },
            { Name: "bogus_arg", Value: "x" },
          ],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.field === "/Transformers/0/Args/1/Name",
    );
    expect(err?.issue).toBe("unknown_transformer_arg");
    const hint = result.hints.find((h) =>
      h.action.includes("transformer arg"),
    ) as { action: string; code?: string } | undefined;
    expect(hint?.code).toBeDefined();
  });

  test("missing required transformer arg", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [{ Label: "users", From: "users", Conditions: [] }],
      Transformers: [
        {
          Label: "t1",
          From: ["users"],
          Type: "by_country",
          Args: [{ Name: "limit", Value: "10" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) =>
        e.field === "/Transformers/0/Args" &&
        e.issue === "missing_required_arg",
    );
    expect(err).toBeDefined();
    expect(err?.expected).toBe("country");
  });

  test("transformer From referencing an unknown label", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [{ Label: "users", From: "users", Conditions: [] }],
      Transformers: [
        {
          Label: "t1",
          From: ["nope"],
          Type: "by_country",
          Args: [{ Name: "country", Value: "US" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.field === "/Transformers/0/From/0",
    );
    expect(err?.issue).toBe("unknown_label");
    expect(err?.got).toBe("nope");
    // Suggestions should list declared labels (the collection + transformer).
    const hint = result.hints.find((h) => h.action.includes("label")) as
      | { action: string; code?: string }
      | undefined;
    expect(hint?.code).toContain("users");
  });

  test("transformer From may reference another transformer label (DAG)", async () => {
    const data = {
      ...minimalWorkflow,
      Collections: [{ Label: "users", From: "users", Conditions: [] }],
      Transformers: [
        {
          Label: "t1",
          From: ["users"],
          Type: "by_country",
          Args: [{ Name: "country", Value: "US" }],
        },
        {
          Label: "t2",
          From: ["t1"],
          Type: "by_country",
          Args: [{ Name: "country", Value: "US" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("unknown action", async () => {
    const data = {
      ...minimalWorkflow,
      Actions: [{ Label: "a1", Name: "no_such_action", Args: [] }],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "/Actions/0/Name");
    expect(err?.issue).toBe("unknown_action");
    const hint = result.hints.find((h) =>
      h.action.includes("action"),
    ) as { action: string; code?: string } | undefined;
    expect(hint?.code).toBeDefined();
  });

  test("unknown action arg", async () => {
    const data = {
      ...minimalWorkflow,
      Actions: [
        {
          Label: "a1",
          Name: "notify",
          Args: [
            { Name: "message", Value: "hi" },
            { Name: "bogus_arg", Value: "x" },
          ],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.field === "/Actions/0/Args/1/Name",
    );
    expect(err?.issue).toBe("unknown_action_arg");
    const hint = result.hints.find((h) =>
      h.action.includes("action arg"),
    ) as { action: string; code?: string } | undefined;
    expect(hint?.code).toBeDefined();
  });

  test("missing required action arg", async () => {
    const data = {
      ...minimalWorkflow,
      Actions: [
        {
          Label: "a1",
          Name: "notify",
          Args: [{ Name: "channel", Value: "email" }],
        },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) =>
        e.field === "/Actions/0/Args" &&
        e.issue === "missing_required_arg",
    );
    expect(err).toBeDefined();
    expect(err?.expected).toBe("message");
  });

  test("workflow_data as JSON string is parsed", async () => {
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: JSON.stringify(minimalWorkflow),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("bad catalogUri path: handler reports unreadable, does not crash", async () => {
    const result = await run({
      catalogUri: path.join(tmpdir, "missing-catalog.json"),
      schemaUri: schemaPath,
      workflow_data: minimalWorkflow,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "/catalogUri");
    expect(err?.issue).toBe("unreadable");
    const hint = result.hints.find((h) =>
      h.command === "glacient capabilities show ref.workflow.components",
    );
    expect(hint).toBeDefined();
  });

  test("remote URI is rejected", async () => {
    const result = await run({
      catalogUri: "https://evil.com/catalog.json",
      schemaUri: schemaPath,
      workflow_data: minimalWorkflow,
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "/catalogUri");
    expect(err?.issue).toBe("invalid_uri");
  });

  test("hints are deduped by (action, code)", async () => {
    const data = {
      ...minimalWorkflow,
      Actions: [
        { Label: "a1", Name: "no_such_one", Args: [] },
        { Label: "a2", Name: "no_such_two", Args: [] },
      ],
    };
    const result = await run({
      catalogUri: catalogPath,
      schemaUri: schemaPath,
      workflow_data: data,
    });
    const actionHints = result.hints.filter((h) =>
      h.action === "Use one of the available action ids",
    );
    expect(actionHints.length).toBe(1);
  });
});
