/**
 * AutoModeToolGuardrail — FEATURE_092 Phase 2b.6 (v0.7.33).
 *
 * Assembles the auto-mode classifier modules (rules + projection +
 * classify + denial-tracker + circuit-breaker + model-resolver) into a
 * `ToolGuardrail` that the Runner calls via `beforeTool` on every
 * tool invocation.
 *
 * Decision flow (per design doc "三层权限金字塔"):
 *
 *   1. Tier-0 deterministic critical match   → user confirmation
 *   2. exact safe read/workspace-temp effect → allow (zero token cost)
 *   3. Tool projection is '' (Tier 1)        → allow
 *   4. Engine is rules → deterministic Tier 2, otherwise user confirms
 *   5. degraded classifier infrastructure    → Accept-edits fallback
 *   6. classify(...) sideQuery
 *        allow                                → allow (record allow → reset consecutive)
 *        confirm                              → user confirmation (record concern)
 *        failure                              → Accept-edits fallback (record error)
 *        AbortError thrown                    → re-throw (propagate user cancel)
 *
 * State (mutable, session-scoped):
 *   - engine: 'llm' | 'rules' (user-selected; classifier health never changes it)
 *   - denialTracker (immutable type, swapped on each event)
 *   - circuitBreaker (immutable type, swapped on each event)
 *
 * Subagent sharing:
 *   The factory accepts an optional `sharedState` ref; passing the same ref
 *   to a subagent's guardrail means denial / circuit / engine state is
 *   shared (per design doc "防绕阈值"). Without it each guardrail is
 *   independent.
 *
 * Provider capability checks and the explicit `supportsAutoModeClassifier`
 * flag are deferred to follow-up phases. Tier 2 is supplied by the Runtime
 * host because canonical filesystem and shell parsing live in @kodax/repl;
 * the guardrail remains the single decision point.
 */

import { createHash } from 'node:crypto';
import type { CostTracker, KodaXBaseProvider } from '@kodax-ai/llm';
import type {
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  ToolGuardrail,
} from '@kodax-ai/agent';

import {
  checkAbsoluteDeny,
  type AbsoluteDenyCheck,
  type AbsoluteDenyResult,
} from './absolute-denylist.js';
import { bashSignalCollector } from './bash-signals.js';
import {
  classify,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type ClassifierAttemptDiagnostics,
  type ClassifierFailureKind,
  type ClassifyDecision,
} from './classify.js';
import {
  createCircuitBreaker,
  recordError as recordBreakerError,
  shouldFallback as breakerShouldFallback,
  type CircuitBreaker,
} from './circuit-breaker.js';
import {
  createDenialTracker,
  recordAllow as recordDenialAllow,
  recordBlock as recordDenialBlock,
  type DenialTracker,
} from './denial-tracker.js';
import { fileSignalCollector } from './file-signals.js';
import {
  resolveClassifierModel,
  type ResolveClassifierModelOptions,
} from './model-resolver.js';
import type { AutoRules } from './rules.js';
import { collectAllSignals, type SignalCollector, type ToolCallSignal } from './signals.js';
import { speculativeRace } from './speculative.js';
import {
  buildPermissionIntentEvidence,
  type PermissionIntentEvidence,
} from './permission-intent.js';
import { safeFallbackToClassifierInput } from '../../tools/classifier-projection.js';
import { resolveToolBridgeTarget } from '../../tools/tool-bridge.js';

export type AutoModeEngine = 'llm' | 'rules';

export interface AutoModeSharedState {
  engine: AutoModeEngine;
  denials: DenialTracker;
  breaker: CircuitBreaker;
}

/**
 * User answer for an escalated tool-call. The guardrail translates this into
 * the actual `GuardrailVerdict` returned to the Runner. `'block'` preserves
 * the original escalation reason as the verdict reason so downstream consumers
 * see why the tool was blocked. `'timeout'` reports that the action was not
 * executed and gives the main model a bounded recovery instruction.
 */
export type AutoModeAskUserVerdict = 'allow' | 'block' | 'timeout';

export interface AutoModeDecisionDiagnostics {
  readonly source:
    | 'classifier_confirm'
    | 'classifier_failure'
    | 'classifier_circuit_breaker'
    | 'configuration';
  readonly classifierFailureKind?: ClassifierFailureKind;
  readonly classifierAttempts?: readonly ClassifierAttemptDiagnostics[];
}

/**
 * Optional REPL-supplied prompt callback for calls that require a human
 * decision (rules escalation, classifier concern/failure, or configuration
 * failure). When supplied, the guardrail calls this and
 * translates the user's answer into allow/block/timeout semantics. When NOT
 * supplied, the guardrail returns `'escalate'` as before — the Runner will
 * then throw `GuardrailEscalateError` (preserves backward compat with
 * SDK-side guardrail consumers that have no askUser surface).
 *
 * Rejection propagates: if the user cancels (Ctrl-C in the prompt), throw
 * an AbortError-shaped exception and the Runner aborts the run cleanly.
 */
export type AutoModeAskUser = (
  call: RunnerToolCall,
  reason: string,
  /**
   * FEATURE_158 (v0.7.39): static-analysis signals collected for this tool
   * call. Optional + readonly so existing callers without signal-aware UI
   * keep working. REPL uses these to render Scope/Risk labels on the
   * confirm dialog (replacing the input-marker path from FEATURE_066).
   */
  signals?: readonly ToolCallSignal[],
  diagnostics?: AutoModeDecisionDiagnostics,
) => Promise<AutoModeAskUserVerdict>;

export interface AutoModeRulesContext {
  readonly projectRoot: string;
  readonly executionCwd: string;
  readonly signals: readonly ToolCallSignal[];
}

export type AutoModePermissionBoundary =
  | 'workspace'
  | 'system-temp'
  | 'outside-workspace'
  | 'protected'
  | 'unresolved';

export interface AutoModePermissionTarget {
  readonly path: string;
  readonly boundary: AutoModePermissionBoundary;
}

export type AutoModePermissionOperation =
  | {
    readonly kind: 'read' | 'write' | 'create' | 'delete';
    readonly target: AutoModePermissionTarget;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  }
  | {
    readonly kind: 'copy' | 'move' | 'rename';
    readonly source: AutoModePermissionTarget;
    readonly destination: AutoModePermissionTarget;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  }
  | {
    readonly kind: 'execute' | 'unknown';
    readonly summary: string;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  };

/** Compact deterministic facts supplied to the permission reviewer. */
export interface AutoModePermissionReview {
  readonly schemaVersion: 1;
  readonly analysis: {
    readonly status: 'complete' | 'incomplete';
    readonly shell: 'powershell' | 'shell' | 'tool';
    readonly binding: 'exact' | 'partial';
    readonly reason?: string;
  };
  readonly operations: readonly AutoModePermissionOperation[];
  readonly risks: readonly string[];
}

export type AutoModeCallAnalyzer = (
  call: RunnerToolCall,
  context: AutoModeRulesContext,
) => AutoModePermissionReview | Promise<AutoModePermissionReview>;

export type AutoModeRulesDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly reason: string }
  | { readonly action: 'escalate'; readonly reason: string };

/** Deterministic Tier-2 evaluator used only while the rules engine is active. */
export type AutoModeRulesEvaluator = (
  call: RunnerToolCall,
  context: AutoModeRulesContext,
) => AutoModeRulesDecision | Promise<AutoModeRulesDecision>;

export interface AutoModeGuardrailConfig {
  readonly rules: AutoRules;
  readonly claudeMd?: string;
  /**
   * Legacy classifier path only. Runtime compact review excludes AGENTS.md.
   * FEATURE_092 follow-up (auto-mode classifier AGENTS.md staleness fix):
   * live getter for the project AGENTS.md content. Takes precedence over the
   * static `claudeMd` string and is evaluated INSIDE the classify path on
   * every call — same live-getter pattern as `getDefaultProvider` /
   * `getDefaultModel` (v0.7.34 hotfix-3).
   *
   * The bug it fixes: the guardrail is a lazy-cached singleton, so a
   * captured `claudeMd` string froze the project rules at first
   * construction. Even `/reload` couldn't refresh it — the classifier kept
   * judging tool calls against a stale AGENTS.md snapshot. The REPL wires
   * this to `loadAgentsFiles` (mtime-cached), so the classifier sees the
   * same fresh project rules the system prompt does.
   */
  readonly getClaudeMd?: () => string | undefined;
  /**
   * FEATURE_092 phase 2b.7b: optional user-prompt callback for escalate
   * paths. See `AutoModeAskUser` for semantics.
   */
  readonly askUser?: AutoModeAskUser;

  /**
   * Runtime-owned Accept-edits fallback used only when classifier
   * infrastructure or its response contract fails.
   */
  readonly allowOnClassifierFailure?: (
    call: RunnerToolCall,
  ) => boolean | Promise<boolean>;

  /** Whether ordinary bash calls can be enforced by an OS workspace sandbox. */
  readonly workspaceShellSandboxAvailable?: boolean;

  /** Mint one exact bash call for workspace-sandboxed execution. */
  readonly admitWorkspaceSandboxCall?: (
    call: RunnerToolCall,
    review: AutoModePermissionReview,
  ) => void;

  /**
   * Runtime-owned deterministic Tier-2 evaluator. It is injected rather than
   * implemented in @kodax/coding because canonical path and shell-AST helpers
   * live in @kodax/repl. Omitting it preserves fail-closed SDK compatibility:
   * every non-Tier-1 rules call escalates.
   */
  readonly evaluateRulesCall?: AutoModeRulesEvaluator;

  /**
   * Runtime-owned compact facts used by deterministic read admission and the
   * LLM permission reviewer. Direct read tools fail closed when this is absent.
   */
  readonly analyzeCall?: AutoModeCallAnalyzer;

  /**
   * Look up a tool's `toClassifierInput` projection by tool name.
   * Returns `undefined` when the tool isn't in the registry. Unknown tools
   * receive a metadata-only fail-closed projection rather than a Tier-1 skip.
   */
  readonly getToolProjection: (
    toolName: string,
  ) => ((input: unknown) => string) | undefined;

  /**
   * Resolve a provider name to an instance. Returns `undefined` when
   * unconfigured / unknown — the guardrail then escalates.
   */
  readonly resolveProvider: (providerName: string) => KodaXBaseProvider | undefined;

  readonly defaultProvider: string;
  readonly defaultModel: string;

  /**
   * FEATURE_092 v0.7.34 hotfix-3 — defaultProvider/defaultModel staleness fix.
   *
   * When supplied, these are called on EVERY classify() invocation, so the
   * classifier follows the user's current main session provider/model even
   * after `/model` or `/provider` mid-session swaps. Falls back to
   * `defaultProvider` / `defaultModel` (static strings) when unset, preserving
   * backward compatibility for SDK consumers that pass string literals.
   */
  readonly getDefaultProvider?: () => string;
  readonly getDefaultModel?: () => string;

  // Override layers consumed by `resolveClassifierModel`
  readonly cliFlag?: string;
  readonly envVar?: string;
  readonly sessionOverride?: string;
  readonly userSettings?: string;

  /**
   * Optional cost-tracker accessors. The classifier writes its tokens to
   * the tracker under `querySource: 'auto_mode'` (handled inside sideQuery).
   */
  readonly getCostTracker?: () => CostTracker | undefined;
  readonly setCostTracker?: (t: CostTracker) => void;

  /** Optional logger for classifier-health and configuration warnings. */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;

  /**
   * Fired whenever the active engine changes through `setEngine(...)`.
   * UI surfaces (status bar engine indicator, slash-command
   * confirmations) subscribe here so the displayed engine stays in sync
   * with the guardrail's internal state without the user having to trigger
   * another mode toggle just to refresh the bar.
   */
  readonly onEngineChange?: (engine: AutoModeEngine) => void;

  /**
   * Optional shared state for subagent threshold-bypass defense
   * (design doc "防绕阈值"). When supplied, the parent and child
   * guardrails reference the SAME object — engine changes and tracker
   * advances are visible across the session boundary.
   */
  readonly sharedState?: AutoModeSharedState;

  /**
   * FEATURE_092 phase 2b.7b slice C: starting engine. Defaults to `'llm'`.
   * Set to `'rules'` to skip the classifier entirely from session start
   * (the deterministic Tier-2 evaluator runs for non-Tier-1 calls). Resolved
   * by the REPL from `~/.kodax/config.json`
   * `autoMode.engine` and the `KODAX_AUTO_MODE_ENGINE` env var.
   */
  readonly initialEngine?: AutoModeEngine;

  /**
   * FEATURE_092 phase 2b.7b slice C: classifier sideQuery timeout in ms.
   * Defaults to 20_000. Resolved by the REPL from `~/.kodax/config.json`
   * `autoMode.timeoutMs`.
   */
  readonly timeoutMs?: number;

  // ============== FEATURE_158 (v0.7.39) ==============

  /**
   * Project root for signal collectors. File-tool collector uses this to
   * detect `outside_project` vs project-relative paths. Bash collector
   * doesn't use it (command-string-level) but threads it for uniform
   * collector contract.
   *
   * Required by FEATURE_158: if omitted, the default coding-side
   * collectors produce no `outside_project` signal (degrades gracefully),
   * but **REPL-injected `extraCollectors` will likely require it**.
   * SDK consumers without a project root should set `projectRoot: ''`
   * and supply no `extraCollectors`.
   */
  readonly projectRoot?: string;

  /** Directory used to resolve relative tool paths. Defaults to projectRoot. */
  readonly executionCwd?: string;

  /**
   * Override the default signal-collector set. When unset, defaults to
   * `[bashSignalCollector, fileSignalCollector]` — coding-side
   * command-string + file-tool collectors that don't depend on REPL
   * path utilities.
   *
   * Use `extraCollectors` instead if you want to **add** collectors
   * without replacing the defaults.
   */
  readonly signalCollectors?: readonly SignalCollector[];

  /**
   * Additional signal collectors to merge with `signalCollectors`.
   * Primary use: REPL injects a path-aware bash collector built on its
   * own `extractPathsFromCommand` / `isAlwaysConfirmPath` utilities
   * (those live in `@kodax/repl` for historical reasons; lifting them
   * is out-of-scope for FEATURE_158 — see design doc layer-boundary
   * decision).
   *
   * Order: defaults run first, then extras (preserves per-collector
   * signal order).
   */
  readonly extraCollectors?: readonly SignalCollector[];

  /** Layer-owned Tier-0 checks that run after the coding-side frozen list. */
  readonly extraAbsoluteDenyChecks?: readonly AbsoluteDenyCheck[];

  /**
   * Speculative-classify quiet window (ms). When a classifier promise
   * settles within this window, the guardrail uses the verdict directly
   * with no perceptible latency.
   *
   * Issue 143 (WS1): when the window expires the guardrail does NOT
   * hard-escalate — it waits for the real classifier verdict and adopts it
   * (late-verdict adoption). The window therefore only controls "fast path
   * vs wait", never "dialog vs no dialog": an `allow` never surfaces a
   * confirm dialog regardless of how long the classifier takes, and only an
   * confirmation/failure verdict reaches the configured user or Accept-edits
   * fallback path.
   * The background classifier's cost is settled exactly once inside
   * classify(), so awaiting it after window expiry does not double-count.
   *
   * Precedence: explicit arg > `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env >
   * `DEFAULT_WINDOW_MS = 500`. Set to 0 to disable the speculative race
   * (degrades to a synchronous classify — identical verdict outcome).
   */
  readonly speculativeWindowMs?: number;
}

/**
 * Snapshot of the auto-mode guardrail's session-scoped state. Returned by
 * `getStats()` for diagnostic surfaces (`/auto-denials`) and the status bar
 * engine indicator. The DenialTracker / CircuitBreaker types are immutable
 * value objects, so this is a copy of the references — caller cannot mutate
 * guardrail state through it.
 */
export interface AutoModeStats {
  readonly engine: AutoModeEngine;
  readonly classifierHealth: 'healthy' | 'degraded';
  readonly classifierModel?: string;
  readonly denials: DenialTracker;
  readonly breaker: CircuitBreaker;
}

export interface AutoModeToolGuardrail extends ToolGuardrail {
  /** Current engine for this session. */
  getEngine(): AutoModeEngine;
  /** Snapshot of engine + denial tracker + circuit breaker. */
  getStats(): AutoModeStats;
  /**
   * Manually set the engine. Used by `/auto-engine` slash command to flip
   * between 'llm' and 'rules' after an explicit user or host choice.
   */
  setEngine(engine: AutoModeEngine): void;

  /** Test-only alias for getEngine(). Backward-compat for test files. */
  getEngineForTest(): AutoModeEngine;
  /** Test-only alias for getStats(). Backward-compat for test files. */
  getStatsForTest(): AutoModeStats;
  /** Test-only override: swap the provider mid-test. */
  setProviderForTest(provider: KodaXBaseProvider): void;
}

const DETERMINISTIC_READ_TOOLS = new Set(['read', 'grep', 'glob']);
const DETERMINISTIC_OPERATION_RISKS = new Set([
  'source_removed',
  'destination_overwrite_possible',
  'cross_boundary_copy',
  'cross_boundary_mutation',
]);
const APPROVAL_TIMEOUT_REASON =
  '[approval_timeout] The requested operation was not executed because user approval timed out. '
  + 'Try a safer, narrower, or reversible way to continue. If no safer alternative exists, '
  + 'stop the task and wait for explicit user approval before retrying.';

type MutationOperationKind = 'copy' | 'create' | 'delete' | 'move' | 'rename' | 'write';

const MUTATION_DENIAL_TERMS: Readonly<Record<
  MutationOperationKind,
  RegExp
>> = {
  copy: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:copy|cp|duplicate)\b|\bwithout\s+(?:copying|duplicating)\b|(?:不要|别|禁止|不得).{0,24}(?:copy|cp|duplicate|复制|拷贝)/i,
  create: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:create|generate|mkdir|make)\b|\bwithout\s+(?:creating|generating|making)\b|(?:不要|别|禁止|不得).{0,24}(?:create|generate|mkdir|make|创建|新建|生成)/i,
  delete: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:delete|del|erase|remove|rm|rmdir)\b|\bwithout\s+(?:deleting|removing|erasing)\b|(?:不要|别|禁止|不得).{0,24}(?:delete|del|erase|remove|rm|rmdir|删除|移除|清理)/i,
  move: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:move|mv|relocate|organize)\b|\bwithout\s+(?:moving|relocating|organizing)\b|(?:不要|别|禁止|不得).{0,24}(?:move|mv|relocate|organize|移动|移到|搬到|整理)/i,
  rename: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:rename|ren)\b|\bwithout\s+renaming\b|(?:不要|别|禁止|不得).{0,24}(?:rename|ren|重命名|改名)/i,
  write: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:write|edit|update|modify|save)\b|\bwithout\s+(?:writing|editing|updating|modifying|saving)\b|(?:不要|别|禁止|不得).{0,24}(?:write|edit|update|modify|save|写入|编辑|修改|更新|保存)/i,
};

const NON_EXECUTING_DENIAL_INTENT = /\b(?:do\s+not|don't|dont|never)\s+(?:execute|run|proceed|perform|apply|make\s+(?:the\s+)?change|do\s+(?:it|that|this))\b|\bnot\s+actually\s+(?:execute|run|proceed|perform|apply|do\s+(?:it|that|this))\b|(?:不要|别|禁止|不得)(?:实际|真的)?(?:执行|操作|运行|实施|应用|改动|动|做)(?![./\\])|不(?:执行|操作)(?![./\\])/i;
const NON_EXECUTING_REQUEST_INTENT = /(?:^|[\n,.;!?，。；！？])\s*(?:(?:please|kindly|just)\s+|(?:(?:can|could|would)\s+you\s+)|请(?:你)?\s*|(?:只|仅|仅仅)\s*)*(?:explain(?![./\\])\b|describe(?![./\\])\b|discuss(?![./\\])\b|how\s+to\b|show\s+me\s+how\b|should\s+(?:i|we)\b|(?:would|could|is|are)\s+(?:moving|copying|deleting|removing|writing|editing|creating|renaming)\b|whether\b|what\s+if\b|hypothetically\b|解释(?!器)|说明(?!书)|讨论|如何|怎么|是否|要不要|该不该|假设|仅供参考|只是\s*说明(?!书))/i;
const CONCRETE_FILE_REFERENCE = /(?:^|[\s"'`])([A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,12})(?=$|[\s"'`,.;:!?])/g;
const ACTION_SCOPED_REFERENCE = /\b(?:copy|cp|duplicate|create|generate|mkdir|make|delete|del|erase|remove|rm|rmdir|move|mv|relocate|organize|rename|ren|write|edit|update|modify|save)\s+(?:the\s+)?["'`]?([A-Za-z0-9_][A-Za-z0-9_.\\/-]*)/gi;
const MUTATION_INTENT_TERMS: Readonly<Record<MutationOperationKind, RegExp>> = {
  copy: /\b(?:copy|cp|duplicate)\b|复制|拷贝/i,
  create: /\b(?:create|generate|mkdir|make)\b|创建|新建|生成/i,
  delete: /\b(?:delete|del|erase|remove|rm|rmdir)\b|删除|移除|清理/i,
  move: /\b(?:move|mv|relocate|organize)\b|移动|移到|搬到|整理/i,
  rename: /\b(?:rename|ren)\b|重命名|改名/i,
  write: /\b(?:write|edit|update|modify|save|fix)\b|写入|编辑|修改|更新|保存|修复/i,
};
const MUTATION_INTENT_COMPATIBILITY: Readonly<Record<
  MutationOperationKind,
  ReadonlySet<MutationOperationKind>
>> = {
  copy: new Set(['copy']),
  create: new Set(['create', 'write']),
  delete: new Set(['delete']),
  move: new Set(['move', 'rename']),
  rename: new Set(['move', 'rename']),
  write: new Set(['create', 'write']),
};

function operationTargetPaths(operation: AutoModePermissionOperation): string[] {
  return 'target' in operation
    ? [operation.target.path]
    : 'source' in operation
      ? [operation.source.path, operation.destination.path]
      : [];
}

function normalizedTargetBasenames(operation: AutoModePermissionOperation): Set<string> {
  const paths = operationTargetPaths(operation);
  return new Set(paths.map((value) => (
    value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? ''
  )));
}

function intentWithoutOperationPaths(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): string {
  const lexemes = operationTargetPaths(operation).flatMap((value) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    const basename = normalized.split('/').at(-1) ?? '';
    return [value, normalized, ...(basename.includes('.') ? [basename] : [])];
  });
  return [...new Set(lexemes.filter((value) => value.length > 1))]
    .sort((left, right) => right.length - left.length)
    .reduce((intent, value) => (
      intent.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' target ')
    ), currentIntent);
}

function intentNamesOnlyDifferentConcreteFiles(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  const references = [
    ...currentIntent.matchAll(CONCRETE_FILE_REFERENCE),
    ...currentIntent.matchAll(ACTION_SCOPED_REFERENCE),
  ]
    .map((match) => match[1]?.replace(/[.,;:!?]+$/, '').toLowerCase())
    .filter((value): value is string => value !== undefined);
  if (references.length === 0) return false;
  const targets = normalizedTargetBasenames(operation);
  return !references.some((reference) => {
    const basename = reference.replace(/\\/g, '/').split('/').at(-1) ?? reference;
    return targets.has(basename);
  });
}

function intentRequestsDifferentMutation(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (
    operation.kind === 'read'
    || operation.kind === 'execute'
    || operation.kind === 'unknown'
  ) return false;
  const operationKind: MutationOperationKind = operation.kind;
  const requested = (Object.entries(MUTATION_INTENT_TERMS) as Array<
    [MutationOperationKind, RegExp]
  >)
    .filter(([, terms]) => terms.test(currentIntent))
    .map(([kind]) => kind);
  return requested.length > 0
    && !requested.some((kind) => MUTATION_INTENT_COMPATIBILITY[operationKind].has(kind));
}

function mutationContradictsCurrentIntent(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (
    operation.kind === 'read'
    || operation.kind === 'execute'
    || operation.kind === 'unknown'
  ) return false;
  const intentWithoutTargets = intentWithoutOperationPaths(operation, currentIntent);
  return MUTATION_DENIAL_TERMS[operation.kind].test(intentWithoutTargets)
    || NON_EXECUTING_DENIAL_INTENT.test(intentWithoutTargets)
    || NON_EXECUTING_REQUEST_INTENT.test(intentWithoutTargets)
    || intentRequestsDifferentMutation(operation, intentWithoutTargets)
    || intentNamesOnlyDifferentConcreteFiles(operation, currentIntent);
}

function isAllowedMutationBoundary(boundary: AutoModePermissionBoundary): boolean {
  return boundary === 'workspace' || boundary === 'system-temp';
}

function isDeterministicallyAllowedOperation(
  operation: AutoModePermissionOperation,
): boolean {
  if (operation.options?.whatIf === true) return true;
  if (operation.kind === 'execute') return operation.options?.readOnly === true;
  if (operation.kind === 'unknown') return false;
  if (operation.kind === 'read') {
    return operation.target.boundary !== 'protected'
      && operation.target.boundary !== 'unresolved';
  }
  if ('target' in operation) return isAllowedMutationBoundary(operation.target.boundary);
  if (!('source' in operation)) return false;
  if (operation.kind === 'copy') {
    return isAllowedMutationBoundary(operation.destination.boundary)
      && operation.source.boundary !== 'protected'
      && operation.source.boundary !== 'unresolved';
  }
  return isAllowedMutationBoundary(operation.source.boundary)
    && isAllowedMutationBoundary(operation.destination.boundary);
}

function isDeterministicallyAllowed(
  permissionReview: AutoModePermissionReview,
  intentEvidence?: PermissionIntentEvidence,
): boolean {
  if (
    permissionReview.analysis.status !== 'complete'
    || permissionReview.analysis.binding !== 'exact'
    || permissionReview.risks.some((risk) => !DETERMINISTIC_OPERATION_RISKS.has(risk))
    || permissionReview.operations.length === 0
  ) {
    return false;
  }
  const currentIntent = intentEvidence?.currentUserContent?.trim();
  return permissionReview.operations.every((operation) => (
    isDeterministicallyAllowedOperation(operation)
    && (
      !currentIntent
      || (
        intentEvidence?.currentUserContentTruncated !== true
        && !mutationContradictsCurrentIntent(operation, currentIntent)
      )
    )
  ));
}

function isSandboxContainableMutation(
  permissionReview: AutoModePermissionReview,
): boolean {
  if (
    permissionReview.analysis.status !== 'complete'
    || permissionReview.analysis.binding !== 'exact'
    || permissionReview.operations.length === 0
  ) return false;
  let hasMutation = false;
  for (const operation of permissionReview.operations) {
    if (operation.options?.whatIf === true || operation.kind === 'read') {
      if (
        operation.kind === 'read'
        && (
          operation.target.boundary === 'protected'
          || operation.target.boundary === 'unresolved'
        )
      ) return false;
      continue;
    }
    if (operation.kind === 'execute' || operation.kind === 'unknown') return false;
    hasMutation = true;
    if ('target' in operation) {
      if (!isAllowedMutationBoundary(operation.target.boundary)) return false;
      continue;
    }
    if (!('source' in operation)) return false;
    if (operation.kind === 'copy') {
      if (
        !isAllowedMutationBoundary(operation.destination.boundary)
        || operation.source.boundary === 'protected'
        || operation.source.boundary === 'unresolved'
      ) return false;
      continue;
    }
    if (
      !isAllowedMutationBoundary(operation.source.boundary)
      || !isAllowedMutationBoundary(operation.destination.boundary)
    ) return false;
  }
  return hasMutation;
}

export function createAutoModeToolGuardrail(
  config: AutoModeGuardrailConfig,
): AutoModeToolGuardrail {
  const state: AutoModeSharedState = config.sharedState ?? {
    engine: config.initialEngine ?? 'llm',
    denials: createDenialTracker(),
    breaker: createCircuitBreaker(),
  };
  const timeoutMs = config.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;

  // For tests only: lets us swap the provider mid-flight.
  let providerOverride: KodaXBaseProvider | undefined;

  // Single mutation point for `state.engine`. Fires `onEngineChange` on every
  // real transition (no callback when the new value equals the old) so UI
  // surfaces (status bar engine indicator) stay in sync without polling. The
  // explicit `setEngine(...)` path goes through here.
  const transitionEngine = (next: AutoModeEngine): void => {
    if (state.engine === next) return;
    state.engine = next;
    config.onEngineChange?.(next);
  };

  // FEATURE_158: signal-collector set — defaults + extras. Frozen at
  // factory time so collectors don't change mid-session.
  const signalCollectors: readonly SignalCollector[] = [
    ...(config.signalCollectors ?? [bashSignalCollector, fileSignalCollector]),
    ...(config.extraCollectors ?? []),
  ];
  const projectRoot = config.projectRoot ?? '';
  const executionCwd = config.executionCwd ?? projectRoot;

  const beforeTool = async (
    call: RunnerToolCall,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict> => {
    const bridgeTarget = resolveToolBridgeTarget(call);
    const guardedCall = bridgeTarget?.ok ? bridgeTarget.call : call;
    // FEATURE_158: collect signals ONCE per call. Used by both the
    // classifier prompt and the escalate-to-user path (REPL UI renders
    // Scope/Risk from signals). Empty array when no collector matches.
    const signals = collectAllSignals(guardedCall, projectRoot, signalCollectors, executionCwd);
    let permissionReview: AutoModePermissionReview | undefined;

    const allowFinal = (): GuardrailVerdict => {
      if (
        guardedCall.name === 'bash'
        && permissionReview
        && isSandboxContainableMutation(permissionReview)
      ) {
        config.admitWorkspaceSandboxCall?.(guardedCall, permissionReview);
      }
      return { action: 'allow' };
    };

    // When the REPL has supplied askUser, every "escalate" path is resolved
    // here into a concrete allow/block; otherwise we fall through to the
    // legacy escalate verdict (Runner throws GuardrailEscalateError).
    // FEATURE_158: pass signals to askUser so REPL can render Scope/Risk.
    const escalateOrAsk = async (
      reason: string,
      diagnostics?: AutoModeDecisionDiagnostics,
    ): Promise<GuardrailVerdict> => {
      if (!config.askUser) {
        return { action: 'escalate', reason };
      }
      const verdict = await config.askUser(guardedCall, reason, signals, diagnostics);
      if (verdict === 'allow') return allowFinal();
      if (verdict === 'timeout') {
        return { action: 'block', reason: APPROVAL_TIMEOUT_REASON };
      }
      return { action: 'block', reason };
    };

    const allowOrAskOnClassifierFailure = async (
      reason: string,
      diagnostics: AutoModeDecisionDiagnostics,
    ): Promise<GuardrailVerdict> => {
      try {
        if (await config.allowOnClassifierFailure?.(guardedCall)) {
          return allowFinal();
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        config.log?.('warn', `[auto-mode] Accept-edits fallback failed: ${detail}`);
      }
      return escalateOrAsk(reason, diagnostics);
    };

    // FEATURE_158 — Tier 0 identifies catastrophic patterns before the
    // classifier. It is a mandatory approval boundary, not an irreversible
    // policy block: interactive users can still authorize an exact action.
    // denialTracker is not incremented because Tier 0 is not a classifier concern.
    const tier0: AbsoluteDenyResult = [
      checkAbsoluteDeny,
      ...(config.extraAbsoluteDenyChecks ?? []),
    ].reduce<AbsoluteDenyResult>((result, check) => (
      result.denied ? result : check(guardedCall, projectRoot, executionCwd)
    ), { denied: false });
    if (tier0.denied) {
      config.log?.(
        'warn',
        `[auto-mode] Tier 0 absolute denylist matched (${tier0.patternId}): ${tier0.reason}`,
      );
    }

    // Tier 1: explicitly exempt tools may opt out through an empty projection.
    // Direct read tools additionally require deterministic target analysis.
    // Unknown tools use a metadata-only fallback so missing extension metadata
    // cannot silently bypass Auto[LLM].
    let action: string;
    try {
      const projector = config.getToolProjection(guardedCall.name);
      const projected: unknown = projector
        ? projector(guardedCall.input)
        : safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
      if (typeof projected !== 'string') throw new TypeError('invalid classifier projection');
      action = projected;
    } catch {
      const reason = `tool classifier projection failed for "${guardedCall.name}"`;
      config.log?.('warn', `[auto-mode] ${reason}`);
      return escalateOrAsk(reason);
    }
    const requiresReadAnalysis = DETERMINISTIC_READ_TOOLS.has(guardedCall.name);
    if (requiresReadAnalysis && !config.analyzeCall) {
      return escalateOrAsk('read safety analyzer is unavailable');
    }
    if (config.analyzeCall && (action !== '' || requiresReadAnalysis)) {
      try {
        permissionReview = await config.analyzeCall(guardedCall, {
          projectRoot,
          executionCwd,
          signals,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        config.log?.('warn', `[auto-mode] permission analyzer failed: ${detail}`);
        if (action === '' && requiresReadAnalysis) {
          return escalateOrAsk(`read safety analysis failed: ${detail}`);
        }
        permissionReview = fallbackPermissionReview(guardedCall.name, action, 'analyzer_failed');
      }
    }
    let permissionAction = action;
    let intentEvidence: ReturnType<typeof buildPermissionIntentEvidence> | undefined;
    if (permissionReview) {
      permissionAction = serializePermissionReview(permissionReview, action);
      intentEvidence = buildPermissionIntentEvidence(ctx.messages ?? [], permissionAction);
    }
    if (tier0.denied) return escalateOrAsk(tier0.reason);
    if (
      permissionReview
      && isDeterministicallyAllowed(permissionReview, intentEvidence)
    ) {
      return allowFinal();
    }
    if (action === '') {
      if (requiresReadAnalysis && permissionReview) {
        // Unsafe, protected, or unresolved reads still receive an LLM review
        // using the structured permission facts even though their legacy tool
        // projection is empty.
        permissionAction = serializePermissionReview(permissionReview, 'read');
        intentEvidence = buildPermissionIntentEvidence(ctx.messages ?? [], permissionAction);
      } else {
        return allowFinal();
      }
    }

    // Rules engine: Tier 1 already returned above. Runtime supplies the
    // deterministic Tier-2 evaluator and this guardrail remains the sole
    // decision point. Direct SDK consumers that omit it retain a fail-closed
    // escalation path.
    if (state.engine === 'rules') {
      if (!config.evaluateRulesCall) {
        return escalateOrAsk('auto-mode rules engine requires user confirmation for this call');
      }
      let decision: AutoModeRulesDecision;
      try {
        decision = await config.evaluateRulesCall(guardedCall, {
          projectRoot,
          executionCwd,
          signals,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const reason = `auto-mode rules could not evaluate this call: ${detail}`;
        config.log?.('warn', `[auto-mode] ${reason}`);
        return escalateOrAsk(reason);
      }
      if (decision.action === 'allow') return allowFinal();
      if (decision.action === 'block') return escalateOrAsk(decision.reason);
      return escalateOrAsk(decision.reason);
    }

    // Resolve the complete override chain before consulting failure trackers.
    // A missing model is a local configuration error, not classifier
    // infrastructure instability. Apply the same bounded fallback without
    // calling the provider or advancing either tracker.
    const resolved = resolveClassifierModel(buildResolveOptions(config));
    if (typeof resolved.model !== 'string' || resolved.model.trim().length === 0) {
      const reason = 'auto-mode classifier model is not configured; select a model before using Auto LLM';
      config.log?.('warn', `[auto-mode] ${reason}`);
      return allowOrAskOnClassifierFailure(reason, {
        source: 'configuration',
      });
    }

    // Infrastructure degradation never widens policy to Auto[rules].
    if (breakerShouldFallback(state.breaker, Date.now())) {
      return allowOrAskOnClassifierFailure(
        'classifier infrastructure is degraded; applying Accept-edits fallback',
        {
          source: 'classifier_circuit_breaker',
        },
      );
    }

    // Resolve the configured provider only after the final model check and
    // threshold gates. Provider lookup itself is local; the first network
    // request happens later inside classify().
    const provider = providerOverride ?? config.resolveProvider(resolved.providerName);
    if (!provider) {
      return allowOrAskOnClassifierFailure(
        `classifier provider "${resolved.providerName}" is not configured`,
        {
          source: 'configuration',
        },
      );
    }

    // FEATURE_158: kick off classifier with signals attached. The promise is
    // held locally so speculativeRace can race it against a quiet window — when
    // the verdict arrives within the window, we use it directly with no
    // perceptible latency.
    //
    // Issue 143 (WS1): the classifier verdict is ALWAYS adopted, even when the
    // window expires. The window only decides whether we resolve instantly
    // (fast classify) or wait a bit longer (slow/remote provider) — it does NOT
    // decide "hard-escalate vs not". A late allow is applied directly and a
    // late concern requests confirmation. This is the
    // late-verdict adoption (CC's peekSpeculativeClassifierCheck equivalent) that
    // makes auto[llm] usable on remote/slow providers where a single classify
    // round-trip routinely outruns the window. The background classifyPromise is
    // never aborted on window expiry (tokens are already in flight) and its cost
    // is settled exactly once inside classify(), so awaiting it again here does
    // not double-count.
    const classifyPromise: Promise<ClassifyDecision> = classify({
      provider,
      model: resolved.model,
      rules: config.rules,
      // Runtime compact review deliberately excludes AGENTS.md. Legacy SDK
      // consumers without an analyzer retain the prior live/static behavior.
      claudeMd: intentEvidence ? undefined : config.getClaudeMd?.() ?? config.claudeMd,
      // classify() ignores transcript when intentEvidence is present; keeping
      // the parameter here preserves its standalone/legacy API.
      transcript: ctx.messages ?? [],
      action: permissionAction,
      intentEvidence,
      getToolProjection: config.getToolProjection,
      signals,
      timeoutMs,
      abortSignal: ctx.abortSignal,
      costTracker: config.getCostTracker?.(),
      setCostTracker: config.setCostTracker,
    });

    // Issue 143 (WS2): the speculative window only earns its keep when a human
    // is waiting on the confirm dialog — it trades a possible early escalate for
    // hiding classifier latency. With no `askUser` surface (SDK / non-interactive
    // / child-agent contexts) there is nobody to pre-empt, so an early
    // `window-expired` escalate is pure harm: it surfaces a transient 500ms
    // timeout as a verdict even though the classifier is about to return
    // allow/block. Force the window to 0 (wait for the full verdict) in that
    // case. When askUser IS present, `undefined` flows through to
    // speculativeRace's env/default resolution unchanged.
    const effectiveWindowMs = config.askUser ? config.speculativeWindowMs : 0;

    let decision: ClassifyDecision;
    try {
      const raceResult = await speculativeRace(classifyPromise, effectiveWindowMs);
      if (raceResult.kind === 'window-expired') {
        // Issue 143 (WS1): window expired — do NOT hard-escalate. Wait for the
        // real verdict and adopt it. The existing agent spinner covers the wait;
        // allow resolves without a dialog while a concern reaches the user. A
        // late AbortError re-surfaces here and is re-thrown by the catch below.
        decision = await classifyPromise;
      } else {
        decision = raceResult.value;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Any other error gets routed through the breaker
      state.breaker = recordBreakerError(state.breaker, Date.now());
      return allowOrAskOnClassifierFailure(
        `classifier error: ${err instanceof Error ? err.message : String(err)}`,
        {
          source: 'classifier_failure',
          classifierFailureKind: 'provider_error',
        },
      );
    }

    // Map decision to verdict and update diagnostic trackers.
    switch (decision.kind) {
      case 'allow':
        state.denials = recordDenialAllow(state.denials);
        return allowFinal();

      case 'confirm':
        state.denials = recordDenialBlock(state.denials);
        return escalateOrAsk(decision.reason, {
          source: 'classifier_confirm',
          classifierAttempts: decision.attempts,
        });

      case 'failure':
        state.breaker = recordBreakerError(state.breaker, Date.now());
        return allowOrAskOnClassifierFailure(decision.reason, {
          source: 'classifier_failure',
          classifierFailureKind: decision.failureKind,
          classifierAttempts: decision.attempts,
        });
    }
  };

  const getStats = (): AutoModeStats => ({
    engine: state.engine,
    classifierHealth: breakerShouldFallback(state.breaker, Date.now())
      ? 'degraded'
      : 'healthy',
    denials: state.denials,
    breaker: state.breaker,
  });
  return {
    kind: 'tool',
    name: 'auto-mode',
    beforeTool,
    getEngine: () => state.engine,
    getStats,
    setEngine: (engine) => {
      transitionEngine(engine);
    },
    // Test-only aliases — kept for backward compat with the existing test files.
    getEngineForTest: () => state.engine,
    getStatsForTest: getStats,
    setProviderForTest: (p) => { providerOverride = p; },
  };
}

function buildResolveOptions(
  config: AutoModeGuardrailConfig,
): ResolveClassifierModelOptions {
  // FEATURE_092 v0.7.34 hotfix-3: normalize getDefaultProvider/getDefaultModel
  // (live getters) over defaultProvider/defaultModel (static strings) so the
  // classifier picks up mid-session `/model` and `/provider` swaps. The
  // ResolveClassifierModelOptions interface stays string-typed — normalization
  // happens here, before the call into resolveClassifierModel.
  return {
    cliFlag: config.cliFlag,
    envVar: config.envVar,
    sessionOverride: config.sessionOverride,
    userSettings: config.userSettings,
    defaultProvider: config.getDefaultProvider?.() ?? config.defaultProvider,
    defaultModel: config.getDefaultModel?.() ?? config.defaultModel,
  };
}

const MAX_PERMISSION_REVIEW_BYTES = 8 * 1024;
const MAX_PERMISSION_ACTION_EVIDENCE_BYTES = 1536;

function serializePermissionReview(review: AutoModePermissionReview, action: string): string {
  const actionEvidence = review.analysis.status === 'incomplete'
    ? buildPermissionActionEvidence(action)
    : undefined;
  const envelope = actionEvidence ? { ...review, actionEvidence } : review;
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PERMISSION_REVIEW_BYTES) return serialized;

  const kindCounts: Record<string, number> = {};
  const boundaryCounts: Record<string, number> = {};
  for (const operation of review.operations) {
    kindCounts[operation.kind] = (kindCounts[operation.kind] ?? 0) + 1;
    for (const target of permissionOperationTargets(operation)) {
      boundaryCounts[target.boundary] = (boundaryCounts[target.boundary] ?? 0) + 1;
    }
  }
  const sampleOperations = selectPermissionOperationSamples(review.operations);
  const sample = sampleOperations.map(compactPermissionOperation);
  return JSON.stringify({
    schemaVersion: review.schemaVersion,
    analysis: review.analysis,
    evidence: {
      status: 'targeted',
      sourceBytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: createHash('sha256').update(serialized).digest('hex'),
    },
    operationSummary: {
      count: review.operations.length,
      kindCounts,
      boundaryCounts,
      sample,
    },
    risks: review.risks,
    ...(actionEvidence ? { actionEvidence } : {}),
  });
}

function selectPermissionOperationSamples(
  operations: readonly AutoModePermissionOperation[],
): readonly AutoModePermissionOperation[] {
  if (operations.length <= 8) return operations;
  const risky = operations.filter((operation) => (
    operation.kind === 'delete' || operation.kind === 'move' || operation.kind === 'rename'
    || permissionOperationTargets(operation).some((target) => (
      target.boundary !== 'workspace' && target.boundary !== 'system-temp'
    ))
  ));
  if (risky.length === 0) return [...operations.slice(0, 4), ...operations.slice(-4)];

  const middleStart = Math.max(0, Math.floor(risky.length / 2) - 1);
  const candidates = [
    ...risky.slice(0, 2),
    ...risky.slice(middleStart, middleStart + 2),
    ...risky.slice(-2),
    operations[0]!,
    operations.at(-1)!,
  ];
  return [...new Set(candidates)].slice(0, 8);
}

function buildPermissionActionEvidence(action: string): Readonly<Record<string, string | number>> {
  const sourceBytes = Buffer.byteLength(action, 'utf8');
  const sha256 = createHash('sha256').update(action).digest('hex');
  if (sourceBytes <= MAX_PERMISSION_ACTION_EVIDENCE_BYTES) {
    return { status: 'complete', text: action, sourceBytes, sha256 };
  }

  const head = sliceUtf8(action, 1024, false);
  const tail = sliceUtf8(action, 512, true);
  const includedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return {
    status: 'targeted',
    text: `${head}\n… omitted …\n${tail}`,
    sourceBytes,
    includedBytes,
    omittedBytes: sourceBytes - includedBytes,
    sha256,
  };
}

function sliceUtf8(value: string, maxBytes: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  const selected: string[] = [];
  let bytes = 0;
  const start = fromEnd ? characters.length - 1 : 0;
  const limit = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== limit; index += step) {
    const character = characters[index];
    if (character === undefined) break;
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    if (fromEnd) selected.unshift(character);
    else selected.push(character);
    bytes += characterBytes;
  }
  return selected.join('');
}

function permissionOperationTargets(
  operation: AutoModePermissionOperation,
): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return [operation.target];
  if ('source' in operation) return [operation.source, operation.destination];
  return [];
}

function compactPermissionOperation(
  operation: AutoModePermissionOperation,
): Readonly<Record<string, unknown>> {
  if ('target' in operation) {
    return {
      kind: operation.kind,
      target: { ...operation.target, path: compactPermissionPath(operation.target.path) },
      ...(operation.options ? { options: operation.options } : {}),
    };
  }
  if ('source' in operation) {
    return {
      kind: operation.kind,
      source: { ...operation.source, path: compactPermissionPath(operation.source.path) },
      destination: {
        ...operation.destination,
        path: compactPermissionPath(operation.destination.path),
      },
      ...(operation.options ? { options: operation.options } : {}),
    };
  }
  return { ...operation, summary: compactPermissionPath(operation.summary) };
}

function compactPermissionPath(value: string): string {
  if (value.length <= 320) return value;
  return `${value.slice(0, 224)}…${value.slice(-95)}`;
}

function fallbackPermissionReview(
  toolName: string,
  action: string,
  risk: string,
): AutoModePermissionReview {
  return {
    schemaVersion: 1,
    analysis: {
      status: 'incomplete', shell: 'tool', binding: 'partial',
      reason: 'deterministic permission facts are unavailable',
    },
    operations: [{
      kind: 'unknown',
      summary: `tool ${toolName}; projection_bytes=${Buffer.byteLength(action, 'utf8')}`,
    }],
    risks: [risk],
  };
}
