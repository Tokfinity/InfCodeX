export interface CompactionAntiThrashState {
  readonly lowSavingsStreak: number;
  readonly cooldownTurnsRemaining: number;
  readonly coveredTokensAfter?: number;
  readonly rearmAtTokens?: number;
}

export interface CompactionSavingsSample {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface CompactionAntiThrashConfig {
  readonly lowSavingsRatio?: number;
  readonly lowSavingsStreakLimit?: number;
  readonly cooldownTurns?: number;
}

export interface CompactionSavingsDecision {
  readonly state: CompactionAntiThrashState;
  readonly savingsRatio: number;
  readonly lowSavings: boolean;
  readonly enteredCooldown: boolean;
}

export type CompactionSkipReason =
  | 'low_savings_cooldown'
  | 'covered_context_unchanged'
  | 'compactable_below_threshold'
  | 'no_compactable_prefix'
  | 'circuit_breaker_cooldown';

export interface RuntimeCompactionSkippedEvent {
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly reason: CompactionSkipReason;
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly triggerPercent: number;
  readonly cooldownTurnsRemaining: number;
  readonly lowSavingsStreak: number;
  /** Full request minus replaceable managed-run-context messages. */
  readonly compactableTokens?: number;
  readonly effectiveTriggerTokens?: number;
  readonly consecutiveFailures?: number;
  readonly circuitBreakerLimit?: number;
  readonly circuitBreakerState?: 'closed' | 'open' | 'half_open';
  readonly rearmAtTokens?: number;
}

const DEFAULT_LOW_SAVINGS_RATIO = 0.1;
const DEFAULT_LOW_SAVINGS_STREAK_LIMIT = 2;
const DEFAULT_COOLDOWN_TURNS = 2;

export function createCompactionAntiThrashState(): CompactionAntiThrashState {
  return {
    lowSavingsStreak: 0,
    cooldownTurnsRemaining: 0,
  };
}

export function shouldSkipLlmCompaction(
  state: CompactionAntiThrashState | undefined,
  currentTokens?: number,
): boolean {
  if ((state?.cooldownTurnsRemaining ?? 0) > 0) return true;
  return currentTokens !== undefined
    && state?.rearmAtTokens !== undefined
    && currentTokens < state.rearmAtTokens;
}

export function consumeCompactionCooldown(
  state: CompactionAntiThrashState | undefined,
): CompactionAntiThrashState {
  const current = state ?? createCompactionAntiThrashState();
  return {
    lowSavingsStreak: current.lowSavingsStreak,
    cooldownTurnsRemaining: Math.max(0, current.cooldownTurnsRemaining - 1),
    coveredTokensAfter: current.coveredTokensAfter,
    rearmAtTokens: current.rearmAtTokens,
  };
}

export function recordCompactionSavings(
  state: CompactionAntiThrashState | undefined,
  sample: CompactionSavingsSample,
  config: CompactionAntiThrashConfig = {},
): CompactionSavingsDecision {
  const current = state ?? createCompactionAntiThrashState();
  const lowSavingsRatio = config.lowSavingsRatio ?? DEFAULT_LOW_SAVINGS_RATIO;
  const streakLimit = config.lowSavingsStreakLimit ?? DEFAULT_LOW_SAVINGS_STREAK_LIMIT;
  const cooldownTurns = config.cooldownTurns ?? DEFAULT_COOLDOWN_TURNS;
  const savingsRatio = computeSavingsRatio(sample);
  const lowSavings = savingsRatio < lowSavingsRatio;
  const coverage = {
    coveredTokensAfter: sample.tokensAfter,
    rearmAtTokens: sample.tokensAfter + Math.max(
      2_048,
      Math.ceil(sample.tokensAfter * 0.1),
    ),
  };

  if (!lowSavings) {
    return {
      state: { ...createCompactionAntiThrashState(), ...coverage },
      savingsRatio,
      lowSavings: false,
      enteredCooldown: false,
    };
  }

  const nextStreak = current.lowSavingsStreak + 1;
  if (nextStreak >= streakLimit) {
    return {
      state: {
        lowSavingsStreak: 0,
        cooldownTurnsRemaining: Math.max(1, cooldownTurns),
        ...coverage,
      },
      savingsRatio,
      lowSavings: true,
      enteredCooldown: true,
    };
  }

  return {
    state: {
      lowSavingsStreak: nextStreak,
      cooldownTurnsRemaining: current.cooldownTurnsRemaining,
      ...coverage,
    },
    savingsRatio,
    lowSavings: true,
    enteredCooldown: false,
  };
}

function computeSavingsRatio(sample: CompactionSavingsSample): number {
  if (sample.tokensBefore <= 0) return 0;
  const savedTokens = Math.max(0, sample.tokensBefore - sample.tokensAfter);
  return savedTokens / sample.tokensBefore;
}
