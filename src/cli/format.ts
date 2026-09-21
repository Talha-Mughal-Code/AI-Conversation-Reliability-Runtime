import type { TerminalState } from '../domain/states.js';
import type { TraceEvent } from '../trace/trace.js';

const ESC = String.fromCharCode(27);
const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (text: string) =>
  useColour ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const dim = wrap('2');
export const bold = wrap('1');
export const green = wrap('32');
export const red = wrap('31');
export const yellow = wrap('33');
export const cyan = wrap('36');

export function paintTerminal(state: TerminalState): string {
  if (state === 'completed') return green(state);
  if (state === 'rejected') return yellow(state);
  return red(state);
}

/** One trace event per line: `  3 |  12ms | lifecycle | provider.chunk {"index":0}`. */
export function formatTrace(trace: readonly TraceEvent[], startedAt: number): string {
  return trace
    .map((event) => {
      const offset = `${String(event.at - startedAt).padStart(5)}ms`;
      const seq = String(event.seq).padStart(3);
      const kind = event.kind === 'lifecycle' ? cyan('lifecycle ') : dim('diagnostic');
      const data = Object.keys(event.data).length > 0 ? dim(` ${JSON.stringify(event.data)}`) : '';
      return `  ${dim(seq)} ${dim(offset)} ${kind} ${event.type}${data}`;
    })
    .join('\n');
}
