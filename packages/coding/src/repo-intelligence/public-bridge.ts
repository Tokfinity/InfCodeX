export {
  analyzeChangedScopeFromSnapshot,
  buildRepoIntelligenceContext,
  collectWorkspaceFilesForSource,
  resolveRepoOverviewSnapshot,
} from './index.js';

export type {
  ChangedScopeReport,
  RepoAreaKind,
  RepoAreaOverview,
  RepoOverview,
  RepoOverviewInventory,
  RepoOverviewSnapshot,
} from './index.js';

export {
  debugLogRepoIntelligence,
  withRepoIntelligenceStorageDir,
  resolveRepoIntelligenceStorageDir,
  safeReadJson,
} from './internal.js';

export type {
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceTrace,
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
