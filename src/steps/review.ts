import type { AuditTrail } from "../audit.js";
import { callModel } from "../llm.js";
import { ReviewOutput, type Fact, type NarrativeOutput } from "../schema.js";

const SYSTEM_PROMPT = `You are the review step of a financial-crime compliance pipeline. A narrative has been drafted from a list of extracted facts. Your job is to find everything wrong with it before a human analyst reads it.

You are given the fact list and the narrative. You are NOT given the source documents.

Check for:

- unsupported_claim: the statement asserts something its cited facts do not actually establish. Read the cited facts and check they carry the claim — a citation that exists but does not support the sentence is the failure mode that matters most here.
- misused_source: the statement conflates two entities, misattributes a fact, or treats a low-confidence or explicitly-excluded match as established.
- material_omission: a fact in the list that an analyst would need, which the narrative does not mention. Conflicts between facts and prior review history are usually material.
- internal_inconsistency: two statements that cannot both be true.
- overreach: the narrative draws a conclusion, assigns risk, or recommends an action. That is the human analyst's decision, not the pipeline's.

Report every issue you find, including ones you are uncertain about or consider low severity. Do not filter for importance — a human is reading this and can dismiss what does not matter. Missing a real problem is far worse than raising one that gets waved off.

If the narrative is sound, return an empty findings list and say so in the completeness assessment. Do not invent problems to look thorough.`;

function buildUserMessage(facts: Fact[], narrative: NarrativeOutput): string {
  const factLines = facts.map((f) => `${f.id} [${f.category}] ${f.claim}`);

  const statementLines = narrative.statements.map(
    (s, i) => `[${i}] ${s.text}   (cites: ${s.fact_ids.join(", ") || "NOTHING"})`,
  );

  const questionLines = narrative.open_questions.map((q, i) => `[${i}] ${q}`);

  return [
    "These are the facts the narrative was written from:",
    "",
    "<facts>",
    ...factLines,
    "</facts>",
    "",
    "This is the narrative under review, one statement per line with its citations:",
    "",
    "<narrative>",
    ...statementLines,
    "</narrative>",
    "",
    "<open_questions>",
    ...(questionLines.length > 0 ? questionLines : ["(none)"]),
    "</open_questions>",
    "",
    "Review it.",
  ].join("\n");
}

/**
 * Step 3 — review.
 *
 * This step exists because the mechanical checks cannot do its job. Verbatim
 * quote matching proves a quote exists in a document; citation checking proves
 * a fact id exists. Neither proves the cited fact actually *supports* the
 * sentence built on it. That judgement needs a reader, and this is the cheapest
 * reader available before a human spends time on it.
 *
 * It is deliberately a separate model call with a fresh context rather than a
 * self-check appended to the summarisation prompt: a model asked to critique
 * its own just-written output in the same context tends to ratify it.
 */
export async function review(
  audit: AuditTrail,
  facts: Fact[],
  narrative: NarrativeOutput,
): Promise<ReviewOutput> {
  const output = await callModel({
    audit,
    step: "review",
    system: SYSTEM_PROMPT,
    user: buildUserMessage(facts, narrative),
    schema: ReviewOutput,
    schemaName: "ReviewOutput",
    sourceDocumentIds: [],
  });

  await audit.record("review_summary", {
    step: "review",
    findings: output.findings.length,
    by_severity: {
      high: output.findings.filter((f) => f.severity === "high").length,
      medium: output.findings.filter((f) => f.severity === "medium").length,
      low: output.findings.filter((f) => f.severity === "low").length,
    },
    recommendation: output.recommendation,
  });

  return output;
}
