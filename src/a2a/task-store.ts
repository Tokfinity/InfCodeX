import fs from 'node:fs';
import path from 'node:path';

import { isRecord, parseA2ATask } from './schemas.js';
import type { A2AMessage, A2ATask } from './types.js';

export interface A2AServerTaskRecord {
  readonly taskId: string;
  readonly contextId: string;
  readonly principalKey: string;
  readonly runtimeIdentity: string;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly executionPolicyRevision?: string;
  readonly messageDigests: Readonly<Record<string, string>>;
  readonly runIds: readonly string[];
  readonly task: A2ATask;
  readonly history: readonly A2AMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventSeq: number;
  readonly lastRuntimeEventSeq: number;
  readonly runtimeEventCount: number;
  readonly runtimeEventBytes: number;
}

type TaskListener = (record: A2AServerTaskRecord) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseRecord(value: unknown): A2AServerTaskRecord {
  if (!isRecord(value)) throw new Error('A2A task store record must be an object.');
  for (const key of ['taskId', 'contextId', 'principalKey', 'runtimeIdentity', 'sessionId', 'createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string') throw new Error(`A2A task store record has invalid ${key}.`);
  }
  if (!isRecord(value.messageDigests) || !Object.values(value.messageDigests).every((item) => typeof item === 'string')) {
    throw new Error('A2A task store message digests are invalid.');
  }
  if (!Array.isArray(value.runIds) || !value.runIds.every((item) => typeof item === 'string')) {
    throw new Error('A2A task store run IDs are invalid.');
  }
  if (!Array.isArray(value.history)) throw new Error('A2A task store history is invalid.');
  if (!Number.isSafeInteger(value.eventSeq) || !Number.isSafeInteger(value.lastRuntimeEventSeq)) {
    throw new Error('A2A task store event cursors are invalid.');
  }
  return {
    taskId: value.taskId as string,
    contextId: value.contextId as string,
    principalKey: value.principalKey as string,
    runtimeIdentity: value.runtimeIdentity as string,
    sessionId: value.sessionId as string,
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(typeof value.executionPolicyRevision === 'string'
      ? { executionPolicyRevision: value.executionPolicyRevision }
      : {}),
    messageDigests: value.messageDigests as Record<string, string>,
    runIds: value.runIds as string[],
    task: parseA2ATask(value.task),
    history: value.history as A2AMessage[],
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    eventSeq: value.eventSeq as number,
    lastRuntimeEventSeq: value.lastRuntimeEventSeq as number,
    runtimeEventCount: Number.isSafeInteger(value.runtimeEventCount) ? value.runtimeEventCount as number : 0,
    runtimeEventBytes: Number.isSafeInteger(value.runtimeEventBytes) ? value.runtimeEventBytes as number : 0,
  };
}

export class A2AFileTaskStore {
  readonly #records = new Map<string, A2AServerTaskRecord>();
  readonly #listeners = new Map<string, Set<TaskListener>>();
  readonly #file: string;
  readonly #lockPath: string;
  readonly #lockFd: number;

  constructor(root: string) {
    const resolved = path.resolve(root);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.#file = path.join(resolved, 'tasks.json');
    this.#lockPath = path.join(resolved, '.server.lock');
    this.#lockFd = this.acquireLock();
    try {
      this.load();
    } catch (error: unknown) {
      fs.closeSync(this.#lockFd);
      fs.rmSync(this.#lockPath, { force: true });
      throw error;
    }
  }

  get(taskId: string): A2AServerTaskRecord | undefined {
    const record = this.#records.get(taskId);
    return record ? clone(record) : undefined;
  }

  findByMessage(principalKey: string, messageId: string): A2AServerTaskRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.principalKey === principalKey && record.messageDigests[messageId] !== undefined) {
        return clone(record);
      }
    }
    return undefined;
  }

  list(principalKey: string): readonly A2AServerTaskRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.principalKey === principalKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  all(): readonly A2AServerTaskRecord[] {
    return [...this.#records.values()].map(clone);
  }

  save(record: A2AServerTaskRecord): A2AServerTaskRecord {
    const next = clone(record);
    this.#records.set(record.taskId, next);
    this.persist();
    for (const listener of this.#listeners.get(record.taskId) ?? []) listener(clone(next));
    return clone(next);
  }

  subscribe(taskId: string, listener: TaskListener): () => void {
    const listeners = this.#listeners.get(taskId) ?? new Set<TaskListener>();
    listeners.add(listener);
    this.#listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(taskId);
    };
  }

  close(): void {
    this.persist();
    this.#listeners.clear();
    fs.closeSync(this.#lockFd);
    fs.rmSync(this.#lockPath, { force: true });
  }

  private acquireLock(): number {
    const attempt = (): number => {
      const fd = fs.openSync(this.#lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fs.fsyncSync(fd);
      return fd;
    };
    try {
      return attempt();
    } catch (error: unknown) {
      let stale = false;
      try {
        const pid = Number.parseInt(fs.readFileSync(this.#lockPath, 'utf8').trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch { stale = true; }
        }
      } catch {
        stale = false;
      }
      if (!stale) throw new Error('A2A task store is already owned by another server.', { cause: error });
      fs.rmSync(this.#lockPath, { force: true });
      return attempt();
    }
  }

  private load(): void {
    if (!fs.existsSync(this.#file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as unknown;
    } catch (error: unknown) {
      throw new Error(`Failed to read A2A task store: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('A2A task store root must be an array.');
    for (const value of parsed) {
      const record = parseRecord(value);
      this.#records.set(record.taskId, record);
    }
  }

  private persist(): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify([...this.#records.values()], null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, this.#file);
  }
}
