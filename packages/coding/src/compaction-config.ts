/**
 * @kodax-ai/coding Compaction Config
 *
 * Default automatic compaction is capacity-only: 100% means there is no
 * independent early percentage trigger. The final provider-envelope capacity
 * check remains authoritative and includes tools, framing, response reserve,
 * and safety margin.
 *
 * User config can override via `~/.kodax/config.json`:
 *   { "compaction": { "triggerPercent": 80 } }
 */

import { readFile } from 'fs/promises';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type { CompactionConfig } from '@kodax-ai/agent';
const CAPACITY_ONLY_TRIGGER_PERCENT = 100;

/**
 * Resolve the default automatic trigger. The context-window argument remains
 * for public API compatibility; the default no longer varies by window.
 */
export function adaptiveTriggerPercent(contextWindow: number | undefined): number {
  void contextWindow;
  return CAPACITY_ONLY_TRIGGER_PERCENT;
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
 *   3. capacity-only base default
 *
 * `triggerPercent < 100` is an explicit caller/user opt-in to early lossy
 * summarization. The default is 100 regardless of effective context window.
 *
 * @param contextWindow retained for compatibility; it does not change the default.
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
    triggerPercent: CAPACITY_ONLY_TRIGGER_PERCENT,
  };

  // SDK overrides win over the user config file — only for fields the
  // caller actually set.
  if (overrides?.enabled !== undefined) merged.enabled = overrides.enabled;
  if (overrides?.contextWindow !== undefined) {
    merged.contextWindow = overrides.contextWindow;
  }

  // Retain the effective-window call shape for compatibility; the default
  // resolver is capacity-only and intentionally ignores the value.
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
