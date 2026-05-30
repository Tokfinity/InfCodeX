/**
 * FEATURE_200 Phase F (v0.7.45) — repo-intelligence domain types extracted
 * from types.ts. Self-contained; re-exported from ../types.ts (and 4 members
 * re-imported there for internal use). `../types` importers unaffected.
 */

export type KodaXRepoIntelligenceMode =
  | 'auto'
  | 'off'
  | 'oss'
  | 'premium-shared'
  | 'premium-native';

export type KodaXRepoIntelligenceResolvedMode =
  | 'off'
  | 'oss'
  | 'premium-shared'
  | 'premium-native';

export interface KodaXRepoIntelligenceCapability {
  mode: KodaXRepoIntelligenceResolvedMode;
  engine: 'oss' | 'premium';
  bridge: 'none' | 'shared' | 'native';
  level: 'basic' | 'enhanced';
  status: 'ok' | 'limited' | 'unavailable' | 'warming';
  warnings: string[];
  contractVersion?: number;
}

export interface KodaXRepoIntelligenceTrace {
  mode: KodaXRepoIntelligenceResolvedMode;
  engine: 'oss' | 'premium';
  bridge: 'none' | 'shared' | 'native';
  triggeredAt: string;
  source: 'fallback' | 'premium';
  daemonLatencyMs?: number;
  cliLatencyMs?: number;
  cacheHit?: boolean;
  capsuleBytes?: number;
  capsuleEstimatedTokens?: number;
}

/**
 * Repo-intelligence retrieval trace event. Emitted by agent / managed-task
 * pipelines (`emitRepoIntelligenceTrace` / `emitManagedRepoIntelligenceTrace`)
 * at `routing` / `preturn` / `module` / `impact` / `task-snapshot` stages,
 * consumed by REPL `json-events` (stdout JSONL contract), `cli-events`
 * (interactive REPL), and `acp_server`.
 *
 * Note: FEATURE_083 (v0.7.24) initially marked this as superseded by
 * `EvidenceSpan` in `@kodax-ai/agent`. **FEATURE_086 (v0.7.27) re-evaluated
 * and retained it**: `EvidenceSpanData` is a generic
 * `{ source, queryPreview?, resultCount?, cacheHit?, error? }` abstraction
 * that does not carry the repo-intelligence-specific `stage` enum,
 * `capability`, or `trace` bundle. The `stage` enum in particular is a
 * typed contract that UI consumers (json-events schema) depend on;
 * flattening it into a bag of attributes would drop type safety and break
 * downstream script compatibility. This type is therefore a product
 * feature of repo-intelligence, not legacy trace plumbing.
 */
export interface KodaXRepoIntelligenceTraceEvent {
  stage: 'routing' | 'preturn' | 'module' | 'impact' | 'task-snapshot';
  summary: string;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXRepoIntelligenceCarrier {
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}
