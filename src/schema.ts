import { z } from "zod";

/**
 * Every shape that crosses a step boundary lives here.
 *
 * These are not just types — each one is compiled to a JSON Schema and used to
 * constrain the model's decoding, so a step physically cannot return a shape
 * that violates its contract. Required fields are the enforcement mechanism:
 * `source_id` on a fact and `fact_ids` on a narrative statement make an
 * uncited claim unrepresentable rather than merely discouraged.
 */

// --- Step 1: extraction -----------------------------------------------------

export const FACT_CATEGORIES = [
  "entity",
  "account",
  "transaction",
  "prior_review",
  "screening",
  "other",
] as const;

export const ExtractedFact = z.object({
  claim: z
    .string()
    .describe("A single atomic fact in one sentence. No inference, no assessment."),
  source_id: z
    .string()
    .describe("The id of the one source document this fact came from, e.g. 'SRC-002'."),
  quote: z
    .string()
    .describe("The supporting passage, copied verbatim from that document. Checked mechanically."),
  category: z.enum(FACT_CATEGORIES).describe("Rough kind of fact, for grouping."),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

export const ExtractionOutput = z.object({ facts: z.array(ExtractedFact) });
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

/**
 * A fact after the pipeline has processed it.
 *
 * `id` is assigned by us, not the model — deterministic, collision-free, and
 * impossible for the model to fabricate a reference to a fact that never existed.
 */
export interface Fact extends ExtractedFact {
  id: string;
  /** True if `quote` was found verbatim in the cited document. */
  verified: boolean;
}

// --- Step 2: summarisation --------------------------------------------------

export const NarrativeStatement = z.object({
  text: z.string().describe("One sentence of the case narrative."),
  fact_ids: z
    .array(z.string())
    .describe("Ids of the facts supporting this sentence, e.g. ['F-004','F-012']. Never empty."),
});
export type NarrativeStatement = z.infer<typeof NarrativeStatement>;

export const NarrativeOutput = z.object({
  statements: z
    .array(NarrativeStatement)
    .describe("The case narrative, one cited sentence at a time, in reading order."),
  open_questions: z
    .array(z.string())
    .describe("Questions the supplied facts do not answer. Questions only — never assertions."),
});
export type NarrativeOutput = z.infer<typeof NarrativeOutput>;

// --- Step 3: review ---------------------------------------------------------

export const FINDING_TYPES = [
  "unsupported_claim",
  "misused_source",
  "material_omission",
  "internal_inconsistency",
  "overreach",
] as const;

export const ReviewFinding = z.object({
  type: z.enum(FINDING_TYPES),
  severity: z.enum(["high", "medium", "low"]),
  description: z.string().describe("What is wrong and why it matters, in plain language."),
  statement_index: z
    .number()
    .int()
    .nullable()
    .describe("Index of the offending narrative statement, or null if not tied to one."),
  fact_ids: z.array(z.string()).describe("Fact ids relevant to this finding, if any."),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewOutput = z.object({
  findings: z.array(ReviewFinding),
  completeness_assessment: z
    .string()
    .describe("Whether the narrative covers what the facts support, and what it leaves out."),
  recommendation: z.enum(["ready_for_analyst", "needs_revision"]),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
