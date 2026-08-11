import type { AuditTrail } from "../audit.js";
import { callModel } from "../llm.js";
import { NarrativeOutput, type Fact } from "../schema.js";

const SYSTEM_PROMPT = `You are the summarisation step of a financial-crime compliance pipeline. A human analyst owns every decision downstream. You are writing a case narrative for that analyst to read.

You are given a list of extracted facts. You are NOT given the source documents, and you have no other knowledge of this customer, these entities, or these transactions.

Rules:

- Every statement you write must be supported by one or more of the supplied facts, cited by fact id. A statement you cannot cite is a statement you must not write.
- Write in plain declarative sentences. One claim per statement.
- Describe what the facts show. Do not recommend a filing, assign a risk rating, or state a conclusion about whether misconduct occurred — that decision belongs to the human analyst.
- Where facts conflict, say so plainly and cite both. Do not silently choose one.
- Where two entities have similar names, do not treat them as the same entity unless a fact says they are.
- Put anything the facts do not settle in open_questions. Open questions must be phrased as questions, never as assertions or implications.
- Do not pad. If the facts support six statements, write six.`;

function buildUserMessage(facts: Fact[]): string {
  const lines = facts.map((f) => `${f.id} [${f.category}] ${f.claim}`);

  return [
    "Here are the extracted facts. This is everything you know.",
    "",
    "<facts>",
    ...lines,
    "</facts>",
    "",
    "Write the case narrative.",
  ].join("\n");
}

export interface SummarizeResult {
  narrative: NarrativeOutput;
  /** Fact ids cited by the narrative that do not exist. Should always be empty. */
  danglingCitations: string[];
  /** Indices of statements that cited nothing at all. */
  uncitedStatements: number[];
}

/**
 * Step 2 — summarisation.
 *
 * Note the signature: this function takes facts, not documents. That is the
 * grounding guarantee, expressed as a type. There is no argument through which
 * the source text could reach this step, so anything in the narrative that is
 * not traceable to a fact was invented — with no ambiguity about where it came
 * from.
 */
export async function summarize(audit: AuditTrail, facts: Fact[]): Promise<SummarizeResult> {
  const narrative = await callModel({
    audit,
    step: "summarize",
    system: SYSTEM_PROMPT,
    user: buildUserMessage(facts),
    schema: NarrativeOutput,
    schemaName: "NarrativeOutput",
    // Deliberately empty: this step never sees a source document, and the trace
    // records that fact rather than leaving it to be inferred from the prompt.
    sourceDocumentIds: [],
  });

  const knownIds = new Set(facts.map((f) => f.id));
  const dangling = new Set<string>();
  const uncitedStatements: number[] = [];

  narrative.statements.forEach((statement, index) => {
    if (statement.fact_ids.length === 0) uncitedStatements.push(index);
    for (const id of statement.fact_ids) {
      if (!knownIds.has(id)) dangling.add(id);
    }
  });

  const danglingCitations = [...dangling];

  await audit.record("citation_check", {
    step: "summarize",
    statements: narrative.statements.length,
    open_questions: narrative.open_questions.length,
    dangling_citations: danglingCitations,
    uncited_statements: uncitedStatements,
  });

  return { narrative, danglingCitations, uncitedStatements };
}
