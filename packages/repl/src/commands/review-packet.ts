import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const READ_DEFAULT_LIMIT = 2_000;
const READ_MAX_LINE_CHARS = 2_000;
const MAX_CHUNK_BYTES = DEFAULT_TOOL_OUTPUT_MAX_BYTES;

export interface ReviewPacketChunk {
  readonly path: string;
  readonly contentHash: string;
}

export interface ReviewPacketMetadata {
  readonly packetPath: string;
  readonly contentHash: string;
  readonly rangeId: string;
  readonly label: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly scopePaths: readonly string[];
  readonly riskFlags: readonly ('routing-high')[];
  readonly budget: {
    readonly maxBytes: number;
    readonly maxLines: number;
    readonly maxLineChars: number;
  };
  readonly evidenceChunks: readonly ReviewPacketChunk[];
  readonly requirementsPresent: boolean;
  readonly testEvidencePresent: boolean;
}

export interface ReviewPacketInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly label: string;
  readonly diff: string;
  readonly customPrompt?: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function safeSessionId(sessionId: string): string {
  const value = sessionId.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return value.length > 0 ? value : 'session';
}

function changedPaths(diff: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    const candidate = match?.[2] ?? match?.[1];
    if (candidate) paths.add(candidate.replace(/\\/g, '/'));
  }
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function splitChunkLines(diff: string): readonly string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  let currentLines = 0;
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
    currentBytes = 0;
    currentLines = 0;
  };

  for (const rawLine of diff.split(/\r?\n/)) {
    const segments: string[] = [];
    for (let offset = 0; offset < rawLine.length || (rawLine.length === 0 && segments.length === 0); offset += READ_MAX_LINE_CHARS) {
      segments.push(rawLine.slice(offset, offset + READ_MAX_LINE_CHARS));
      if (rawLine.length === 0) break;
    }
    for (const line of segments) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (
        currentLines >= READ_DEFAULT_LIMIT ||
        currentBytes + lineBytes > MAX_CHUNK_BYTES
      ) {
        flush();
      }
      current.push(line);
      currentBytes += lineBytes;
      currentLines += 1;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

export async function writeReviewPacket(input: ReviewPacketInput): Promise<ReviewPacketMetadata> {
  const captured = input.diff;
  const rangeId = hash(`${input.label}\0${input.customPrompt ?? ''}\0${captured}`);
  const packetDir = path.resolve(
    input.cwd,
    '.agent',
    'tmp',
    'sessions',
    safeSessionId(input.sessionId),
    'review-packets',
  );
  await mkdir(packetDir, { recursive: true });

  const chunks = splitChunkLines(captured);
  const evidenceChunks: ReviewPacketChunk[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const chunkPath = path.join(packetDir, `${rangeId}.chunk-${String(index + 1).padStart(3, '0')}.diff`);
    await writeFile(chunkPath, chunk, 'utf8');
    evidenceChunks.push({ path: chunkPath, contentHash: hash(chunk) });
  }

  const requirementsPresent = Boolean(input.customPrompt?.trim());
  const packetPath = path.join(packetDir, `${rangeId}.md`);
  const metadata: ReviewPacketMetadata = {
    packetPath,
    contentHash: hash(captured),
    rangeId,
    label: input.label,
    scopePaths: changedPaths(captured),
    riskFlags: [],
    budget: {
      maxBytes: DEFAULT_TOOL_OUTPUT_MAX_BYTES,
      maxLines: READ_DEFAULT_LIMIT,
      maxLineChars: READ_MAX_LINE_CHARS,
    },
    evidenceChunks,
    requirementsPresent,
    testEvidencePresent: false,
  };
  const body = [
    '# KodaX Review Packet',
    `label: ${metadata.label}`,
    `rangeId: ${metadata.rangeId}`,
    `contentHash: ${metadata.contentHash}`,
    `scopePaths: ${metadata.scopePaths.join(', ') || '(none)'}`,
    `requirementsPresent: ${metadata.requirementsPresent}`,
    `testEvidencePresent: ${metadata.testEvidencePresent}`,
    ...(input.customPrompt ? [`userFocus: ${input.customPrompt}`] : []),
    '',
    'Evidence chunks (read every listed chunk before issuing a verdict):',
    ...evidenceChunks.map((chunk, index) => `${index + 1}. ${chunk.path} sha256=${chunk.contentHash}`),
    '',
    'The packet is immutable for this review attempt. A new diff must create a new rangeId.',
  ].join('\n');
  await writeFile(packetPath, body, 'utf8');
  return metadata;
}
