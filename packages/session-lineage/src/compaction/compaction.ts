/**
 * @kodax-ai/agent Compaction Core
 *
 * Progressive compaction with lightweight tool-result pruning and rolling
 * summarization to an internal low-water mark.
 */

import { randomUUID } from 'node:crypto';
import type { KodaXBaseProvider, KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type { CompactionAnchor, CompactionConfig, CompactionResult } from './types.js';
import { countTokens, estimateTokens } from '@kodax-ai/agent';
import { extractArtifactLedger, extractFileOps } from './file-tracker.js';
import { extractCompactMemorySeed, generateSummary } from './summary-generator.js';
import { extractBashIntent } from './bash-intent.js';

const DEFAULT_CONTEXT_WINDOW = 200000;
const STRUCTURED_PRUNE_MINIMUM_TOKENS = 20000;
const STRUCTURED_PRUNE_PROTECT_TOKENS = 40000;

/**
 * FEATURE_183 (v0.7.42) — tool names whose tool_result content is NEVER
 * pruned / microcompact-cleared.
 *
 * **Rationale**: KodaX historically used a near-empty blacklist (`{'skill'}`),
 * meaning *every* other tool_result was eligible for prune / clear. Forensic
 * analysis (788-session scan) + claudecode parity review showed this
 * over-aggressively destroyed high-value context — child-task verdicts, user
 * Q&A, MCP outputs, repo-intelligence capsules, control-plane payloads — all
 * silently replaced with `[Cleared: ...]` placeholders the model could not
 * reconstruct.
 *
 * **Design**: flip from blacklist to whitelist semantics implicitly by listing
 * everything *worth keeping*. The 12 tools still missing here are the
 * "exploration / execution" set (read, edit, write, multi_edit,
 * insert_after_anchor, bash, glob, grep, code_search, semantic_lookup,
 * web_search, web_fetch) — high-frequency, large-result, low-density-of-decision
 * tools where pruning to a preview is the right call.
 *
 * **Cross-package coupling**: these names mirror @kodax-ai/coding's
 * registry-declared tool names. session-lineage cannot import from coding
 * (would create a circular tsc -b dependency), so the names are duplicated
 * here. The `protected-tools-registry-parity.test.ts` asserts both sides
 * stay in sync — any name drift breaks the test.
 *
 * **Categories** (size context: 1 baseline → 23):
 *   - skill content (1)        — already protected pre-F183
 *   - user-interaction (2)     — ask_user_question, exit_plan_mode
 *   - task delegation (3)      — dispatch_child_task, task_stop, send_message
 *   - control plane (1)        — emit_managed_protocol
 *   - worktree / undo (3)      — worktree_create, worktree_remove, undo
 *   - MCP (5)                  — mcp_search/describe/call/read_resource/get_prompt
 *   - repo intelligence (8)    — repo_overview, changed_scope, changed_diff,
 *                                changed_diff_bundle, module_context,
 *                                symbol_context, process_context, impact_estimate
 */
const PRUNE_PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  // Pre-F183
  'skill',
  // User-interaction + plan
  'ask_user_question',
  'exit_plan_mode',
  // Task delegation / control flow
  'dispatch_child_task',
  'task_stop',
  'send_message',
  // Control plane
  'emit_managed_protocol',
  // Worktree / undo (low-frequency but high-value control events)
  'worktree_create',
  'worktree_remove',
  'undo',
  // MCP — user-configured external tools, results high-reuse
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
  // Repo intelligence — already-condensed high-density capsules
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
]);

/**
 * Exported as the canonical PROTECTED set so peer modules
 * (microcompaction.ts default config, registry-parity test, future
 * Stage 3 ledger work) can pull a single source-of-truth.
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = PRUNE_PROTECTED_TOOLS;

const MAX_SUMMARIZATION_TOKENS_PER_CHUNK = 50000;
const SUMMARIZATION_RETRY_DELAY_MS = 2000;
/**
 * Marker prefix on the synthesized summary system message. Other packages
 * use this literal as the discriminator to tell CompactionSummary system
 * messages apart from role-prompt system messages \u2014 exported so callers
 * (notably `@kodax-ai/coding`'s `preserveTranscriptForRoundExit`) cannot
 * drift from the producer side.
 */
export const COMPACTION_SUMMARY_PREFIX = '[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n';

/** User messages below this token threshold are never truncated */
const USER_MESSAGE_PROTECTION_TOKENS = 800;
/** Tokens to keep from the head of a long user message */
const USER_MESSAGE_HEAD_TOKENS = 400;
/** Tokens to keep from the tail of a long user message */
const USER_MESSAGE_TAIL_TOKENS = 200;

export interface ToolContextInfo {
  name: string;
  preview: string;
}

interface ToolContextSeed {
  id: string;
  name: string;
  action: string;
  target?: string;
  query?: string;
  previewOverride?: string;
}

interface PruneDecision {
  idsToPrune: Set<string>;
  prunableTokens: number;
}

interface PruneResult {
  messages: KodaXMessage[];
  hasPruned: boolean;
}

interface SummaryAttemptResult {
  summary: string;
  summarizedMessages: number;
  failed: boolean;
}

/**
 * FEATURE_181 (v0.7.42): detect LLM "I have no content to summarize" output.
 *
 * Empty-like markers observed across 788 sessions (7.8% of compactions):
 *   - "No active goal" / "no active goal"
 *   - "conversation is empty" / "The conversation is empty"
 *   - "no prior context"
 *   - "nothing to summarize" / "no content to summarize"
 *
 * Also catches very short outputs (< 80 chars) — a meaningful goal summary
 * is empirically ≥150 chars even for simple tasks. Conservative threshold:
 * false positives only cause us to KEEP the previous summary, never lose
 * information.
 *
 * Exported for unit testing.
 */
export function isEmptyLikeSummary(summary: string): boolean {
  if (!summary) return true;
  const trimmed = summary.trim();
  if (trimmed.length < 80) return true;
  const lower = trimmed.toLowerCase();
  const emptyMarkers = [
    'no active goal',
    'conversation is empty',
    'no prior context',
    'nothing to summarize',
    'no content to summarize',
    'no content provided',
  ];
  return emptyMarkers.some((m) => lower.includes(m));
}

export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  tokenCountOverride?: number,
): boolean {
  if (!config.enabled) return false;

  const tokens = tokenCountOverride ?? estimateTokens(messages);
  const threshold = getTriggerTokens(config, contextWindow);
  return tokens > threshold;
}

export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string,
  tokenCountOverride?: number,
  summaryPrompt?: string,
  updateSummaryPrompt?: string,
): Promise<CompactionResult> {
  const tokensBefore = tokenCountOverride ?? estimateTokens(messages);

  if (!needsCompaction(messages, config, contextWindow, tokenCountOverride)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  let previousSummary: string | undefined;
  let remainingMessages = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === 'system'
      && typeof msg.content === 'string'
      && msg.content.startsWith(COMPACTION_SUMMARY_PREFIX)
    ) {
      previousSummary = msg.content.slice(COMPACTION_SUMMARY_PREFIX.length);
      remainingMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  const protectionPercent = config.protectionPercent ?? 20;
  const protectionTokens = Math.floor(contextWindow * (protectionPercent / 100));
  const protectCutIndex = findCutPoint(remainingMessages, protectionTokens);
  const toProcess = remainingMessages.slice(0, protectCutIndex);
  const toProtect = remainingMessages.slice(protectCutIndex);

  if (toProcess.length === 0) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  const totalFileOps = extractFileOps(toProcess);
  const artifactLedger = extractArtifactLedger(toProcess);

  const pruningThresholdTokens = config.pruningThresholdTokens ?? 500;
  const toolContextMap = buildToolContextMap(toProcess);
  const structuredPrune = collectStructuredPruneIds(toProcess, toolContextMap);
  const pruneResult = pruneToolResults(
    toProcess,
    toolContextMap,
    structuredPrune,
    pruningThresholdTokens,
  );

  const prunedMessages = pruneResult.messages;
  const prunedQueue = [...prunedMessages, ...toProtect];
  const triggerTokens = getTriggerTokens(config, contextWindow);

  const pruningGapRatio = config.pruningGapRatio ?? 0.8;
  // FEATURE_182 (v0.7.42): fast-path is ONLY safe when a previousSummary
  // exists to retain. Without one, fast-path returns
  // buildFallbackCompactionSummary which cements the generic "Continue the
  // current task" template as the session summary forever (subsequent
  // fast-path compactions then reuse that template as previousSummary).
  // 48% of compactions take fast-path per the 788-session scan; many are
  // session-first compactions that get permanently stuck on the fallback.
  // Force slow-path in this case so LLM seeds a real summary at least
  // once. If slow-path also breaks early (currentMessages ≤ targetTokens),
  // the existing fallback at finalSummary || ... line still applies — same
  // outcome as before, no regression.
  if (
    previousSummary
    && pruneResult.hasPruned
    && estimateTokens(prunedQueue) <= triggerTokens * pruningGapRatio
  ) {
    const retainedSummary = previousSummary;
    const finalMessages = [createSummaryMessage(retainedSummary), ...prunedQueue];
    const tokensAfter = estimateTokens(finalMessages);
    const memorySeed = extractCompactMemorySeed(retainedSummary, totalFileOps);

    return {
      compacted: true,
      messages: finalMessages,
      summary: retainedSummary,
      tokensBefore,
      tokensAfter,
      entriesRemoved: 0,
      details: totalFileOps,
      artifactLedger,
      memorySeed,
      anchor: createCompactionAnchor(
        retainedSummary,
        tokensBefore,
        tokensAfter,
        0,
        totalFileOps,
        artifactLedger,
        memorySeed,
      ),
    };
  }

  const rollingSummaryPercent = config.rollingSummaryPercent ?? 10;
  const rollingSummaryTokens = Math.max(
    1,
    Math.floor(contextWindow * (rollingSummaryPercent / 100)),
  );
  const targetTokens = getTargetTokens(config, contextWindow);

  let summary = previousSummary || '';
  let workingProcess = prunedMessages;
  let entriesRemoved = 0;

  while (workingProcess.length > 0) {
    const currentMessages = buildCompactedMessages(summary, workingProcess, toProtect);
    if (estimateTokens(currentMessages) <= targetTokens) {
      break;
    }

    const summarizeCutIndex = Math.max(
      1,
      findForwardCutPoint(workingProcess, rollingSummaryTokens),
    );
    const toSummarize = workingProcess.slice(0, summarizeCutIndex);
    if (toSummarize.length === 0) {
      break;
    }

    const summaryAttempt = await summarizeMessages(
      toSummarize,
      provider,
      customInstructions,
      systemPrompt,
      summary,
      summaryPrompt,
      updateSummaryPrompt,
    );

    if (summaryAttempt.summarizedMessages === 0) {
      break;
    }

    // FEATURE_181 (v0.7.42): empty-like LLM summary must NOT overwrite a
    // non-empty previous summary. Empty output happens 7.8% of the time
    // (788-session scan) when the toSummarize chunk consists entirely of
    // [Cleared:...] / [Pruned:...] placeholders — microcompact +
    // pruneToolResults already stripped the facts before the LLM ran. The
    // LLM correctly reports "no content to summarize" but overwriting a
    // real prior summary with that empty marker erases the only memory of
    // earlier islands. This caused the 091743 kimi loop: post-compact
    // summary said "No active goal" and the model re-attempted file reads
    // it had no record of having done. Always consume the chunk (move
    // workingProcess forward) but keep the previous summary if the new
    // one is empty-like.
    if (isEmptyLikeSummary(summaryAttempt.summary) && summary) {
      workingProcess = workingProcess.slice(summaryAttempt.summarizedMessages);
      entriesRemoved += summaryAttempt.summarizedMessages;
      if (summaryAttempt.failed) {
        break;
      }
      continue;
    }

    summary = summaryAttempt.summary;
    workingProcess = workingProcess.slice(summaryAttempt.summarizedMessages);
    entriesRemoved += summaryAttempt.summarizedMessages;

    if (summaryAttempt.failed) {
      break;
    }
  }

  const summaryChanged = summary !== (previousSummary || '');
  const didCompact = pruneResult.hasPruned || entriesRemoved > 0 || summaryChanged;
  if (!didCompact) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
      details: totalFileOps,
    };
  }

  const finalSummary = summary || buildFallbackCompactionSummary(totalFileOps, artifactLedger);
  const compactedMessages = buildCompactedMessages(finalSummary, workingProcess, toProtect);
  const tokensAfter = estimateTokens(compactedMessages);
  const memorySeed = extractCompactMemorySeed(finalSummary, totalFileOps);

  return {
    compacted: true,
    messages: compactedMessages,
    summary: finalSummary || undefined,
    tokensBefore,
    tokensAfter,
    entriesRemoved,
    details: totalFileOps,
    artifactLedger,
    memorySeed,
    anchor: createCompactionAnchor(
      finalSummary,
      tokensBefore,
      tokensAfter,
      entriesRemoved,
      totalFileOps,
      artifactLedger,
      memorySeed,
    ),
  };
}

async function summarizeMessages(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  customInstructions: string | undefined,
  systemPrompt: string | undefined,
  previousSummary: string,
  summaryPrompt: string | undefined,
  updateSummaryPrompt: string | undefined,
): Promise<SummaryAttemptResult> {
  let summary = previousSummary;
  let summarizedMessages = 0;
  const chunks = chunkMessages(messages, MAX_SUMMARIZATION_TOKENS_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.length === 0) continue;

    try {
      summary = await generateSummary(
        chunk,
        provider,
        extractFileOps(chunk),
        customInstructions,
        systemPrompt,
        summary || undefined,
        summaryPrompt,
        updateSummaryPrompt,
      );
      summarizedMessages += chunk.length;
    } catch (error) {
      if (process.env.KODAX_DEBUG_COMPACTION) {
        console.warn('[Compaction] Summary chunk failed, keeping partial summary progress.', error);
      }
      return { summary, summarizedMessages, failed: true };
    }

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SUMMARIZATION_RETRY_DELAY_MS));
    }
  }

  return { summary, summarizedMessages, failed: false };
}

function buildCompactedMessages(
  summary: string,
  messages: KodaXMessage[],
  protectedMessages: KodaXMessage[],
): KodaXMessage[] {
  return summary
    ? [createSummaryMessage(summary), ...messages, ...protectedMessages]
    : [...messages, ...protectedMessages];
}

function createSummaryMessage(summary: string): KodaXMessage {
  return {
    role: 'system',
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}`,
  };
}

function createCompactionAnchor(
  summary: string,
  tokensBefore: number,
  tokensAfter: number,
  entriesRemoved: number,
  details: CompactionResult['details'],
  artifactLedger: NonNullable<CompactionResult['artifactLedger']>,
  memorySeed: NonNullable<CompactionResult['memorySeed']>,
): CompactionAnchor {
  return {
    summary,
    tokensBefore,
    tokensAfter,
    entriesRemoved,
    reason: 'automatic_compaction',
    artifactLedgerId: artifactLedger.length > 0
      ? `ledger_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      : undefined,
    details,
    memorySeed,
  };
}

function buildFallbackCompactionSummary(
  details: NonNullable<CompactionResult['details']>,
  artifactLedger: NonNullable<CompactionResult['artifactLedger']>,
): string {
  const importantTargets = Array.from(new Set([
    ...details.readFiles,
    ...details.modifiedFiles,
    ...artifactLedger.map((entry) => entry.displayTarget ?? entry.target),
  ])).slice(0, 8);

  const keyContextLines = importantTargets.length > 0
    ? importantTargets.map((target) => `- ${target}`)
    : ['- No high-value targets recorded'];
  const readFiles = details.readFiles.length > 0 ? details.readFiles : [''];
  const modifiedFiles = details.modifiedFiles.length > 0 ? details.modifiedFiles : [''];

  return [
    '## Goal',
    'Continue the current task from the latest preserved context.',
    '',
    '## Constraints & Preferences',
    '- Preserve existing user intent and repo-local constraints.',
    '',
    '## Progress',
    '### Completed',
    '- [x] Older context was compacted into a durable anchor.',
    '',
    '### In Progress',
    '- [ ] Continue from the latest preserved tail.',
    '',
    '### Blockers',
    '- None',
    '',
    '## Key Decisions',
    '- **Compaction**: Keep only continuation-critical history.',
    '',
    '## Next Steps',
    '1. Re-open the most relevant targets before continuing if needed.',
    '',
    '## Key Context',
    ...keyContextLines,
    '',
    '---',
    '',
    '<read-files>',
    ...readFiles,
    '</read-files>',
    '',
    '<modified-files>',
    ...modifiedFiles,
    '</modified-files>',
  ].join('\n');
}

function getTriggerTokens(config: CompactionConfig, contextWindow: number): number {
  return contextWindow * (config.triggerPercent / 100);
}

function getTargetTokens(config: CompactionConfig, contextWindow: number): number {
  const protectionPercent = config.protectionPercent ?? 20;
  const triggerPercent = config.triggerPercent;

  if (triggerPercent <= protectionPercent) {
    return getTriggerTokens(config, contextWindow);
  }

  const targetPercent = protectionPercent + 0.4 * (triggerPercent - protectionPercent);
  return Math.floor(contextWindow * (targetPercent / 100));
}

function splitPathSegments(target: string): string[] {
  return target.split(/[\\/]+/).filter(Boolean);
}

function isPathLikeTarget(target: string | undefined): boolean {
  if (!target) {
    return false;
  }
  return /[\\/]/.test(target) || /\.[a-z0-9]+$/i.test(target);
}

function shortestUniqueSuffix(target: string, allTargets: string[]): string {
  const parts = splitPathSegments(target);
  if (parts.length === 0) {
    return target;
  }

  for (let length = 1; length <= parts.length; length++) {
    const suffix = parts.slice(-length).join('/');
    const matches = allTargets.filter((candidate) => candidate.endsWith(suffix));
    if (matches.length === 1) {
      return suffix;
    }
  }

  return parts.join('/');
}

export function buildToolContextMap(messages: KodaXMessage[]): Map<string, ToolContextInfo> {
  const toolContextMap = new Map<string, ToolContextInfo>();
  const seeds: ToolContextSeed[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;

      const name = String(block.name || 'tool');
      const input = (block.input as Record<string, unknown>) || {};
      const command = input.command ?? input.CommandLine ?? input.command_line;

      if (typeof command === 'string' && command.trim()) {
        const intent = extractBashIntent(command);
        const parts = intent.split(/\s+/);
        seeds.push({
          id: block.id,
          name,
          action: parts[0] ?? name,
          target: parts.slice(1).find((token) => token && !token.startsWith('-')) ?? parts[0] ?? name,
          previewOverride: intent,
        });
        continue;
      }

      const target = (() => {
        const pathLikeKeys = [
          'path',
          'file',
          'outputPath',
          'cwd',
          'target_path',
          'scenePath',
          'scriptPath',
          'resourcePath',
          'module',
          'entry',
          'url',
        ] as const;
        for (const key of pathLikeKeys) {
          const value = input[key];
          if (typeof value === 'string' && value.trim()) {
            return value.trim();
          }
        }
        return undefined;
      })();
      const query = typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.query === 'string'
          ? input.query
          : undefined;
      const action = name === 'write' ? 'write'
        : name === 'edit' ? 'edit'
          : name === 'read' ? 'read'
            : name === 'grep' ? 'grep'
              : name;

      seeds.push({
        id: block.id,
        name,
        action,
        target,
        query,
      });
    }
  }

  const pathTargets = seeds
    .map((seed) => seed.target)
    .filter((target): target is string => isPathLikeTarget(target));

  for (const seed of seeds) {
    let preview: string;

    if (seed.previewOverride) {
      preview = seed.previewOverride;
    } else {
      const displayTarget = seed.target
        ? (isPathLikeTarget(seed.target)
          ? shortestUniqueSuffix(seed.target, pathTargets)
          : seed.target)
        : undefined;

      preview = seed.query && displayTarget
        ? `${seed.action} ${displayTarget} "${seed.query}"`
        : displayTarget
          ? `${seed.action} ${displayTarget}`
          : seed.query
            ? `${seed.action} "${seed.query}"`
            : seed.name;
    }

    toolContextMap.set(seed.id, {
      name: seed.name,
      preview,
    });
  }

  return toolContextMap;
}

function collectStructuredPruneIds(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>,
): PruneDecision {
  let protectedTurns = 0;
  let protectedToolTokens = 0;
  let prunableTokens = 0;
  const idsToPrune = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'user') {
      protectedTurns++;
    }

    if (protectedTurns < 2 || msg.role !== 'user' || !Array.isArray(msg.content)) {
      continue;
    }

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block?.type !== 'tool_result' || typeof block.content !== 'string') continue;

      const toolInfo = toolContextMap.get(block.tool_use_id);
      if (toolInfo && PRUNE_PROTECTED_TOOLS.has(toolInfo.name)) continue;

      const blockTokens = countToolResultTokens(block.content);
      protectedToolTokens += blockTokens;

      if (protectedToolTokens > STRUCTURED_PRUNE_PROTECT_TOKENS) {
        idsToPrune.add(block.tool_use_id);
        prunableTokens += blockTokens;
      }
    }
  }

  if (prunableTokens < STRUCTURED_PRUNE_MINIMUM_TOKENS) {
    return { idsToPrune: new Set<string>(), prunableTokens: 0 };
  }

  return { idsToPrune, prunableTokens };
}

function pruneToolResults(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>,
  structuredPrune: PruneDecision,
  pruningThresholdTokens: number,
): PruneResult {
  let hasPruned = false;
  const prunedMessages = messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      // Truncate long string-content user messages (non-array)
      if (msg.role === 'user' && typeof msg.content === 'string') {
        return truncateUserMessage(msg);
      }
      return msg;
    }

    let changed = false;
    const newContent = msg.content.map((block) => {
      // Truncate long user text blocks
      if (block.type === 'text' && 'text' in block) {
        const truncated = truncateUserText(block.text);
        if (truncated !== block.text) {
          changed = true;
          hasPruned = true;
          return { ...block, text: truncated };
        }
        return block;
      }

      if (block.type !== 'tool_result' || typeof block.content !== 'string') {
        return block;
      }

      // FEATURE_183 (v0.7.42): protected tools are immune to BOTH
      // structured-prune AND oversize-prune. Pre-F183 the oversize path
      // ignored the protected set entirely — meaning a single >50K-token
      // result from `skill` / `mcp_call` / `dispatch_child_task` would still
      // be replaced with `[Pruned: ...]`. That's exactly the failure mode
      // PROTECTED is supposed to prevent. The structured-prune layer already
      // skips protected tools in `collectStructuredPruneIds`; this same
      // belt-and-suspenders check on the oversize path closes the gap.
      const toolInfoForProtection = toolContextMap.get(block.tool_use_id);
      if (toolInfoForProtection && PRUNE_PROTECTED_TOOLS.has(toolInfoForProtection.name)) {
        return block;
      }

      const shouldStructuredPrune = structuredPrune.idsToPrune.has(block.tool_use_id);
      const shouldOversizePrune = countTokens(block.content) > pruningThresholdTokens;
      if (!shouldStructuredPrune && !shouldOversizePrune) {
        return block;
      }

      changed = true;
      hasPruned = true;
      const toolInfo = toolContextMap.get(block.tool_use_id);
      return {
        ...block,
        content: toolInfo ? `[Pruned: ${toolInfo.preview}]` : '[Pruned]',
      };
    });

    return changed ? { ...msg, content: newContent } : msg;
  });

  return { messages: prunedMessages, hasPruned };
}

/**
 * Truncate a long user text string, preserving head and tail.
 * Short texts (≤ USER_MESSAGE_PROTECTION_TOKENS) are returned as-is.
 */
export function truncateUserText(text: string): string {
  const tokens = countTokens(text);
  if (tokens <= USER_MESSAGE_PROTECTION_TOKENS) return text;

  const headChars = Math.floor(text.length * (USER_MESSAGE_HEAD_TOKENS / tokens));
  const tailChars = Math.floor(text.length * (USER_MESSAGE_TAIL_TOKENS / tokens));
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);

  return `${head}\n[…user message truncated, original ~${tokens} tokens…]\n${tail}`;
}

/** Truncate a string-content user message */
function truncateUserMessage(msg: KodaXMessage): KodaXMessage {
  if (typeof msg.content !== 'string') return msg;
  const truncated = truncateUserText(msg.content);
  return truncated !== msg.content ? { ...msg, content: truncated } : msg;
}

function countToolResultTokens(content: string): number {
  return 4 + countTokens(content);
}

function getAtomicBlocks(messages: KodaXMessage[]): Array<{ start: number; end: number; tokens: number }> {
  const atomicBlocks: Array<{ start: number; end: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const hasToolUse = msg.role === 'assistant'
      && Array.isArray(msg.content)
      && msg.content.some((b: KodaXContentBlock) => b.type === 'tool_use');

    if (hasToolUse) {
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user'
        && Array.isArray(nextMsg.content)
        && nextMsg.content.some((b: KodaXContentBlock) => b.type === 'tool_result');

      if (hasNextToolResult) {
        atomicBlocks.push({
          start: i,
          end: i + 1,
          tokens: estimateTokens([msg, nextMsg]),
        });
        i++;
        continue;
      }
    }

    atomicBlocks.push({
      start: i,
      end: i,
      tokens: estimateTokens([msg]),
    });
  }

  return atomicBlocks;
}

function findCutPoint(messages: KodaXMessage[], keepRecentTokens: number): number {
  let tokenCount = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    if (tokenCount > keepRecentTokens) {
      return block.start;
    }
  }

  return 0;
}

function findForwardCutPoint(messages: KodaXMessage[], targetTokens: number): number {
  let tokenCount = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  if (atomicBlocks.length === 0) {
    return messages.length > 0 ? 1 : 0;
  }

  let cutEndIndex = 0;
  for (let i = 0; i < atomicBlocks.length; i++) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    cutEndIndex = block.end + 1;
    if (tokenCount >= targetTokens) {
      break;
    }
  }

  return Math.min(cutEndIndex, messages.length);
}

function chunkMessages(messages: KodaXMessage[], maxTokensPerChunk: number): KodaXMessage[][] {
  const chunks: KodaXMessage[][] = [];
  let currentChunk: KodaXMessage[] = [];
  let currentTokens = 0;

  const atomicBlocks = getAtomicBlocks(messages);

  for (const block of atomicBlocks) {
    const group = messages.slice(block.start, block.end + 1);
    const groupTokens = block.tokens;

    if (currentTokens + groupTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
      currentTokens = groupTokens;
      continue;
    }

    currentChunk.push(...group);
    currentTokens += groupTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
