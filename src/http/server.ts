import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../config/env.js';
import { randomIds } from '../domain/ids.js';
import { RuleBasedPolicy } from '../policy/policy.js';
import { GeminiProvider } from '../provider/gemini.js';
import { GroqProvider } from '../provider/groq.js';
import { PacedProvider } from '../provider/paced.js';
import { ScriptedProvider, chunked, stall } from '../provider/scripted.js';
import type { ModelProvider } from '../provider/provider.js';
import { SystemClock } from '../runtime/clock.js';
import { TurnRuntime } from '../runtime/runtime.js';
import { SCENARIO_NAMES, getScenario } from '../scenarios.js';
import { FileConversationStore } from '../store/file-store.js';
import type { ConversationStore } from '../store/store.js';

/**
 * HTTP/SSE front end.
 *
 * Deliberately thin. It owns transport concerns only -- parsing a request,
 * framing SSE, and translating a dropped socket into a cancellation -- and
 * contains no state-machine, policy or persistence logic. The CLI and this
 * server construct the same `TurnRuntime` and get identical semantics, which is
 * the concrete answer to "how would the same core runtime sit behind a web or
 * mobile client".
 *
 * The one genuinely web-specific behaviour is in `POST /turns`: when the client
 * disconnects mid-stream, `request.on('close')` aborts the turn's signal. That
 * is the same path the CLI uses for Ctrl-C, so a browser closing a tab produces
 * a `cancelled` run with its partial output retained, not an orphaned turn.
 */

/** Delay between streamed chunks in the browser demo. Presentation only. */
const CHUNK_PACING_MS = 90;

export interface ServerOptions {
  readonly store: ConversationStore;
  readonly provider: ModelProvider;
  readonly timeoutMs?: number;
}

export function createRuntimeServer(options: ServerOptions): Server {
  /**
   * Runtimes are cheap and hold no state between turns, so one is built per
   * turn. That lets `?scenario=` swap in the scenario's own scripted provider
   * and deadline; everything else about the runtime is identical.
   */
  const makeRuntime = (provider: ModelProvider, timeoutMs: number) =>
    new TurnRuntime({
      policy: new RuleBasedPolicy(),
      provider,
      store: options.store,
      clock: new SystemClock(),
      ids: randomIds,
      timeoutMs,
    });

  const defaultProvider = options.provider;
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;

  return createServer((request, response) => {
    handle(request, response, { makeRuntime, defaultProvider, defaultTimeoutMs }, options.store).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
}

interface RuntimeFactory {
  readonly makeRuntime: (provider: ModelProvider, timeoutMs: number) => TurnRuntime;
  readonly defaultProvider: ModelProvider;
  readonly defaultTimeoutMs: number;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  runtimes: RuntimeFactory,
  store: ConversationStore,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (request.method === 'GET' && path === '/health') {
    return sendJson(response, 200, { ok: true });
  }

  // A single static page, read from disk on each request so it can be edited
  // without restarting. No build step and no bundler: the page talks to the
  // same SSE endpoint curl does.
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html');
    const html = await readFile(file, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }

  if (request.method === 'POST' && path === '/turns') {
    return streamTurn(request, response, runtimes, url);
  }

  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && runMatch) {
    const run = await store.getRun(decodeURIComponent(runMatch[1]!));
    return run ? sendJson(response, 200, run) : sendJson(response, 404, { error: 'unknown run' });
  }

  const runsMatch = /^\/conversations\/([^/]+)\/runs$/.exec(path);
  if (request.method === 'GET' && runsMatch) {
    const runs = await store.listRuns(decodeURIComponent(runsMatch[1]!));
    // Newest first: the page reads [0] to show the turn that just finished,
    // which is the only way it can learn the outcome of a turn it cancelled
    // (aborting the request means the terminal SSE frame never arrives).
    const ordered = [...runs].sort((a, b) => b.startedAt - a.startedAt);
    return sendJson(response, 200, { runs: ordered });
  }

  const messagesMatch = /^\/conversations\/([^/]+)\/messages$/.exec(path);
  if (request.method === 'GET' && messagesMatch) {
    const messages = await store.listMessages(decodeURIComponent(messagesMatch[1]!));
    return sendJson(response, 200, { messages });
  }

  sendJson(response, 404, { error: 'not found' });
}

async function streamTurn(
  request: IncomingMessage,
  response: ServerResponse,
  runtimes: RuntimeFactory,
  url: URL,
): Promise<void> {
  let body: { conversationId?: string; input?: string };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: 'body must be JSON' });
  }

  // `?scenario=` drives a deterministic outcome over HTTP without a live
  // provider. It supplies the scenario's input, its scripted provider AND its
  // deadline -- swapping only the input would let `?scenario=timeout` complete
  // successfully, which would be worse than not offering the parameter.
  const scenarioName = url.searchParams.get('scenario');
  const scenario = scenarioName ? getScenario(scenarioName) : null;
  const input = scenario ? scenario.input : body.input;
  const conversationId = body.conversationId ?? 'conv_http';

  if (typeof input !== 'string') {
    return sendJson(response, 400, { error: 'input is required' });
  }

  // The cancellation scenario is driven by the CLI cancelling after N chunks.
  // Over HTTP the canceller is the client, so the stream has to stay open long
  // enough for them to hang up -- otherwise it completes in a few milliseconds
  // and the scenario cannot demonstrate what it is named after.
  const script =
    scenario?.cancelAfterChunks !== undefined ? [...scenario.script, stall()] : scenario?.script;

  let runtime = runtimes.makeRuntime(runtimes.defaultProvider, runtimes.defaultTimeoutMs);
  if (scenario && script) {
    // Pace chunks so streaming is actually visible in a browser, but never for a
    // deadline-driven scenario: adding real delay there would push the run past
    // its own timeout and change the outcome the scenario exists to demonstrate.
    const paced = scenario.expectedTerminal !== 'timed_out';
    const provider = new ScriptedProvider(script);
    runtime = runtimes.makeRuntime(
      paced ? new PacedProvider(provider, CHUNK_PACING_MS) : provider,
      scenario.timeoutMs,
    );
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const controller = new AbortController();
  // A dropped socket is a cancellation, not a silently orphaned turn.
  //
  // The signal has to come from the RESPONSE, not the request: `request`
  // emits 'close' as soon as the request message is complete, which for a POST
  // is while we are still streaming, and would cancel every turn. The response
  // emits 'close' both on normal completion and on a premature disconnect, so
  // `writableEnded` distinguishes the two.
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  const result = await runtime.execute(
    { conversationId, input },
    {
      signal: controller.signal,
      onChunk: (text) => sendEvent(response, 'chunk', { text }),
    },
  );

  // Best-effort: the client may already be gone, which is precisely the case
  // that produced a cancelled run above.
  sendEvent(response, 'terminal', {
    runId: result.runId,
    state: result.terminalState,
    policyRuleId: result.decision.ruleId,
    chunkCount: result.chunkCount,
    outputIsPartial: result.outputIsPartial,
    termination: result.termination,
  });
  sendEvent(response, 'trace', { events: result.trace });
  response.end();
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8') || '{}'));
    request.on('error', reject);
  });
}

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body, null, 2));
}

function buildProvider(): ModelProvider {
  const name = process.env.PROVIDER ?? 'scripted';
  const model = process.env.MODEL;

  if (name === 'groq') {
    const apiKey = requireKey('GROQ_API_KEY');
    return new GroqProvider(model ? { apiKey, model } : { apiKey });
  }
  if (name === 'gemini') {
    const apiKey = requireKey('GEMINI_API_KEY');
    return new GeminiProvider(model ? { apiKey, model } : { apiKey });
  }
  return new ScriptedProvider(chunked('This is a scripted reply streamed over SSE.', 8));
}

function requireKey(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is not set.`);
  return value;
}

// Only start listening when executed directly, so tests can import the factory.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  loadEnvFile();
  const port = Number(process.env.PORT ?? 8787);
  const provider = buildProvider();
  const server = createRuntimeServer({
    store: FileConversationStore.inDirectory(process.env.RUNTIME_DATA_DIR ?? '.runtime-data'),
    provider,
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 30_000),
  });
  server.listen(port, () => {
    process.stdout.write(`runtime listening on http://localhost:${port}\n`);
    process.stdout.write(`  provider: ${provider.name}\n`);
    process.stdout.write(`  curl -N -X POST localhost:${port}/turns -d '{"input":"hello"}'\n`);
    process.stdout.write(
      `  curl -N -X POST 'localhost:${port}/turns?scenario=timeout' -d '{}'   (scenarios: ${SCENARIO_NAMES.join(', ')})\n`,
    );
  });
}
