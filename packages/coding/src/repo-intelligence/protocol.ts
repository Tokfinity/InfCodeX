/**
 * KodaX Repo-Intelligence Protocol
 *
 * RPC contract types for repo-intelligence daemon requests/responses.
 *
 * FEATURE_194 (v0.7.43): inlined from former `@kodax-ai/repointel-protocol`
 * package. The original "multi-host (kodax/codex/claude/opencode)" intent
 * had 0 external consumers — the only consumers were sibling files in
 * `packages/coding/src/repo-intelligence/`. Per YAGNI / CLAUDE.md "3+ use
 * cases" rule, the standalone-package abstraction was premature; if a
 * future host genuinely needs the contract, re-extracting these 69 LoC
 * is ~30 min of work.
 */

export const REPOINTEL_CONTRACT_VERSION = 1 as const;
export const REPOINTEL_DEFAULT_ENDPOINT = 'http://127.0.0.1:47891';

export type RepoIntelligenceHost = 'kodax' | 'codex' | 'claude' | 'opencode';
export type RepoIntelligenceIntent = 'auto' | 'review' | 'edit' | 'plan' | 'explain';
export type RepointelCommand =
  | 'preturn'
  | 'context-pack'
  | 'impact'
  | 'symbol'
  | 'process'
  | 'status'
  | 'warm';

export interface RepointelRequestPayload {
  workspaceRoot?: string;
  executionCwd?: string;
  gitRoot?: string;
  targetPath?: string;
  refresh?: boolean;
  host?: RepoIntelligenceHost;
  intent?: RepoIntelligenceIntent;
  budget?: number;
  module?: string;
  symbol?: string;
  entry?: string;
  path?: string;
}

export interface RepointelRpcRequest {
  contractVersion: typeof REPOINTEL_CONTRACT_VERSION;
  buildId?: string;
  command: RepointelCommand;
  payload: RepointelRequestPayload;
}

export interface RepointelRpcResponse {
  contractVersion: number;
  buildId?: string;
  status: 'ok' | 'limited' | 'unavailable' | 'warming';
  warnings?: string[];
  error?: string;
  cacheHit?: boolean;
  result?: unknown;
  trace?: {
    daemonLatencyMs?: number;
    capsuleBytes?: number;
    capsuleEstimatedTokens?: number;
  };
}

export interface RepoPreturnBundle {
  routingSignals?: unknown;
  moduleContext?: unknown;
  impactEstimate?: unknown;
  repoContext?: string;
  summary?: string;
  recommendedFiles?: string[];
  lowConfidence?: boolean;
}
