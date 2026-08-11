# hummingbird-pipeline

A small, readable compliance-agent pipeline: it takes a suspicious-activity alert
plus a handful of source documents, extracts the relevant facts, drafts a case
narrative grounded only in those facts, reviews its own draft, and then **stops**
for a human analyst.

This is a learning build. It is not a product, it has no UI, and every alert,
person, company, and transaction in `fixtures/` is invented.

## What it does

```
alert + source documents
   │
   ├─ 1. extract    LLM pulls atomic facts, each tagged with the source it came from
   │                 └─ every quote is string-matched back into that document
   │
   ├─ 2. summarize  LLM writes a narrative from the FACTS ONLY — never the documents
   │                 └─ every sentence carries the fact ids supporting it
   │
   ├─ 3. review     a second LLM call, fresh context, tries to break the draft
   │
   └─ 4. human gate writes a case file and halts. Nothing is filed.
```

Every model call is written to an append-only trace as it happens.

## Running it

Requires Node 18+ (developed on 20.16).

```sh
npm install
cp .env.example .env        # then paste your ANTHROPIC_API_KEY into it
npm run pipeline
```

| Script | What it does |
| --- | --- |
| `npm run pipeline` | Draft a case: extract → summarize → review → halt |
| `npm run queue` | What is waiting on an analyst |
| `npm run review-case` | Open the next pending case file |
| `npm run decide` | Record an analyst decision (interactive) |
| `npm run fixtures` | Prints the synthetic alert and source documents. No model call |
| `npm run hello` | One trivial API call, to prove the plumbing works |
| `npm run typecheck` | `tsc --noEmit` |

The pipeline halts and does not resume. Review is a separate invocation, by a
person:

```sh
npm run pipeline       # produces a case file, then stops
npm run queue          # see what needs a decision
npm run review-case    # read it
npm run decide         # record escalate / close / request_information
```

The decision is appended to the **same** `trace.jsonl` as the model calls, so
one file answers both "what did the machine do?" and "what did the human
conclude, and why?". Decisions are immutable, require a named analyst and a
rationale, and closing a case with high-severity findings takes an explicit
confirmation. `escalate` writes a record and stops — nothing is filed.

Exit codes: `0` case file ready · `2` ready, but the review raised high-severity
findings · `1` the run failed and produced nothing to review.

Each run writes to `runs/<run-id>/`:

- `trace.jsonl` — the audit trail, one event per line
- `case-file.md` — the package a human analyst reads
- `result.json` — the same content, machine-readable

`runs/` is gitignored.

## The interesting parts

**Grounding is enforced by types, not by asking nicely.** `summarize()` takes
`Fact[]`, not documents — there is no parameter through which source text could
reach it. So anything in the narrative that isn't traceable to a fact was
invented, with no ambiguity about where it came from. The audit trail records
`docs=[]` for that step, making the guarantee visible in the trace rather than
something you have to take on faith.

**Citation is structural.** The schema requires a `source_id` and a verbatim
`quote` on every fact, and `fact_ids` on every narrative sentence. Because the
API constrains decoding to that schema, an uncited claim is unrepresentable
rather than merely discouraged.

**Grounding fails closed.** A fact whose quote cannot be located in the document
it cites is quarantined, excluded from every downstream step, and reported.

**The review step exists because mechanical checks have a ceiling.** Verbatim
matching proves a quote exists in a document. Citation checking proves a fact id
exists. Neither proves the cited fact actually *supports* the sentence built on
it. On the first full run, that gap is exactly what the review caught: a
statement asserting two entities were the same counterparty on a name match
alone, with real citations pointing at real facts.

**The gate is an absence.** There is no filing client, no outbound call, and no
"if confident, proceed" branch anywhere in the codebase. The pipeline's terminal
state is a file on disk.

## The fixtures are deliberately hostile

Grounding is only testable if the source material fights back, so the four
documents contain:

1. Facts that appear in exactly one source, so citation is meaningful.
2. Two sources that **disagree** on beneficial ownership (62% vs 51%).
3. A **near-miss entity** — adverse media about a similarly-named but explicitly
   unrelated company. Conflating it with the subject is the most realistic and
   most damaging hallucination in this domain.
4. A claim in the alert that no source supports (four branch locations; the
   transaction data shows three).

## Known gaps

Being explicit, since the gaps matter as much as the build:

- **No eval suite.** Four fixtures and a handful of runs is a demo, not evidence.
- **The review step is itself an LLM** — it reduces risk, it does not bound it.
- **No PII redaction in the trace.** Fine for synthetic data, unacceptable with
  real customers.
- **No prompt caching**, no queue, no concurrency, no backoff beyond the SDK's
  built-in retries.

## Layout

```
fixtures/          synthetic alert + source documents
src/
  client.ts        Anthropic client, model pinned in one place
  schema.ts        every shape that crosses a step boundary
  llm.ts           the ONLY path to the model; audits every call
  audit.ts         append-only JSONL trace
  fixtures.ts      loads the alert and sources; ids come from filenames
  case-file.ts     renders the analyst's package
  pipeline.ts      the orchestrator and the human gate
  steps/
    extract.ts     the only step that sees raw documents
    summarize.ts   facts in, cited narrative out
    review.ts      tries to break the draft
```

Built with [Claude Code](https://claude.com/claude-code).
