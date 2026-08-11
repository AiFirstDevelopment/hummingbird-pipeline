import { readFile } from "node:fs/promises";
import { AuditTrail } from "../audit.js";
import { callModel } from "../llm.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserMessage } from "../steps/review.js";
import { ReviewOutput, type Fact, type NarrativeOutput } from "../schema.js";

/**
 * A/B test: does asking the review step to filter for significance reduce what
 * it reports?
 *
 * The claim being tested is that a severity filter reads like a sensible
 * tightening but suppresses real findings — the model investigates just as hard,
 * then declines to report anything it judges below the stated bar.
 *
 * Method: hold the input constant (one saved run's facts and narrative), vary
 * only the system prompt, N runs per arm. Holding the narrative fixed matters —
 * if each arm reviewed a freshly generated narrative, differences in the
 * narrative would confound differences in the reviewer.
 *
 *   npx tsx --env-file=.env src/experiments/review-prompt-ab.ts runs/<run-id>/result.json
 */

const RUNS_PER_ARM = 3;

/** The filtered variant. Deliberately reasonable-sounding — that is the point. */
const FILTERED_PROMPT = REVIEW_SYSTEM_PROMPT.replace(
  "Report every issue you find, including ones you are uncertain about or consider low severity. Do not filter for importance — a human is reading this and can dismiss what does not matter. Missing a real problem is far worse than raising one that gets waved off.",
  "Only report significant issues. Be conservative and do not nitpick — analyst time is expensive, so raise a finding only if you are confident it is a genuine problem that would change the analyst's reading.",
);

const resultPath = process.argv[2];
if (!resultPath) {
  console.error("usage: tsx src/experiments/review-prompt-ab.ts runs/<run-id>/result.json");
  process.exit(1);
}

const saved = JSON.parse(await readFile(resultPath, "utf8")) as {
  facts: Fact[];
  narrative: NarrativeOutput;
};

const user = buildReviewUserMessage(saved.facts, saved.narrative);
const audit = await AuditTrail.start();

console.log(`experiment ${audit.runId}`);
console.log(`input      ${resultPath} (${saved.facts.length} facts, ${saved.narrative.statements.length} statements)`);
console.log(`arms       control (report everything) vs filtered (only significant)`);
console.log(`n          ${RUNS_PER_ARM} per arm`);
console.log();

const arms = [
  { name: "control ", system: REVIEW_SYSTEM_PROMPT },
  { name: "filtered", system: FILTERED_PROMPT },
];

const results = await Promise.all(
  arms.flatMap((arm) =>
    Array.from({ length: RUNS_PER_ARM }, (_, i) =>
      callModel({
        audit,
        step: "review",
        system: arm.system,
        user,
        schema: ReviewOutput,
        schemaName: "ReviewOutput",
        sourceDocumentIds: [],
      }).then((output) => ({ arm: arm.name, trial: i, output })),
    ),
  ),
);

for (const arm of arms) {
  const runs = results.filter((r) => r.arm === arm.name);
  const counts = runs.map((r) => r.output.findings.length);
  const total = counts.reduce((a, b) => a + b, 0);

  console.log("=".repeat(72));
  console.log(`${arm.name.trim().toUpperCase()}  — findings per run: ${counts.join(", ")}  (mean ${(total / runs.length).toFixed(1)})`);
  console.log("=".repeat(72));

  for (const run of runs) {
    const bySeverity = (["high", "medium", "low"] as const)
      .map((s) => `${s[0]}=${run.output.findings.filter((f) => f.severity === s).length}`)
      .join(" ");
    console.log(`  trial ${run.trial}: ${run.output.findings.length} findings (${bySeverity}) — ${run.output.recommendation}`);
    for (const finding of run.output.findings) {
      const where = finding.statement_index !== null ? `[${finding.statement_index}]` : "[-]";
      console.log(`      ${finding.severity.padEnd(6)} ${finding.type.padEnd(23)} ${where} ${finding.description.slice(0, 90)}`);
    }
  }
  console.log();
}

const mean = (name: string) => {
  const runs = results.filter((r) => r.arm === name);
  return runs.reduce((a, r) => a + r.output.findings.length, 0) / runs.length;
};

const control = mean("control ");
const filtered = mean("filtered");

console.log("=".repeat(72));
console.log(`control  mean findings: ${control.toFixed(1)}`);
console.log(`filtered mean findings: ${filtered.toFixed(1)}`);
console.log(
  control > 0
    ? `filtered reports ${(((control - filtered) / control) * 100).toFixed(0)}% fewer findings than control`
    : "control found nothing; test is uninformative",
);
console.log(`\ntrace ${audit.dir}/trace.jsonl`);
