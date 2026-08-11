import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL } from "./client.js";
import type { AuditTrail } from "./audit.js";

export type StepName = "extract" | "summarize" | "review";

export class ModelCallError extends Error {}

interface CallOptions<T extends z.ZodType> {
  audit: AuditTrail;
  step: StepName;
  system: string;
  user: string;
  schema: T;
  /** Human-readable schema name, recorded in the trace. */
  schemaName: string;
  /**
   * Ids of the source documents whose text appears in this prompt.
   *
   * Recorded in the audit trail so a reviewer can answer "what was this model
   * actually looking at?" without re-reading the prompt. Empty is meaningful:
   * it proves a step ran without access to the raw documents.
   */
  sourceDocumentIds: string[];
  maxTokens?: number;
}

/**
 * The only path to the model.
 *
 * Every call is bracketed by two audit events. The `model_call_started` record
 * is written *before* the request goes out, so a call that times out, hangs, or
 * crashes the process still leaves proof it was attempted — a trace with a
 * started and no completed is exactly the signal you want when debugging a
 * stuck run. Logging only on success would make failures invisible.
 */
export async function callModel<T extends z.ZodType>(opts: CallOptions<T>): Promise<z.infer<T>> {
  const { audit, step, system, user, schema, schemaName, sourceDocumentIds } = opts;
  const maxTokens = opts.maxTokens ?? 16000;

  await audit.record("model_call_started", {
    step,
    model: MODEL,
    schema: schemaName,
    max_tokens: maxTokens,
    source_documents_supplied: sourceDocumentIds,
    system_prompt: system,
    user_prompt: user,
  });

  const startedAt = Date.now();

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(schema) },
    });
  } catch (error) {
    await audit.record("model_call_failed", {
      step,
      latency_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ModelCallError(`${step}: request failed — ${String(error)}`);
  }

  await audit.record("model_call_completed", {
    step,
    latency_ms: Date.now() - startedAt,
    model: response.model,
    stop_reason: response.stop_reason,
    usage: response.usage,
    parsed_output: response.parsed_output,
  });

  // Three ways a structurally valid call still yields nothing usable. A
  // production pipeline distinguishes them, because the operator response
  // differs: refusal is a policy signal, max_tokens is a config problem, and a
  // null parse is a schema problem.
  if (response.stop_reason === "refusal") {
    throw new ModelCallError(
      `${step}: model declined (${JSON.stringify(response.stop_details)})`,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new ModelCallError(
      `${step}: output truncated at max_tokens=${maxTokens}. Raise it and re-run.`,
    );
  }
  if (!response.parsed_output) {
    throw new ModelCallError(`${step}: no parsed output (stop_reason=${response.stop_reason})`);
  }

  return response.parsed_output;
}
