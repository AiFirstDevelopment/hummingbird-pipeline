import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const runsRoot = join(projectRoot, "runs");

/**
 * The audit trail.
 *
 * Two decisions here are the whole point of this file:
 *
 * 1. Append-only JSONL, flushed on every event. If the process dies halfway
 *    through a run — timeout, OOM, someone hits Ctrl-C — everything up to that
 *    moment is already durable on disk. A trace you buffer in memory and write
 *    at the end is a trace you lose exactly when you most need it.
 *
 * 2. One line per event, not one blob per run. That makes the trace greppable,
 *    tailable while a run is in flight, and appendable without a read-modify-write.
 *
 * In a real deployment this would also redact PII before writing, and ship to
 * append-only storage the pipeline itself cannot rewrite. Everything here is
 * synthetic, so the trace records prompts and responses in full.
 */
export class AuditTrail {
  private seq = 0;

  private constructor(
    readonly runId: string,
    readonly dir: string,
    private readonly tracePath: string,
  ) {}

  static async start(): Promise<AuditTrail> {
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const dir = join(runsRoot, runId);
    await mkdir(dir, { recursive: true });

    const trail = new AuditTrail(runId, dir, join(dir, "trace.jsonl"));
    await trail.record("run_started", {
      node_version: process.version,
      cwd: process.cwd(),
    });
    return trail;
  }

  /**
   * Reopens an existing run's trace so a later event — a human decision, hours
   * or days after the pipeline finished — lands in the same file as the model
   * calls that produced the draft.
   *
   * This is the point of the whole exercise: a trace that records what the
   * machine did but not what the human concluded cannot answer "why was this
   * case closed?", which is the question that actually gets asked. Appending
   * after `run_finished` is correct, not a bug — the run did finish, and then
   * later a person decided something.
   *
   * The sequence counter resumes from the highest seq already on disk so
   * ordering stays monotonic across sessions.
   */
  static async resume(runId: string): Promise<AuditTrail> {
    const dir = join(runsRoot, runId);
    const tracePath = join(dir, "trace.jsonl");

    const existing = await readFile(tracePath, "utf8");
    const lastSeq = existing
      .trimEnd()
      .split("\n")
      .reduce((max, line) => Math.max(max, (JSON.parse(line) as { seq: number }).seq), -1);

    const trail = new AuditTrail(runId, dir, tracePath);
    trail.seq = lastSeq + 1;
    return trail;
  }

  /** Appends one event. Every model call, gate decision, and check lands here. */
  async record(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({
      seq: this.seq++,
      ts: new Date().toISOString(),
      run_id: this.runId,
      event,
      ...payload,
    });
    await appendFile(this.tracePath, line + "\n", "utf8");
  }

  /** Writes a run artifact (case file, intermediate JSON) alongside the trace. */
  async writeArtifact(name: string, contents: string): Promise<string> {
    const path = join(this.dir, name);
    await writeFile(path, contents, "utf8");
    await this.record("artifact_written", { name, bytes: Buffer.byteLength(contents) });
    return path;
  }
}
