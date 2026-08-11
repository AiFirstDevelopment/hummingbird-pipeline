import type { AuditTrail } from "../audit.js";
import type { SourceDocument } from "../fixtures.js";
import { callModel } from "../llm.js";
import { ExtractionOutput, type Fact } from "../schema.js";

const SYSTEM_PROMPT = `You are the extraction step of a financial-crime compliance pipeline. A human analyst owns every decision downstream. Your only job is to pull facts out of the documents you are given.

Rules:

- Use ONLY the source documents provided. You have no other knowledge of this customer, these entities, or these transactions. If it is not in a document, it does not exist.
- Every fact must come from exactly one source document, identified by its source_id.
- The quote field must be copied verbatim from that document. Do not paraphrase, reformat, summarise, or correct it. It is checked mechanically against the document text.
- Extract facts, not conclusions. "Nine cash deposits totalling $79,400 occurred between 2026-05-02 and 2026-06-27" is a fact. "The deposit pattern appears structured" is an assessment, and assessments are not your job.
- If two documents disagree about the same detail, extract both as separate facts. Do not reconcile them, pick a winner, or note the conflict — later steps handle that.
- If a document is not relevant to the alert, extract nothing from it rather than reaching for something to say about it.
- Do not treat a name similarity as an identity. Two entities are the same only if a document says so.`;

function buildUserMessage(alert: string, sources: SourceDocument[]): string {
  const wrapped = sources
    .map((s) => `<source id="${s.id}">\n${s.text.trim()}\n</source>`)
    .join("\n\n");

  return [
    "Here is the alert under investigation:",
    "",
    `<alert>\n${alert.trim()}\n</alert>`,
    "",
    "Here are the source documents available to you:",
    "",
    wrapped,
    "",
    "Extract the facts relevant to investigating this alert.",
  ].join("\n");
}

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface ExtractionResult {
  /** Facts whose quote was found verbatim in the cited document. Safe to use. */
  verified: Fact[];
  /** Facts that failed verification. Quarantined — never passed downstream. */
  quarantined: Fact[];
}

/**
 * Step 1 — extraction.
 *
 * This is the only step that sees the raw source documents. Everything after it
 * works from the fact list, which is what makes grounding checkable: if a later
 * step says something that isn't in the facts, it invented it.
 */
export async function extract(
  audit: AuditTrail,
  alert: string,
  sources: SourceDocument[],
): Promise<ExtractionResult> {
  const output = await callModel({
    audit,
    step: "extract",
    system: SYSTEM_PROMPT,
    user: buildUserMessage(alert, sources),
    schema: ExtractionOutput,
    schemaName: "ExtractionOutput",
    sourceDocumentIds: sources.map((s) => s.id),
  });

  // Ids are assigned here, not by the model: deterministic, sequential, and
  // guaranteed to refer to a fact that actually exists.
  const documentsById = new Map(sources.map((s) => [s.id, normalise(s.text)]));

  const facts: Fact[] = output.facts.map((fact, i) => {
    const document = documentsById.get(fact.source_id);
    const verified = document !== undefined && document.includes(normalise(fact.quote));
    return { ...fact, id: `F-${String(i + 1).padStart(3, "0")}`, verified };
  });

  const verified = facts.filter((f) => f.verified);
  const quarantined = facts.filter((f) => !f.verified);

  await audit.record("grounding_check", {
    step: "extract",
    total: facts.length,
    verified: verified.length,
    quarantined: quarantined.length,
    quarantined_facts: quarantined.map((f) => ({
      id: f.id,
      source_id: f.source_id,
      claim: f.claim,
      quote: f.quote,
      reason: documentsById.has(f.source_id) ? "quote_not_found_in_source" : "unknown_source_id",
    })),
  });

  // Fail safe, loudly. A fact whose quote cannot be located in the document it
  // claims to come from is exactly the failure this pipeline exists to catch,
  // so it is dropped from everything downstream rather than merely flagged.
  return { verified, quarantined };
}
