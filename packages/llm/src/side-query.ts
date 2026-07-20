/**
 * sideQuery — independent one-shot LLM invocation.
 *
 * Used by features that need a clean LLM call outside the main agent loop.
 * The auto mode classifier (FEATURE_092) is the first consumer; future
 * users include compaction, title generation, and SA mutation reflection.
 *
 * Constraints (deliberate):
 *   - tools=[] hardcoded — sideQuery is single-turn, no tool loop
 *   - text-only output — tool_use blocks from the model produce stopReason='error'
 *   - independent timeout (default 30s; callers may supply a bounded deadline)
 *   - independent cost bucket via querySource (mapped to TokenUsageRecord.role)
 *
 * Failure handling: never throws. Timeout, abort, provider error, and
 * unexpected tool_use all produce a result with stopReason='timeout' /
 * 'aborted' / 'error' so callers implement their own degradation.
 */

import { performance } from 'node:perf_hooks';

import type {
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXReasoningProfile,
  KodaXTokenUsage,
} from './types.js';
import { KodaXBaseProvider } from './providers/base.js';
import { type CostTracker, recordRetry, recordUsage } from './cost-tracker.js';

export type SideQueryStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'timeout'
  | 'aborted'
  | 'error';

export interface SideQueryRequest {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly KodaXMessage[];
  readonly reasoning?: KodaXReasoningRequest;
  /** Optional per-request cap for small structured sidecar responses. */
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly querySource: string;
  readonly costTracker?: CostTracker;
}

export interface SideQueryResult {
  readonly text: string;
  readonly usage: KodaXTokenUsage;
  readonly costTracker?: CostTracker;
  readonly stopReason: SideQueryStopReason;
  /**
   * Bounded request metadata only; prompts and response text are never copied.
   * The built-in `sideQuery()` always supplies it. Optionality preserves source
   * compatibility for existing SDK mocks and structural result adapters.
   */
  readonly diagnostics?: SideQueryDiagnostics;
  readonly error?: Error;
}

export type SideQueryTerminalPhase =
  | 'completed'
  | 'pre_output'
  | 'streaming'
  | 'contract_error';

export interface SideQueryDiagnostics {
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly retryCount: number;
  readonly retryWaitMs: number;
  /** Time until the first non-empty text delta, when the adapter exposes it. */
  readonly firstOutputMs?: number;
  /** Time from the first observed text delta until termination. */
  readonly streamMs?: number;
  /** Honest coarse phase; provider adapters cannot split DNS/connect/remote queue. */
  readonly terminalPhase: SideQueryTerminalPhase;
}

const EMPTY_USAGE: KodaXTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveDefaultSideQueryReasoning(
  profile: KodaXReasoningProfile | undefined,
): KodaXReasoningRequest | undefined {
  if (!profile) return { effort: 'none' };

  const rejected = new Set([
    ...(profile.disabledEfforts ?? []),
    ...(profile.localRejectEfforts ?? []),
  ]);
  const visibleEfforts = profile.supportedEfforts
    ?.filter((preset) => preset.isUserVisible !== false)
    .map((preset) => preset.value)
    .filter((effort) => !rejected.has(effort));

  if (
    !rejected.has('none') &&
    (profile.supportsDisabledThinking === true || visibleEfforts?.includes('none'))
  ) {
    return { effort: 'none' };
  }

  const lowestEnabledEffort = visibleEfforts?.find((effort) => effort !== 'none');
  return lowestEnabledEffort === undefined
    ? undefined
    : { effort: lowestEnabledEffort };
}

export async function sideQuery(req: SideQueryRequest): Promise<SideQueryResult> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let costTracker = req.costTracker;
  const startedAt = performance.now();
  let firstOutputMs: number | undefined;
  let retryCount = 0;
  let retryWaitMs = 0;

  const diagnostics = (
    terminalPhase: SideQueryTerminalPhase,
  ): SideQueryDiagnostics => {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      provider: req.provider.name,
      model: req.model,
      timeoutMs,
      elapsedMs,
      retryCount,
      retryWaitMs,
      ...(firstOutputMs !== undefined
        ? {
            firstOutputMs,
            streamMs: Math.max(0, elapsedMs - firstOutputMs),
          }
        : {}),
      terminalPhase,
    };
  };

  // Track which source aborted FIRST so the resulting stopReason label is
  // deterministic when timeout and parent-abort fire near-simultaneously.
  // Without this, both `controller.signal.aborted` and `req.abortSignal.aborted`
  // can be true by the time the catch block runs, and the label loses fidelity.
  let abortCause: 'timeout' | 'parent' | undefined;
  const recordAbort = (cause: 'timeout' | 'parent'): void => {
    if (!abortCause) abortCause = cause;
    controller.abort();
  };

  const timeoutHandle = setTimeout(() => recordAbort('timeout'), timeoutMs);

  const onParentAbort = (): void => recordAbort('parent');
  if (req.abortSignal) {
    if (req.abortSignal.aborted) {
      recordAbort('parent');
    } else {
      req.abortSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  try {
    const result = await req.provider.stream(
      [...req.messages],
      [],
      req.system,
      req.reasoning ?? resolveDefaultSideQueryReasoning(
        req.provider.getReasoningProfile(req.model),
      ),
      {
        modelOverride: req.model,
        ...(isPositiveInteger(req.maxOutputTokens)
          ? { maxOutputTokensOverride: req.maxOutputTokens }
          : {}),
        onTextDelta: (text) => {
          if (text.length > 0 && firstOutputMs === undefined) {
            firstOutputMs = Math.max(
              0,
              Math.round(performance.now() - startedAt),
            );
          }
        },
        onRetryAfter: (event) => {
          retryCount += 1;
          retryWaitMs += Math.max(0, event.waitMs);
          if (!costTracker) return;
          costTracker = recordRetry(costTracker, {
            provider: event.provider,
            waitMs: event.waitMs,
            reason: event.reason,
            source: event.source,
          });
        },
      },
      controller.signal,
    );

    const usage = result.usage ?? EMPTY_USAGE;
    const textBlocks = result.textBlocks ?? [];
    const toolBlocks = result.toolBlocks ?? [];
    const text = textBlocks.map((b) => b.text).join('');

    if (toolBlocks.length > 0) {
      return {
        text,
        usage,
        costTracker,
        stopReason: 'error',
        diagnostics: diagnostics('contract_error'),
        error: new Error(
          `sideQuery: provider returned ${toolBlocks.length} tool_use block(s); sideQuery expects text-only output`,
        ),
      };
    }

    if (costTracker) {
      costTracker = recordUsage(costTracker, {
        provider: req.provider.name,
        model: req.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cachedReadTokens,
        cacheWriteTokens: usage.cachedWriteTokens,
        role: req.querySource,
      });
    }

    return {
      text,
      usage,
      costTracker,
      stopReason: mapStopReason(result.stopReason),
      diagnostics: diagnostics('completed'),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    let stopReason: SideQueryStopReason = 'error';
    if (controller.signal.aborted) {
      stopReason = abortCause === 'timeout' ? 'timeout' : 'aborted';
    }

    return {
      text: '',
      usage: EMPTY_USAGE,
      costTracker,
      stopReason,
      diagnostics: diagnostics(
        firstOutputMs === undefined ? 'pre_output' : 'streaming',
      ),
      error,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (req.abortSignal) {
      req.abortSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

// Provider stop reasons we recognize:
//   'max_tokens' → output truncation (caller may want to retry with larger budget)
//   'end_turn' / 'stop_sequence' / undefined → normal completion
//   'tool_use' → unreachable here (toolBlocks check above already errored out)
// Any unknown future value is conservatively treated as a normal completion;
// the caller's parsing of `text` is the authoritative success signal.
function mapStopReason(raw: string | undefined): SideQueryStopReason {
  if (raw === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}
