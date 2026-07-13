/**
 * FEATURE_093 (v0.7.24): minimal contract interfaces for the coding extension
 * runtime. Extracted so `@kodax-ai/coding/src/types.ts` can reference the
 * extension runtime at the type level without importing `./extensions/runtime.js`,
 * which in turn imports from `types.ts` — a cycle that lasted since v0.7.20.
 *
 * Scope: the capability methods that tool execution consumes, plus optional
 * session lifecycle hooks that the coding run loop uses when the runtime
 * supports them.
 *
 * File must have NO imports from `../types.js` (that is the cycle we are
 * breaking). Shared capability/session value types come from `@kodax-ai/agent`.
 */

import type {
  CapabilityKind,
  CapabilityResult,
  KodaXExtensionSessionRecord,
  KodaXJsonValue,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXWireReasoningEffort,
} from '@kodax-ai/llm';

export interface ExtensionRuntimeModelSelection {
  provider?: string;
  model?: string;
}

export interface RuntimeDefaultsSnapshot {
  activeTools?: string[];
  modelSelection: ExtensionRuntimeModelSelection;
  thinkingLevel?: KodaXWireReasoningEffort;
}

export interface BoundExtensionRuntimeController {
  queueUserMessage(message: string | KodaXMessage): void;
  getSessionState<T = KodaXJsonValue>(extensionId: string, key: string): T | undefined;
  setSessionState(extensionId: string, key: string, value: KodaXJsonValue | undefined): void;
  getSessionStateSnapshot(extensionId: string): Record<string, KodaXJsonValue>;
  appendSessionRecord(
    extensionId: string,
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ): KodaXExtensionSessionRecord;
  listSessionRecords(extensionId: string, type?: string): KodaXExtensionSessionRecord[];
  clearSessionRecords(extensionId: string, type?: string): number;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getModelSelection(): ExtensionRuntimeModelSelection;
  setModelSelection(next: ExtensionRuntimeModelSelection): void;
  getThinkingLevel(): KodaXWireReasoningEffort | undefined;
  setThinkingLevel(level: KodaXWireReasoningEffort): void;
}

export interface CapabilityRuntimeContract {
  hasCapabilityProvider?(providerId: string): boolean;
  searchCapabilities(
    providerId: string,
    query: string,
    options?: { kind?: CapabilityKind; limit?: number; server?: string },
  ): Promise<unknown[]>;

  describeCapability(providerId: string, capabilityId: string): Promise<unknown>;

  executeCapability(
    providerId: string,
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<CapabilityResult>;

  readCapability(
    providerId: string,
    capabilityId: string,
    options?: Record<string, unknown>,
  ): Promise<CapabilityResult>;

  getCapabilityPrompt(
    providerId: string,
    capabilityId: string,
    args?: Record<string, unknown>,
  ): Promise<unknown>;

  getCapabilityPromptContext(providerId: string): Promise<string | undefined>;
}

export interface ExtensionRuntimeContract extends CapabilityRuntimeContract {
  getDefaults?(): RuntimeDefaultsSnapshot;
  bindController?(controller: BoundExtensionRuntimeController): (() => void) | void;
  hydrateSession?(sessionId: string): Promise<void>;
}
