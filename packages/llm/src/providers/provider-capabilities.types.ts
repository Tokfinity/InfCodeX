/**
 * FEATURE_198 v0.7.44 — Provider capability JSON schema + validator.
 *
 * Backs `KODAX_PROVIDER_SNAPSHOTS` with a separate JSON file so KodaX
 * consumers can hot-patch capability data (context window, max output
 * tokens, model lists) without waiting for a KodaX release.
 *
 * Hand-rolled validator (no zod) — single schema, lightweight package,
 * aligns with the "no new deps unless 3+ use cases" rule. Validator
 * fails loudly with the field path so manual JSON edits surface clearly.
 */

import type {
  KodaXModelDescriptor,
  KodaXProviderCapabilityProfile,
  KodaXReasoningCapability,
  KodaXVerifyStrategy,
} from '../types.js';

/**
 * Capability profile names that the loader resolves to the concrete
 * profile objects exported from `capability-profile.ts`. JSON keeps a
 * string name (debugger-friendly, hot-patch-stable) instead of inlining
 * the full profile object, which would balloon the file and duplicate
 * the shape defined in `capability-profile.ts`.
 */
export type CapabilityProfileName =
  | 'native'
  | 'image-input-native'
  | 'cli-bridge'
  | 'image-input-cli-bridge';

/**
 * JSON shape for a single provider entry. Mirrors the in-memory
 * `ProviderSnapshot` (registry.ts) one-to-one, except:
 *  - `capabilityProfile` is a name (string) the loader resolves
 *  - `cliBridge: true` opts the entry into runtime fill of `model` and
 *    `models` from `cli-bridge-models.ts` (gemini-cli / codex-cli)
 *  - `cliBridge` entries OMIT `model` / `models` from the JSON since
 *    those are owned by the local CLI binary, not KodaX metadata
 */
export interface ProviderCapabilityJsonEntry {
  readonly apiKeyEnv: string;
  readonly model?: string;
  readonly models?: ReadonlyArray<KodaXModelDescriptor>;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: CapabilityProfileName;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly thinkingBudgetCap?: number;
  readonly supportsThinking?: boolean;
  /** When true, loader injects `model` + `models` from cli-bridge-models.ts. */
  readonly cliBridge?: boolean;
  /**
   * FEATURE_216 v0.7.45 — Verify primitive this provider uses for
   * credential checks. Required (no silent default) because the choice
   * is provider-empirical, not protocol-derived. cliBridge entries MUST
   * be 'unsupported' (CLI binary owns its own credentials).
   */
  readonly verifyStrategy: KodaXVerifyStrategy;
}

export interface ProviderCapabilitiesJson {
  readonly version: 1;
  readonly updatedAt: string;
  readonly providers: Readonly<Record<string, ProviderCapabilityJsonEntry>>;
}

/**
 * Resolved snapshot — what `KODAX_PROVIDER_SNAPSHOTS` callers see.
 * Identical shape to the legacy in-memory type so consumers are
 * unchanged.
 */
export interface ProviderSnapshot {
  readonly model: string;
  readonly models?: ReadonlyArray<KodaXModelDescriptor>;
  readonly apiKeyEnv: string;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: KodaXProviderCapabilityProfile;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly thinkingBudgetCap?: number;
  readonly supportsThinking?: boolean;
  /** FEATURE_216 v0.7.45 — verify primitive for this provider. */
  readonly verifyStrategy: KodaXVerifyStrategy;
}

const VALID_REASONING_CAPABILITIES: readonly KodaXReasoningCapability[] = [
  'none',
  'prompt-only',
  'native-effort',
  'native-budget',
  'native-toggle',
  'unknown',
];

const VALID_PROFILE_NAMES: readonly CapabilityProfileName[] = [
  'native',
  'image-input-native',
  'cli-bridge',
  'image-input-cli-bridge',
];

const VALID_VERIFY_STRATEGIES: readonly KodaXVerifyStrategy[] = [
  'count-tokens',
  'models-list',
  'minimal-message',
  'unsupported',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `provider-capabilities.json: ${path} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `provider-capabilities.json: ${path} must be a non-negative finite number`,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`provider-capabilities.json: ${path} must be a boolean`);
  }
  return value;
}

function requireReasoningCapability(
  value: unknown,
  path: string,
): KodaXReasoningCapability {
  if (
    typeof value !== 'string' ||
    !VALID_REASONING_CAPABILITIES.includes(value as KodaXReasoningCapability)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_REASONING_CAPABILITIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXReasoningCapability;
}

function requireProfileName(value: unknown, path: string): CapabilityProfileName {
  if (
    typeof value !== 'string' ||
    !VALID_PROFILE_NAMES.includes(value as CapabilityProfileName)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_PROFILE_NAMES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as CapabilityProfileName;
}

function requireVerifyStrategy(value: unknown, path: string): KodaXVerifyStrategy {
  if (
    typeof value !== 'string' ||
    !VALID_VERIFY_STRATEGIES.includes(value as KodaXVerifyStrategy)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_VERIFY_STRATEGIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXVerifyStrategy;
}

function validateModelDescriptor(
  raw: unknown,
  path: string,
): KodaXModelDescriptor {
  if (!isPlainObject(raw)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const id = requireString(raw.id, `${path}.id`);
  const displayName = optionalString(raw.displayName, `${path}.displayName`);
  const contextWindow = optionalNumber(raw.contextWindow, `${path}.contextWindow`);
  const maxOutputTokens = optionalNumber(
    raw.maxOutputTokens,
    `${path}.maxOutputTokens`,
  );
  const thinkingBudgetCap = optionalNumber(
    raw.thinkingBudgetCap,
    `${path}.thinkingBudgetCap`,
  );
  const replayReasoningContent = optionalBoolean(
    raw.replayReasoningContent,
    `${path}.replayReasoningContent`,
  );
  const strictThinkingSignature = optionalBoolean(
    raw.strictThinkingSignature,
    `${path}.strictThinkingSignature`,
  );
  const streamMaxDurationMs = optionalNumber(
    raw.streamMaxDurationMs,
    `${path}.streamMaxDurationMs`,
  );
  const reasoningCapability =
    raw.reasoningCapability === undefined
      ? undefined
      : requireReasoningCapability(
          raw.reasoningCapability,
          `${path}.reasoningCapability`,
        );
  const descriptor: KodaXModelDescriptor = { id };
  if (displayName !== undefined) descriptor.displayName = displayName;
  if (contextWindow !== undefined) descriptor.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) descriptor.maxOutputTokens = maxOutputTokens;
  if (thinkingBudgetCap !== undefined) {
    descriptor.thinkingBudgetCap = thinkingBudgetCap;
  }
  if (reasoningCapability !== undefined) {
    descriptor.reasoningCapability = reasoningCapability;
  }
  if (replayReasoningContent !== undefined) {
    descriptor.replayReasoningContent = replayReasoningContent;
  }
  if (strictThinkingSignature !== undefined) {
    descriptor.strictThinkingSignature = strictThinkingSignature;
  }
  if (streamMaxDurationMs !== undefined) {
    descriptor.streamMaxDurationMs = streamMaxDurationMs;
  }
  return descriptor;
}

function validateModelReasoningCapabilities(
  raw: unknown,
  path: string,
): Record<string, KodaXReasoningCapability> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const out: Record<string, KodaXReasoningCapability> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = requireReasoningCapability(value, `${path}.${key}`);
  }
  return out;
}

function validateProviderEntry(
  raw: unknown,
  name: string,
): ProviderCapabilityJsonEntry {
  if (!isPlainObject(raw)) {
    throw new Error(
      `provider-capabilities.json: providers.${name} must be an object`,
    );
  }
  const cliBridge = optionalBoolean(raw.cliBridge, `providers.${name}.cliBridge`);
  const apiKeyEnv = requireString(raw.apiKeyEnv, `providers.${name}.apiKeyEnv`);
  const reasoningCapability = requireReasoningCapability(
    raw.reasoningCapability,
    `providers.${name}.reasoningCapability`,
  );
  const capabilityProfile = requireProfileName(
    raw.capabilityProfile,
    `providers.${name}.capabilityProfile`,
  );
  const verifyStrategy = requireVerifyStrategy(
    raw.verifyStrategy,
    `providers.${name}.verifyStrategy`,
  );
  // cliBridge providers' credentials live in the CLI binary's own token
  // store, outside SDK reach — there is no HTTP primitive to probe.
  if (cliBridge && verifyStrategy !== 'unsupported') {
    throw new Error(
      `provider-capabilities.json: providers.${name} is a cliBridge entry but verifyStrategy="${verifyStrategy}" — must be "unsupported" (CLI binary owns credentials)`,
    );
  }
  const contextWindow = optionalNumber(
    raw.contextWindow,
    `providers.${name}.contextWindow`,
  );
  const maxOutputTokens = optionalNumber(
    raw.maxOutputTokens,
    `providers.${name}.maxOutputTokens`,
  );
  const thinkingBudgetCap = optionalNumber(
    raw.thinkingBudgetCap,
    `providers.${name}.thinkingBudgetCap`,
  );
  const supportsThinking = optionalBoolean(
    raw.supportsThinking,
    `providers.${name}.supportsThinking`,
  );
  const modelReasoningCapabilities = validateModelReasoningCapabilities(
    raw.modelReasoningCapabilities,
    `providers.${name}.modelReasoningCapabilities`,
  );

  // CLI-bridge providers MUST omit model/models — they're filled at load
  // time from the local CLI config. Static providers MUST provide model.
  const model = optionalString(raw.model, `providers.${name}.model`);
  if (cliBridge && (model !== undefined || raw.models !== undefined)) {
    throw new Error(
      `provider-capabilities.json: providers.${name} is a cliBridge entry but defines model/models — must be omitted (filled at load time)`,
    );
  }
  if (!cliBridge && model === undefined) {
    throw new Error(
      `provider-capabilities.json: providers.${name}.model is required (only cliBridge entries may omit)`,
    );
  }
  let models: ReadonlyArray<KodaXModelDescriptor> | undefined;
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      throw new Error(
        `provider-capabilities.json: providers.${name}.models must be an array`,
      );
    }
    models = raw.models.map((entry, index) =>
      validateModelDescriptor(entry, `providers.${name}.models[${index}]`),
    );
  }

  const entry: ProviderCapabilityJsonEntry = {
    apiKeyEnv,
    reasoningCapability,
    capabilityProfile,
    verifyStrategy,
  };
  if (model !== undefined) (entry as { model: string }).model = model;
  if (models !== undefined) (entry as { models: typeof models }).models = models;
  if (contextWindow !== undefined) {
    (entry as { contextWindow: number }).contextWindow = contextWindow;
  }
  if (maxOutputTokens !== undefined) {
    (entry as { maxOutputTokens: number }).maxOutputTokens = maxOutputTokens;
  }
  if (thinkingBudgetCap !== undefined) {
    (entry as { thinkingBudgetCap: number }).thinkingBudgetCap = thinkingBudgetCap;
  }
  if (supportsThinking !== undefined) {
    (entry as { supportsThinking: boolean }).supportsThinking = supportsThinking;
  }
  if (modelReasoningCapabilities !== undefined) {
    (
      entry as { modelReasoningCapabilities: typeof modelReasoningCapabilities }
    ).modelReasoningCapabilities = modelReasoningCapabilities;
  }
  if (cliBridge) {
    (entry as { cliBridge: boolean }).cliBridge = true;
  }
  return entry;
}

/**
 * Validate the parsed JSON object. Throws with a path-qualified error
 * on the first schema violation. Returns a structurally-typed clone
 * suitable for downstream resolution.
 */
export function validateProviderCapabilitiesJson(
  raw: unknown,
): ProviderCapabilitiesJson {
  if (!isPlainObject(raw)) {
    throw new Error('provider-capabilities.json: root must be an object');
  }
  if (raw.version !== 1) {
    throw new Error(
      `provider-capabilities.json: version must be 1, got ${JSON.stringify(raw.version)}`,
    );
  }
  const updatedAt = requireString(raw.updatedAt, 'updatedAt');
  if (!isPlainObject(raw.providers)) {
    throw new Error('provider-capabilities.json: providers must be an object');
  }
  const providers: Record<string, ProviderCapabilityJsonEntry> = {};
  for (const [name, entry] of Object.entries(raw.providers)) {
    providers[name] = validateProviderEntry(entry, name);
  }
  return { version: 1, updatedAt, providers };
}
