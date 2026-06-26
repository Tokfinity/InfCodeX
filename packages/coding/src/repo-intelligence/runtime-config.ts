import type {
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
} from '../types.js';

export interface RepoIntelligenceRuntimeInspection {
  configuredMode: KodaXRepoIntelligenceMode;
  requestedMode: KodaXRepoIntelligenceResolvedMode;
  traceEnabled: boolean;
  effectiveEngine: 'off' | 'light' | 'full';
  status: 'disabled' | 'ok' | 'limited' | 'unavailable' | 'warming';
  fallbackToLight: boolean;
  warnings: string[];
  error?: string;
}

export interface RepoIntelligenceRuntimeConfig {
  mode: KodaXRepoIntelligenceMode;
  trace: boolean;
  warnings: string[];
}

const PUBLIC_MODES = new Set<string>(['auto', 'off', 'light', 'full']);
const LEGACY_MODES = new Set<string>(['oss', 'premium-native', 'premium-shared']);

function readModeValue(value: string | undefined): {
  mode?: KodaXRepoIntelligenceMode;
  warning?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return {};
  if (PUBLIC_MODES.has(normalized)) {
    return { mode: normalized as KodaXRepoIntelligenceMode };
  }
  if (LEGACY_MODES.has(normalized)) {
    return {
      warning: `Ignoring legacy repo-intelligence mode "${normalized}". Use auto, full, light, or off.`,
    };
  }
  return {
    warning: `Ignoring unknown repo-intelligence mode "${value}". Expected auto, full, light, or off.`,
  };
}

function legacyBridgeWarnings(): string[] {
  const warnings: string[] = [];
  if (process.env.KODAX_REPOINTEL_BIN?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_BIN; repo intelligence is built into KodaX.');
  }
  if (process.env.KODAX_REPOINTEL_ENDPOINT?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_ENDPOINT; repo intelligence no longer uses a daemon endpoint.');
  }
  if (process.env.KODAX_REPOINTEL_BUILD_ID?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_BUILD_ID; built-in repo intelligence has no external build-id probe.');
  }
  return warnings;
}

export function resolveRepoIntelligenceRuntimeConfig(
  modeOverride?: KodaXRepoIntelligenceMode,
  traceOverride?: boolean,
): RepoIntelligenceRuntimeConfig {
  const warnings = legacyBridgeWarnings();
  const preferredEnv = readModeValue(process.env.KODAX_REPO_INTELLIGENCE);
  const legacyEnv = readModeValue(process.env.KODAX_REPO_INTELLIGENCE_MODE);
  if (preferredEnv.warning) warnings.push(preferredEnv.warning);
  if (legacyEnv.warning) warnings.push(legacyEnv.warning);
  if (process.env.KODAX_REPO_INTELLIGENCE_MODE?.trim()) {
    warnings.push('Ignoring deprecated KODAX_REPO_INTELLIGENCE_MODE; use KODAX_REPO_INTELLIGENCE.');
  }

  return {
    mode: modeOverride ?? preferredEnv.mode ?? 'auto',
    trace: traceOverride ?? process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1',
    warnings,
  };
}

export function resolveRepoIntelligenceMode(
  modeOverride?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const mode = resolveRepoIntelligenceRuntimeConfig(modeOverride).mode;
  if (mode === 'auto') {
    return 'full';
  }
  return mode;
}

export async function inspectRepoIntelligenceRuntime(
  options: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<RepoIntelligenceRuntimeInspection> {
  const config = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const requestedMode = resolveRepoIntelligenceMode(config.mode);
  return {
    configuredMode: config.mode,
    requestedMode,
    traceEnabled: config.trace,
    effectiveEngine: requestedMode,
    status: requestedMode === 'off' ? 'disabled' : 'ok',
    fallbackToLight: false,
    warnings: config.warnings,
  };
}
