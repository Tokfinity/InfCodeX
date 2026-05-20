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
  enabled: boolean;
  /** Raw user-config override; preserved across resolutions. */
  userOverrideContextWindow?: number;
}

export interface CompactionInfoResolverProviderLike {
  getEffectiveContextWindow?: (model?: string) => number;
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

  // 1. user override wins unconditionally
  if (startupInfo.userOverrideContextWindow !== undefined) {
    return startupInfo.contextWindow === startupInfo.userOverrideContextWindow
      ? startupInfo
      : { ...startupInfo, contextWindow: startupInfo.userOverrideContextWindow };
  }

  // 2. provider's per-model resolution
  try {
    const provider = resolveProvider(currentConfig.provider);
    const perModel = provider?.getEffectiveContextWindow?.(currentConfig.model);
    if (perModel !== undefined && perModel !== startupInfo.contextWindow) {
      return { ...startupInfo, contextWindow: perModel };
    }
    if (perModel !== undefined) {
      // Same value already — no-op.
      return startupInfo;
    }
  } catch {
    // Unknown provider name (e.g. stale state during a swap) — fall through.
  }

  // 3. fallback to startup snapshot
  return startupInfo;
}
