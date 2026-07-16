import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentExecutorPlaneStore,
  AgentTaskEvent,
  AgentTaskSnapshot,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRegistration(value: unknown): value is ExternalAgentRegistration {
  if (!isRecord(value)) return false;
  return typeof value.agentId === 'string'
    && typeof value.displayName === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.executorId === 'string'
    && (value.protocol === 'a2a' || value.protocol === 'mcp' || value.protocol === 'http')
    && typeof value.configurationRevision === 'string'
    && typeof value.endpointIdentityHash === 'string'
    && isRecord(value.capabilities)
    && isRecord(value.effects);
}

function isTask(value: unknown): value is AgentTaskSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.taskId === 'string'
    && (value.route === 'local' || value.route === 'external')
    && typeof value.agentId === 'string'
    && typeof value.objective === 'string'
    && typeof value.state === 'string'
    && typeof value.cancellation === 'string'
    && isRecord(value.registration)
    && typeof value.idempotencyKey === 'string'
    && typeof value.dispatchAttempt === 'number'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isEvent(value: unknown): value is AgentTaskEvent {
  if (!isRecord(value)) return false;
  return typeof value.taskId === 'string'
    && Number.isSafeInteger(value.seq)
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string';
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse Runtime agent store file ${file}: ${message}`);
  }
}

function readList<T>(
  file: string,
  guard: (value: unknown) => value is T,
): readonly T[] {
  if (!fs.existsSync(file)) return [];
  const parsed = parseJson(file);
  if (!Array.isArray(parsed) || !parsed.every(guard)) {
    throw new Error(`Runtime agent store file has an invalid array shape: ${file}`);
  }
  return structuredClone(parsed);
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function taskDirectory(root: string, taskId: string): string {
  const directoryKey = createHash('sha256').update(taskId).digest('hex');
  return path.join(root, directoryKey);
}

function readEvents(file: string): readonly AgentTaskEvent[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/).map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Runtime agent event at ${file}:${index + 1}: ${message}`);
    }
    if (!isEvent(parsed)) throw new Error(`Invalid Runtime agent event shape at ${file}:${index + 1}`);
    return parsed;
  });
}

export function createRuntimeAgentExecutorPlaneStore(
  agentStoreDir: string,
): AgentExecutorPlaneStore {
  const root = path.resolve(agentStoreDir);
  const registrationsFile = path.join(root, 'registrations.json');
  const tasksDir = path.join(root, 'tasks');
  return {
    async loadRegistrations() {
      return readList(registrationsFile, isRegistration);
    },
    async saveRegistrations(registrations) {
      writeJsonAtomic(registrationsFile, registrations);
    },
    async loadTasks() {
      if (!fs.existsSync(tasksDir)) return [];
      const tasks: AgentTaskSnapshot[] = [];
      for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(tasksDir, entry.name, 'snapshot.json');
        if (!fs.existsSync(file)) continue;
        const parsed = parseJson(file);
        if (!isTask(parsed)) throw new Error(`Invalid Runtime agent task shape: ${file}`);
        tasks.push(parsed);
      }
      return tasks;
    },
    async saveTask(task) {
      writeJsonAtomic(path.join(taskDirectory(tasksDir, task.taskId), 'snapshot.json'), task);
    },
    async loadEvents(taskId) {
      return readEvents(path.join(taskDirectory(tasksDir, taskId), 'events.jsonl'));
    },
    async appendEvent(event) {
      const file = path.join(taskDirectory(tasksDir, event.taskId), 'events.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
  };
}
