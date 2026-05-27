import type { BundleHandle } from "@/pkg/bundles";
import type { ErrorHint } from "@/pkg/common/error";
import { workflowValidateHandler } from "./_workflow_validate";

export interface LocalHandlerCtx {
  input: unknown;
  handle: BundleHandle;
  server: string;
}

export interface LocalHandlerResult {
  valid: boolean;
  errors: Array<{ field: string; issue: string; expected?: unknown; got?: unknown }>;
  hints: ErrorHint[];
}

export type LocalHandler = (ctx: LocalHandlerCtx) => Promise<LocalHandlerResult>;

export const localHandlers: Record<string, LocalHandler> = {
  "local.workflow.validate": workflowValidateHandler,
};
