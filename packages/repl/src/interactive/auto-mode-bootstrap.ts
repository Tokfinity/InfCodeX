/**
 * Auto-Mode Guardrail Bootstrap — FEATURE_092 phase 2b.7b (v0.7.33).
 *
 * Builds an `AutoModeToolGuardrail` wired to the live REPL's provider
 * registry, tool registry, AGENTS.md content, and confirm-dialog askUser
 * surface. The factory returns a lazy accessor: the guardrail is constructed
 * on first call so REPLs that never enter `auto` mode pay zero cost.
 *
 * What lives in this file (vs. inline in repl.ts):
 *   - The wiring is FEATURE_092-specific and can be unit-tested independently.
 *   - `repl.ts` is already large; keeping the auto-mode plumbing here makes
 *     it greppable and easier to evolve as later phases (settings, subagent
 *     propagation, slash-command engine toggle) extend the feature surface.
 *
 * Caller responsibilities (kept minimal — REPL passes down what it owns):
 *   - `getCurrentPermissionMode` is read by `askUser` so the confirm dialog
 *     copy reflects the user's actual mode (the guardrail itself doesn't
 *     care about permission mode beyond "we're in auto").
 *   - `getCurrentProvider` / `getCurrentModel` are passed as the
 *     `getDefaultProvider` / `getDefaultModel` LIVE getters on the guardrail
 *     config (FEATURE_092 v0.7.34 hotfix-3). They are evaluated on every
 *     classify() call, so mid-session `/model` and `/provider` swaps DO
 *     retarget the classifier without the user re-entering auto mode.
 *     AGENTS.md is wired the same way via the `getClaudeMd` live getter
 *     (FEATURE_092 follow-up) — it reads `loadAgentsFiles` (mtime-cached)
 *     on every classify so mid-session AGENTS.md edits reach the classifier
 *     without a restart or `/reload`. Only `rules`
 *     (`~/.kodax/auto-rules.jsonc`) remains captured-at-init; those edits
 *     are rare and a restart applies them.
 */

import {
  createAutoModeToolGuardrail,
  formatAgentsForPrompt,
  getBuiltinRegisteredToolDefinition,
  getKodaxGlobalDir,
  getRegisteredToolDefinition,
  loadAgentsFiles,
  loadAutoRules,
  resolveProvider as resolveCodingProvider,
  type AutoModeAskUser,
  type AutoModeSharedState,
  type AutoModeToolGuardrail,
  type RulesLoadResult,
  type SignalCollector,
} from '@kodax-ai/coding';
import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { PermissionMode } from '../permission/types.js';
import { replBashUserKodaxWriteDeny } from '../permission/repl-bash-signals.js';

export interface AutoModeBootstrapDeps {
  /**
   * Surface-specific user-confirmation callback. Readline REPL wraps
   * `confirmToolExecution(rl, ...)`; Ink REPL wraps `showConfirmDialog`.
   * Bootstrap stays surface-agnostic so the same factory can wire both
   * UIs without depending on readline.
   */
  readonly askUser: AutoModeAskUser;
  readonly projectRoot: string;
  /** Directory used to resolve relative tool paths. */
  readonly executionCwd: string;
  readonly getCurrentProviderName: () => string;
  readonly getCurrentModel: () => string | undefined;
  readonly getCurrentPermissionMode: () => PermissionMode;
  /**
   * FEATURE_092 phase 2b.7b slice C: resolved settings/env block. The REPL
   * computes this once via `loadAutoModeSettings()` (in
   * `packages/repl/src/common/permission-config.ts`) and threads it here so
   * the bootstrap stays free of file-system I/O and is hermetically testable.
   */
  readonly autoModeSettings: ResolvedAutoModeBootstrapSettings;
  /**
   * Optional structured logger. Defaults to writing yellow warnings + dim
   * info lines to stderr via console (matching REPL conventions).
   */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;
  /**
   * Fired whenever the guardrail's classifier engine changes — both on
   * automatic downgrades (denial threshold / circuit breaker) and on
   * manual `setEngine` calls. The REPL surfaces this into status-bar
   * state so the engine indicator stays accurate without requiring a
   * mode toggle to refresh.
   */
  readonly onEngineChange?: (engine: 'llm' | 'rules') => void;

  /** Session-owned engine/denial/breaker state shared by context-specific guardrails. */
  readonly sharedState?: AutoModeSharedState;

  /**
   * FEATURE_158 (v0.7.39): additional signal collectors merged with the
   * coding-side defaults (`bashSignalCollector` + `fileSignalCollector`).
   * The REPL passes `replBashPathSignalCollector` here so bash commands
   * targeting protected paths (~/.kodax / <projectRoot>/.kodax) or
   * redirecting outside the project produce signals — the path utilities
   * live in @kodax/repl, so this is the layer-boundary-preserving
   * injection point.
   */
  readonly extraCollectors?: readonly SignalCollector[];
}

/**
 * Subset of `ResolvedAutoModeSettings` the bootstrap actually needs. Imported
 * via structural typing so bootstrap doesn't pull a dependency on
 * `permission-config.ts` (which would create a cycle through the REPL barrel).
 */
export interface ResolvedAutoModeBootstrapSettings {
  readonly engine: 'llm' | 'rules';
  readonly classifierModel?: string;
  readonly classifierModelEnv?: string;
  readonly timeoutMs?: number;
  /**
   * Issue 143 (WS3): speculative-classify quiet window in ms. Forwarded to the
   * guardrail's `speculativeWindowMs`. When undefined, the guardrail falls back
   * to the `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env / `DEFAULT_WINDOW_MS = 500`.
   */
  readonly speculativeWindowMs?: number;
}

export interface AutoModeBootstrapResult {
  /**
   * Lazy accessor — constructs the guardrail on first call. Subsequent
   * calls return the same instance so engine + tracker state is shared
   * across turns within a session.
   */
  readonly getGuardrail: () => AutoModeToolGuardrail;
  /**
   * The rules-load result from `loadAutoRules`. Surfaced so the REPL can
   * print sources/skipped/errors in the startup banner (phase 2b.8 will
   * surface this via `/auto-engine`; v1 just exposes the data).
   */
  readonly rulesLoadResult: RulesLoadResult;
}

/**
 * Async because `loadAutoRules` reads disk. Call once at REPL startup
 * after AGENTS.md has been loaded; the returned `getGuardrail` is sync.
 */
export async function bootstrapAutoMode(
  deps: AutoModeBootstrapDeps,
): Promise<AutoModeBootstrapResult> {
  const rulesLoadResult = await loadAutoRules({
    userKodaxDir: getKodaxGlobalDir(),
    projectRoot: deps.projectRoot,
  });

  let guardrail: AutoModeToolGuardrail | undefined;

  const getGuardrail = (): AutoModeToolGuardrail => {
    if (guardrail) return guardrail;
    guardrail = createAutoModeToolGuardrail({
      rules: rulesLoadResult.merged,
      // FEATURE_092 follow-up: live getter instead of a captured string so the
      // classifier never reads a frozen AGENTS.md snapshot. Goes straight to
      // `loadAgentsFiles` (mtime-cached) so mid-session edits take effect on
      // the next classify with no `/reload` needed — same source the system
      // prompt uses. Cheap: a cache hit is a per-level statSync + byte reuse.
      getClaudeMd: () =>
        formatAgentsForPrompt(
          loadAgentsFiles({ cwd: process.cwd(), projectRoot: deps.projectRoot }),
        ),
      getToolProjection: (toolName) => {
        const def =
          getRegisteredToolDefinition(toolName)
          ?? getBuiltinRegisteredToolDefinition(toolName);
        return def?.toClassifierInput;
      },
      resolveProvider: (name): KodaXBaseProvider | undefined => {
        try {
          return resolveCodingProvider(name);
        } catch {
          return undefined;
        }
      },
      // Static fallback values (still required by the config interface for
      // SDK consumers that don't supply getters). Snapshotted at first
      // getGuardrail() call.
      defaultProvider: deps.getCurrentProviderName(),
      defaultModel: deps.getCurrentModel() ?? '',
      // FEATURE_092 v0.7.34 hotfix-3: live getters re-read provider/model on
      // every classify() so `/model` + `/provider` mid-session swaps retarget
      // the classifier. The empty-model warn surfaces a misconfiguration
      // (main session has no model set) instead of failing silently inside
      // sideQuery.
      getDefaultProvider: deps.getCurrentProviderName,
      getDefaultModel: () => {
        const m = deps.getCurrentModel();
        if (!m) {
          deps.log?.(
            'warn',
            '[auto-mode] classifier defaultModel is empty; main session has no model set — classifier will likely fail',
          );
          return '';
        }
        return m;
      },
      askUser: deps.askUser,
      log: deps.log,
      onEngineChange: deps.onEngineChange,
      sharedState: deps.sharedState,
      // FEATURE_158: thread projectRoot to signal collectors + Tier 0;
      // path-aware bash collector merges with coding-side defaults.
      projectRoot: deps.projectRoot,
      executionCwd: deps.executionCwd,
      extraCollectors: deps.extraCollectors,
      extraAbsoluteDenyChecks: [replBashUserKodaxWriteDeny],
      // FEATURE_092 phase 2b.7b slice C: starting engine + timeout + classifier
      // model overrides. `userSettings` is layer 4 of `resolveClassifierModel`;
      // `envVar` is layer 2 (cli flag and session-override remain unset until
      // phase 2b.8 surfaces them via `/auto-model`).
      initialEngine: deps.autoModeSettings.engine,
      timeoutMs: deps.autoModeSettings.timeoutMs,
      userSettings: deps.autoModeSettings.classifierModel,
      envVar: deps.autoModeSettings.classifierModelEnv,
      // Issue 143 (WS3): thread the resolved speculative window so REPL + Space
      // honour `autoMode.speculativeWindowMs` (config.json) /
      // `KODAX_AUTO_SPECULATIVE_WINDOW_MS` (env). Undefined → guardrail default.
      speculativeWindowMs: deps.autoModeSettings.speculativeWindowMs,
    });
    return guardrail;
  };

  return { getGuardrail, rulesLoadResult };
}
