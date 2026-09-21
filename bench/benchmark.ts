/**
 * Verification benchmark for Problem 5.
 *
 * Runs every deterministic scenario N times (default 10) and checks the
 * state-machine invariants the brief asks for. No live model, no network, no
 * sleeps: the provider is scripted and the clock is injected, so the whole
 * benchmark settles in milliseconds and produces identical output every run.
 *
 *   npm run bench
 *   npm run bench -- --iterations 25
 */
import { parseArgs } from 'node:util';
import { sequentialIds } from '../src/domain/ids.js';
import type { TerminalState } from '../src/domain/states.js';
import { TERMINAL_STATES, isTerminal } from '../src/domain/states.js';
import { RuleBasedPolicy } from '../src/policy/policy.js';
import { ScriptedProvider } from '../src/provider/scripted.js';
import { FakeClock, flush } from '../src/runtime/clock.js';
import { TurnRuntime } from '../src/runtime/runtime.js';
import { SCENARIO_NAMES, SCENARIOS, type Scenario, type ScenarioName } from '../src/scenarios.js';
import { InMemoryConversationStore } from '../src/store/store.js';
import { isTerminalEventType, type TraceEvent } from '../src/trace/trace.js';

/**
 * Diagnostics that may legitimately follow the terminal lifecycle event.
 *
 * The brief's invariant is "no events appear after a terminal event". Committing
 * the outcome and recording a losing racer both happen after the run settles, by
 * design -- suppressing them would hide exactly the behaviour AC6 asks to be
 * observable. So the invariant is enforced precisely: no *lifecycle* event after
 * the terminal one, and every post-terminal diagnostic must be one of these.
 */
const POST_TERMINAL_DIAGNOSTICS: ReadonlySet<string> = new Set([
  'terminal.refused',
  'provider.unwound',
  'provider.event_after_terminal',
  'provider.chunk_dropped',
  'commit.assistant_message',
  'commit.partial_retained',
  'trace.after_terminal_suppressed',
]);

interface Observation {
  readonly scenario: ScenarioName;
  readonly runId: string;
  readonly terminalState: TerminalState;
  readonly chunkCount: number;
  readonly providerInvoked: boolean;
  readonly providerCallCount: number;
  readonly outputIsPartial: boolean;
  readonly assistantMessages: number;
  readonly partialRetained: boolean;
  /** Terminal transitions the domain actually accepted. Must be exactly 1. */
  readonly acceptedTerminalTransitions: number;
  readonly refusedTerminalTransitions: number;
  readonly trace: readonly TraceEvent[];
  /** Stable fingerprint used to prove repeatability across iterations. */
  readonly signature: string;
}

async function runOnce(
  scenario: Scenario,
  ids: ReturnType<typeof sequentialIds>,
): Promise<Observation> {
  const clock = new FakeClock();
  const provider = new ScriptedProvider(scenario.script);
  // A store per run keeps the assistant-message assertion scoped to this run.
  const store = new InMemoryConversationStore();

  const runtime = new TurnRuntime({
    policy: new RuleBasedPolicy(),
    provider,
    store,
    clock,
    ids,
    timeoutMs: scenario.timeoutMs,
  });

  const controller = new AbortController();
  let shown = 0;

  const pending = runtime.execute(
    { conversationId: 'bench', input: scenario.input },
    {
      signal: controller.signal,
      onChunk: () => {
        shown += 1;
        if (scenario.cancelAfterChunks === shown) controller.abort();
      },
    },
  );

  if (scenario.expectedTerminal === 'timed_out') {
    // Let the turn reach its stall, then move the injected clock past the
    // deadline. Nothing here waits on real time.
    await flush();
    // Registered after the runtime's own deadline, so on a tie the deadline
    // holds the latch and this cancellation is the one that gets refused.
    if (scenario.cancelAtMs !== undefined) {
      clock.setTimer(scenario.cancelAtMs, () => controller.abort());
    }
    await clock.advance(scenario.timeoutMs);
  }

  const result = await pending;

  const messages = await store.listMessages('bench');
  const assistantMessages = messages.filter((m) => m.role === 'assistant').length;
  const storedRun = await store.getRun(result.runId);

  return {
    scenario: scenario.name,
    runId: result.runId,
    terminalState: result.terminalState,
    chunkCount: result.chunkCount,
    providerInvoked: result.providerInvoked,
    providerCallCount: provider.callCount,
    outputIsPartial: result.outputIsPartial,
    assistantMessages,
    partialRetained: (storedRun?.outputText.length ?? 0) > 0 && storedRun?.outputIsPartial === true,
    acceptedTerminalTransitions: result.transitions.filter((t) => isTerminal(t.to)).length,
    refusedTerminalTransitions: result.trace.filter((e) => e.type === 'terminal.refused').length,
    trace: result.trace,
    signature: [
      result.terminalState,
      result.chunkCount,
      result.outputText.length,
      result.decision.ruleId,
      result.trace.map((e) => e.type).join('>'),
    ].join('|'),
  };
}

interface Invariant {
  readonly label: string;
  /** Runs this invariant applies to. */
  readonly applies: (o: Observation) => boolean;
  /** True when the run satisfies it. */
  readonly holds: (o: Observation) => boolean;
}

const INVARIANTS: readonly Invariant[] = [
  {
    // Asserted against the domain's transition log. The trace seals itself at the
    // terminal event, so checking the trace alone would pass even with the latch
    // removed -- the two guards would mask each other.
    label: 'the domain accepts exactly one terminal transition',
    applies: () => true,
    holds: (o) => o.acceptedTerminalTransitions === 1,
  },
  {
    label: 'the trace reports the same single terminal state',
    applies: () => true,
    holds: (o) => {
      const terminals = o.trace.filter((e) => e.kind === 'lifecycle' && isTerminalEventType(e.type));
      return terminals.length === 1 && terminals[0]!.type === `run.${o.terminalState}`;
    },
  },
  {
    label: 'a losing terminal claim is refused and recorded',
    applies: (o) => o.scenario === 'terminal_race',
    holds: (o) => o.refusedTerminalTransitions >= 1 && o.acceptedTerminalTransitions === 1,
  },
  {
    label: 'rejected runs never invoke the provider',
    applies: (o) => o.terminalState === 'rejected',
    holds: (o) =>
      o.providerCallCount === 0 &&
      !o.providerInvoked &&
      !o.trace.some((e) => e.type === 'provider.invoked'),
  },
  {
    label: 'non-completed runs persist no assistant response',
    applies: (o) => o.terminalState !== 'completed',
    holds: (o) => o.assistantMessages === 0,
  },
  {
    label: 'completed runs persist exactly one assistant response',
    applies: (o) => o.terminalState === 'completed',
    holds: (o) => o.assistantMessages === 1 && !o.outputIsPartial,
  },
  {
    label: 'no lifecycle event follows the terminal event',
    applies: () => true,
    holds: (o) => {
      const lifecycle = o.trace.filter((e) => e.kind === 'lifecycle');
      const terminalAt = lifecycle.findIndex((e) => isTerminalEventType(e.type));
      return terminalAt === lifecycle.length - 1;
    },
  },
  {
    label: 'post-terminal diagnostics are limited to the documented set',
    applies: () => true,
    holds: (o) => {
      const terminalSeq = o.trace.find(
        (e) => e.kind === 'lifecycle' && isTerminalEventType(e.type),
      )?.seq;
      if (terminalSeq === undefined) return false;
      return o.trace
        .filter((e) => e.seq > terminalSeq)
        .every((e) => POST_TERMINAL_DIAGNOSTICS.has(e.type));
    },
  },
  {
    label: 'partial output is retained on the run record, never as a message',
    applies: (o) => o.terminalState !== 'completed' && o.chunkCount > 0,
    holds: (o) => o.partialRetained && o.assistantMessages === 0,
  },
  {
    label: 'trace sequence numbers are dense and ordered',
    applies: () => true,
    holds: (o) => o.trace.every((e, i) => e.seq === i),
  },
];

function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { iterations: { type: 'string', default: '10' } },
  });
  const iterations = Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 1) {
    process.stderr.write('--iterations must be a positive integer.\n');
    return Promise.resolve(1);
  }
  return execute(iterations);
}

async function execute(iterations: number): Promise<number> {
  const started = Date.now();
  const observations: Observation[] = [];
  const ids = sequentialIds();

  for (const name of SCENARIO_NAMES) {
    for (let i = 0; i < iterations; i++) {
      observations.push(await runOnce(SCENARIOS[name], ids));
    }
  }

  const failures: string[] = [];
  const line = (text = '') => process.stdout.write(`${text}\n`);

  line();
  line('Reliable AI Conversation Runtime - verification benchmark');
  line(
    `${observations.length} runs (${SCENARIO_NAMES.length} scenarios x ${iterations} iterations), ` +
      'scripted provider, injected clock, no network',
  );

  // --- per scenario -------------------------------------------------------
  line();
  line('scenario          runs  terminal          chunks  provider  assistant  partial');
  line('----------------  ----  ----------------  ------  --------  ---------  -------');

  for (const name of SCENARIO_NAMES) {
    const group = observations.filter((o) => o.scenario === name);
    const expected = SCENARIOS[name];
    const first = group[0]!;

    const states = new Set(group.map((o) => o.terminalState));
    if (states.size !== 1 || !states.has(expected.expectedTerminal)) {
      failures.push(
        `${name}: expected every run to end ${expected.expectedTerminal}, saw ${[...states].join(', ')}`,
      );
    }

    const chunkCounts = new Set(group.map((o) => o.chunkCount));
    if (chunkCounts.size !== 1 || !chunkCounts.has(expected.expectedChunks)) {
      failures.push(
        `${name}: expected ${expected.expectedChunks} chunks, saw ${[...chunkCounts].join(', ')}`,
      );
    }

    // Repeatability: identical fingerprints across every iteration.
    const signatures = new Set(group.map((o) => o.signature));
    if (signatures.size !== 1) {
      failures.push(`${name}: not repeatable, ${signatures.size} distinct outcomes across iterations`);
    }

    line(
      [
        name.padEnd(16),
        String(group.length).padStart(4),
        first.terminalState.padEnd(16),
        String(first.chunkCount).padStart(6),
        (first.providerInvoked ? 'yes' : 'no').padStart(8),
        String(group.reduce((sum, o) => sum + o.assistantMessages, 0)).padStart(9),
        (first.partialRetained ? 'yes' : 'no').padStart(7),
      ].join('  '),
    );
  }

  // --- terminal state counts ---------------------------------------------
  line();
  line('terminal state counts');
  for (const state of TERMINAL_STATES) {
    const count = observations.filter((o) => o.terminalState === state).length;
    line(`  ${state.padEnd(12)} ${String(count).padStart(4)}`);
  }
  const unsettled = observations.filter((o) => !TERMINAL_STATES.includes(o.terminalState)).length;
  line(`  ${'(unsettled)'.padEnd(12)} ${String(unsettled).padStart(4)}`);

  // --- invariants ---------------------------------------------------------
  line();
  line('invariants');
  for (const invariant of INVARIANTS) {
    const applicable = observations.filter(invariant.applies);
    const upheld = applicable.filter(invariant.holds);
    const ok = upheld.length === applicable.length;
    if (!ok) {
      failures.push(
        `${invariant.label}: ${applicable.length - upheld.length} of ${applicable.length} runs violated it`,
      );
    }
    line(
      `  [${ok ? 'PASS' : 'FAIL'}] ${invariant.label.padEnd(58)} ${String(upheld.length).padStart(3)}/${String(applicable.length).padEnd(3)}`,
    );
  }

  // --- result -------------------------------------------------------------
  line();
  if (failures.length > 0) {
    line(`RESULT: FAIL (${failures.length} violation${failures.length === 1 ? '' : 's'})`);
    for (const failure of failures) line(`  - ${failure}`);
    line();
    return 1;
  }

  line(`RESULT: PASS (0 violations, ${Date.now() - started}ms)`);
  line();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
