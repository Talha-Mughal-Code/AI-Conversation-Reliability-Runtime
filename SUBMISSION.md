# Product Engineering Challenge Submission

## Candidate

- **Name:** Talha Mughal
- **Email:** devtalhamughal@gmail.com
- **GitHub:** [@Talha-Mughal-Code](https://github.com/Talha-Mughal-Code)
- **Repository:** https://github.com/Talha-Mughal-Code/AI-Conversation-Reliability-Runtime
- **Selected problem:** Problem 5 — Reliable AI Conversation Runtime
- **Demo video:** _TODO — paste the Loom/YouTube/Drive link here and check that it opens in a logged-out browser_

---

## Run the project

Prerequisites: **Node 20+** (uses `node:util` `parseArgs`, global `fetch`, `AbortSignal`). No database, no Docker, no API key required.

```bash
npm install
npm test          # 58 tests
npm run bench     # the verification benchmark
```

### Trigger the successful scenario

```bash
npm run cli -- demo success
```

Streams a reply, reaches `completed`, and persists both the user and assistant messages.

### Trigger the failure / recovery scenarios

Each is one command. All are deterministic and need no credentials:

```bash
npm run cli -- demo rejection          # policy blocks the input; provider never called
npm run cli -- demo cancellation       # caller cancels after 3 chunks
npm run cli -- demo timeout            # provider stalls; deadline fires
npm run cli -- demo provider_failure   # provider errors after partial output
npm run cli -- demo terminal_race      # deadline and cancellation collide; one wins
```

Then inspect what was committed:

```bash
npm run cli -- history      # transcript: only completed turns have an assistant message
npm run cli -- runs         # every run, its terminal state, and whether partial output was retained
npm run cli -- trace <runId>  # the full ordered operational trace for one run
```

For a free-form turn, `Ctrl-C` cancels the **turn** (not the process), so the terminal state and record are still written:

```bash
npm run cli -- chat "explain the Meiji restoration"
```

### Browser demo

```bash
npm run serve        # then open http://localhost:8787
```

A single static page (`public/index.html`, no build step, no framework) that streams a
turn, lets you cancel it mid-stream, and shows the persisted transcript, the run table and
the operational trace side by side. It is a thin client over the same SSE endpoint the CLI
and `curl` use and contains no runtime logic of its own.

The clearest thing to try: click **cancellation**, then **Cancel** while text is streaming.
The run lands as `cancelled` with its partial text retained on the run record, and the
transcript beside it shows a user message and **no assistant message**.

Two things about the page are presentation-only and marked as such in the code:

- chunks are paced ~90ms apart so streaming is visible to a human — skipped for
  deadline-driven scenarios, where adding real delay would change the outcome;
- the `cancellation` scenario gets a trailing `stall()` over HTTP, because there the
  canceller is the client rather than a driver cancelling after N chunks.

### HTTP/SSE directly

```bash
npm run serve
```

```bash
curl -N -X POST localhost:8787/turns -d '{"input":"hello"}'
curl -N -X POST 'localhost:8787/turns?scenario=timeout' -d '{}'
curl -N -X POST 'localhost:8787/turns?scenario=provider_failure' -d '{}'
curl localhost:8787/runs/<runId>
curl localhost:8787/conversations/conv_http/messages
```

`?scenario=` supplies the scenario's input, its scripted provider **and** its deadline, so every scenario reaches the same terminal state it does on the CLI. All six are available.

Closing the connection mid-stream produces a `cancelled` run, the same path `Ctrl-C` uses in the CLI:

```bash
curl -N --max-time 1 -X POST 'localhost:8787/turns?scenario=cancellation' -d '{}'
npm run cli -- runs --conversation conv_http
```

Observed: `cancelled`, partial output retained on the run record, and no assistant message in the transcript.

### Optional: a live model provider

Both are free-tier friendly. Tests and the benchmark never touch them.

```bash
GROQ_API_KEY=... npm run cli -- chat "hello" --provider groq
GEMINI_API_KEY=... npm run cli -- chat "hello" --provider gemini
```

Environment variables used: `GROQ_API_KEY`, `GEMINI_API_KEY`, `PROVIDER`, `PORT`, `RUNTIME_DATA_DIR`. No secret values are committed.

### A note on `npm audit`

The shipped runtime has **zero production dependencies** — `dependencies` in `package.json` is empty. `npm install` currently reports two *moderate* advisories, both the same one (`@vitest/mocker` path traversal) reaching us through the test runner.

It is not exploitable here: the advisory applies to Vitest's browser/UI server, which this project never starts — there is no `--ui` or browser-mode configuration, and `npm test` runs headless.

It is also not fixable on Node 20: the patched release is Vitest 4.1.11+, and Vitest 5 requires Node >= 22.12. Running `npm audit fix --force` would install Vitest 5 and break the suite for any reviewer on Node 20. I upgraded to the newest Node-20-compatible release (3.2.7), which clears the previously reported critical and high advisories, and stopped there deliberately rather than trading a working test suite for a clean audit line.

---

## Run the tests

```bash
npm test          # vitest, 58 tests across 7 files
npm run typecheck # tsc --noEmit, strict
```

The suite runs in roughly 400ms. It uses a scripted provider and an injected clock: **no network, no paid API, and no `sleep` of any kind.** A test that needs more than a second is treated as a bug — `vitest.config.ts` caps `testTimeout` at 5s to keep that honest.

---

## Acceptance scenarios and verification

All seven acceptance criteria are implemented and tested.

| AC | Behaviour | Where it is proven |
| --- | --- | --- |
| AC1 | Successful streamed turn | `tests/runtime.test.ts` → "AC1 successful streamed turn" |
| AC2 | Pre-response rejection, provider never called | `tests/runtime.test.ts` → asserts `provider.callCount === 0` |
| AC3 | Cancellation during streaming | asserts `chunksEmitted === 3` of 8 — production stopped |
| AC4 | Timeout | injected clock + a stalling provider; zero real waiting |
| AC5 | Provider failure after partial output | partial retained, traceable, no assistant message |
| AC6 | Terminal-state race | one winner; the loser is refused **and recorded** |
| AC7 | Safe operational trace | secrets redacted; hidden reasoning absent from trace *and* store |

### Verification benchmark

```bash
npm run bench                  # 6 scenarios x 10 iterations = 60 runs
npm run bench -- --iterations 25
```

Exit code is `0` on pass and `1` on any violation. **Observed result** (copied from a real run, not an expectation):

```
Reliable AI Conversation Runtime - verification benchmark
60 runs (6 scenarios x 10 iterations), scripted provider, injected clock, no network

scenario          runs  terminal          chunks  provider  assistant  partial
----------------  ----  ----------------  ------  --------  ---------  -------
success             10  completed             12       yes         10       no
rejection           10  rejected               0        no          0       no
cancellation        10  cancelled              3       yes          0      yes
timeout             10  timed_out              2       yes          0      yes
provider_failure    10  failed                 2       yes          0      yes
terminal_race       10  timed_out              2       yes          0      yes

terminal state counts
  completed      10
  rejected       10
  cancelled      10
  timed_out      20
  failed         10
  (unsettled)     0

invariants
  [PASS] the domain accepts exactly one terminal transition          60/60
  [PASS] the trace reports the same single terminal state            60/60
  [PASS] a losing terminal claim is refused and recorded             10/10
  [PASS] rejected runs never invoke the provider                     10/10
  [PASS] non-completed runs persist no assistant response            50/50
  [PASS] completed runs persist exactly one assistant response       10/10
  [PASS] no lifecycle event follows the terminal event               60/60
  [PASS] post-terminal diagnostics are limited to the documented set  60/60
  [PASS] partial output is retained on the run record, never as a message  40/40
  [PASS] trace sequence numbers are dense and ordered                60/60

RESULT: PASS (0 violations, 10ms)
```

Output is byte-identical across separate process invocations (verified by diffing two runs).

### Two deviations from the brief, both deliberate

**1. I added a sixth scenario, `terminal_race`.**
The brief lists five. Running only those five, *nothing in the benchmark ever races two terminal claims* — in the timeout and cancellation scenarios the provider simply unwinds and no second claim is attempted. AC6's invariant was being asserted over runs that never exercised it. `terminal_race` schedules a cancellation at the exact deadline instant so both claims land in one synchronous batch, and the deadline (registered first) wins deterministically.

**2. "No events appear after a terminal event" is enforced precisely, not literally.**
Committing the outcome and recording a *losing* terminal claim both necessarily happen after the run settles. Suppressing them would hide exactly the behaviour AC6 asks to be observable. So trace events are typed `lifecycle | diagnostic`:

- the recorder **seals lifecycle events** at the terminal event — no lifecycle event can follow it;
- post-terminal **diagnostics** are permitted, and the benchmark asserts every one of them is on a documented allow-list of seven types (`terminal.refused`, `provider.unwound`, `commit.assistant_message`, …).

Both halves are benchmark invariants. If you would rather see the literal reading, the change is one line in `TraceRecorder.diagnostic`.

### Mutation testing — what actually has teeth

A benchmark that cannot fail is worthless, so I broke the code on purpose and checked that it complained:

| Mutation | Caught? |
| --- | --- |
| Persist an assistant message for every terminal state | Yes — 2 invariants, 70 runs |
| Invoke the provider before the policy gate decides | Yes — 10/10 rejected runs |
| Remove the terminal latch **only** | **No** — absorbed by the transition table |
| Remove the chunk-loop `settled` check **only** | **No** — absorbed by `appendChunk`'s own guard |
| Remove the latch **and** open a terminal→terminal edge | Yes — 4 benchmark violations + 8 unit tests |

The two misses are honest findings rather than gaps I am hiding. Terminal states have **no outgoing edges**, so the transition table already prevents re-entry; the explicit `terminal !== null` check is a deliberate second layer that (a) returns the correct refusal reason — `already_terminal` rather than `illegal_transition` — and (b) stays correct if someone later adds an edge by mistake. The same redundancy exists between the streaming loop's `run.settled` check and `appendChunk`'s guard. I kept both layers; I am not claiming either is load-bearing on its own.

---

## Architecture and data flow

```
            ┌──────────────┐        ┌──────────────┐
  CLI  ────▶│              │        │  PolicyEngine│  no provider import:
  HTTP ────▶│  TurnRuntime │───1───▶│  (rule-based)│  cannot call a model
            │              │        └──────────────┘
            │  orchestrator│        ┌──────────────┐
            │              │───3───▶│ ModelProvider│  scripted | groq | gemini
            │   settle()   │◀──────▶│  (AbortSignal)│
            └───┬──────┬───┘        └──────────────┘
                │      │            ┌──────────────┐
                │      └─────2,4───▶│ Conversation │  commit rules live here
                │                   │    Store     │
                │                   └──────────────┘
                ▼
         ┌─────────────┐    ┌──────────────┐
         │  Run        │    │TraceRecorder │
         │ (the latch) │    │  + redact()  │
         └─────────────┘    └──────────────┘
```

**Flow of one turn:** gate → commit user message → stream → settle → commit outcome.

| Component | Owns | Deliberately does not know about |
| --- | --- | --- |
| `domain/Run` | State, transitions, accumulated text | Clocks, I/O, providers, logging |
| `domain/states` | The transition table | Everything else |
| `policy/` | Allow/reject + a rule id | Providers — there is no import |
| `provider/` | Vendor wire formats → `chunk`/`done` | The state machine, the store |
| `runtime/TurnRuntime` | Sequencing, deadline, abort wiring | Vendor formats, storage engine |
| `trace/` | Ordered events + redaction | Business meaning of a run |
| `store/` | Durability + commit rules | How a turn is executed |
| `cli/`, `http/` | Presentation and transport only | All of the above |

### Three racers, one door

A turn can be ended by the provider finishing, the deadline firing, or the caller cancelling. All three call the same function:

```ts
const settle = (state, detail) => {
  const claim = run.transition(state, detail);   // synchronous claim
  if (!claim.accepted) {
    trace.diagnostic('terminal.refused', { attempted: state, held: claim.state });
    return false;                                 // loser performs no I/O at all
  }
  trace.lifecycle(`run.${state}`, detail);
  return true;
};
```

The claim is synchronous and the I/O happens afterwards, so **by the time any racer awaits anything, it already knows whether it won.** `tests/latch-await-race.test.ts` demonstrates why that ordering is necessary by including the broken shape — check, `await`, then act — and showing it double-settles.

### Commit rules

These are the heart of "never represent a non-success as a success". Stated on `ConversationStore` and asserted in five tests:

1. The **user message** is committed only after the policy gate allows, and before the provider is invoked. A rejected input never enters the transcript at all.
2. The **assistant message** is committed only on the `completed` transition, only by the caller that won the latch.
3. **Partial output** from a cancelled, timed-out or failed run is retained on the run record and never appended as a message. Operators can see what was produced; the product never presents it as a delivered reply.
4. A **run record** is written for every terminal outcome, including rejection.

You can see all four in one screen:

```
$ npm run cli -- history
user      When did Tokyo become the capital of Japan?
assistant Tokyo has been the capital of Japan since 1868, ...
user      Tell me about Japanese history at length.
user      Explain the Boshin war.

$ npm run cli -- runs
run_faaca943...  completed  chunks=12  provider=true
run_b58f8817...  rejected   chunks=0   provider=false
run_208e1682...  cancelled  chunks=3   provider=true partial-output-retained
run_bbb4add6...  failed     chunks=2   provider=true partial-output-retained
```

Four runs, one assistant message, and the rejected turn has no user message either.

---

## Technology choices

**TypeScript + Node 20.** Cancellation is the crux of this problem, and `AbortController`/`AbortSignal` is the platform primitive that both `fetch` and async iterators already understand — so cancellation propagates to a real HTTP socket without hand-rolled plumbing. Async generators give ordered streaming with natural backpressure. Zero runtime dependencies; `vitest`, `tsx` and `typescript` are dev-only, so reviewer setup is `npm install`.

**Alternatives considered:**

- **Go** — `context.Context` is arguably a better cancellation model and real preemptive threads would make the terminal race "harder". I decided against it: the multi-process limitation (below) is identical in Go, so it buys ceremony rather than correctness, and the brief grades state-machine modelling, not mutex mechanics.
- **Python + asyncio** — comparable semantics, but the same single-process caveat plus a weaker story for typed state transitions.
- **A real database (SQLite/Postgres)** — the exercise is about the *commit boundary*, not the storage engine. A JSON file behind a `ConversationStore` port keeps records inspectable with `cat` during the demo and makes the swap a one-file change. Trade-off accepted: no transactions, no concurrent writers across processes.
- **A framework (Express/Fastify)** — the HTTP layer is ~190 lines of `node:http`. A framework would add dependencies without changing any graded behaviour.

**Groq and Gemini** rather than a paid provider, because both have usable free tiers. Having *two* live adapters plus the fake was worth it: it forced the provider port to be genuinely vendor-neutral, and both vendors ship hidden reasoning (`delta.reasoning`, `parts[].thought`) which made the "no hidden reasoning in the trace" requirement concrete rather than theoretical.

---

## Important decisions

### 1. Hidden reasoning is excluded by the type system, not by redaction

`ProviderEvent` is `{ type: 'chunk'; text: string } | { type: 'done' }`. There is **no variant capable of carrying reasoning**. Adapters read `delta.reasoning` / `parts[].thought` and drop them at the translation boundary; nothing downstream could forward them even with a bug. Redaction is a second layer for secrets that arrive inside ordinary prose (`Bearer …`, `sk-…`, `gsk_…`, `AIza…`), not the primary defence.

The same reasoning drove the policy gate: `PolicyEngine` imports no provider type, so "the provider is never called on rejection" is a property of the module graph rather than of statement ordering.

### 2. A stream that ends without a completion event is `failed`, not `completed`

If a provider closes its stream mid-flight, treating that as success would be a silent lie — the user would see a truncated answer presented as finished. The runtime settles `provider.truncated_stream` → `failed` instead. Encoded structurally too: `completed` is reachable only from `streaming`, and `rejected` only from `screening`.

### 3. The run record is an operational surface; the transcript is user data

Found while testing: the trace was redacted but `StoredRun.input` still held a raw `Bearer` token. That forced an explicit ruling rather than a patch. **The transcript keeps the user's words verbatim** — it is their data and the product's own record. **The run record's `input` is redacted** — operators read run records in bulk, and that is an ops surface. Both halves are now asserted in one test in `tests/store.test.ts`.

---

## Assumptions and limitations

**Assumptions**

- One turn per run; no multi-turn conversation history is sent to the provider (the brief scopes this to a single turn).
- The policy gate is a plausible deterministic stand-in for a safety classifier, not a real one. Four ordered rules, first match wins, so every decision is attributable to one `ruleId`.
- The timeout covers the whole turn including the policy gate, so a slow gate cannot extend a turn past its bound.
- On a tie between the deadline and a cancellation, the deadline wins because the runtime registers its timer first. Deterministic, and asserted — but it is a consequence of registration order, not a product rule. If the product wanted cancellation to win, that would be an explicit priority in `settle()`.

**Limitations (known and deliberate)**

- **The terminal latch is in-process.** JavaScript being single-threaded does *not* make it free — every `await` is a yield point, and check-then-act across one is a genuine bug (demonstrated in `tests/latch-await-race.test.ts`). The latch is correct because its critical section is synchronous. But behind multiple processes it would not hold; see below.
- **The file store has no cross-process locking.** Writes are serialised within one process and atomic via temp-file + rename, which is enough for a CLI and a single server, and not enough for two.
- No authentication, authorisation, rate limiting or multi-tenancy — out of scope per the brief.
- No retry or fallback across providers. A provider failure is terminal for the turn by design; retrying is a product decision that would need its own idempotency story.
- **The timeout is a single whole-turn budget, which is the wrong shape for reasoning models.** One number cannot distinguish "thinking for 40 seconds before the first token" from "died after three words", and the submitted defaults (10s CLI, 30s HTTP) would cut off a healthy reasoning model. Design for the fix is in *Production and scale* below. I found this while pointing the runtime at a live reasoning model rather than by reading the code.
- The live Groq/Gemini adapters are **not covered by automated tests** (they would need network). They share the tested SSE reader, and the runtime treats them through the same port as the fake — but I want to be clear that their happy path is verified by hand, not by CI.
- The browser page is a deliberately minimal demo client, not a chat product: no history navigation, no retry, no responsive design work. The brief puts a polished chat interface out of scope, and it carries no state-machine logic that would need testing on its own.

---

## Production and scale

Distinguishing clearly between what the submitted code does now and what I would change.

**What it does now:** a single process owns the latch in memory, persists JSON to disk, and holds streaming state for the life of one turn.

**What I would change first, in order:**

1. **Replace the single timeout with three budgets.** Today one deadline covers the whole turn. That conflates two unrelated failures: a model that is slow to *start* and a stream that has *died*. Reasoning models sit squarely in the gap — they legitimately emit nothing for tens of seconds before the first token.

   | Budget | Guards against | Default I would pick |
   | --- | --- | --- |
   | First chunk | model never starts | 60-90s, generous; thinking lives here |
   | Idle | stream dies mid-answer | 15-20s, reset on every chunk |
   | Total | runaway turn | 5 minutes, hard ceiling |

   There is a trap in the obvious version of this, and it is specific to the privacy guarantee in decision 1. Reasoning models *are* sending data while they think — Groq's `delta.reasoning`, Gemini's `thought` parts — and this runtime deliberately discards it at the adapter. So a healthy, actively-thinking model looks completely silent to the orchestrator, and a naive "no data means dead" idle timer would kill exactly the models the change is meant to support.

   The fix is to separate *liveness* from *content*: add a `{ type: 'activity' }` provider event that carries no text, emitted by adapters when reasoning tokens or keep-alives arrive. It resets the idle timer and is never recorded or displayed. The model proves it is alive without revealing what it is thinking, and `ProviderEvent` still has no channel capable of carrying reasoning.

   I left this out of the submitted code deliberately. The brief asks for "a configurable timeout" and AC4 is satisfied by the one that exists; building a three-budget scheme is the first thing that would have gone beyond the brief, and I would rather hand over a correct small thing plus an honest account of its limits.

2. **Move the latch into the database.** `Run.transition()` is the single seam — every terminal path already funnels through it. The production version becomes a conditional write (`UPDATE runs SET terminal_state = $1 WHERE id = $2 AND terminal_state IS NULL`) and the returned row count replaces `accepted`. The signature and all call sites stay as they are; this is a one-file change *because* the latch was centralised, which is the main reason it is centralised.
3. **Make the commit rules a transaction.** Today "append assistant message" and "save run record" are two writes. A crash between them leaves a completed run with no message. They belong in one transaction, which also gives the assistant message an idempotency key so a retried commit cannot duplicate it.
4. **Decouple streaming from the request.** Cancellation currently arrives via the HTTP response's `close` event, so a client that reconnects cannot resume. Production would publish chunks to a per-run channel with a durable cursor — essentially Problem 1 of this challenge — so a dropped connection is not automatically a cancellation.
5. **Ship the trace to a real sink.** It is structured and redacted already; the change is emitting to OpenTelemetry rather than holding it on the run record, plus sampling chunk events (one per chunk does not scale to long replies — I would keep first/last and a count).
6. **Bound concurrency per provider** with a queue and circuit breaker. `provider.http_error` currently fails one turn; at scale a provider outage should shed load rather than have every turn independently discover it.

**What I would *not* change:** the component boundaries. The policy gate, provider port, and store port are each swappable without touching the state machine, and that is the property that makes the above changes small.

---

## AI usage

I used **Claude (Claude Code)** throughout, as an implementation pair rather than a code generator I accepted blindly.

**What it contributed:** the module scaffolding, the bulk of the test bodies, the CLI/benchmark formatting, and the Groq/Gemini adapters.

**What I directed:** the architecture — the terminal latch as the single seam, the decision to give `ProviderEvent` no channel for reasoning, the four commit rules, the `lifecycle`/`diagnostic` split, and the choice to add a sixth benchmark scenario.

**How I reviewed it:** every change ran against `tsc --noEmit` and the full suite. More importantly, I mutation-tested the benchmark (table above) rather than trusting a green result — which is how I found that the benchmark was checking the trace instead of the domain log, and that no scenario actually exercised the latch. Several bugs surfaced this way and are documented rather than quietly fixed: `chunked()` returning `n-1` chunks, the raw token in `StoredRun.input`, listening for disconnects on the wrong Node event, and a `FakeClock` that flushed between same-instant timers and so hid genuine collisions.

> _TODO — adjust the above to reflect your own division of labour before submitting. Reviewers will ask you to walk through any part of this code, so make sure this section is true of you._

---

## Credibility note

> _TODO — this section is yours to write; I cannot write it for you._
>
> Cover, in a short paragraph or a few bullets:
>
> - **The product or system** and the problem it solved
> - **Your personal contribution** — what you specifically owned, not what the team did
> - **Scale or operational complexity** — users, traffic, concurrency, data volume, latency, reliability, cost, or deployment/on-call responsibility. Approximate figures are fine.
> - **One difficult engineering or product decision** you made, and the trade-off you accepted
> - **A public link** — repo, case study, or product page — if one exists
>
> Confidential details may be anonymised. The scorecard rates this separately from the code and rewards *specificity and coherent reasoning* over famous names or large numbers.
