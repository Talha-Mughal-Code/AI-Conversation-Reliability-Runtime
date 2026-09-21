import { parseArgs } from 'node:util';
import { loadEnvFile } from '../config/env.js';
import { randomIds } from '../domain/ids.js';
import { RuleBasedPolicy } from '../policy/policy.js';
import { GeminiProvider } from '../provider/gemini.js';
import { GroqProvider } from '../provider/groq.js';
import { ScriptedProvider, chunked } from '../provider/scripted.js';
import type { ModelProvider } from '../provider/provider.js';
import { SCENARIO_NAMES, getScenario } from '../scenarios.js';
import { FileConversationStore } from '../store/file-store.js';
import { SystemClock } from '../runtime/clock.js';
import { TurnRuntime } from '../runtime/runtime.js';
import { bold, cyan, dim, formatTrace, paintTerminal, red } from './format.js';

const DATA_DIR = process.env.RUNTIME_DATA_DIR ?? '.runtime-data';
const DEFAULT_CONVERSATION = 'conv_local';

const USAGE = `
${bold('Reliable AI Conversation Runtime')}

  npm run cli -- chat "<message>"      Run one turn. Ctrl-C cancels it.
  npm run cli -- demo <scenario>       Run a deterministic scenario.
  npm run cli -- trace <runId>         Print a stored run's operational trace.
  npm run cli -- history               Print the persisted transcript.
  npm run cli -- runs                  List runs and their terminal states.

Scenarios: ${SCENARIO_NAMES.join(', ')}

Options
  --conversation <id>   Conversation to use (default: ${DEFAULT_CONVERSATION})
  --provider <name>     scripted | groq | gemini   (default: scripted)
  --timeout <ms>        Turn deadline (default: 10000)
  --model <name>        Model id for a live provider

Live providers read GROQ_API_KEY or GEMINI_API_KEY from the environment.
`;

function buildProvider(name: string, modelFlag: string | undefined): ModelProvider {
  const model = modelFlag ?? process.env.MODEL;
  if (name === 'groq') {
    const apiKey = requireKey('GROQ_API_KEY');
    return new GroqProvider(model ? { apiKey, model } : { apiKey });
  }
  if (name === 'gemini') {
    const apiKey = requireKey('GEMINI_API_KEY');
    return new GeminiProvider(model ? { apiKey, model } : { apiKey });
  }
  // Deterministic default, so the CLI runs with no credentials at all.
  return new ScriptedProvider(
    chunked('This is a scripted reply from the deterministic provider used for local runs.', 10),
  );
}

function requireKey(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`${variable} is not set. Use --provider scripted to run without credentials.`);
  }
  return value;
}

async function main(): Promise<number> {
  loadEnvFile();
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      conversation: { type: 'string' },
      provider: { type: 'string', default: 'scripted' },
      timeout: { type: 'string', default: '10000' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }

  const store = FileConversationStore.inDirectory(DATA_DIR);
  const conversationId = values.conversation ?? DEFAULT_CONVERSATION;

  switch (command) {
    case 'chat':
    case 'demo':
      return runTurn(command, positionals[1], { store, conversationId, values });
    case 'trace':
      return printTrace(store, positionals[1]);
    case 'history':
      return printHistory(store, conversationId);
    case 'runs':
      return printRuns(store, conversationId);
    default:
      process.stderr.write(`${red(`Unknown command "${command}".`)}\n${USAGE}\n`);
      return 1;
  }
}

interface TurnContext {
  readonly store: FileConversationStore;
  readonly conversationId: string;
  readonly values: { provider?: string; timeout?: string; model?: string };
}

async function runTurn(
  command: string,
  argument: string | undefined,
  ctx: TurnContext,
): Promise<number> {
  const { store, conversationId, values } = ctx;

  if (!argument) {
    process.stderr.write(red(`${command} needs an argument.\n`));
    return 1;
  }

  const scenario = command === 'demo' ? getScenario(argument) : null;
  const input = scenario ? scenario.input : argument;
  const timeoutMs = scenario ? scenario.timeoutMs : Number(values.timeout ?? '10000');
  const provider = scenario
    ? new ScriptedProvider(scenario.script)
    : buildProvider(values.provider ?? 'scripted', values.model);

  if (scenario) {
    process.stdout.write(`${dim(`scenario: ${scenario.name} - ${scenario.description}`)}\n`);
  }

  const runtime = new TurnRuntime({
    policy: new RuleBasedPolicy(),
    provider,
    store,
    clock: new SystemClock(),
    ids: randomIds,
    timeoutMs,
  });

  const controller = new AbortController();
  // Ctrl-C cancels the turn rather than killing the process, so the terminal
  // state and the persisted record are still written.
  const onSigint = () => {
    process.stdout.write(dim('\n(cancelling...)\n'));
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  process.stdout.write(`${cyan('you')} ${input}\n${cyan('bot')} `);

  let shown = 0;
  const startedAt = Date.now();
  const result = await runtime.execute(
    { conversationId, input },
    {
      signal: controller.signal,
      onChunk: (text) => {
        process.stdout.write(text);
        shown += 1;
        if (scenario?.cancelAfterChunks === shown) controller.abort();
      },
    },
  );
  process.off('SIGINT', onSigint);

  const partial =
    result.outputIsPartial && result.chunkCount > 0 ? dim(' (output is partial)') : '';
  process.stdout.write('\n\n');
  process.stdout.write(`  run        ${result.runId}\n`);
  process.stdout.write(`  state      ${paintTerminal(result.terminalState)}\n`);
  process.stdout.write(`  policy     ${result.decision.ruleId}\n`);
  process.stdout.write(`  chunks     ${result.chunkCount}${partial}\n`);
  if (result.termination) {
    process.stdout.write(`  reason     ${result.termination.code} - ${result.termination.message}\n`);
  }
  process.stdout.write(`\n${dim('trace')}\n${formatTrace(result.trace, startedAt)}\n`);
  process.stdout.write(`\n${dim(`inspect records: npm run cli -- trace ${result.runId}`)}\n`);

  return result.terminalState === 'completed' ? 0 : 2;
}

async function printTrace(store: FileConversationStore, runId: string | undefined): Promise<number> {
  if (!runId) {
    process.stderr.write(red('trace needs a run id.\n'));
    return 1;
  }
  const run = await store.getRun(runId);
  if (!run) {
    process.stderr.write(red(`No stored run ${runId}.\n`));
    return 1;
  }

  process.stdout.write(`${bold(run.runId)}  ${paintTerminal(run.terminalState)}\n`);
  process.stdout.write(`  input          ${JSON.stringify(run.input)}\n`);
  process.stdout.write(`  policy rule    ${run.policyRuleId}\n`);
  process.stdout.write(`  provider used  ${run.providerInvoked}\n`);
  process.stdout.write(`  output         ${JSON.stringify(run.outputText)}\n`);
  process.stdout.write(`  partial        ${run.outputIsPartial}\n`);
  process.stdout.write(`\n${formatTrace(run.trace, run.startedAt)}\n`);
  return 0;
}

async function printHistory(store: FileConversationStore, conversationId: string): Promise<number> {
  const messages = await store.listMessages(conversationId);
  if (messages.length === 0) {
    process.stdout.write(
      dim('No persisted messages. Only completed turns write an assistant message.\n'),
    );
    return 0;
  }
  for (const message of messages) {
    process.stdout.write(`${cyan(message.role.padEnd(9))} ${message.text}\n`);
  }
  return 0;
}

async function printRuns(store: FileConversationStore, conversationId: string): Promise<number> {
  const runs = await store.listRuns(conversationId);
  if (runs.length === 0) {
    process.stdout.write(dim('No runs recorded yet.\n'));
    return 0;
  }
  for (const run of runs) {
    const partial = run.outputIsPartial && run.outputText ? dim(' partial-output-retained') : '';
    // Escape codes would count toward padEnd's width, so pad with the plain
    // string's length and colour only the word itself.
    const pad = ' '.repeat(Math.max(0, 10 - run.terminalState.length));
    const state = `${paintTerminal(run.terminalState)}${pad}`;
    const chunks = String(run.chunkCount).padEnd(3);
    process.stdout.write(
      `${run.runId}  ${state} chunks=${chunks} provider=${run.providerInvoked}${partial}\n`,
    );
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${red(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
