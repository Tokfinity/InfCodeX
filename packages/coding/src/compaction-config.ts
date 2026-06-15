/**
 * @kodax-ai/coding Compaction Config
 *
 * Default trigger picks an adaptive percent based on the active provider's
 * context window. Short-window models compact earlier so the LLM doesn't
 * cross the attention-degradation zone (empirically ~120K based on
 * FEATURE_107 P6 eval, 2026-05-01).
 *
 * Mapping (chosen so the absolute trigger token count stays comparable
 * across windows — short-window models hit attention degradation at the
 * same absolute token count, not at the same percentage):
 *
 *   contextWindow ≤ 200K   →  60%   (~120K trigger)
 *   contextWindow ≤ 256K   →  65%   (~166K trigger)
 *   contextWindow ≤ 500K   →  70%   (~350K trigger)
 *   contextWindow > 500K   →  75%   (~750K @ 1M, prior default)
 *
 * User config can override via `~/.kodax/config.json`:
 *   { "compaction": { "triggerPercent": 80 } }
 */

import { readFile } from 'fs/promises';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type { CompactionConfig } from '@kodax-ai/agent';
const LEGACY_DEFAULT_TRIGGER_PERCENT = 75;

/**
 * Pick the trigger percent for a given context window. Exported so callers
 * (and tests) can resolve the same value the loader would.
 */
export function adaptiveTriggerPercent(contextWindow: number | undefined): number {
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    return LEGACY_DEFAULT_TRIGGER_PERCENT;
  }
  if (contextWindow <= 200_000) return 60;
  if (contextWindow <= 256_000) return 65;
  if (contextWindow <= 500_000) return 70;
  return 75;
}

const BASE_CONFIG: Pick<CompactionConfig, 'enabled'> = {
  enabled: true,
};

/**
 * SDK-consumer compaction override. Mirrors the subset of `CompactionConfig`
 * an in-process caller (`KodaXOptions.compaction`) is allowed to pin.
 */
export type CompactionConfigOverride = Partial<
  Pick<CompactionConfig, 'contextWindow' | 'triggerPercent' | 'enabled'>
>;

/**
 * Load compaction config. Resolution precedence for every field
 * (highest to lowest):
 *
 *   1. SDK override (`overrides` arg — in-process `KodaXOptions.compaction`)
 *   2. user config (`~/.kodax/config.json` → `compaction.*`)
 *   3. adaptive / base default
 *
 * For `triggerPercent` the bottom of the cascade is the adaptive bucket
 * keyed off the *effective* context window (an override window must move
 * the bucket too); falls back to legacy 75% when no window is known.
 *
 * @param contextWindow active provider's context window in tokens (used for
 *   the adaptive trigger bucket when neither layer pins a window/percent).
 * @param overrides in-process overrides that win over the user config file.
 */
export async function loadCompactionConfig(
  contextWindow?: number,
  overrides?: CompactionConfigOverride,
): Promise<CompactionConfig> {
  const userConfigPath = getAgentConfigPath('config.json');
  let userOverrides: Partial<CompactionConfig> | undefined;
  try {
    const userConfig = await readConfigFile(userConfigPath);
    if (userConfig?.compaction) {
      userOverrides = userConfig.compaction as Partial<CompactionConfig>;
    }
  } catch {
    // ignore — fall through to default
  }

  const merged: CompactionConfig = {
    ...BASE_CONFIG,
    ...userOverrides,
    // triggerPercent is recomputed below; this satisfies the required field
    // during the spread when userOverrides omits it.
    triggerPercent: LEGACY_DEFAULT_TRIGGER_PERCENT,
  };

  // SDK overrides win over the user config file — only for fields the
  // caller actually set.
  if (overrides?.enabled !== undefined) merged.enabled = overrides.enabled;
  if (overrides?.contextWindow !== undefined) {
    merged.contextWindow = overrides.contextWindow;
  }

  // The adaptive bucket keys off the effective window so a pinned window
  // (SDK or user config) lands in the right bucket.
  const bucketWindow = merged.contextWindow ?? contextWindow;
  merged.triggerPercent =
    typeof overrides?.triggerPercent === 'number'
      ? overrides.triggerPercent
      : typeof userOverrides?.triggerPercent === 'number'
        ? userOverrides.triggerPercent
        : adaptiveTriggerPercent(bucketWindow);

  return merged;
}

async function readConfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
