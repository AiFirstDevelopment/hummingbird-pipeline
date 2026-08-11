import { createInterface } from "node:readline/promises";
import { AuditTrail } from "./audit.js";
import {
  DECISIONS,
  loadDecision,
  loadResult,
  resolveRunId,
  type Decision,
  type DecisionRecord,
} from "./runs.js";

/**
 * Records an analyst's decision on a case.
 *
 * This is the second half of the human gate. The first half presents the draft;
 * this half captures what a person concluded and writes it into the same
 * append-only trace as the model calls. Without it you can reconstruct what the
 * machine did but not why the case was closed — and "why was this closed?" is
 * the question that actually gets asked, sometimes years later.
 *
 * Note what this does NOT do: nothing is filed, transmitted, or actioned. An
 * `escalate` decision writes a record and stops. Whatever happens next is a
 * separate system with its own controls.
 *
 *   npm run decide
 *   npm run decide -- --run <run-id>
 *   npm run decide -- --decision close --analyst "J. Stevick" --rationale "..."
 */

const MIN_RATIONALE = 20;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const runId = await resolveRunId(arg("run"));

const existing = await loadDecision(runId);
if (existing) {
  console.error(`Case ${runId} was already decided.`);
  console.error(`  ${existing.decision.toUpperCase()} by ${existing.analyst} at ${existing.decided_at}`);
  console.error(`  "${existing.rationale}"`);
  console.error(`\nDecisions are immutable. Re-run the pipeline to produce a new case.`);
  process.exit(1);
}

const result = await loadResult(runId);
const findings = result.review.findings;
const high = findings.filter((f) => f.severity === "high");

console.log(`Case ${runId}`);
console.log(`  ${result.narrative.statements.length} statements, drawn from ${result.facts.length} verified facts`);
console.log(`  machine recommendation: ${result.review.recommendation}`);
console.log();

if (findings.length === 0) {
  console.log("  Automated review raised no findings.");
} else {
  console.log(`  Automated review raised ${findings.length} finding(s):`);
  for (const f of findings) {
    console.log(`    [${f.severity.toUpperCase()}] ${f.type}: ${f.description.slice(0, 110)}`);
  }
}
console.log();
console.log(`  Full case file: runs/${runId}/case-file.md`);
console.log();

// --- gather the decision ----------------------------------------------------

let decision = arg("decision") as Decision | undefined;
let analyst = arg("analyst");
let rationale = arg("rationale");

const interactive = process.stdin.isTTY === true;

if (!decision || !analyst || !rationale) {
  if (!interactive) {
    console.error(
      "Not a TTY. Supply --decision, --analyst and --rationale to record a decision non-interactively.",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    analyst ||= (await rl.question("Analyst name: ")).trim();

    if (!decision) {
      console.log(`\nDecision options: ${DECISIONS.join(" / ")}`);
      const answer = (await rl.question("Decision: ")).trim();
      decision = answer as Decision;
    }

    rationale ||= (await rl.question("Rationale (why — this is the audit record): ")).trim();

    // Closing a case the machine flagged as high severity should cost you a
    // keystroke and a moment's thought. Friction here is the control.
    if (decision === "close" && high.length > 0) {
      console.log(`\n  ${high.length} HIGH-severity finding(s) were raised on this case.`);
      const confirm = (await rl.question("  Close anyway? Type CLOSE to confirm: ")).trim();
      if (confirm !== "CLOSE") {
        console.error("\nAborted. No decision recorded.");
        process.exit(1);
      }
    }
  } finally {
    rl.close();
  }
}

// --- validate ---------------------------------------------------------------

if (!decision || !DECISIONS.includes(decision)) {
  console.error(`\nInvalid decision. Expected one of: ${DECISIONS.join(", ")}`);
  process.exit(1);
}
if (!analyst) {
  console.error("\nAn analyst name is required — an unattributed decision is not an audit record.");
  process.exit(1);
}
// The interactive path asks for confirmation before closing a case with
// high-severity findings. The scripted path must not be a way around that
// control, so it requires an explicit flag instead.
if (decision === "close" && high.length > 0 && !interactive && !process.argv.includes("--confirm-close-high")) {
  console.error(
    `\n${high.length} HIGH-severity finding(s) on this case. Pass --confirm-close-high to close it non-interactively.`,
  );
  process.exit(1);
}
if (!rationale || rationale.length < MIN_RATIONALE) {
  console.error(
    `\nRationale must be at least ${MIN_RATIONALE} characters. "${rationale ?? ""}" does not explain anything to whoever reads this later.`,
  );
  process.exit(1);
}

// --- record it --------------------------------------------------------------

const record: DecisionRecord = {
  run_id: runId,
  decision,
  analyst,
  rationale,
  findings_at_decision: findings.length,
  high_severity_at_decision: high.length,
  decided_at: new Date().toISOString(),
};

const audit = await AuditTrail.resume(runId);
await audit.record("case_reopened_for_decision", { by: analyst });
await audit.record("human_decision_recorded", { ...record, filed: false });
await audit.writeArtifact("decision.json", JSON.stringify(record, null, 2));
await audit.record("case_closed", { decision, filed: false });

console.log();
console.log(`Recorded: ${decision.toUpperCase()} by ${analyst}`);
console.log(`  decision  runs/${runId}/decision.json`);
console.log(`  trace     runs/${runId}/trace.jsonl`);
console.log();
console.log("Nothing was filed or transmitted. This pipeline records decisions; it does not act on them.");
