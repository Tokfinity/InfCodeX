import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export type RuntimeControlHealth = 'healthy' | 'control_history_untrusted';

export type RuntimeOperationState =
  | 'accepted'
  | 'dispatched'
  | 'applied'
  | 'rejected'
  | 'interrupted'
  | 'unknown';

export interface RuntimeControlOperationInput {
  readonly operationId: string;
  readonly journalEpoch: string;
  readonly principalId: string;
  readonly method: string;
  readonly resourceId?: string;
  readonly params: unknown;
}

export interface RuntimeControlOperationReceipt {
  readonly operationId: string;
  readonly journalEpoch: string;
  readonly principalId: string;
  readonly method: string;
  readonly resourceId?: string;
  readonly requestDigest: string;
  readonly state: RuntimeOperationState;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly updatedAt: string;
}

export interface RuntimeControlJournal {
  readonly journalEpoch: string;
  readonly health: RuntimeControlHealth;
  execute<T>(
    input: RuntimeControlOperationInput,
    options: { readonly externalEffect?: boolean },
    effect: () => Promise<T>,
  ): Promise<T>;
  get(operationId: string): RuntimeControlOperationReceipt | undefined;
}

export interface CreateRuntimeControlJournalOptions {
  readonly rootDir: string;
}

interface RuntimeControlJournalMeta {
  readonly version: 1;
  readonly journalEpoch: string;
  readonly createdAt: string;
}

interface RuntimeControlOperationRecord extends RuntimeControlOperationReceipt {
  readonly type: 'operation';
}

export class RuntimeControlJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeControlJournalError';
    this.code = code;
  }
}

export function createRuntimeControlJournal(
  options: CreateRuntimeControlJournalOptions,
): RuntimeControlJournal {
  fs.mkdirSync(options.rootDir, { recursive: true });
  const metaFile = path.join(options.rootDir, 'journal-meta.json');
  const controlFile = path.join(options.rootDir, 'control.jsonl');
  const loadedMeta = loadOrCreateMeta(metaFile);
  const meta = loadedMeta.meta;
  const loaded = loadOperationRecords(controlFile);
  const records = loaded.records;
  const inflight = new Map<string, Promise<unknown>>();
  let health: RuntimeControlHealth = loaded.trusted && loadedMeta.trusted
    ? 'healthy'
    : 'control_history_untrusted';

  if (health === 'healthy') {
    recoverUnfinished(records, controlFile);
  }

  return {
    journalEpoch: meta.journalEpoch,
    get health() {
      return health;
    },
    execute<T>(
      input: RuntimeControlOperationInput,
      executeOptions: { readonly externalEffect?: boolean },
      effect: () => Promise<T>,
    ): Promise<T> {
      if (health !== 'healthy') {
        return Promise.reject(new RuntimeControlJournalError(
          'control_history_untrusted',
          'Runtime control history is untrusted; mutations are quarantined.',
        ));
      }
      try {
        validateOperationInput(input, meta.journalEpoch);
        const requestDigest = digestCanonical(input.params);
        const existing = records.get(input.operationId);
        if (existing) {
          assertMatchingOperation(existing, input, requestDigest);
          const active = inflight.get(input.operationId);
          if (active) return active as Promise<T>;
          return replayOperation<T>(existing);
        }
        const promise = executeNewOperation<T>(
          controlFile,
          records,
          input,
          requestDigest,
          executeOptions.externalEffect === true,
          effect,
          () => { health = 'control_history_untrusted'; },
        );
        inflight.set(input.operationId, promise);
        void promise.finally(() => inflight.delete(input.operationId)).catch(() => undefined);
        return promise;
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
    get(operationId: string) {
      return records.get(operationId);
    },
  };
}

async function executeNewOperation<T>(
  controlFile: string,
  records: Map<string, RuntimeControlOperationReceipt>,
  input: RuntimeControlOperationInput,
  requestDigest: string,
  externalEffect: boolean,
  effect: () => Promise<T>,
  quarantine: () => void,
): Promise<T> {
  const base = operationRecord(input, requestDigest, 'accepted');
  appendRecord(controlFile, base);
  records.set(input.operationId, base);
  if (externalEffect) updateOperation(controlFile, records, base, 'dispatched');
  let result: T;
  try {
    result = await effect();
  } catch (error: unknown) {
    const normalized = normalizeOperationError(error);
    try {
      updateOperation(controlFile, records, base, 'rejected', { error: normalized });
    } catch {
      quarantine();
    }
    throw error;
  }
  try {
    const applied = updateOperation(controlFile, records, base, 'applied', { result });
    return applied.result as T;
  } catch {
    // The effect returned successfully but its durable receipt did not. Never
    // rewrite that outcome as rejected or run it again.
    quarantine();
    records.set(input.operationId, {
      ...base,
      state: 'unknown',
      updatedAt: new Date().toISOString(),
    });
    throw new RuntimeControlJournalError(
      'operation_unknown',
      'Runtime operation completed but its durable outcome could not be recorded.',
    );
  }
}

function updateOperation(
  controlFile: string,
  records: Map<string, RuntimeControlOperationReceipt>,
  base: RuntimeControlOperationReceipt,
  state: RuntimeOperationState,
  extra: Pick<RuntimeControlOperationReceipt, 'result' | 'error'> = {},
): RuntimeControlOperationReceipt {
  const record: RuntimeControlOperationRecord = {
    type: 'operation',
    ...base,
    state,
    ...extra,
    updatedAt: new Date().toISOString(),
  };
  appendRecord(controlFile, record);
  records.set(record.operationId, record);
  return record;
}

function operationRecord(
  input: RuntimeControlOperationInput,
  requestDigest: string,
  state: RuntimeOperationState,
): RuntimeControlOperationRecord {
  return {
    type: 'operation',
    operationId: input.operationId,
    journalEpoch: input.journalEpoch,
    principalId: input.principalId,
    method: input.method,
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
    requestDigest,
    state,
    updatedAt: new Date().toISOString(),
  };
}

function replayOperation<T>(receipt: RuntimeControlOperationReceipt): Promise<T> {
  if (receipt.state === 'applied') return Promise.resolve(receipt.result as T);
  if (receipt.state === 'rejected') {
    return Promise.reject(new RuntimeControlJournalError(
      receipt.error?.code ?? 'operation_rejected',
      receipt.error?.message ?? 'Runtime operation was rejected.',
    ));
  }
  const code = receipt.state === 'unknown' ? 'operation_unknown' : 'operation_interrupted';
  return Promise.reject(new RuntimeControlJournalError(
    code,
    `Runtime operation is ${receipt.state}; it will not be replayed.`,
  ));
}

function assertMatchingOperation(
  receipt: RuntimeControlOperationReceipt,
  input: RuntimeControlOperationInput,
  requestDigest: string,
): void {
  if (
    receipt.journalEpoch === input.journalEpoch
    && receipt.principalId === input.principalId
    && receipt.method === input.method
    && receipt.resourceId === input.resourceId
    && receipt.requestDigest === requestDigest
  ) return;
  throw new RuntimeControlJournalError(
    'operation_id_reuse',
    'Runtime operation ID was already used for a different request or principal.',
  );
}

function validateOperationInput(input: RuntimeControlOperationInput, journalEpoch: string): void {
  if (input.journalEpoch !== journalEpoch) {
    throw new RuntimeControlJournalError(
      'operation_epoch_mismatch',
      'Runtime operation belongs to a different control journal epoch.',
    );
  }
  if (!/^[A-Za-z0-9_.:-]{4,160}$/.test(input.operationId)) {
    throw new RuntimeControlJournalError('invalid_operation_id', 'Runtime operation ID is invalid.');
  }
  if (input.principalId.length === 0 || input.method.length === 0) {
    throw new RuntimeControlJournalError('invalid_operation', 'Runtime operation identity is incomplete.');
  }
}

function recoverUnfinished(
  records: Map<string, RuntimeControlOperationReceipt>,
  controlFile: string,
): void {
  for (const receipt of [...records.values()]) {
    if (receipt.state !== 'accepted' && receipt.state !== 'dispatched') continue;
    updateOperation(
      controlFile,
      records,
      receipt,
      receipt.state === 'dispatched' ? 'unknown' : 'interrupted',
    );
  }
}

function loadOperationRecords(controlFile: string): {
  readonly trusted: boolean;
  readonly records: Map<string, RuntimeControlOperationReceipt>;
} {
  const records = new Map<string, RuntimeControlOperationReceipt>();
  if (!fs.existsSync(controlFile)) return { trusted: true, records };
  const lines = fs.readFileSync(controlFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isOperationRecord(parsed)) return { trusted: false, records };
      records.set(parsed.operationId, parsed);
    } catch {
      return { trusted: false, records };
    }
  }
  return { trusted: true, records };
}

function loadOrCreateMeta(metaFile: string): {
  readonly meta: RuntimeControlJournalMeta;
  readonly trusted: boolean;
} {
  if (fs.existsSync(metaFile)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (isJournalMeta(parsed)) return { meta: parsed, trusted: true };
    } catch {
      // Preserve the corrupt bytes and open read-only below so health remains queryable.
    }
    return {
      meta: createJournalMeta(),
      trusted: false,
    };
  }
  const meta = createJournalMeta();
  writeJsonAtomic(metaFile, meta);
  return { meta, trusted: true };
}

function createJournalMeta(): RuntimeControlJournalMeta {
  return {
    version: 1,
    journalEpoch: `je_${randomUUID().replace(/-/g, '')}`,
    createdAt: new Date().toISOString(),
  };
}

function appendRecord(file: string, record: RuntimeControlOperationRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeFileSync(fd, line, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuntimeControlJournalError('invalid_operation', 'Operation contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().filter((key) => record[key] !== undefined);
    return `{${entries.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new RuntimeControlJournalError('invalid_operation', 'Operation contains a non-JSON value.');
}

function normalizeOperationError(error: unknown): { readonly code: string; readonly message: string } {
  if (!(error instanceof Error)) return { code: 'operation_rejected', message: String(error) };
  const candidate = error as Error & { readonly code?: unknown };
  return {
    code: typeof candidate.code === 'string' ? candidate.code : 'operation_rejected',
    message: error.message,
  };
}

function isJournalMeta(value: unknown): value is RuntimeControlJournalMeta {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.journalEpoch === 'string'
    && typeof value.createdAt === 'string';
}

function isOperationRecord(value: unknown): value is RuntimeControlOperationRecord {
  if (!isRecord(value)) return false;
  return value.type === 'operation'
    && typeof value.operationId === 'string'
    && typeof value.journalEpoch === 'string'
    && typeof value.principalId === 'string'
    && typeof value.method === 'string'
    && typeof value.requestDigest === 'string'
    && isOperationState(value.state)
    && typeof value.updatedAt === 'string';
}

function isOperationState(value: unknown): value is RuntimeOperationState {
  return value === 'accepted'
    || value === 'dispatched'
    || value === 'applied'
    || value === 'rejected'
    || value === 'interrupted'
    || value === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
