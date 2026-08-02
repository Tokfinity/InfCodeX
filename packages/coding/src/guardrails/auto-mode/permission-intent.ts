import { createHash } from 'node:crypto';
import type { GuardrailPermissionIntent } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

export interface PermissionIntentEvidence {
  readonly status: 'complete' | 'targeted' | 'missing';
  /** Latest genuine user request, kept separate as the authoritative intent. */
  readonly currentUserContent?: string;
  readonly currentUserContentTruncated?: boolean;
  /** Runtime-delegated task context; informative, never a replacement for root authority. */
  readonly delegatedObjective?: string;
  readonly delegatedObjectiveTruncated?: boolean;
  readonly bindingConstraints?: readonly string[];
  readonly scopeHint?: string;
  readonly readOnly?: boolean;
  readonly content: string;
  readonly sourceBytes: number;
  readonly includedBytes: number;
  readonly omittedBytes: number;
  readonly sha256: string;
}

export const MAX_PERMISSION_INTENT_BYTES = 6 * 1024;
export const MAX_CURRENT_USER_INTENT_BYTES = 4 * 1024;
export const INTENT_CONSTRAINT_ROUTING_MARKER_SOURCE = String.raw`\b(?:do\s+not|don't|dont|no|never|must\s+not|should\s+not|may\s+not|cannot|can't|avoid|without|refrain(?:\s+from)?|neither|not\s+permitted|only|exclusive(?:ly)?|solely|just|forbidden|prohibited|disallowed|limit(?:ed)?|restrict(?:ed)?|confine(?:d)?|skip|ignore|omit|leave|stay|stay\s+clear|keep|keep\s+out|within|inside|nothing\s+else|out\s+of\s+scope|except|exclud(?:e|ed|ing)|other\s+than|everything\s+but|all\s+but|apart\s+from|exception|save\s+for|read[- ]only|unchanged|untouched|as[- ]is|observation\s+only|alter(?:ing|ed)?|wait|confirmation|approval|stop|pause|hold)\b|(?:不要|请勿|勿|别|严禁|禁止|不得|不可|不准|不能|避免|仅|只|限定|限制|范围|超出|保持|排除|跳过|忽略|远离|等待|确认|批准|停止|暂停)`;
const SLICE_CHARS = 480;
const AUTHORITY_TERMS = /\b(?:allow|approve|authorize|deny|forbid|must|never|avoid|without|only|stop|pause|outside|within|scope|omit|read[- ]only|unchanged|untouched|delete|move|write|shell|terminal)\b|允许|授权|同意|禁止|不要|别|仅|只|范围|超出|保持|停止|暂停|必须|工作区外|删除|移动|写入/i;

interface IntentSegment {
  readonly turn: number;
  readonly order: number;
  readonly text: string;
  readonly score: number;
}

export function buildPermissionIntentEvidence(
  messages: readonly KodaXMessage[],
  query: string,
  maxBytes = MAX_PERMISSION_INTENT_BYTES,
  authority?: GuardrailPermissionIntent,
): PermissionIntentEvidence {
  if (authority !== undefined) {
    return buildExplicitPermissionIntentEvidence(authority, messages, query, maxBytes);
  }
  const userTexts = messages.flatMap((message) => extractUserText(message));
  const latestUserContent = userTexts.at(-1) ?? '';
  const currentUserContent = compactCurrentUserContent(latestUserContent, query);
  const currentUserContentTruncated = currentUserContent !== latestUserContent;
  const source = userTexts.map((text, index) => `[user-turn:${index + 1}] ${text}`).join('\n');
  const sourceBytes = utf8Bytes(source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (userTexts.length === 0) {
    return {
      status: 'missing', currentUserContent, currentUserContentTruncated,
      content: '', sourceBytes: 0,
      includedBytes: 0, omittedBytes: 0, sha256,
    };
  }
  if (sourceBytes <= maxBytes) {
    return {
      status: 'complete', currentUserContent, currentUserContentTruncated,
      content: source, sourceBytes,
      includedBytes: sourceBytes, omittedBytes: 0, sha256,
    };
  }

  const terms = queryTerms(query);
  const segments = buildSegments(userTexts, terms);
  const selected = selectSegments(segments, maxBytes);
  const content = selected
    .sort((left, right) => left.turn - right.turn || left.order - right.order)
    .map((segment) => segment.text)
    .join('\n');
  const includedBytes = utf8Bytes(content);
  return {
    status: 'targeted', currentUserContent, currentUserContentTruncated,
    content, sourceBytes, includedBytes,
    omittedBytes: Math.max(0, sourceBytes - includedBytes), sha256,
  };
}

function buildExplicitPermissionIntentEvidence(
  authority: GuardrailPermissionIntent,
  messages: readonly KodaXMessage[],
  query: string,
  maxBytes: number,
): PermissionIntentEvidence {
  const rootUserIntent = authority.rootUserIntent?.trim() ?? '';
  const delegatedObjective = authority.delegatedObjective?.trim() ?? '';
  const bindingConstraints = (authority.bindingConstraints ?? [])
    .map((constraint) => constraint.trim())
    .filter(Boolean);
  const scopeHint = authority.scopeHint?.trim() || undefined;
  // A root run can receive genuine user follow-ups while it is active. The
  // latest such turn is the current authority; the run-start prompt is only
  // the fallback. Child transcripts contain generated briefings, so child
  // authority remains the authenticated root intent plus delegated fields.
  const transcriptUserIntents = delegatedObjective
    ? []
    : messages.flatMap((message) => extractUserText(message));
  const effectiveCurrentIntent = transcriptUserIntents.at(-1) ?? rootUserIntent;
  const currentUserContent = compactCurrentUserContent(effectiveCurrentIntent, query);
  const compactDelegatedObjective = compactCurrentUserContent(delegatedObjective, query);
  // Root runs may need prior genuine user turns to interpret a short follow-up
  // such as "do it". Child runs have an explicit delegated objective, so their
  // generated briefing must never be admitted through this transcript path.
  const transcriptPriorIntents = transcriptUserIntents.slice(0, -1);
  const priorUserIntents = rootUserIntent
    && rootUserIntent !== effectiveCurrentIntent
    && !transcriptPriorIntents.includes(rootUserIntent)
    ? [rootUserIntent, ...transcriptPriorIntents]
    : transcriptPriorIntents;
  const sourceParts = [
    ...priorUserIntents.map((text) => `[prior-user-intent] ${text}`),
    ...(effectiveCurrentIntent ? [`[root-user-intent] ${effectiveCurrentIntent}`] : []),
    ...(delegatedObjective ? [`[delegated-objective] ${delegatedObjective}`] : []),
    ...bindingConstraints.map((constraint) => `[binding-constraint] ${constraint}`),
    ...(scopeHint ? [`[scope-hint] ${scopeHint}`] : []),
    ...(authority.readOnly === true ? ['[runtime-capability] read-only'] : []),
  ];
  const source = sourceParts.join('\n');
  const sourceBytes = utf8Bytes(source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  const segments = buildSegments(sourceParts, queryTerms(query));
  const content = sourceBytes <= maxBytes
    ? source
    : selectSegments(segments, maxBytes)
      .sort((left, right) => left.turn - right.turn || left.order - right.order)
      .map((segment) => segment.text.replace(/^\[user-turn:\d+\]\s*/, ''))
      .join('\n');
  const includedBytes = utf8Bytes(content);
  return {
    status: sourceBytes === 0 ? 'missing' : sourceBytes <= maxBytes ? 'complete' : 'targeted',
    ...(currentUserContent ? { currentUserContent } : {}),
    currentUserContentTruncated: currentUserContent !== effectiveCurrentIntent,
    ...(compactDelegatedObjective ? { delegatedObjective: compactDelegatedObjective } : {}),
    delegatedObjectiveTruncated: compactDelegatedObjective !== delegatedObjective,
    bindingConstraints,
    ...(scopeHint ? { scopeHint } : {}),
    readOnly: authority.readOnly === true,
    content,
    sourceBytes,
    includedBytes,
    omittedBytes: Math.max(0, sourceBytes - includedBytes),
    sha256,
  };
}

function compactCurrentUserContent(text: string, query: string): string {
  if (utf8Bytes(text) <= MAX_CURRENT_USER_INTENT_BYTES) return text;
  const terms = queryTerms(query);
  const candidates = relevantSlices(text, terms).map((slice, order) => ({
    turn: 0,
    order,
    text: slice,
    score: segmentScore(slice, terms, 0, 1),
  }));
  return selectSegments(candidates, MAX_CURRENT_USER_INTENT_BYTES)
    .sort((left, right) => left.order - right.order)
    .map((segment) => segment.text)
    .join('\n');
}

function extractUserText(message: KodaXMessage): string[] {
  if (message.role !== 'user') return [];
  if ((message as KodaXMessage & { readonly _synthetic?: boolean })._synthetic === true) return [];
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    return text && !isSyntheticReminder(text) ? [text] : [];
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n');
  const trimmed = text.trim();
  return trimmed && !isSyntheticReminder(trimmed) ? [trimmed] : [];
}

function isSyntheticReminder(text: string): boolean {
  return /^<system-reminder(?:\s|>)/i.test(text);
}

function buildSegments(userTexts: readonly string[], terms: readonly string[]): IntentSegment[] {
  const segments: IntentSegment[] = [];
  for (let turn = 0; turn < userTexts.length; turn += 1) {
    const paragraphs = userTexts[turn]!.split(/\r?\n+/).filter(Boolean);
    for (let order = 0; order < paragraphs.length; order += 1) {
      const paragraph = paragraphs[order]!;
      const slices = relevantSlices(paragraph, terms);
      for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
        const slice = slices[sliceIndex]!;
        const label = `[user-turn:${turn + 1}] ${slice}`;
        segments.push({
          turn,
          order: order * 100 + sliceIndex,
          text: label,
          score: segmentScore(slice, terms, turn, userTexts.length),
        });
      }
    }
  }
  return segments;
}

function relevantSlices(text: string, terms: readonly string[]): string[] {
  if (text.length <= SLICE_CHARS) return [text];
  const starts = new Set<number>([0, Math.max(0, text.length - SLICE_CHARS)]);
  const lower = text.toLowerCase();
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      starts.add(Math.max(0, Math.min(text.length - SLICE_CHARS, index - Math.floor(SLICE_CHARS / 2))));
      index = lower.indexOf(term, index + term.length);
    }
  }
  for (const match of text.matchAll(new RegExp(
    INTENT_CONSTRAINT_ROUTING_MARKER_SOURCE,
    'gi',
  ))) {
    starts.add(Math.max(
      0,
      Math.min(text.length - SLICE_CHARS, match.index - Math.floor(SLICE_CHARS / 2)),
    ));
  }
  return [...starts]
    .sort((left, right) => left - right)
    .filter((start, index, all) => index === 0 || start - all[index - 1]! >= SLICE_CHARS / 2)
    .map((start) => text.slice(start, start + SLICE_CHARS));
}

function segmentScore(
  text: string,
  terms: readonly string[],
  turn: number,
  turnCount: number,
): number {
  const lower = text.toLowerCase();
  const matches = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
  return matches * 100
    + (AUTHORITY_TERMS.test(text) ? 50 : 0)
    + (turn === turnCount - 1 ? 1_000 : turn);
}

function selectSegments(segments: readonly IntentSegment[], maxBytes: number): IntentSegment[] {
  const selected: IntentSegment[] = [];
  let remaining = Math.max(0, maxBytes);
  for (const segment of [...segments].sort((left, right) => right.score - left.score)) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const bytes = utf8Bytes(segment.text);
    if (bytes + separatorBytes <= remaining) {
      selected.push(segment);
      remaining -= bytes + separatorBytes;
    }
  }
  return selected;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.:/\\-]{3,}/gu) ?? [])]
    .sort((left, right) => right.length - left.length)
    .slice(0, 32);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
