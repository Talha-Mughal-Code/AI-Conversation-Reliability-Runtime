import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConversationStore, StoredMessage, StoredRun } from './store.js';

interface FileShape {
  readonly messages: StoredMessage[];
  readonly runs: Record<string, StoredRun>;
}

const EMPTY: FileShape = { messages: [], runs: {} };

/**
 * JSON-file persistence.
 *
 * Chosen so a reviewer can `cat` the records during the demo and see exactly
 * which commit rule produced them -- the point of this exercise is the commit
 * boundary, not the storage engine. A real deployment would put the same port
 * behind Postgres; `ConversationStore` is the only thing the runtime knows.
 *
 * Two properties still matter and are implemented:
 *  - writes are serialised through a promise chain, so concurrent runs in one
 *    process cannot interleave a read-modify-write and lose a record
 *  - writes are atomic (temp file + rename), so a crash mid-write leaves the
 *    previous good file rather than a truncated one
 */
export class FileConversationStore implements ConversationStore {
  private cache: FileShape | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static inDirectory(dir: string): FileConversationStore {
    return new FileConversationStore(join(dir, 'conversations.json'));
  }

  appendMessage(message: StoredMessage): Promise<void> {
    return this.mutate((state) => {
      state.messages.push(message);
    });
  }

  saveRun(run: StoredRun): Promise<void> {
    return this.mutate((state) => {
      state.runs[run.runId] = run;
    });
  }

  async listMessages(conversationId: string): Promise<readonly StoredMessage[]> {
    const state = await this.load();
    return state.messages.filter((m) => m.conversationId === conversationId);
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const state = await this.load();
    return state.runs[runId] ?? null;
  }

  async listRuns(conversationId: string): Promise<readonly StoredRun[]> {
    const state = await this.load();
    return Object.values(state.runs).filter((r) => r.conversationId === conversationId);
  }

  /** Serialises read-modify-write so two runs cannot clobber each other's record. */
  private mutate(apply: (state: FileShape) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const state = await this.load();
      apply(state);
      await this.persist(state);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<FileShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = { ...EMPTY, ...(JSON.parse(raw) as FileShape) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = { messages: [], runs: {} };
    }
    return this.cache;
  }

  private async persist(state: FileShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, this.filePath); // atomic on POSIX
  }
}
