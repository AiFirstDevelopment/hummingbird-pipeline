import type { Fact, NarrativeOutput, ReviewOutput } from "./schema.js";

interface CaseFileInput {
  runId: string;
  alert: string;
  facts: Fact[];
  quarantined: Fact[];
  narrative: NarrativeOutput;
  review: ReviewOutput;
  danglingCitations: string[];
  uncitedStatements: number[];
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Renders the package a human analyst reads.
 *
 * Written for someone who was not watching the run and does not trust it: every
 * narrative sentence carries its citations inline, the facts those citations
 * point at are listed underneath, and the machine's own review of its work is
 * placed *above* the narrative rather than buried at the end. An analyst should
 * hit the objections before they read the prose those objections are about.
 */
export function renderCaseFile(input: CaseFileInput): string {
  const { runId, alert, facts, quarantined, narrative, review } = input;
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const out: string[] = [];

  out.push(`# Case file — awaiting analyst review`);
  out.push("");
  out.push(`> **No filing, report, or external action has been taken.** This pipeline`);
  out.push(`> produces a draft for a human to accept, amend, or discard. It has no`);
  out.push(`> capability to file, and no step downstream of this document is automated.`);
  out.push("");
  out.push(`- **Run id:** \`${runId}\``);
  out.push(`- **Generated:** ${new Date().toISOString()}`);
  out.push(`- **Facts used:** ${facts.length}`);
  out.push(`- **Facts quarantined:** ${quarantined.length}`);
  out.push(`- **Review findings:** ${review.findings.length}`);
  out.push(`- **Machine recommendation:** \`${review.recommendation}\``);
  out.push("");

  // --- Machine review, first ---
  out.push(`## Automated review of the draft below`);
  out.push("");
  out.push(review.completeness_assessment);
  out.push("");

  if (review.findings.length === 0) {
    out.push(`_The review step raised no findings. This is not evidence the narrative is`);
    out.push(`correct — only that this check did not catch anything._`);
  } else {
    const sorted = [...review.findings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    for (const finding of sorted) {
      const where =
        finding.statement_index !== null ? ` — statement [${finding.statement_index}]` : "";
      out.push(`- **${finding.severity.toUpperCase()} / ${finding.type}**${where}`);
      out.push(`  ${finding.description}`);
      if (finding.fact_ids.length > 0) {
        out.push(`  _Related facts: ${finding.fact_ids.join(", ")}_`);
      }
    }
  }
  out.push("");

  // --- Integrity checks ---
  out.push(`## Integrity checks`);
  out.push("");
  out.push(`| Check | Result |`);
  out.push(`| --- | --- |`);
  out.push(
    `| Facts with quote verified verbatim in source | ${facts.length} of ${facts.length + quarantined.length} |`,
  );
  out.push(
    `| Facts quarantined (quote not found) | ${quarantined.length === 0 ? "none" : `**${quarantined.length}**`} |`,
  );
  out.push(
    `| Narrative citations pointing at unknown facts | ${input.danglingCitations.length === 0 ? "none" : `**${input.danglingCitations.join(", ")}**`} |`,
  );
  out.push(
    `| Narrative statements with no citation | ${input.uncitedStatements.length === 0 ? "none" : `**${input.uncitedStatements.join(", ")}**`} |`,
  );
  out.push("");

  if (quarantined.length > 0) {
    out.push(`### Quarantined facts (excluded from the narrative)`);
    out.push("");
    for (const fact of quarantined) {
      out.push(`- \`${fact.id}\` claimed source \`${fact.source_id}\`: ${fact.claim}`);
      out.push(`  - Quote not located in that document: "${fact.quote.slice(0, 160)}"`);
    }
    out.push("");
  }

  // --- Narrative ---
  out.push(`## Draft narrative`);
  out.push("");
  narrative.statements.forEach((statement, index) => {
    const cites = statement.fact_ids.length > 0 ? statement.fact_ids.join(", ") : "**UNCITED**";
    out.push(`**[${index}]** ${statement.text}  \`(${cites})\``);
    out.push("");
  });

  if (narrative.open_questions.length > 0) {
    out.push(`## Open questions the sources do not answer`);
    out.push("");
    for (const question of narrative.open_questions) {
      out.push(`- ${question}`);
    }
    out.push("");
  }

  // --- Evidence ---
  out.push(`## Evidence`);
  out.push("");
  out.push(`Every fact below was located verbatim in the document it cites.`);
  out.push("");

  const cited = new Set(narrative.statements.flatMap((s) => s.fact_ids));
  for (const fact of facts) {
    const marker = cited.has(fact.id) ? "" : " _(not used in narrative)_";
    out.push(`- \`${fact.id}\` **${fact.source_id}** [${fact.category}]${marker}`);
    out.push(`  ${fact.claim}`);
    out.push(`  > ${fact.quote.replace(/\s+/g, " ").trim()}`);
  }
  out.push("");

  // --- Original alert ---
  out.push(`## Original alert`);
  out.push("");
  out.push("```");
  out.push(alert.trim());
  out.push("```");
  out.push("");

  // --- The gate ---
  out.push(`## Analyst decision`);
  out.push("");
  out.push(`This section is intentionally blank. The pipeline stops here.`);
  out.push("");
  out.push(`- [ ] Reviewed the findings above`);
  out.push(`- [ ] Verified the cited facts against the source documents`);
  out.push(`- [ ] Decision: _(escalate / close / request more information)_`);
  out.push(`- [ ] Analyst: _______________  Date: _______________`);
  out.push("");

  const unusedFacts = facts.filter((f) => !cited.has(f.id));
  if (unusedFacts.length > 0) {
    out.push(
      `_Note: ${unusedFacts.length} verified fact(s) were not referenced by the narrative. They are listed above and marked._`,
    );
    out.push("");
  }

  return out.join("\n");
}
