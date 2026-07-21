/**
 * Per-render resolution of the live compaction info, with a two-layer
 * cascade mirroring `commands.ts` (`/compact`) and CAP-056
 * (`resolveContextWindow`). Used by the status bar and the live banner
 * inside InkREPL so `/model` swaps update the displayed window without
 * touching the startup `<Static>` banner (which is render-once by Ink
 * design and stays at the session-start snapshot).
 *
 * Precedence (highest to lowest):
 *   1. user-config `compaction.contextWindow`  (manual override; always wins)
 *   2. active provider's `getEffectiveContextWindow(currentModel)`  (per-model)
 *   3. startup-resolved `compactionInfo.contextWindow`  (fallback)
 */

export interface LiveCompactionInfo {
  contextWindow: number;
  triggerPercent: number;
  triggerTokens?: number;
  enabled: boolean;
  /** Provider response capacity reserved from the same model descriptor. */
  reservedResponseTokens?: number;
  /** Raw user-config override; preserved across resolutions. */
  userOverrideContextWindow?: number;
}

export interface CompactionInfoResolverProviderLike {
  getEffectiveContextWindow?: (model?: string) => number;
  getEffectiveMaxOutputTokens?: (model?: string) => number;
}

export type CompactionInfoResolverProviderLookup = (
  providerName: string,
) => CompactionInfoResolverProviderLike | undefined;

/**
 * Resolve the effective compaction info for the active provider/model
 * combination. Always returns a new object when the contextWindow
 * actually changes — callers can use object-identity for memoization.
 */
export function resolveEffectiveCompactionInfo(
  startupInfo: LiveCompactionInfo | undefined,
  currentConfig: { provider: string; model?: string },
  resolveProvider: CompactionInfoResolverProviderLookup,
): LiveCompactionInfo | undefined {
  if (!startupInfo) return undefined;

  let contextWindow = startupInfo.userOverrideContextWindow ?? startupInfo.contextWindow;
  let reservedResponseTokens = startupInfo.reservedResponseTokens;

  try {
    const provider = resolveProvider(currentConfig.provider);
    if (startupInfo.userOverrideContextWindow === undefined) {
      contextWindow = provider?.getEffectiveContextWindow?.(currentConfig.model)
        ?? contextWindow;
    }
    reservedResponseTokens = provider?.getEffectiveMaxOutputTokens?.(currentConfig.model)
      ?? reservedResponseTokens;
  } catch {
    // Unknown provider name during a swap: keep the startup snapshot.
  }

  if (
    contextWindow === startupInfo.contextWindow
    && reservedResponseTokens === startupInfo.reservedResponseTokens
  ) {
    return startupInfo;
  }

  return { ...startupInfo, contextWindow, reservedResponseTokens };
}
