/**
 * KodaX CLI Utilities
 * CLI 灞傚伐鍏峰嚱鏁?
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawnSync, type SpawnSyncReturns } from 'child_process';
import { getAgentConfigHome, getCachedRejectedEfforts } from '@kodax-ai/agent';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { setLocale } from './i18n.js';
import {
  buildProviderCapabilitySnapshot,
  evaluateProviderPolicy,
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  getProviderList as getBuiltInProviderList,
  getProviderModel as getBuiltInProviderModel,
  getProviderModels,
  resolveModelCapabilities,
  resolveReasoningEffort,
  resolveReasoningEffortForModelSwitch,
  getCustomProviderList,
  getCustomProvider,
  isProviderConfigured as isBuiltInProviderConfigured,
  registerCustomProviders,
  resolveProvider,
  type KodaXProviderCapabilityProfile,
  type KodaXProviderCapabilitySnapshot,
  type KodaXProviderPolicyDecision,
  type KodaXProviderPolicyHints,
  type KodaXReasoningCapability,
  type KodaXAgentMode,
  type KodaXReasoningMode,
  type KodaXMcpServersConfig,
  type KodaXCustomProviderConfig,
  type KodaXReasoningProfile,
} from '@kodax-ai/coding';
import { narrowReasoningProfile } from '@kodax-ai/llm';

const execAsync = promisify(exec);

/**
 * CLI config directory paths — top-level constants frozen at module-load time.
 *
 * **LOAD-TIME FREEZE WARNING (v0.7.35.1 FEATURE_145)** — these constants
 * are computed ONCE when this module is first imported, by reading
 * `getAgentConfigHome()` (which itself reads `KODAX_HOME` env var and
 * the programmatic override at that single moment). Subsequent calls to
 * `setAgentConfigHome()` have NO effect on these constants. This
 * matches the prior v0.7.35 behavior where they were inlined as
 * `path.join(os.homedir(), '.kodax')` — same load-time semantics, just
 * routed through the resolver so that `KODAX_HOME` env is now honored.
 *
 * **For substrate consumers**: if you intend to redirect the agent
 * config home via `setAgentConfigHome()`, you MUST call it BEFORE
 * importing any module that transitively imports `@kodax-ai/repl`'s
 * `utils.ts`. Common downstream consumers that capture these constants
 * include:
 *   - `repl/interactive/storage.ts` → `KODAX_SESSIONS_DIR` (session
 *     persistence; silent corruption risk if override is set late)
 *   - the SDK's `repl/index.ts` re-exports
 *   - root `src/index.ts` re-exports
 *
 * **For env-var users**: setting `KODAX_HOME=/path` before launching
 * the kodax CLI works as expected — the env var is read at first
 * import.
 *
 * **For per-call resolution**: use `getAgentConfigHome()` /
 * `getAgentConfigPath(...)` directly from `@kodax-ai/agent` instead of
 * these constants — those resolve at call time and honor late
 * `setAgentConfigHome()` calls.
 */
export const KODAX_DIR = getAgentConfigHome();
export const KODAX_SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');
export const KODAX_CONFIG_FILE = path.join(KODAX_DIR, 'config.json');

// UI display constants
export const PREVIEW_MAX_LENGTH = 60;

let cachedVersion: string | null = null;
let shellEnvironmentHydrated = false;

type ShellEnvRunner = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
    detached: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnSyncReturns<string>;

const SHELL_ENV_PROBE_TERM = 'dumb';

function buildShellEnvCommand(shellPath: string): { args: string[]; sentinel: string } {
  const shellName = path.basename(shellPath).toLowerCase();
  const sentinel = '__KODAX_SHELL_ENV_START__';
  const command = `printf '%s\\0' '${sentinel}'; env -0`;

  if (shellName === 'fish') {
    return { args: ['-i', '-c', command], sentinel };
  }

  const args =
    shellName === 'bash' || shellName === 'zsh'
      ? ['-ic', command]
      : ['-lc', command];

  return { args, sentinel };
}

function parseNullDelimitedShellEnv(stdout: string, sentinel: string): Record<string, string> {
  const marker = `${sentinel}\0`;
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return {};
  }

  const payload = stdout.slice(markerIndex + marker.length);
  const env: Record<string, string> = {};

  for (const entry of payload.split('\0')) {
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    env[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }

  return env;
}

export function hydrateProcessEnvFromShell(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ShellEnvRunner;
  shell?: string;
} = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    return false;
  }

  if (env.KODAX_DISABLE_SHELL_ENV_HYDRATION === '1') {
    return false;
  }

  const shellPath = options.shell ?? env.SHELL;
  if (!shellPath || !path.isAbsolute(shellPath)) {
    return false;
  }

  const { args, sentinel } = buildShellEnvCommand(shellPath);
  const run = options.run ?? spawnSync;
  const shellProbeEnv: NodeJS.ProcessEnv = {
    ...env,
    TERM: SHELL_ENV_PROBE_TERM,
  };
  const result = run(shellPath, args, {
    encoding: 'utf8',
    env: shellProbeEnv,
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  const stdout = typeof result.stdout === 'string'
    ? result.stdout
    : result.stdout.toString('utf8');
  const shellEnv = parseNullDelimitedShellEnv(stdout, sentinel);
  let applied = false;

  for (const [key, value] of Object.entries(shellEnv)) {
    // TERM is probe-only; applying it back would misrepresent the live terminal.
    if (key === 'TERM') {
      continue;
    }
    if (env[key] !== undefined) {
      continue;
    }
    env[key] = value;
    applied = true;
  }

  return applied;
}

function ensureShellEnvironmentHydrated(): void {
  if (shellEnvironmentHydrated) {
    return;
  }

  shellEnvironmentHydrated = true;
  try {
    hydrateProcessEnvFromShell();
  } catch {
    // Shell env hydration is best-effort. Falling back to the inherited
    // process env keeps startup resilient in restricted runtimes.
  }
}

// Test-only helper to keep module-level hydration state from leaking across
// multiple cases running in the same process.
export function resetShellEnvironmentHydrationForTesting(): void {
  shellEnvironmentHydrated = false;
}

export function registerConfiguredCustomProviders(config: {
  customProviders?: KodaXCustomProviderConfig[];
}): void {
  registerCustomProviders(config.customProviders ?? []);
}

function normalizeConfiguredExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : [];
}

function migrateLegacyPermissionModeInConfig<T extends { permissionMode?: string }>(
  config: T,
): T {
  if (config.permissionMode !== 'default') {
    return config;
  }

  const migrated = {
    ...config,
    permissionMode: 'accept-edits',
  } as T;

  try {
    fsSync.mkdirSync(path.dirname(KODAX_CONFIG_FILE), { recursive: true });
    fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(migrated, null, 2));
  } catch {
    // Keep runtime behavior correct even if the migration cannot be persisted.
  }

  return migrated;
}

/**
 * FEATURE_092 follow-up (v0.7.46): the `auto-in-project` permission-mode alias is
 * retired. Self-heal the user config to the canonical `auto` instead of nagging a
 * deprecation notice on every startup. Uses a TARGETED rewrite of just the
 * permissionMode value (preserves every other field, comment and formatting,
 * unlike the lossy `JSON.stringify` rewrite above) and canonicalizes the in-memory
 * value so the once-per-session deprecation emitter never fires.
 */
function migrateAutoInProjectAliasInConfig<T extends { permissionMode?: string }>(
  config: T,
): T {
  if (config.permissionMode !== 'auto-in-project') {
    return config;
  }
  try {
    const raw = fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf-8');
    const next = raw.replace(
      /("permissionMode"\s*:\s*)"auto-in-project"/,
      '$1"auto"',
    );
    if (next !== raw) {
      fsSync.writeFileSync(KODAX_CONFIG_FILE, next);
    }
  } catch {
    // Best-effort self-heal; the in-memory canonicalization below still applies.
  }
  return { ...config, permissionMode: 'auto' } as T;
}

// Read version from package.json dynamically - 动态读取版本号
// In standalone binary builds (Bun --compile), package.json is not on disk;
// the build script injects `process.env.KODAX_VERSION` via --define so this
// function returns the baked-in version without filesystem access.
// 在 Bun 编译后的单文件分发里读不到 package.json，由 build 脚本通过 --define
// 注入 KODAX_VERSION，运行时优先返回该值。
export function getVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const injected = process.env.KODAX_VERSION;
  if (injected) {
    cachedVersion = injected;
    return cachedVersion;
  }

  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  if (fsSync.existsSync(packageJsonPath)) {
    try {
      cachedVersion = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version ?? '0.0.0';
      return cachedVersion ?? '0.0.0';
    } catch {
      // Fall through to the stable default version when package metadata is unavailable.
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

// Export for backwards compatibility
export const KODAX_VERSION = getVersion();

// Get provider model name (snapshot-based, no API key needed)
export function getProviderModel(name: string): string | null {
  return getBuiltInProviderModel(name);
}

/**
 * Merge user-configured models with built-in provider models.
 * Config entries come first (preserving user order), then built-in models
 * not already present in the config list are appended (deduplicated, case-insensitive).
 */
function mergeModels(configModels: string[], builtInModels: string[]): string[] {
  const configSet = new Set(configModels.map(m => m.toLowerCase()));
  const merged = [...configModels];
  for (const m of builtInModels) {
    if (!configSet.has(m.toLowerCase())) {
      merged.push(m);
    }
  }
  return merged;
}

// Get available models for a provider (respects config-level providerModels, merged with built-in)
// Uses getProviderModels (snapshot-based, no API key required) for built-in providers,
// falls back to getProvider() instantiation for custom providers.
export function getProviderAvailableModels(name: string, providerModelsConfig?: Record<string, string[]>): string[] {
  if (!providerModelsConfig) {
    providerModelsConfig = loadConfig().providerModels;
  }
  const configModels = providerModelsConfig?.[name];
  if (configModels && configModels.length > 0) {
    // Merge config list with built-in models to avoid accidentally dropping models
    try {
      const builtInModels = getProviderModels(name);
      if (builtInModels.length > 0) return mergeModels(configModels, builtInModels);
    } catch {
      // Built-in provider snapshots are optional here; custom providers may still supply models.
    }
    try {
      const custom = getCustomProvider(name);
      if (custom) return mergeModels(configModels, custom.getAvailableModels());
    } catch {
      // Ignore custom-provider lookup failures and fall back to user-configured models below.
    }
    return configModels;
  }
  // No config override — use built-in models from snapshot
  try {
    const builtInModels = getProviderModels(name);
    if (builtInModels.length > 0) return builtInModels;
  } catch {
    // Fall through to custom providers when a built-in snapshot is unavailable.
  }
  // Check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getAvailableModels();
  } catch {
    // Ignore custom-provider lookup failures and report no models.
  }
  return [];
}

export function getProviderReasoningCapability(
  name: string,
  model?: string,
): KodaXReasoningCapability | 'unknown' {
  // Try built-in provider snapshot first (no API key needed)
  const capability = getProviderConfiguredReasoningCapability(name, model);
  if (capability !== 'unknown') return capability;
  // Fallback: check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getReasoningCapability(model);
  } catch {
    // Unknown custom providers should degrade to "unknown" without surfacing an exception.
  }
  return 'unknown';
}

export function getProviderCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  const builtInProfile = getProviderConfiguredCapabilityProfile(name);
  if (builtInProfile) {
    return builtInProfile;
  }

  try {
    const custom = getCustomProviderList().find((provider) => provider.name === name);
    return custom?.capabilityProfile ?? null;
  } catch {
    return null;
  }
}

function getProviderCapabilityMetadata(
  name: string,
  model?: string,
): {
  capabilityProfile: KodaXProviderCapabilityProfile;
  reasoningCapability: KodaXReasoningCapability | 'unknown';
} | null {
  const capabilityProfile = getProviderCapabilityProfile(name);
  const reasoningCapability = getProviderReasoningCapability(name, model);

  if (capabilityProfile) {
    return {
      capabilityProfile,
      reasoningCapability,
    };
  }

  try {
    const provider = resolveProvider(name);
    return {
      capabilityProfile: provider.getCapabilityProfile(),
      reasoningCapability: provider.getReasoningCapability(model),
    };
  } catch {
    return null;
  }
}

export function getProviderCapabilitySnapshot(
  name: string,
  model?: string,
): KodaXProviderCapabilitySnapshot | null {
  const metadata = getProviderCapabilityMetadata(name, model);
  if (!metadata) {
    return null;
  }

  return buildProviderCapabilitySnapshot({
    providerName: name,
    model,
    capabilityProfile: metadata.capabilityProfile,
    reasoningCapability:
      metadata.reasoningCapability === 'unknown'
        ? undefined
        : metadata.reasoningCapability,
  });
}

export function getProviderPolicyDecision(
  name: string,
  model: string | undefined,
  reasoningMode: KodaXReasoningMode,
  hints?: KodaXProviderPolicyHints,
): KodaXProviderPolicyDecision | null {
  const metadata = getProviderCapabilityMetadata(name, model);
  if (!metadata) {
    return null;
  }

  return evaluateProviderPolicy({
    providerName: name,
    model,
    capabilityProfile: metadata.capabilityProfile,
    reasoningCapability:
      metadata.reasoningCapability === 'unknown'
        ? undefined
        : metadata.reasoningCapability,
    reasoningMode,
    hints,
  });
}

export function describeProviderCapabilitySummary(
  profile: KodaXProviderCapabilityProfile,
): string {
  const transport =
    profile.transport === 'cli-bridge' ? 'CLI bridge' : 'Native API';
  const conversation =
    profile.conversationSemantics === 'last-user-message'
      ? 'forwards only the latest user message'
      : 'preserves full conversation history';
  const mcp =
    profile.mcpSupport === 'native' ? 'MCP available' : 'MCP unavailable';

  return `${transport}; ${conversation}; ${mcp}`;
}

export function formatReasoningCapabilityShort(
  capability: KodaXReasoningCapability | 'unknown',
): string {
  switch (capability) {
    case 'native-budget':
      return 'B';
    case 'native-effort':
      return 'E';
    case 'native-toggle':
      return 'T';
    case 'native-adaptive':
      return 'A';
    case 'none':
    case 'prompt-only':
    case 'unknown':
    default:
      return '-';
  }
}

export function formatReasoningEffortForDisplay(
  effort: string | undefined,
): string | undefined {
  if (!effort) {
    return undefined;
  }
  return effort === 'none' ? 'off' : effort;
}

function pushUniqueEffortDisplay(
  values: string[],
  effort: string | undefined,
): void {
  const display = formatReasoningEffortForDisplay(effort);
  if (display && !values.includes(display)) {
    values.push(display);
  }
}

export function getProviderReasoningEffortOptions(
  provider: string,
  model?: string,
): string[] {
  const values = ['auto'];
  const capability = resolveReasoningProfileForDisplay(provider, model);
  const presets = capability?.supportedEfforts?.filter(
    (preset) => preset.isUserVisible !== false,
  );
  if (!presets || presets.length === 0) {
    for (const effort of ['off', 'low', 'medium', 'high']) {
      pushUniqueEffortDisplay(values, effort);
    }
    return values;
  }
  for (const preset of presets) {
    pushUniqueEffortDisplay(values, preset.value);
  }
  return values;
}

/**
 * Ordered effort ladder for the Ctrl+T cycle (and any keyboard stepper).
 *
 * Derived from the active model's reasoning profile so the rungs are always the
 * ones that model actually exposes. Two deliberate shaping rules:
 *
 * - `off` (the canonical disable stop) is included only when the model can
 *   disable thinking (`none` in supportedEfforts or `supportsDisabledThinking`).
 *   Always-on models (kimi-k2.7-code / minimax-m2-always) get no `off` rung.
 * - Efforts that merely FOLD to off on this model — e.g. `minimal` on a toggle
 *   or budget provider where it sits in `disabledEfforts` — are dropped from the
 *   cycle so the user doesn't hit a second, redundant disable stop next to
 *   `off`. They remain reachable via the explicit `/effort <value>` command,
 *   which renders them honestly as `minimal->off`.
 *
 * `auto` (clear the explicit override → model default) is always the last rung.
 */
export function getProviderReasoningEffortCycle(
  provider: string,
  model?: string,
): string[] {
  const capability = resolveReasoningProfileForDisplay(provider, model);
  const disabled = new Set(capability?.disabledEfforts ?? []);
  const presets = capability?.supportedEfforts?.filter(
    (preset) => preset.isUserVisible !== false,
  );

  const concrete: string[] = [];
  let canDisable = capability?.supportsDisabledThinking === true;
  if (!presets || presets.length === 0) {
    for (const effort of ['low', 'medium', 'high']) {
      pushUniqueEffortDisplay(concrete, effort);
    }
    canDisable = true;
  } else {
    for (const preset of presets) {
      if (preset.value === 'none') {
        canDisable = true;
        continue;
      }
      if (disabled.has(preset.value)) {
        canDisable = true;
        continue;
      }
      pushUniqueEffortDisplay(concrete, preset.value);
    }
  }

  const cycle: string[] = [];
  if (canDisable) {
    cycle.push('off');
  }
  cycle.push(...concrete);
  cycle.push('auto');
  return cycle;
}

function legacyReasoningModeToEffortDisplay(
  mode: KodaXReasoningMode | undefined,
  thinking: boolean | undefined,
): string {
  if (thinking === false) {
    return 'off';
  }
  switch (mode) {
    case 'off':
      return 'off';
    case 'quick':
      return 'low';
    case 'balanced':
      return 'medium';
    case 'deep':
      return 'high';
    case 'auto':
    default:
      return 'auto';
  }
}

function resolveReasoningProfileForDisplay(
  provider: string,
  model: string | undefined,
): KodaXReasoningProfile | undefined {
  const modelId = model ?? getProviderModel(provider);
  if (!modelId) {
    return undefined;
  }
  const profile = resolveModelCapabilities(provider, modelId)?.reasoningProfile;
  if (!profile) {
    return undefined;
  }
  // Apply the runtime capability cache: efforts observed/probed to be rejected
  // by this provider/model are removed so the cycle, /effort options, and the
  // status label all stop offering them (single funnel for every display
  // consumer).
  return narrowReasoningProfile(profile, getCachedRejectedEfforts(provider, modelId));
}

export function formatReasoningEffortStatusLabel(input: {
  provider: string;
  model?: string;
  effort?: string;
  effortOverride?: boolean;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
}): string {
  const fallback = formatReasoningEffortForDisplay(input.effort)
    ?? legacyReasoningModeToEffortDisplay(input.reasoningMode, input.thinking);
  const capability = resolveReasoningProfileForDisplay(input.provider, input.model);
  if (!capability) {
    return fallback;
  }

  try {
    const resolved = resolveReasoningEffort({
      capability,
      explicitEffort: input.effortOverride ? input.effort : undefined,
      sessionEffort: input.effortOverride ? undefined : input.effort,
      legacyReasoningMode: input.reasoningMode,
      thinking: input.thinking,
    });
    const configured = formatReasoningEffortForDisplay(resolved.configuredEffort) ?? fallback;
    // A configured effort that sits in `disabledEfforts` (e.g. `minimal` on a
    // toggle/budget provider) folds to "off" at the wire layer (base.ts).
    // Reflect that truth so the status reads `minimal->off` instead of a bare
    // `minimal` that lies about thinking still being on.
    const foldsToOff = resolved.configuredEffort !== undefined
      && capability.disabledEfforts?.includes(resolved.configuredEffort) === true;
    const effective = foldsToOff
      ? 'off'
      : formatReasoningEffortForDisplay(resolved.effectiveEffort);
    return effective && effective !== configured
      ? `${configured}->${effective}`
      : configured;
  } catch {
    if (input.effort) {
      try {
        const switchResolution = resolveReasoningEffortForModelSwitch({
          currentEffort: input.effort,
          capability,
        });
        const configured = formatReasoningEffortForDisplay(input.effort) ?? fallback;
        const effective = formatReasoningEffortForDisplay(switchResolution.effectiveEffort);
        return effective && effective !== configured
          ? `${configured}->${effective}`
          : configured;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

export function resolveProviderReasoningRuntimeEffort(input: {
  provider: string;
  model?: string;
  effort?: string;
  effortOverride?: boolean;
  permissionMode?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
}): {
  configuredEffort?: string;
  runtimeEffort?: string;
  preserved: boolean;
  diagnostic?: string;
} {
  const configuredEffort = resolvePermissionModeEffort(input);
  if (!configuredEffort) {
    return { preserved: true };
  }

  const capability = resolveReasoningProfileForDisplay(input.provider, input.model);
  if (!capability) {
    return {
      configuredEffort,
      runtimeEffort: configuredEffort,
      preserved: true,
    };
  }
  const resolution = resolveReasoningEffortForModelSwitch({
    currentEffort: configuredEffort,
    capability,
  });

  return {
    configuredEffort,
    runtimeEffort: resolution.effectiveEffort,
    preserved: resolution.preserved,
    diagnostic: resolution.diagnostic,
  };
}

export function describeReasoningCapabilityControl(
  capability: KodaXReasoningCapability | 'unknown',
): string {
  switch (capability) {
    case 'native-budget':
      return 'budget';
    case 'native-effort':
      return 'effort';
    case 'native-toggle':
      return 'toggle';
    case 'native-adaptive':
      return 'adaptive';
    case 'none':
    case 'prompt-only':
    case 'unknown':
    default:
      return 'none';
  }
}

export function describeReasoningExecution(
  mode: KodaXReasoningMode,
  capability: KodaXReasoningCapability | 'unknown',
): string {
  if (mode === 'off') {
    return 'Reasoning disabled';
  }

  switch (capability) {
    case 'native-budget':
      return 'Uses native thinking budget control';
    case 'native-effort':
      return 'Uses native reasoning effort control';
    case 'native-toggle':
      return 'Uses provider-native thinking toggle only';
    case 'native-adaptive':
      return 'Model adaptively decides thinking depth (Opus 4.7+)';
    case 'none':
      return 'Runs without native reasoning parameters';
    case 'prompt-only':
      return 'Uses prompt overlays only; no native reasoning parameter';
    case 'unknown':
    default:
      return 'Runs without native reasoning parameters';
  }
}

// Get list of all providers with their status
export function getProviderList(providerModelsConfig?: Record<string, string[]>): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: string;
  capabilityProfile: KodaXProviderCapabilityProfile;
  custom?: boolean;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: string;
    capabilityProfile: KodaXProviderCapabilityProfile;
    custom?: boolean;
  }> = [];
  if (!providerModelsConfig) {
    providerModelsConfig = loadConfig().providerModels;
  }
  for (const provider of getBuiltInProviderList()) {
    result.push({
      name: provider.name,
      model: provider.model,
      models: getProviderAvailableModels(provider.name, providerModelsConfig),
      configured: provider.capabilityProfile.transport === 'cli-bridge'
        ? true
        : provider.configured,
      reasoningCapability: provider.reasoningCapability,
      capabilityProfile: provider.capabilityProfile,
    });
  }
  // Append custom providers - 追加自定义 Provider
  try {
    const customList = getCustomProviderList().map((provider) => ({
      ...provider,
      models: (() => {
        const configModels = providerModelsConfig?.[provider.name];
        return configModels && configModels.length > 0
          ? mergeModels(configModels, provider.models)
          : provider.models;
      })(),
    }));
    result.push(...customList);
  } catch {
    // Custom providers not initialized or unavailable
  }
  return result;
}

// Check if provider is configured (supports both built-in and custom)
export function isProviderConfigured(name: string): boolean {
  if (isBuiltInProviderConfigured(name)) return true;
  try {
    const custom = getCustomProvider(name);
    return custom?.isConfigured() ?? false;
  } catch {
    return false;
  }
}

// Load config from ~/.kodax/config.json
export function loadConfig(): {
  provider?: string;
  model?: string;
  effort?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  /**
   * FEATURE_078 (v0.7.29): preferred name for `reasoningMode`. Both
   * fields map to the same runtime L1 user-ceiling semantic; when both
   * are present `reasoningCeiling` wins. Prefer this name in new
   * configs — `reasoningMode` is kept accepted for backward
   * compatibility and never auto-renamed (no user-visible churn).
   */
  reasoningCeiling?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  permissionMode?: string;
  locale?: string;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
  extensions?: string[];
  mcpServers?: KodaXMcpServersConfig;
  repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  repoIntelligenceTrace?: boolean;
  streamIdleTimeoutMs?: number;
  /**
   * FEATURE_184 Phase D.3 follow-up (v0.7.42) — opt-in Sidecar Verifier
   * observability. When `true`, the runtime emits a persisted note per
   * verifier call:
   *   `[Sidecar Verifier] {verdict} · {model} · {ms}ms · {trace}`
   * Mirrored to env var `KODAX_VERIFIER_LOG=1` so the agent-runtime
   * layer (which has no access to `~/.kodax/config.json`) can read it.
   */
  verifierLog?: boolean;
  /**
   * FEATURE_187 Phase C (v0.7.43) — opt-in Stall Sidecar observability.
   * When `true`, the runtime emits a persisted note per L2 stall
   * verdict (isStuck true OR false):
   *   `[Stall Sidecar] isStuck={true|false} · {provider}/{model} · {ms}ms · {trace}`
   * Mirrored to env var `KODAX_STALL_LOG=1`.
   */
  stallLog?: boolean;
  /**
   * FEATURE_102 Phase 3 (v0.7.45) — ordered cross-provider fallback chain for
   * child dispatch. When a child's primary provider is exhausted/down, the
   * runtime re-runs it on the next provider here. Empty/absent = OFF. Mirrored
   * to env var `KODAX_FALLBACK_PROVIDERS` (comma-separated) for the coding
   * layer, which has no config access. Set via the `/fallback` command.
   */
  fallbackProviders?: string[];
} {
  try {
    if (fsSync.existsSync(KODAX_CONFIG_FILE)) {
      const parsed = JSON.parse(fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf-8')) as {
        provider?: string;
        model?: string;
        effort?: string;
        planModeEffort?: string;
        thinking?: boolean;
        reasoningMode?: KodaXReasoningMode;
        reasoningCeiling?: KodaXReasoningMode;
        agentMode?: KodaXAgentMode;
        permissionMode?: string;
        locale?: string;
        providerModels?: Record<string, string[]>;
        customProviders?: KodaXCustomProviderConfig[];
        extensions?: unknown;
        mcpServers?: KodaXMcpServersConfig;
        repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
        repoIntelligenceTrace?: boolean;
        streamIdleTimeoutMs?: number;
        verifierLog?: boolean;
        stallLog?: boolean;
        fallbackProviders?: string[];
      };
      // FEATURE_078: collapse `reasoningCeiling` (preferred) onto
      // `reasoningMode` so existing call sites that read
      // `options.reasoningMode` keep working unchanged. When both are
      // present we trust `reasoningCeiling` — that's the deliberately
      // named L1 ceiling field, and the legacy `reasoningMode` is
      // typically left over from older configs the user forgot about.
      const collapsedReasoning: KodaXReasoningMode | undefined =
        parsed.reasoningCeiling ?? parsed.reasoningMode;
      return migrateAutoInProjectAliasInConfig(
        migrateLegacyPermissionModeInConfig({
          ...parsed,
          reasoningMode: collapsedReasoning,
          extensions: normalizeConfiguredExtensions(parsed.extensions),
        }),
      );
    }
  } catch {
    // Unreadable user config should fall back to defaults instead of breaking startup.
  }
  return {};
}

function applyResilienceRuntimeEnv(config: ReturnType<typeof loadConfig>): void {
  // streamIdleTimeoutMs: config.json → env var → read by resilience/config.ts
  // Env var takes precedence over config.json (set first, check before overwrite).
  if (config.streamIdleTimeoutMs && !process.env.KODAX_STREAM_IDLE_TIMEOUT_MS) {
    process.env.KODAX_STREAM_IDLE_TIMEOUT_MS = String(config.streamIdleTimeoutMs);
  }
}

function applyRepoIntelligenceRuntimeEnv(config: ReturnType<typeof loadConfig>): void {
  if (config.repoIntelligenceMode && !process.env.KODAX_REPO_INTELLIGENCE) {
    process.env.KODAX_REPO_INTELLIGENCE = config.repoIntelligenceMode;
  }
  if (config.repoIntelligenceTrace === true && !process.env.KODAX_REPO_INTELLIGENCE_TRACE) {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
  }
}

/**
 * FEATURE_184 Phase D.3 follow-up (v0.7.42) — propagate the user-config
 * `verifierLog` boolean to the runtime env var the coding layer reads.
 * Env wins when both are set (mirrors `applyResilienceRuntimeEnv` /
 * `applyRepoIntelligenceRuntimeEnv` precedence — env-set-first means
 * a developer can override via shell without editing config).
 */
function applyVerifierRuntimeEnv(config: ReturnType<typeof loadConfig>): void {
  if (config.verifierLog === true && !process.env.KODAX_VERIFIER_LOG) {
    process.env.KODAX_VERIFIER_LOG = '1';
  }
}

/**
 * FEATURE_187 Phase C (v0.7.43) — propagate the user-config
 * `stallLog` boolean to `KODAX_STALL_LOG=1` env. Same env-wins
 * precedence as the verifier counterpart.
 */
function applyStallSidecarRuntimeEnv(config: ReturnType<typeof loadConfig>): void {
  if (config.stallLog === true && !process.env.KODAX_STALL_LOG) {
    process.env.KODAX_STALL_LOG = '1';
  }
}

/**
 * FEATURE_102 Phase 3 (v0.7.45) — propagate the user-config
 * `fallbackProviders` chain to `KODAX_FALLBACK_PROVIDERS` (comma-separated)
 * for the coding layer's child-fallback resolver. Same env-wins precedence as
 * the verifier/stall counterparts.
 */
function applyFallbackRuntimeEnv(config: ReturnType<typeof loadConfig>): void {
  const chain = config.fallbackProviders?.filter((entry) => entry.trim().length > 0) ?? [];
  if (chain.length > 0 && !process.env.KODAX_FALLBACK_PROVIDERS) {
    process.env.KODAX_FALLBACK_PROVIDERS = chain.join(',');
  }
}

export function prepareRuntimeConfig(): ReturnType<typeof loadConfig> {
  ensureShellEnvironmentHydrated();
  const config = loadConfig();
  applyResilienceRuntimeEnv(config);
  applyRepoIntelligenceRuntimeEnv(config);
  applyVerifierRuntimeEnv(config);
  applyStallSidecarRuntimeEnv(config);
  applyFallbackRuntimeEnv(config);
  registerConfiguredCustomProviders(config);
  // Initialize i18n locale from config (falls back to system LANG)
  setLocale(config.locale);
  return config;
}

// Save config to ~/.kodax/config.json
export function saveConfig(config: {
  provider?: string;
  model?: string;
  effort?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  permissionMode?: string;
  locale?: string;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
  extensions?: string[];
  mcpServers?: KodaXMcpServersConfig;
  repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  repoIntelligenceTrace?: boolean;
  /** FEATURE_184 Phase D.3 follow-up — opt-in verifier log line. */
  verifierLog?: boolean;
  /** FEATURE_187 Phase C — opt-in stall sidecar log line. */
  stallLog?: boolean;
  /** FEATURE_102 Phase 3 — cross-provider child fallback chain. */
  fallbackProviders?: string[];
}): void {
  const current = loadConfig();
  const merged = { ...current, ...config };
  const normalizedExtensions = normalizeConfiguredExtensions(merged.extensions);
  if (normalizedExtensions !== undefined) {
    merged.extensions = normalizedExtensions;
  }
  // Remove fields explicitly set to undefined (e.g. clearing model when switching provider)
  for (const key of Object.keys(config) as Array<keyof typeof config>) {
    if (config[key] === undefined) {
      delete (merged as Record<string, unknown>)[key];
    }
  }
  fsSync.mkdirSync(path.dirname(KODAX_CONFIG_FILE), { recursive: true });
  fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

/**
 * Reconstruct `effortOverride` at startup. A persisted `config.effort` only
 * ever comes from an explicit choice (Ctrl+T / `/effort <value>`; clearing to
 * auto deletes the field), so a present config effort must restore as an
 * override — otherwise the round-tripped value is mis-read as a session
 * default and the Ctrl+T position detector treats it as `auto`. The CLI
 * `--effort` flag also forces an override for the launched session.
 */
export function resolveInitialEffortOverride(
  options: { effort?: string },
  config: { effort?: string },
): boolean {
  return options.effort !== undefined || config.effort !== undefined;
}

export function resolvePermissionModeEffort(config: {
  effort?: string;
  effortOverride?: boolean;
  permissionMode?: string;
  planModeEffort?: string;
}): string | undefined {
  if (
    config.permissionMode === 'plan'
    && config.effortOverride !== true
    && config.planModeEffort !== undefined
  ) {
    return config.planModeEffort;
  }
  return config.effort;
}

/**
 * Get git root directory.
 *
 * v0.7.46 fix — accepts optional `cwd` so in-process SDK embedders (KodaX
 * Space) that serve multiple projects from a single runtime can resolve
 * the git root of the project the user opened, NOT the embedder's
 * startup directory. Without `cwd`, `git rev-parse --show-toplevel`
 * inherits the host process's cwd, which mis-tags storage operations
 * for multi-project embedders (the same root cause as the
 * `saveSessionSnapshot` gitRoot bug in agent-runtime/middleware/ shipped in v0.7.45).
 *
 * No `cwd` arg → behaves identically to the pre-v0.7.46 form
 * (process.cwd() of the host).
 */
export async function getGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function formatProviderSourceKind(
  sourceKind: KodaXProviderCapabilitySnapshot['sourceKind'],
): string {
  switch (sourceKind) {
    case 'builtin':
      return 'Built-in';
    case 'runtime':
      return 'Runtime extension';
    case 'custom':
      return 'Custom config';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

export function formatProviderCapabilityDetailLines(
  snapshot: KodaXProviderCapabilitySnapshot,
): string[] {
  const transport =
    snapshot.transport === 'cli-bridge' ? 'CLI bridge' : 'Native API';
  const conversation =
    snapshot.conversationSemantics === 'last-user-message'
      ? 'latest-user-message only'
      : 'full conversation history';

  return [
    `Source: ${formatProviderSourceKind(snapshot.sourceKind)}`,
    `Transport: ${transport}`,
    `Conversation semantics: ${conversation}`,
    `Context fidelity: ${snapshot.contextFidelity}`,
    `Tool calling: ${snapshot.toolCallingFidelity}`,
    `Session behavior: ${snapshot.sessionSupport}`,
    `Long-running support: ${snapshot.longRunningSupport}`,
    `Evidence-heavy flows: ${snapshot.evidenceSupport}`,
    `Multimodal support: ${snapshot.multimodalSupport}`,
    `MCP support: ${snapshot.mcpSupport}`,
    `Reasoning control: ${describeReasoningCapabilityControl(snapshot.reasoningCapability)}`,
  ];
}

export function getProviderCommonPolicyScenarios(
  name: string,
  model: string | undefined,
  reasoningMode: KodaXReasoningMode,
): Array<{ label: string; decision: KodaXProviderPolicyDecision }> {
  const scenarios: Array<{
    label: string;
    hints: KodaXProviderPolicyHints;
  }> = [
    { label: 'General coding', hints: {} },
    { label: 'Evidence-heavy review', hints: { evidenceHeavy: true } },
    { label: 'Long-running task', hints: { longRunning: true } },
  ];

  return scenarios
    .map((scenario) => ({
      label: scenario.label,
      decision: getProviderPolicyDecision(
        name,
        model,
        reasoningMode,
        scenario.hints,
      ),
    }))
    .filter(
      (
        scenario,
      ): scenario is { label: string; decision: KodaXProviderPolicyDecision } =>
        scenario.decision !== null,
    );
}

// API rate limiting - API 速率限制
const KODAX_API_MIN_INTERVAL = 0.5;
let lastApiCallTime = 0;
const apiLock = { locked: false, queue: [] as (() => void)[] };

export async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  while (apiLock.locked) {
    await new Promise<void>(resolve => apiLock.queue.push(resolve));
  }
  apiLock.locked = true;
  try {
    const elapsed = (Date.now() - lastApiCallTime) / 1000;
    if (elapsed < KODAX_API_MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, (KODAX_API_MIN_INTERVAL - elapsed) * 1000));
    }
    const result = await fn();
    lastApiCallTime = Date.now();
    return result;
  } finally {
    apiLock.locked = false;
    const next = apiLock.queue.shift();
    if (next) next();
  }
}
