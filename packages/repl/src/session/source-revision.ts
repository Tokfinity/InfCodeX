import { createHash } from 'node:crypto';

export type SessionSourceFileKind = 'main' | 'islands' | 'legacy_archive';

export interface SessionSourceRevisionInput {
  readonly kind: SessionSourceFileKind;
  readonly relativePath: string;
  readonly bytes: Buffer;
}

export interface SessionSourceFileRevisionState {
  readonly kind: SessionSourceFileKind;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly chain: string;
  /** Canonical base64 for the final incomplete source chunk. */
  readonly tail: string;
}

export interface SessionSourceRevisionState {
  readonly version: 1;
  readonly files: readonly SessionSourceFileRevisionState[];
}

const KIND_ORDER: Readonly<Record<SessionSourceFileKind, number>> = {
  main: 0,
  islands: 1,
  legacy_archive: 2,
};
const SOURCE_CHUNK_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Invalid Session source-relative path: ${relativePath}`);
  }
  return normalized;
}

function initialFileChain(kind: SessionSourceFileKind, relativePath: string): string {
  return createHash('sha256')
    .update('kodax-session-source-file-v1\0')
    .update(`${kind}:${Buffer.byteLength(relativePath, 'utf8')}:${relativePath}`)
    .digest('hex');
}

function extendChunkChain(chain: string, chunk: Buffer): string {
  return createHash('sha256')
    .update('kodax-session-source-chunk-v1\0')
    .update(chain, 'hex')
    .update(chunk)
    .digest('hex');
}

function consumeCompleteChunks(
  chain: string,
  bytes: Buffer,
): { readonly chain: string; readonly count: number; readonly tail: Buffer } {
  let nextChain = chain;
  let count = 0;
  let offset = 0;
  while (bytes.length - offset >= SOURCE_CHUNK_BYTES) {
    nextChain = extendChunkChain(nextChain, bytes.subarray(offset, offset + SOURCE_CHUNK_BYTES));
    count += 1;
    offset += SOURCE_CHUNK_BYTES;
  }
  return { chain: nextChain, count, tail: bytes.subarray(offset) };
}

function compareFileStates(
  left: Pick<SessionSourceFileRevisionState, 'kind' | 'relativePath'>,
  right: Pick<SessionSourceFileRevisionState, 'kind' | 'relativePath'>,
): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || left.relativePath.localeCompare(right.relativePath);
}

export function createSessionSourceRevisionState(
  inputs: readonly SessionSourceRevisionInput[],
): SessionSourceRevisionState {
  const files = inputs.map((input): SessionSourceFileRevisionState => {
    const relativePath = normalizeRelativePath(input.relativePath);
    const chunks = consumeCompleteChunks(initialFileChain(input.kind, relativePath), input.bytes);
    return {
      kind: input.kind,
      relativePath,
      byteLength: input.bytes.length,
      chunkCount: chunks.count,
      chain: chunks.chain,
      tail: chunks.tail.toString('base64'),
    };
  }).sort(compareFileStates);
  if (new Set(files.map((file) => file.kind)).size !== files.length) {
    throw new Error('Duplicate Session source file kind');
  }
  return { version: 1, files };
}

export function createSessionSourceRevision(state: SessionSourceRevisionState): string {
  const hash = createHash('sha256');
  hash.update('kodax-session-source-bundle-v2\0');
  for (const file of state.files) {
    hash.update(
      `${file.kind}:${Buffer.byteLength(file.relativePath, 'utf8')}:${file.relativePath}:`
      + `${file.byteLength}:${file.chunkCount}:${file.chain}:`,
    );
    hash.update(Buffer.from(file.tail, 'base64'));
  }
  return `sha256:${hash.digest('hex')}`;
}

export function extendSessionMainSourceRevisionState(
  state: SessionSourceRevisionState,
  mainRelativePath: string,
  appendedBytes: Buffer,
): SessionSourceRevisionState | undefined {
  if (appendedBytes.length === 0) return state;
  if (appendedBytes[0] !== 0x0a) return undefined;
  const normalizedPath = normalizeRelativePath(mainRelativePath);
  const mainIndex = state.files.findIndex(
    (file) => file.kind === 'main' && file.relativePath === normalizedPath,
  );
  if (mainIndex < 0) return undefined;
  const main = state.files[mainIndex]!;
  const chunks = consumeCompleteChunks(
    main.chain,
    Buffer.concat([Buffer.from(main.tail, 'base64'), appendedBytes]),
  );
  const files = [...state.files];
  files[mainIndex] = {
    ...main,
    byteLength: main.byteLength + appendedBytes.length,
    chunkCount: main.chunkCount + chunks.count,
    chain: chunks.chain,
    tail: chunks.tail.toString('base64'),
  };
  return { version: 1, files };
}

export function isSessionSourceRevisionState(
  value: unknown,
): value is SessionSourceRevisionState {
  if (
    !isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.files)
    || !value.files.some((candidate) => isRecord(candidate) && candidate.kind === 'main')
  ) return false;
  let previous: SessionSourceFileRevisionState | undefined;
  const kinds = new Set<SessionSourceFileKind>();
  for (const candidate of value.files) {
    if (!isRecord(candidate)) return false;
    const kind = candidate.kind;
    if (kind !== 'main' && kind !== 'islands' && kind !== 'legacy_archive') return false;
    if (
      typeof candidate.relativePath !== 'string'
      || candidate.relativePath.length === 0
      || candidate.relativePath.includes('\\')
      || candidate.relativePath.startsWith('/')
      || candidate.relativePath.split('/').some((segment) => segment === '..')
      || !Number.isSafeInteger(candidate.byteLength)
      || Number(candidate.byteLength) < 0
      || !Number.isSafeInteger(candidate.chunkCount)
      || Number(candidate.chunkCount) < 0
      || typeof candidate.chain !== 'string'
      || !/^[0-9a-f]{64}$/.test(candidate.chain)
      || typeof candidate.tail !== 'string'
      || kinds.has(kind)
    ) return false;
    const tail = Buffer.from(candidate.tail, 'base64');
    if (
      tail.length >= SOURCE_CHUNK_BYTES
      || tail.toString('base64') !== candidate.tail
      || Number(candidate.chunkCount) !== Math.floor(Number(candidate.byteLength) / SOURCE_CHUNK_BYTES)
      || tail.length !== Number(candidate.byteLength) % SOURCE_CHUNK_BYTES
    ) return false;
    const current = candidate as unknown as SessionSourceFileRevisionState;
    if (previous !== undefined && compareFileStates(previous, current) >= 0) return false;
    kinds.add(kind);
    previous = current;
  }
  return true;
}
