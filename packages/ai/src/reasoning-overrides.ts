import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningOverride,
} from './types.js';

type StoredConfig = {
  providerReasoningOverrides?: Record<string, KodaXReasoningOverride>;
  [key: string]: unknown;
};

function getKodaxDir(): string {
  return process.env.KODAX_HOME ?? path.join(os.homedir(), '.kodax');
}

function getConfigFilePath(): string {
  return process.env.KODAX_CONFIG_FILE
    ?? path.join(getKodaxDir(), 'config.json');
}

export function reasoningCapabilityToOverride(
  capability: KodaXReasoningCapability,
): KodaXReasoningOverride | undefined {
  switch (capability) {
    case 'native-budget':
      return 'budget';
    case 'native-effort':
      return 'effort';
    case 'native-toggle':
      return 'toggle';
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

export function reasoningOverrideToCapability(
  override: KodaXReasoningOverride,
): KodaXReasoningCapability {
  switch (override) {
    case 'budget':
      return 'native-budget';
    case 'effort':
      return 'native-effort';
    case 'toggle':
      return 'native-toggle';
    case 'none':
    default:
      return 'none';
  }
}

export function buildReasoningOverrideKey(
  providerName: string,
  config: Pick<KodaXProviderConfig, 'baseUrl' | 'model'>,
  modelOverride?: string,
): string {
  return [
    providerName,
    config.baseUrl ?? '',
    modelOverride ?? config.model,
  ].join('|');
}

function loadStoredConfig(): StoredConfig {
  const configFile = getConfigFilePath();
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as StoredConfig;
    }
  } catch {
    // Best-effort local cache: ignore malformed or unreadable config.
  }
  return {};
}

function saveStoredConfig(config: StoredConfig): void {
  const configFile = getConfigFilePath();
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (error) {
    if (process.env.KODAX_DEBUG_OVERRIDES) {
      console.error('[ReasoningOverride] Failed to save config:', error);
    }
  }
}

export function loadReasoningOverride(
  providerName: string,
  config: Pick<KodaXProviderConfig, 'baseUrl' | 'model'>,
  modelOverride?: string,
): KodaXReasoningOverride | undefined {
  const stored = loadStoredConfig();
  const key = buildReasoningOverrideKey(providerName, config, modelOverride);
  return stored.providerReasoningOverrides?.[key];
}

export function saveReasoningOverride(
  providerName: string,
  config: Pick<KodaXProviderConfig, 'baseUrl' | 'model'>,
  override: KodaXReasoningOverride,
  modelOverride?: string,
): void {
  const stored = loadStoredConfig();
  const key = buildReasoningOverrideKey(providerName, config, modelOverride);
  stored.providerReasoningOverrides = {
    ...(stored.providerReasoningOverrides ?? {}),
    [key]: override,
  };
  saveStoredConfig(stored);
}

export function clearReasoningOverride(
  providerName: string,
  config: Pick<KodaXProviderConfig, 'baseUrl' | 'model'>,
  modelOverride?: string,
): void {
  const stored = loadStoredConfig();
  const key = buildReasoningOverrideKey(providerName, config, modelOverride);
  if (!stored.providerReasoningOverrides?.[key]) {
    return;
  }

  const nextOverrides = { ...stored.providerReasoningOverrides };
  delete nextOverrides[key];

  stored.providerReasoningOverrides =
    Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;

  saveStoredConfig(stored);
}
