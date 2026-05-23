/**
 * Coding-tool runtime wrappers for the runner-driven AMA path.
 *
 * Hosts:
 *   - `WRITE_ONLY_TOOL_NAMES` + `SHELL_MUTATION_EXTENSIONS` — the
 *     write/edit + mutating-shell-command sets that drive both the
 *     mutation tracker and the role-bound guard wrappers
 *   - `recordMutationForTool` — populates `ctx.mutationTracker` per
 *     legacy `beforeToolExecute` parity
 *   - `wrapCodingToolAsRunnable` — generic coding handler →
 *     `RunnableTool` adapter (per-call progress, budget metering,
 *     mutation tracker, error envelope)
 *   - `wrapReadOnlyBash` — verification-only bash guard (Evaluator)
 *   - the two Generator-side write/bash mutation-guard wrappers (now
 *     thin pass-throughs after FEATURE_193 retired the V1 Scout role
 *     that fed mutation intent; wrap signatures preserved for the
 *     `agent-chain.ts` Map-override call sites)
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~1361–1621 of
 * the pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41)
 * modular split.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  RunnableTool,
  RunnerToolContext,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { incrementManagedBudgetUsage } from './budget.js';
import type { ManagedTaskBudgetController } from './budget.js';
import {
  matchesShellPattern,
  SHELL_WRITE_PATTERNS,
} from './tool-policy.js';
import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  ManagedMutationTracker,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import type { VerdictRecorder } from './types.js';

// =============================================================================
// Tool wrapping: coding handler → RunnableTool
// =============================================================================

const WRITE_ONLY_TOOL_NAMES = new Set(['write', 'edit', 'insert_after_anchor']);

/**
 * Mirror of the legacy `beforeToolExecute` mutation-tracking branch in
 * task-engine.ts:~3907. Populates `ctx.mutationTracker` with files +
 * totalOps when a write/edit tool runs (or bash executes a destructive
 * command). Idempotent — missing tracker is a no-op.
 */
export function recordMutationForTool(
  tracker: ManagedMutationTracker | undefined,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!tracker) return;
  const normalized = toolName.toLowerCase();
  if (WRITE_ONLY_TOOL_NAMES.has(normalized) || normalized === 'bash') {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : undefined;
    if (filePath) {
      const oldLen = typeof input.old_string === 'string' ? input.old_string.split('\n').length : 0;
      const newLen = typeof input.new_string === 'string' ? input.new_string.split('\n').length : 0;
      const contentLen = typeof input.content === 'string' ? input.content.split('\n').length : 0;
      const linesDelta = contentLen || Math.abs(newLen - oldLen) || 1;
      tracker.files.set(filePath, (tracker.files.get(filePath) ?? 0) + linesDelta);
      tracker.totalOps += 1;
    } else if (normalized === 'bash') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (/\b(git\s+(add|commit|push|merge|rebase|reset)|npm\s+(publish|install)|rm\s|mv\s|cp\s)/i.test(cmd)) {
        tracker.totalOps += 1;
      }
    }
  }
}

export function wrapCodingToolAsRunnable(
  definition: KodaXToolDefinition,
  handler: (
    input: Record<string, unknown>,
    ctx: KodaXToolExecutionContext,
  ) => Promise<RunnerToolResult['content']>,
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...definition,
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      recordMutationForTool(baseCtx.mutationTracker, definition.name, input);
      // Attach reportToolProgress per-call so async-generator
      // tools (dispatch_child_task) can surface their internal progress via
      // KodaXEvents.onToolProgress → REPL transcript. Mirrors
      // `agent.ts:1345-1353` (ctxWithProgress wrapping).
      const toolCallId = runnerCtx?.toolCallId;
      const ctxForCall: KodaXToolExecutionContext = events?.onToolProgress && toolCallId
        ? {
          ...baseCtx,
          reportToolProgress: (message: string) => {
            events.onToolProgress?.({ id: toolCallId, message });
          },
        }
        : baseCtx;
      try {
        const content = await handler(input, ctxForCall);
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `[Tool Error] ${definition.name}: ${message}`, isError: true };
      }
    },
  };
}

/**
 * Shell commands that mutate the filesystem / git state. Super-set of the
 * legacy `SHELL_WRITE_PATTERNS` allow-list (tool-policy.ts:110) so
 * verification-only roles (Evaluator) can still use `bash` for read-only
 * checks (ls, cat, git diff, etc.) without silently gaining write
 * capability.
 *
 * v0.7.26 H4 parity — the first group mirrors legacy exactly:
 *   - PowerShell verbs (Set-Content / Add-Content / Out-File / Tee-Object /
 *     Copy-Item / Move-Item / Rename-Item / Remove-Item / New-Item /
 *     Clear-Content)
 *   - Unix basic (rm / mv / cp / del / erase / touch / mkdir / rmdir /
 *     rename / ren)
 *   - Script exec (sed -i / perl -pi / python -c / node -e)
 *   - Redirect (> / >> outside of 2>&1 / &1 forms)
 * The second group extends legacy with v0.7.26 safety patterns:
 *   - chmod / chown
 *   - git write verbs (add / commit / push / merge / rebase / reset /
 *     checkout <ref> / rm)
 *   - package-manager install/publish/update verbs (npm / pnpm / yarn)
 *
 * Matches on leading command-word boundary — `rm /tmp/foo` blocks
 * but `node rm-stub.js` does not.
 */
/**
 * v0.7.26 extensions to legacy `SHELL_WRITE_PATTERNS`. Legacy only guarded
 * classic filesystem-mutating shells; these cover state-changing shells
 * that surfaced as risks after FEATURE_084 landed. `SHELL_WRITE_PATTERNS`
 * (imported from `tool-policy.ts`) is applied first; these extensions
 * apply second so the combined set is a strict super-set.
 */
const SHELL_MUTATION_EXTENSIONS: readonly string[] = [
  '\\bchmod\\s',
  '\\bchown\\s',
  '\\bgit\\s+(?:add|commit|push|merge|rebase|reset|checkout\\s+[^-]|rm)',
  '\\bnpm\\s+(?:install|publish|update|rm)',
  '\\bpnpm\\s+(?:install|publish|update|rm)',
  '\\byarn\\s+(?:add|publish|remove)',
];

/**
 * Wrap a bash tool so verification-only roles (Scout / Evaluator) cannot
 * execute shell commands that mutate the filesystem or git state.
 *
 * P2 parity — reuses the same `SHELL_WRITE_PATTERNS` set the Generator
 * docs-scoped / review-only guard uses, so all three roles share a
 * single source of truth. The v0.7.26 safety extensions sit on top of
 * the legacy set — never narrower.
 *
 * Mirrors legacy `createToolPolicyHook` behaviour at task-engine.ts
 * ~1915 which blocked `SHELL_WRITE_PATTERNS` on read-only role tool
 * policies. Non-bash tools pass through unchanged.
 */
export function wrapReadOnlyBash(bashTool: RunnableTool, roleTitle: string): RunnableTool {
  return {
    ...bashTool,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (command) {
        // Shared super-set: legacy SHELL_WRITE_PATTERNS + v0.7.26 safety
        // extensions. Using the shared set here (instead of calling
        // enforceShellWriteBoundary, which carries the Generator-flavored
        // "docs-only" message) lets Scout / Evaluator keep their own
        // "verification-only" blocking message — matches legacy
        // createToolPolicyHook branching.
        if (
          matchesShellPattern(command, SHELL_WRITE_PATTERNS)
          || matchesShellPattern(command, SHELL_MUTATION_EXTENSIONS)
        ) {
          // v0.7.26: Scout no longer uses this wrapper (Scout has full
          // tools per v22 parity); only Evaluator reaches here. Evaluator
          // IS verification-only by architectural design — its job is to
          // spot-check the Generator handoff, not mutate state. The
          // block message names that role semantic + the read-intent
          // hint for `python -c` / `node -e` so the LLM reaches for
          // `read` / `grep` instead of re-trying shell.
          const isReadIntent = /^python\s+-c|^node\s+-e/.test(command);
          const hint = isReadIntent
            ? 'If you only need to inspect a file, use the `read` or `grep` tool instead — both go around the shell.'
            : 'If mutation is genuinely required by the verification contract, flag it in the verdict reason instead of performing it here.';
          return {
            content:
              `[Managed Task ${roleTitle}] Shell command blocked because this role is verification-only. ${hint} Blocked command: ${command.slice(0, 120)}`,
            isError: true,
          };
        }
      }
      return bashTool.execute(input, ctx);
    },
  };
}

/**
 * Shard 6d-j + 6d-M — Generator write / shell mutation boundary.
 *
 * Mirrors the legacy `createToolPolicyHook` behaviour (task-engine.ts
 * ~1891) for the runner-driven Generator:
 *   - `'review-only'` → Generator write/edit blocked; destructive shell
 *     commands blocked (review tasks must not mutate state).
 *   - `'docs-scoped'` → Generator write/edit gated against
 *     `DOCS_ONLY_WRITE_PATH_PATTERNS` (docs/*.md / CHANGELOG /
 *     FEATURE_LIST / etc.); destructive shell commands blocked.
 *   - `'open'` (default) → tools pass through unchanged.
 *
 * FEATURE_193 (v0.7.43): V1 Scout role retired — `recorder.scout` is never
 * populated on the V2 path, so `resolveGeneratorMutationIntent` permanently
 * returned `'open'`. The helper + its `inferScoutMutationIntent` call were
 * removed; the wrap functions now short-circuit on a constant `intent`. The
 * wrap function signatures keep `recorder` / `planRef` parameters so the
 * call sites in `agent-chain.ts` remain stable (the V2 Worker still threads
 * both refs for the worker `instructions` closure to consume).
 */

export function wrapGeneratorWriteWithMutationGuard(
  writeOrEdit: RunnableTool,
  _recorder: VerdictRecorder,
  _planRef: { current: ReasoningPlan | undefined },
): RunnableTool {
  return {
    ...writeOrEdit,
    execute: async (input, ctx): Promise<RunnerToolResult> => writeOrEdit.execute(input, ctx),
  };
}

export function wrapGeneratorBashWithMutationGuard(
  bashTool: RunnableTool,
  _recorder: VerdictRecorder,
  _planRef: { current: ReasoningPlan | undefined },
): RunnableTool {
  return {
    ...bashTool,
    execute: async (input, ctx): Promise<RunnerToolResult> => bashTool.execute(input, ctx),
  };
}
