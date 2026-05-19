/**
 * P2b write-turn max_output_tokens cap — RST-prone provider guard.
 *
 * Centralises the per-turn ceiling applied when a write/edit tool is in
 * scope for an RST-prone provider (Chinese-cloud subscription gateways
 * that observed reproducible mid-stream TCP RST during large tool_use
 * buffering). The cap fires only when (a) the provider is in the RST-
 * prone list, (b) a `write|edit|multi_edit` tool is in this turn's
 * inventory, and (c) the user has not explicitly set
 * `KODAX_MAX_OUTPUT_TOKENS` (explicit override wins).
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 3133–3215 in
 * the pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — constants and helper bodies
 * are byte-identical to the previous in-file declarations.
 */

/**
 * P2b (v0.7.26 → narrowed in v0.7.42) — default list of providers that
 * have shown reproducible mid-stream TCP RST during large tool_use
 * buffering. Users can override via the `KODAX_RST_PRONE_PROVIDERS` env
 * var (comma-separated provider names).
 *
 * History — original v0.7.26 list also included `kimi-code`,
 * `minimax-coding`, and `mimo-coding` on a prophylactic basis (same
 * Chinese-cloud /anthropic-shim architecture as zhipu-coding). The
 * 2026-04 bench round measured each of them completing a 64K stream
 * cleanly with `stop_reason=tool_use` (kimi-code 525s / minimax-coding
 * 464s / mimo-coding 309s) and observed no server-side kill window
 * comparable to zhipu-coding's 308s. Per-provider bench citations live
 * in `packages/llm/src/providers/registry.ts` on each provider class.
 *
 * Keeping them on the prophylactic list had a user-visible side effect:
 * every Worker write/edit turn was silently narrowed to 8K, then the
 * L4 escalation banner ("Output budget reached, escalating to 64000")
 * fired on practically every long-form generation. v0.7.42 trims the
 * list back to the one provider where the cap is bench-justified
 * (zhipu-coding). If a future regression brings RST back for any of
 * the removed providers, opt-in via the env var still works without a
 * code change:
 *
 *   KODAX_RST_PRONE_PROVIDERS="zhipu-coding,kimi-code,minimax-coding,mimo-coding"
 */
const DEFAULT_RST_PRONE_PROVIDERS: ReadonlySet<string> = new Set([
  'zhipu-coding',
]);

/** P2b — default per-turn ceiling applied when a write/edit tool is
 * in scope for an RST-prone provider. 8 KiB is comfortably below the
 * observed RST window while still large enough to fit a skeleton or a
 * single-section edit. Override via `KODAX_WRITE_TURN_MAX_TOKENS`. */
const DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS = 8192;

/**
 * P2b — tool names whose presence in a turn's inventory indicates the
 * model MAY emit a large tool_use payload whose streaming buffering
 * could trip an RST on a weak provider.
 */
const P2B_CAPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
]);

function resolveRstProneProviderSet(): ReadonlySet<string> {
  const override = process.env.KODAX_RST_PRONE_PROVIDERS;
  if (override === undefined) return DEFAULT_RST_PRONE_PROVIDERS;
  // Empty string is an explicit "disable the cap" signal, distinct
  // from unset (which keeps defaults).
  const trimmed = override.trim();
  if (trimmed.length === 0) return new Set();
  return new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean));
}

function resolveWriteTurnMaxTokens(): number {
  const raw = process.env.KODAX_WRITE_TURN_MAX_TOKENS;
  if (!raw) return DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS;
}

/**
 * P2b — decide whether this turn's tool inventory + provider warrant
 * the write-turn max_output_tokens cap, and apply it via the provider's
 * one-shot override. Returns `true` iff the cap was applied (the caller
 * clears the override in a finally block to prevent leakage). The cap
 * is NOT applied when the user has explicitly set KODAX_MAX_OUTPUT_TOKENS
 * — that signals "I want the higher budget even on risky providers."
 */
export function maybeApplyP2bWriteTurnCap(
  provider: { setMaxOutputTokensOverride: (v: number | undefined) => void; getEffectiveMaxOutputTokens: () => number },
  providerName: string,
  wireTools: readonly { name: string }[],
): boolean {
  // Explicit user override wins — never silently narrow their budget.
  if (process.env.KODAX_MAX_OUTPUT_TOKENS) return false;

  const proneProviders = resolveRstProneProviderSet();
  if (!proneProviders.has(providerName)) return false;

  const hasWriteTool = wireTools.some((t) => P2B_CAPPED_TOOL_NAMES.has(t.name));
  if (!hasWriteTool) return false;

  const cap = resolveWriteTurnMaxTokens();
  const effective = provider.getEffectiveMaxOutputTokens();
  if (effective <= cap) {
    // Already at or below the cap (another override is in force, e.g.
    // L4 escalation from a prior turn). Don't expand it.
    return false;
  }
  provider.setMaxOutputTokensOverride(cap);
  return true;
}
