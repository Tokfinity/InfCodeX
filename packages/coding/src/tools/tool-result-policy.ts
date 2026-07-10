import type { KodaXToolExecutionContext } from '../types.js';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import {
  formatSize,
  persistToolOutput,
  truncateHead,
  truncateTail,
} from './truncate.js';
import {
  clampToolResultPolicyToBudget,
  type ToolResultBudget,
} from './tool-result-budget.js';

export interface ToolResultPolicy {
  maxLines: number;
  maxBytes: number;
  direction: 'head' | 'tail';
  spillToFile: boolean;
}

export interface GuardedToolResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
  policy: ToolResultPolicy;
  /**
   * FEATURE_121 v0.7.40 — set when `persistToolOutput` threw and
   * `content` was returned inline as the data-loss-guard fallback.
   * Callers that need an LLM-summary follow-up (`dispatch-child-tasks`
   * for `child_task_summary`) branch on this flag. Undefined/false
   * means the normal success path ran.
   */
  spillFailed?: boolean;
}

const DEFAULT_POLICY: ToolResultPolicy = {
  maxLines: 1200,
  maxBytes: 40 * 1024,
  direction: 'head',
  spillToFile: true,
};

const TOOL_RESULT_POLICIES: Record<string, ToolResultPolicy> = {
  read: {
    maxLines: 2000,
    maxBytes: 50 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  bash: {
    maxLines: 600,
    maxBytes: 32 * 1024,
    direction: 'tail',
    spillToFile: true,
  },
  grep: {
    maxLines: 400,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_search: {
    maxLines: 240,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_fetch: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  code_search: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  semantic_lookup: {
    maxLines: 260,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff: {
    maxLines: 1400,
    maxBytes: 48 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff_bundle: {
    maxLines: 1600,
    maxBytes: 56 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  write: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  edit: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  // FEATURE_121 (v0.7.40): child task <task-completed> banner summary.
  // 50KB / head — aligns with `read`. Child role prompts encourage placing
  // executive summary in the report head, so head-direction preserves the
  // most decision-relevant content for Worker.
  child_task_summary: {
    maxLines: 1500,
    maxBytes: 50 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  tool_call: {
    maxLines: 2200,
    maxBytes: 64 * 1024,
    direction: 'head',
    spillToFile: true,
  },
};

export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  return TOOL_RESULT_POLICIES[toolName] ?? DEFAULT_POLICY;
}

function buildToolResultHint(toolName: string): string {
  switch (toolName) {
    case 'read':
      return 'Use read with offset/limit or grep to continue with a smaller slice.';
    case 'bash':
      return 'Narrow the command, or redirect output to a file before reading it.';
    case 'grep':
      return 'Narrow the pattern or path, or switch to files_with_matches/count first.';
    case 'web_search':
      return 'Refine the query or fetch a specific result URL for higher-confidence source capture.';
    case 'web_fetch':
      return 'Fetch a narrower page or follow up with read/grep on the saved output file.';
    case 'code_search':
      return 'Narrow the search root or query, or follow up with read on the matched file.';
    case 'semantic_lookup':
      return 'Narrow the query or use symbol_context/module_context for a deeper semantic follow-up.';
    case 'changed_diff':
      return 'Continue with changed_diff offset/limit, or switch to read for current-file context after identifying the relevant patch slice.';
    case 'changed_diff_bundle':
      return 'Use changed_diff_bundle to sweep high-priority files first, then switch to changed_diff or read for a specific suspicious file.';
    case 'write':
    case 'edit':
      return 'Inspect the file with read instead of relying on a huge diff preview.';
    case 'child_task_summary':
      return 'Use the Read tool on the saved output path to view the full child task report.';
    default:
      return 'Use a narrower follow-up tool call to inspect the missing details.';
  }
}

export interface ApplyToolResultGuardrailOptions {
  /**
   * FEATURE_121 (v0.7.40): force the guardrail down the spill+preview path
   * regardless of `policy.maxBytes`. Used by envelope aggregate budget
   * enforcement to reclaim space when N child summaries individually fit
   * but together exceed the envelope cap.
   */
  forceSpill?: boolean;
  /** Optional context-aware cap; omitted keeps the legacy per-tool policy. */
  toolResultBudget?: ToolResultBudget;
}

export async function applyToolResultGuardrail(
  toolName: string,
  content: string,
  ctx: KodaXToolExecutionContext,
  options?: ApplyToolResultGuardrailOptions,
): Promise<GuardedToolResult> {
  const policy = clampToolResultPolicyToBudget(
    getToolResultPolicy(toolName),
    options?.toolResultBudget,
  );
  // Under forceSpill, we still want the same head/tail preview behaviour, but
  // we treat any content as "must spill" so we go through the spill path.
  const effectivePolicy: ToolResultPolicy = options?.forceSpill
    ? { ...policy, maxBytes: Math.min(policy.maxBytes, 2 * 1024), maxLines: Math.min(policy.maxLines, 20) }
    : policy;
  const truncation =
    effectivePolicy.direction === 'tail'
      ? truncateTail(content, effectivePolicy)
      : truncateHead(content, effectivePolicy);

  if (!truncation.truncated && !options?.forceSpill) {
    return {
      content,
      truncated: false,
      policy,
    };
  }

  let outputPath: string | undefined;
  let spillFailed = false;
  let spillError: unknown;
  if (policy.spillToFile) {
    try {
      outputPath = await persistToolOutput(toolName, content, ctx);
    } catch (err) {
      outputPath = undefined;
      spillFailed = true;
      spillError = err;
    }
  }

  // FEATURE_121 v0.7.40 — spill-failure data-loss guard.
  //
  // When `persistToolOutput` throws (disk full / EACCES / EROFS / EIO /
  // ENOSPC / SELinux denial), the previous behaviour silently dropped
  // the truncation tail: caller got a `~50KB` preview with no spill
  // path and no marker, the remaining bytes were unrecoverable, and
  // the Worker had no signal that anything was lost.
  //
  // Treatment: return full `content` inlined with `truncated: false`.
  // The agent-layer envelope-budget enforcer will get a second chance
  // to spill at banner-composition time; if that also fails, the full
  // payload still rides in the LLM context (over-budget but visible)
  // rather than silently shrinking. User contract for FEATURE_121:
  // silent data loss > observable over-budget.
  //
  // `truncated: false` is the right field value here even though the
  // mechanism is "fallback inline" — all current callers
  // (dispatch-child-tasks.ts × 3, envelope-budget.ts × 1) read only
  // `.content`. If a future caller branches on `.truncated`, it should
  // treat this case the same as "small content fit in budget" (which
  // is exactly the externally-visible behaviour).
  //
  // Disk failure is still reported, but through the diagnostic channel so
  // interactive hosts can render or suppress it without corrupting the TUI.
  if (spillFailed) {
    emitKodaXDiagnostic({
      source: 'coding:tool-result-policy',
      level: 'error',
      message:
        `persistToolOutput failed for ${toolName}; ` +
        `inlining ${Buffer.byteLength(content, 'utf-8')} bytes to preserve data.`,
      detail: spillError,
    });
    return {
      content,
      truncated: false,
      policy,
      spillFailed: true,
    };
  }

  const preview =
    truncation.firstLineExceedsLimit && !truncation.content
      ? '[Output preview omitted because the first line alone exceeded the tool-output byte limit.]'
      : truncation.content;

  const prefix =
    policy.direction === 'tail'
      ? 'Tool output truncated to the most recent portion.'
      : 'Tool output truncated.';
  const summary =
    `${prefix} Showing ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  const saved =
    outputPath
      ? ` Full output saved to: ${outputPath}.`
      : '';
  const hint = ` ${buildToolResultHint(toolName)}`;
  const guardedContent = `${preview}\n\n[${summary}${saved}${hint}]`;

  if (process.env.KODAX_DEBUG_TOOL_GUARDRAILS) {
    emitKodaXDiagnostic({
      source: 'coding:tool-result-policy',
      level: 'debug',
      message: 'Tool result truncated by guardrail.',
      detail: {
        toolName,
        outputPath,
        totalBytes: truncation.totalBytes,
        shownBytes: truncation.outputBytes,
        truncatedBy: truncation.truncatedBy,
      },
    });
  }

  return {
    content: guardedContent,
    truncated: true,
    outputPath,
    policy,
  };
}
