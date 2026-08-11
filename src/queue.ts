import { listRunIds, summarise } from "./runs.js";

/**
 * The analyst work queue.
 *
 * A gate that halts is only half a workflow — someone has to be able to find
 * what is waiting on them. This is the cheapest possible version of the case
 * list every real compliance platform puts in front of an analyst.
 */

const ids = await listRunIds();

if (ids.length === 0) {
  console.log("No cases. Run `npm run pipeline` to generate one.");
  process.exit(0);
}

const summaries = await Promise.all(ids.map(summarise));
const pending = summaries.filter((s) => s.decision === null);
const decided = summaries.filter((s) => s.decision !== null);

console.log(`AWAITING DECISION (${pending.length})`);
console.log("-".repeat(78));

if (pending.length === 0) {
  console.log("  nothing pending");
} else {
  for (const s of [...pending].reverse()) {
    const flag = s.highSeverity > 0 ? ` !! ${s.highSeverity} HIGH` : "";
    console.log(`  ${s.runId}`);
    console.log(
      `    ${s.statements} statements · ${s.findings} findings${flag} · machine says: ${s.recommendation}`,
    );
  }
}

if (decided.length > 0) {
  console.log();
  console.log(`DECIDED (${decided.length})`);
  console.log("-".repeat(78));
  for (const s of [...decided].reverse()) {
    const d = s.decision!;
    console.log(`  ${s.runId}`);
    console.log(`    ${d.decision.toUpperCase()} by ${d.analyst} at ${d.decided_at}`);
  }
}

console.log();
console.log("Review a case:  npm run review-case            (opens the next pending case file)");
console.log("Record it:      npm run decide                 (interactive)");
