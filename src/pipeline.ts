import { AuditTrail } from "./audit.js";
import { loadAlert, loadSources } from "./fixtures.js";
import { extract } from "./steps/extract.js";
import { summarize } from "./steps/summarize.js";
import { review } from "./steps/review.js";
import { renderCaseFile } from "./case-file.js";
import { ModelCallError } from "./llm.js";

/**
 * The orchestrator.
 *
 * gather -> summarise -> review -> stop.
 *
 * The chain is plain sequential code, not an agent deciding what to do next.
 * That is deliberate: in a compliance workflow the order of operations is a
 * control, and a control you can read in one function is a control you can
 * audit. The model does the judgement inside each step; it does not choose
 * the steps.
 *
 * Exit codes, for whatever schedules this:
 *   0  case file ready, awaiting analyst
 *   2  case file ready, but the review raised high-severity findings
 *   1  the pipeline failed and produced nothing to review
 */

const EXIT_READY = 0;
const EXIT_FAILED = 1;
const EXIT_NEEDS_ATTENTION = 2;

const audit = await AuditTrail.start();
console.log(`run ${audit.runId}`);
console.log(`trace ${audit.dir}/trace.jsonl`);
console.log();

try {
  const alert = await loadAlert();
  const sources = await loadSources();
  await audit.record("inputs_loaded", {
    source_ids: sources.map((s) => s.id),
    alert_bytes: Buffer.byteLength(alert),
  });

  // --- 1. gather -----------------------------------------------------------
  process.stdout.write("extract   ... ");
  const { verified, quarantined } = await extract(audit, alert, sources);
  console.log(`${verified.length} facts verified, ${quarantined.length} quarantined`);

  if (verified.length === 0) {
    throw new Error("no verified facts — nothing to summarise");
  }

  // --- 2. summarise --------------------------------------------------------
  process.stdout.write("summarize ... ");
  const { narrative, danglingCitations, uncitedStatements } = await summarize(audit, verified);
  console.log(
    `${narrative.statements.length} statements, ${narrative.open_questions.length} open questions`,
  );

  // --- 3. review -----------------------------------------------------------
  process.stdout.write("review    ... ");
  const reviewOutput = await review(audit, verified, narrative);
  const high = reviewOutput.findings.filter((f) => f.severity === "high").length;
  console.log(
    `${reviewOutput.findings.length} findings (${high} high) — ${reviewOutput.recommendation}`,
  );

  // --- 4. human gate -------------------------------------------------------
  //
  // Everything above produced a draft. Nothing below acts on it. The pipeline's
  // terminal state is a file on disk and a non-committal exit code; there is no
  // filing client, no outbound call, and no "if confident, proceed" branch —
  // the absence of that branch is the control.
  const caseFile = renderCaseFile({
    runId: audit.runId,
    alert,
    facts: verified,
    quarantined,
    narrative,
    review: reviewOutput,
    danglingCitations,
    uncitedStatements,
  });

  const caseFilePath = await audit.writeArtifact("case-file.md", caseFile);
  await audit.writeArtifact(
    "result.json",
    JSON.stringify(
      { runId: audit.runId, facts: verified, quarantined, narrative, review: reviewOutput },
      null,
      2,
    ),
  );

  const needsAttention = high > 0 || reviewOutput.recommendation === "needs_revision";

  await audit.record("human_gate_reached", {
    state: "AWAITING_HUMAN_REVIEW",
    filed: false,
    needs_attention: needsAttention,
    case_file: caseFilePath,
  });
  await audit.record("run_finished", { outcome: "awaiting_human_review" });

  console.log();
  console.log("HALTED: awaiting human review. Nothing has been filed.");
  console.log(`case file  ${caseFilePath}`);

  process.exit(needsAttention ? EXIT_NEEDS_ATTENTION : EXIT_READY);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await audit.record("run_failed", {
    error: message,
    kind: error instanceof ModelCallError ? "model_call" : "pipeline",
  });
  await audit.record("run_finished", { outcome: "failed" });

  console.error();
  console.error(`FAILED: ${message}`);
  console.error(`trace   ${audit.dir}/trace.jsonl`);
  process.exit(EXIT_FAILED);
}
