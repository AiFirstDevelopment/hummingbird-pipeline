import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fact, NarrativeOutput, ReviewOutput } from "./schema.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const runsRoot = join(projectRoot, "runs");

export const DECISIONS = ["escalate", "close", "request_information"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface DecisionRecord {
  run_id: string;
  decision: Decision;
  analyst: string;
  rationale: string;
  findings_at_decision: number;
  high_severity_at_decision: number;
  decided_at: string;
}

export interface RunResult {
  runId: string;
  facts: Fact[];
  quarantined: Fact[];
  narrative: NarrativeOutput;
  review: ReviewOutput;
}

export interface RunSummary {
  runId: string;
  dir: string;
  findings: number;
  highSeverity: number;
  recommendation: string;
  statements: number;
  decision: DecisionRecord | null;
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Run ids are ISO-timestamp prefixed, so lexical sort is chronological. */
export async function listRunIds(): Promise<string[]> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Experiment runs write a trace but no result.json — not reviewable cases.
    if (await exists(join(runsRoot, entry.name, "result.json"))) ids.push(entry.name);
  }
  return ids.sort();
}

export async function loadResult(runId: string): Promise<RunResult> {
  const raw = await readFile(join(runsRoot, runId, "result.json"), "utf8");
  return JSON.parse(raw) as RunResult;
}

export async function loadDecision(runId: string): Promise<DecisionRecord | null> {
  const path = join(runsRoot, runId, "decision.json");
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, "utf8")) as DecisionRecord;
}

export async function summarise(runId: string): Promise<RunSummary> {
  const result = await loadResult(runId);
  return {
    runId,
    dir: join(runsRoot, runId),
    findings: result.review.findings.length,
    highSeverity: result.review.findings.filter((f) => f.severity === "high").length,
    recommendation: result.review.recommendation,
    statements: result.narrative.statements.length,
    decision: await loadDecision(runId),
  };
}

/**
 * Resolves a run id from a CLI argument.
 *
 * "latest" resolves to the most recent *undecided* case rather than simply the
 * newest run — an analyst working a queue wants the next thing needing a
 * decision, not the last thing that happened to execute.
 */
export async function resolveRunId(arg: string | undefined): Promise<string> {
  const ids = await listRunIds();
  if (ids.length === 0) throw new Error("no runs found — run `npm run pipeline` first");

  if (arg && arg !== "latest") {
    if (!ids.includes(arg)) throw new Error(`no such run: ${arg}`);
    return arg;
  }

  for (const id of [...ids].reverse()) {
    if ((await loadDecision(id)) === null) return id;
  }
  return ids[ids.length - 1] as string;
}
