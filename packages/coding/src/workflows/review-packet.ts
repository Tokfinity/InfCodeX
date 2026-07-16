import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  READ_DEFAULT_LIMIT,
  READ_MAX_LINE_CHARS,
} from '../tools/truncate.js';
import { classifyFileCategory } from '../repo-intelligence/index.js';

export interface ReviewPacketBudget {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly maxLineChars: number;
}

export interface ReviewPacketChunk {
  readonly path: string;
  readonly contentHash: string;
}

export interface ReviewPacketMetadata {
  readonly packetPath: string;
  readonly contentHash: string;
  readonly rangeId: string;
  readonly partitionKey: string;
  readonly label: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly scopePaths: readonly string[];
  readonly riskFlags: readonly 'routing-high'[];
  readonly budget: ReviewPacketBudget;
  readonly evidenceChunks: readonly ReviewPacketChunk[];
  readonly requirementsPresent: boolean;
  readonly testEvidencePresent: boolean;
}

export interface ReviewPacketInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly label: string;
  /** Exact captured diff bytes. The builder never rereads Git. */
  readonly diff: string;
  readonly scope?: 'staged' | 'unstaged' | 'all' | 'compare' | 'commit';
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly customPrompt?: string;
  readonly requirements?: readonly string[];
  readonly testEvidence?: readonly string[];
  /** Must come from KodaXTaskRoutingDecision; no local semantic inference occurs. */
  readonly routingRisk?: 'low' | 'medium' | 'high';
  /** Test seam only; production snapshots the existing Read-tool caps. */
  readonly budget?: ReviewPacketBudget;
}

interface CapturedFileDiff {
  readonly path: string;
  readonly partitionKey: string;
  readonly content: string;
}

const DEFAULT_BUDGET: ReviewPacketBudget = {
  maxBytes: DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  maxLines: READ_DEFAULT_LIMIT,
  maxLineChars: READ_MAX_LINE_CHARS,
};

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return safe || 'packet';
}

function areaIdForPath(filePath: string): string {
  const parts = normalizePath(filePath).split('/').filter(Boolean);
  if (parts.length <= 1) return 'cross-cutting';
  if ((parts[0] === 'packages' || parts[0] === 'clients') && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? 'cross-cutting';
}

function partitionKeyForPath(filePath: string): string {
  return `${areaIdForPath(filePath)}/${classifyFileCategory(filePath)}`;
}

function capturedDiffStat(diff: string): string {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
  }
  return `${captureFileDiffs(diff).length} file(s), +${added}, -${deleted}`;
}

function capturedRangeSummary(diff: string): readonly string[] {
  const firstDiff = diff.search(/^diff --git /m);
  if (firstDiff <= 0) return [];
  return diff.slice(0, firstDiff).trim().split(/\r?\n/).slice(0, 40);
}

function captureFileDiffs(diff: string): readonly CapturedFileDiff[] {
  const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)\r?$/gm)];
  if (starts.length === 0) {
    return [{ path: '(cross-cutting)', partitionKey: 'cross-cutting/other', content: diff }];
  }
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? diff.length;
    const filePath = normalizePath(match[2] ?? match[1] ?? '(unknown)');
    return {
      path: filePath,
      partitionKey: partitionKeyForPath(filePath),
      content: diff.slice(start, end),
    };
  }).sort((left, right) =>
    ordinal(left.partitionKey, right.partitionKey) || ordinal(left.path, right.path)
  );
}

function fits(text: string, budget: ReviewPacketBudget): boolean {
  const lines = text.split(/\r?\n/);
  return Buffer.byteLength(text, 'utf8') <= budget.maxBytes &&
    lines.length <= budget.maxLines &&
    lines.every((line) => line.length <= budget.maxLineChars);
}

function packetHeader(input: ReviewPacketInput, rangeId: string, partitionKey: string, paths: readonly string[]): string {
  const requirements = [...(input.requirements ?? []), ...(input.customPrompt ? [input.customPrompt] : [])];
  return [
    '# KodaX Review Packet',
    `label: ${input.label}`,
    `rangeId: ${rangeId}`,
    `partitionKey: ${partitionKey}`,
    `diffStat: ${capturedDiffStat(input.diff)}`,
    ...(input.baseRef ? [`baseRef: ${input.baseRef}`] : []),
    ...(input.headRef ? [`headRef: ${input.headRef}`] : []),
    `riskFlags: ${input.routingRisk === 'high' ? 'routing-high' : '(none)'}`,
    ...(capturedRangeSummary(input.diff).length > 0
      ? ['rangeSummary:', ...capturedRangeSummary(input.diff).map((line) => `  ${line}`)]
      : []),
    'scopePaths:',
    ...paths.map((item) => `- ${item}`),
    'bindingRequirements:',
    ...(requirements.length > 0 ? requirements.map((item) => `- ${item}`) : ['- (not provided)']),
    'reportedTestEvidence:',
    ...((input.testEvidence?.length ?? 0) > 0
      ? input.testEvidence!.map((item) => `- ${item}`)
      : ['- (not provided)']),
  ].join('\n');
}

function splitLongLine(line: string, maxLineChars: number): readonly string[] {
  if (line.length <= maxLineChars) return [line];
  const maxDigits = String(line.length).length;
  const longestMarker = `[KodaX continuation ${'9'.repeat(maxDigits)}/${'9'.repeat(maxDigits)}] `;
  if (longestMarker.length >= maxLineChars) {
    return Array.from(
      { length: Math.ceil(line.length / maxLineChars) },
      (_, index) => line.slice(index * maxLineChars, (index + 1) * maxLineChars),
    );
  }
  const payloadLimit = maxLineChars - longestMarker.length;
  const count = Math.ceil(line.length / payloadLimit);
  const segments: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const marker = `[KodaX continuation ${index + 1}/${count}] `;
    const payload = line.slice(index * payloadLimit, (index + 1) * payloadLimit);
    segments.push(`${marker}${payload}`);
  }
  return segments;
}

function readableLines(content: string, budget: ReviewPacketBudget): readonly string[] {
  return content.split(/\r?\n/).flatMap((line) => splitLongLine(line, budget.maxLineChars));
}

function chunkEvidence(content: string, budget: ReviewPacketBudget): readonly string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
  };
  for (const line of readableLines(content, budget)) {
    const prospective = [...current, line].join('\n');
    if (current.length > 0 && !fits(prospective, budget)) flush();
    current.push(line);
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

function groupPackets(files: readonly CapturedFileDiff[], input: ReviewPacketInput, rangeId: string, budget: ReviewPacketBudget): readonly CapturedFileDiff[][] {
  const groups: CapturedFileDiff[][] = [];
  let current: CapturedFileDiff[] = [];
  for (const file of files) {
    if (current.length > 0 && current[0]?.partitionKey !== file.partitionKey) {
      groups.push(current);
      current = [];
    }
    const prospective = [...current, file];
    const header = packetHeader(input, rangeId, file.partitionKey, prospective.map((item) => item.path));
    const body = `${header}\n\n## Scoped diff\n\n${prospective.map((item) => item.content).join('')}`;
    if (current.length > 0 && !fits(body, budget)) {
      groups.push(current);
      current = [file];
    } else {
      current = prospective;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export async function writeReviewPackets(input: ReviewPacketInput): Promise<readonly ReviewPacketMetadata[]> {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const scope = input.scope ?? 'all';
  const rangeId = sha256(`${input.baseRef ?? ''}\0${input.headRef ?? ''}\0${scope}\0${input.diff}`);
  const packetDir = path.resolve(
    input.cwd,
    '.agent',
    'tmp',
    'sessions',
    safeName(input.sessionId),
    'review-packets',
    rangeId,
  );
  await mkdir(packetDir, { recursive: true });

  const groups = groupPackets(captureFileDiffs(input.diff), input, rangeId, budget);
  const output: ReviewPacketMetadata[] = [];
  for (const [index, files] of groups.entries()) {
    const partitionKey = files[0]?.partitionKey ?? 'cross-cutting/other';
    const scopePaths = files.map((file) => file.path);
    const evidence = files.map((file) => file.content).join('');
    const header = packetHeader(input, rangeId, partitionKey, scopePaths);
    const inlineBody = `${header}\n\n## Scoped diff\n\n${evidence}`;
    const stem = `${String(index + 1).padStart(3, '0')}-${safeName(partitionKey)}`;
    const evidenceChunks: ReviewPacketChunk[] = [];
    let body = inlineBody;
    if (!fits(inlineBody, budget)) {
      const chunks = chunkEvidence(evidence, budget);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const chunkHash = sha256(chunk);
        const chunkPath = path.join(packetDir, `${stem}.chunk-${String(chunkIndex + 1).padStart(3, '0')}-${chunkHash.slice(0, 12)}.diff`);
        await writeFile(chunkPath, chunk, 'utf8');
        evidenceChunks.push({ path: chunkPath, contentHash: chunkHash });
      }
      body = [
        header,
        '',
        '## Evidence chunks',
        'Read every listed chunk in ordinal order before returning a verdict.',
        ...evidenceChunks.map((chunk, chunkIndex) => `${chunkIndex + 1}. ${chunk.path} sha256=${chunk.contentHash}`),
        '',
        `originalEvidenceHash: ${sha256(evidence)}`,
      ].join('\n');
    }
    const contentHash = sha256(JSON.stringify({
      rangeId,
      partitionKey,
      scopePaths,
      budget,
      evidence,
      requirements: input.requirements ?? [],
      customPrompt: input.customPrompt ?? '',
      testEvidence: input.testEvidence ?? [],
      riskFlags: input.routingRisk === 'high' ? ['routing-high'] : [],
    }));
    const packetPath = path.join(packetDir, `${stem}-${contentHash.slice(0, 12)}.md`);
    await writeFile(packetPath, body, 'utf8');
    output.push({
      packetPath,
      contentHash,
      rangeId,
      partitionKey,
      label: input.label,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.headRef ? { headRef: input.headRef } : {}),
      scopePaths,
      riskFlags: input.routingRisk === 'high' ? ['routing-high'] : [],
      budget,
      evidenceChunks,
      requirementsPresent: Boolean(input.customPrompt?.trim() || input.requirements?.some((item) => item.trim())),
      testEvidencePresent: Boolean(input.testEvidence?.some((item) => item.trim())),
    });
  }
  return output;
}
