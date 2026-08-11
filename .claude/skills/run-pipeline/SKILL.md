---
name: run-pipeline
description: Run, inspect, or debug the compliance agent pipeline in this repo — the extract → summarize → review → human-gate flow, its run artifacts, and its audit trace. Use when running the pipeline, reading a trace, diagnosing a failed or low-quality run, or changing a pipeline step.
---

# Running the compliance pipeline

## Prerequisites

Node 18+ (developed on 20.16) and an API key in `.env` at the repo root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` is gitignored. If it is missing, `src/client.ts` exits with a message
before any request goes out — a missing key never surfaces as a mid-run 401.

## Commands

| Command | Effect | Costs tokens |
| --- | --- | --- |
| `npm run pipeline` | Full run: extract → summarize → review → gate | Yes — 3 calls, ~11K in / ~9K out |
| `npm run fixtures` | Print the alert and source documents | No |
| `npm run hello` | One trivial call, proves key + network + model string | Yes, trivially |
| `npm run typecheck` | `tsc --noEmit` | No |

A full run takes roughly two minutes. Most of that is the model thinking, not
network — do not assume it has hung before ~3 minutes.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Case file ready, awaiting analyst | Normal success |
| 2 | Case file ready, but review raised high-severity findings | Also a success path — read the findings |
| 1 | Run failed, nothing produced to review | Read the trace |

**Exit 2 is not an error.** It is the pipeline correctly reporting that its own
draft has problems. Treating it as a failure defeats the purpose of the review
step.

## Reading a run

Artifacts land in `runs/<run-id>/` (gitignored):

- `trace.jsonl` — audit trail, one event per line, appended as the run proceeds
- `case-file.md` — what a human analyst reads; start here
- `result.json` — same content, machine-readable

Useful `jq` recipes against `trace.jsonl`:

```sh
cd runs/<run-id>

# Event sequence
jq -r '"\(.seq)\t\(.event)\t\(.step // "-")"' trace.jsonl

# What each step was allowed to see. summarize and review MUST show docs=[]
jq -r 'select(.event=="model_call_started")
       | "\(.step): docs=[\(.source_documents_supplied | join(","))]"' trace.jsonl

# Latency and token spend per step
jq -r 'select(.event=="model_call_completed")
       | "\(.step)\t\(.latency_ms)ms\t\(.usage.input_tokens) in / \(.usage.output_tokens) out"' trace.jsonl

# Any fact dropped for failing verbatim verification
jq -c 'select(.event=="grounding_check") | .quarantined_facts' trace.jsonl

# Confirm nothing was filed
jq -c 'select(.event=="human_gate_reached")' trace.jsonl
```

Because the trace is append-only and flushed per event, a crashed run still
leaves everything up to the crash. A `model_call_started` with no matching
`model_call_completed` means that call hung or the process died inside it.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no verified facts — nothing to summarise` | Every extracted quote failed verbatim matching | Check `grounding_check` in the trace. Usually a fixture was edited without re-running, or the model is reformatting quotes |
| `output truncated at max_tokens` | Thinking + output exceeded the cap. Opus 5 thinks by default and `max_tokens` bounds both | Raise `maxTokens` in the failing step's `callModel` call |
| `model declined` | Safety classifier refusal | Check `stop_details` in the error. Unlikely with these fixtures |
| `no parsed output` | Schema problem | Check the schema in `src/schema.ts` against structured-output constraints |
| Narrative cites `F-###` that does not exist | Model invented a fact id | `citation_check` records it as `dangling_citations`. Should never happen — investigate rather than patching around |

## Invariants — do not break these

These are the point of the build. A change that violates one silently destroys
the guarantee the pipeline exists to make.

1. **`summarize()` and `review()` must never receive source documents.** They
   take `Fact[]`. If source text can reach them, the grounding claim is void —
   you can no longer tell an invented sentence from a sourced one. The trace
   showing `docs=[]` for those steps is the evidence.
2. **All model calls go through `callModel()` in `src/llm.ts`.** Calling
   `client.messages.*` directly anywhere else produces an unaudited call.
3. **Fact ids are assigned by the pipeline, never by the model** (`extract.ts`).
   Model-generated ids can collide or reference facts that do not exist.
4. **Unverified facts are quarantined, not flagged-and-passed.** A fact whose
   quote is not in its cited document must not reach a downstream step.
5. **Nothing files.** There is no filing client, no outbound call, and no
   "if confident, proceed" branch. Do not add one. The pipeline's terminal state
   is a file on disk and an exit code.

## Changing a step

Each step is prompt + schema + a mechanical check:

- `src/steps/extract.ts` — the only step that sees raw documents
- `src/steps/summarize.ts` — facts in, cited narrative out
- `src/steps/review.ts` — tries to break the draft

Shared shapes are in `src/schema.ts`. Changing a schema changes the JSON Schema
sent to the API, so the model's output shape changes with it — re-run the full
pipeline after any schema edit rather than typechecking alone.

The review prompt deliberately asks for **every** issue including low-severity
ones. Do not add "only report significant findings" — the model follows that
literally and measured recall drops, which is the opposite of what a review step
is for.

## Fixtures

`fixtures/` is deliberately adversarial: conflicting ownership percentages
across two sources, a near-miss entity in adverse media, single-source facts,
and an alert claim the transaction data contradicts. If you add fixtures, add
traps — clean documents make the pipeline look good and prove nothing.

Source IDs come from filenames (`SRC-002.md` → `SRC-002`), so the filesystem is
the authority on which IDs exist. Renaming a file changes its ID.

All data is synthetic. Do not add real customer or transaction data — this repo
is public.
