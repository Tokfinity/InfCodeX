import path from 'path';
import {
  resolveRepoOverviewSnapshot,
  debugLogRepoIntelligence,
  safeReadJson,
  type RepoOverviewSnapshot,
} from './public-bridge.js';
import type { KodaXToolExecutionContext } from './public-bridge.js';
import type { RepoIntelligenceIndex } from './semantic-types.js';
import {
  buildRepoIntelligencePreflight,
  collectSourceFileStateMap,
  collectSourceFileStates,
  hydrateCachedFileAnalysis,
  isTypeScriptLikeLanguage,
  serializeCachedFileAnalysisEntry,
} from './semantic-workspace.js';
import {
  analyzeSourceFilesForBuild,
  finalizeRepoIntelligenceBuildInputs,
  materializeRepoIntelligenceIndex,
  prepareRepoIntelligenceBuildInputsFromSnapshot,
} from './semantic-build-materialize.js';
import {
  DIRTY_SOURCE_HINT_FILE,
  FILE_ANALYSIS_INDEX_FILE,
  QUERY_INDEX_FILE,
  QUERY_MANIFEST_FILE,
  QUERY_SCHEMA_VERSION,
  computePathFingerprint,
  computeSourceFingerprint,
  getDirtySourcePathsForInputs,
  isCleanGitSnapshot,
  isDirtySourceHintPayload,
  isFileAnalysisIndexPayload,
  isRepoIntelligenceIndexPayload,
  isRepoIntelligenceManifestPayload,
  languageFromFile,
  normalizeRelativePath,
  sameWorkspaceSnapshot,
  writeJsonFileAtomic,
  type DirtySourceHintPayload,
  type FileAnalysis,
  type FileAnalysisIndexPayload,
  type RepoIntelligenceAnalysisProfile,
  type RepoIntelligenceManifest,
  type RepoIntelligencePreflight,
  type RepoIntelligenceWorkspaceInputs,
  type RepoSourceFileState,
} from './semantic-shared.js';

export async function buildRepoIntelligenceIndexFromInputs(
  inputs: RepoIntelligenceWorkspaceInputs,
): Promise<RepoIntelligenceIndex> {
  const sourceStates = await collectSourceFileStates(
    inputs.workspaceRoot,
    inputs.sourceFiles,
    inputs.areaByFile,
    inputs.overview.areas,
    inputs.analysisProfile,
  );
  const completeInputs = finalizeRepoIntelligenceBuildInputs(inputs, sourceStates);
  const analysisEntries = await analyzeSourceFilesForBuild(completeInputs, completeInputs.sourceFiles);
  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

export async function readRepoIntelligenceManifest(
  storageRoot: string,
): Promise<RepoIntelligenceManifest | null> {
  return safeReadJson<RepoIntelligenceManifest>(
    path.join(storageRoot, QUERY_MANIFEST_FILE),
    isRepoIntelligenceManifestPayload,
  );
}

export async function readFileAnalysisIndex(
  storageRoot: string,
): Promise<FileAnalysisIndexPayload | null> {
  return safeReadJson<FileAnalysisIndexPayload>(
    path.join(storageRoot, FILE_ANALYSIS_INDEX_FILE),
    isFileAnalysisIndexPayload,
  );
}

export async function readDirtySourceHint(
  storageRoot: string,
): Promise<DirtySourceHintPayload | null> {
  return safeReadJson<DirtySourceHintPayload>(
    path.join(storageRoot, DIRTY_SOURCE_HINT_FILE),
    isDirtySourceHintPayload,
  );
}

export function hasOwnAnalysisEntry(
  analyses: FileAnalysisIndexPayload['analyses'],
  filePath: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(analyses, filePath);
}

export function hasCompatibleIncrementalCache(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): boolean {
  return manifest.schemaVersion === QUERY_SCHEMA_VERSION
    && fileAnalysisIndex.schemaVersion === QUERY_SCHEMA_VERSION
    && manifest.workspaceRoot === inputs.workspaceRoot
    && fileAnalysisIndex.workspaceRoot === inputs.workspaceRoot
    && manifest.workspaceSnapshot.source === inputs.workspaceSnapshot.source
    && manifest.sourceStates.length === manifest.sourceFileCount
    && fileAnalysisIndex.sourceFingerprint === manifest.sourceFingerprint;
}

async function readCompatibleCachedQueryIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
): Promise<RepoIntelligenceIndex | null> {
  const cached = await safeReadJson<RepoIntelligenceIndex>(
    path.join(inputs.storageRoot, QUERY_INDEX_FILE),
    isRepoIntelligenceIndexPayload,
  );
  if (
    cached?.schemaVersion !== QUERY_SCHEMA_VERSION
    || cached.workspaceRoot !== inputs.workspaceRoot
    || cached.generatedAt !== manifest.generatedAt
    || cached.sourceFileCount !== manifest.sourceFileCount
    || cached.sourceFingerprint !== manifest.sourceFingerprint
  ) {
    return null;
  }
  return cached;
}

export function canDirectReuseCleanCachedQueryIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
): boolean {
  return isCleanGitSnapshot(inputs.workspaceSnapshot)
    && sameWorkspaceSnapshot(manifest.workspaceSnapshot, inputs.workspaceSnapshot)
    && manifest.overviewFingerprint === inputs.overviewFingerprint
    && manifest.sourceFileCount === inputs.sourceFiles.length;
}

export function canDirectReuseDirtyCachedQueryIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  dirtySourceHint: DirtySourceHintPayload | null,
): boolean {
  return Boolean(
    inputs.workspaceSnapshot.source === 'git'
      && inputs.workspaceSnapshot.hasUncommittedChanges === true
      && dirtySourceHint
      && dirtySourceHint.schemaVersion === QUERY_SCHEMA_VERSION
      && dirtySourceHint.workspaceRoot === inputs.workspaceRoot
      && dirtySourceHint.head === inputs.workspaceSnapshot.head
      && dirtySourceHint.branch === inputs.workspaceSnapshot.branch
      && dirtySourceHint.overviewFingerprint === inputs.overviewFingerprint
      && dirtySourceHint.sourceFileCount === inputs.sourceFiles.length
      && dirtySourceHint.dirtyPathsFingerprint === inputs.dirtyPathsFingerprint
      && dirtySourceHint.dirtySourceFingerprint === inputs.dirtySourceFingerprint,
  );
}

export async function tryDirectReuseCleanCachedQueryIndexFromPreflight(
  preflight: RepoIntelligencePreflight,
): Promise<RepoIntelligenceIndex | null> {
  if (!isCleanGitSnapshot(preflight.workspaceSnapshot)) {
    return null;
  }

  const manifest = await readRepoIntelligenceManifest(preflight.storageRoot);
  if (
    !manifest
    || manifest.schemaVersion !== QUERY_SCHEMA_VERSION
    || manifest.workspaceRoot !== preflight.workspaceRoot
    || !sameWorkspaceSnapshot(manifest.workspaceSnapshot, preflight.workspaceSnapshot)
    || manifest.overviewFingerprint !== preflight.overviewFingerprint
  ) {
    return null;
  }

  const cached = await safeReadJson<RepoIntelligenceIndex>(
    path.join(preflight.storageRoot, QUERY_INDEX_FILE),
    isRepoIntelligenceIndexPayload,
  );
  if (
    cached?.schemaVersion !== QUERY_SCHEMA_VERSION
    || cached.workspaceRoot !== preflight.workspaceRoot
    || cached.overviewGeneratedAt !== manifest.overviewGeneratedAt
    || cached.sourceFileCount !== manifest.sourceFileCount
    || cached.sourceFingerprint !== manifest.sourceFingerprint
  ) {
    return null;
  }

  return cached;
}

export async function tryDirectReuseDirtyCachedQueryIndexFromPreflight(
  preflight: RepoIntelligencePreflight,
): Promise<RepoIntelligenceIndex | null> {
  if (
    preflight.workspaceSnapshot.source !== 'git'
    || preflight.workspaceSnapshot.hasUncommittedChanges !== true
  ) {
    return null;
  }

  const dirtySourceHint = await readDirtySourceHint(preflight.storageRoot);
  if (
    !dirtySourceHint
    || dirtySourceHint.schemaVersion !== QUERY_SCHEMA_VERSION
    || dirtySourceHint.workspaceRoot !== preflight.workspaceRoot
    || dirtySourceHint.head !== preflight.workspaceSnapshot.head
    || dirtySourceHint.branch !== preflight.workspaceSnapshot.branch
    || dirtySourceHint.overviewFingerprint !== preflight.overviewFingerprint
    || dirtySourceHint.dirtyPathsFingerprint !== preflight.dirtyPathsFingerprint
    || dirtySourceHint.dirtySourceFingerprint !== preflight.dirtySourceFingerprint
  ) {
    return null;
  }

  const cached = await safeReadJson<RepoIntelligenceIndex>(
    path.join(preflight.storageRoot, QUERY_INDEX_FILE),
    isRepoIntelligenceIndexPayload,
  );
  if (
    cached?.schemaVersion !== QUERY_SCHEMA_VERSION
    || cached.workspaceRoot !== preflight.workspaceRoot
    || cached.generatedAt !== dirtySourceHint.queryGeneratedAt
    || cached.sourceFileCount !== dirtySourceHint.sourceFileCount
    || cached.sourceFingerprint !== dirtySourceHint.sourceFingerprint
  ) {
    return null;
  }

  return cached;
}

export function mapSourceStatesByFile(
  sourceStates: RepoSourceFileState[],
): Map<string, RepoSourceFileState> {
  return new Map(sourceStates.map((state) => [state.filePath, state]));
}

export function buildCompleteInputsFromSourceStates(
  inputs: RepoIntelligenceWorkspaceInputs,
  sourceStatesByFile: Map<string, RepoSourceFileState>,
): RepoIntelligenceWorkspaceInputs | null {
  const sourceStates = inputs.sourceFiles
    .map((filePath) => sourceStatesByFile.get(filePath))
    .filter((state): state is RepoSourceFileState => state !== undefined);

  if (sourceStates.length !== inputs.sourceFiles.length) {
    return null;
  }

  return finalizeRepoIntelligenceBuildInputs(inputs, sourceStates);
}

export function classifyChangedOrNewSourceFiles(
  sourceStates: RepoSourceFileState[],
  previousByFile: Map<string, RepoSourceFileState>,
): Set<string> | null {
  const changedOrNewFiles = new Set<string>();
  for (const state of sourceStates) {
    const previousState = previousByFile.get(state.filePath);
    if (!previousState) {
      changedOrNewFiles.add(state.filePath);
      continue;
    }
    if (previousState.analyzerVersion !== state.analyzerVersion) {
      return null;
    }
    if (
      previousState.fileFingerprint !== state.fileFingerprint
      || previousState.language !== state.language
      || previousState.moduleId !== state.moduleId
    ) {
      changedOrNewFiles.add(state.filePath);
    }
  }
  return changedOrNewFiles;
}

export async function buildIncrementalAnalysisEntries(
  inputs: RepoIntelligenceWorkspaceInputs,
  previousByFile: Map<string, RepoSourceFileState>,
  fileAnalysisIndex: FileAnalysisIndexPayload,
  changedOrNewFiles: Set<string>,
): Promise<Map<string, FileAnalysis | null> | null> {
  if (!inputs.sourceStates) {
    return null;
  }

  const sourceStatesByFile = mapSourceStatesByFile(inputs.sourceStates);
  const shouldReanalyzeTypeScript = inputs.analysisProfile === 'full' && Array.from(changedOrNewFiles).some((filePath) => {
    const state = sourceStatesByFile.get(filePath);
    return state ? isTypeScriptLikeLanguage(state.language) : false;
  });

  const filesToAnalyze = new Set<string>();
  for (const state of inputs.sourceStates) {
    if (shouldReanalyzeTypeScript && isTypeScriptLikeLanguage(state.language)) {
      filesToAnalyze.add(state.filePath);
      continue;
    }
    if (changedOrNewFiles.has(state.filePath)) {
      filesToAnalyze.add(state.filePath);
    }
  }

  const analysisEntries = new Map<string, FileAnalysis | null>();
  for (const state of inputs.sourceStates) {
    if (filesToAnalyze.has(state.filePath)) {
      continue;
    }
    if (!hasOwnAnalysisEntry(fileAnalysisIndex.analyses, state.filePath)) {
      return null;
    }
    analysisEntries.set(
      state.filePath,
      hydrateCachedFileAnalysis(
        state.filePath,
        state,
        fileAnalysisIndex.analyses[state.filePath] ?? null,
      ),
    );
  }

  if (filesToAnalyze.size > 0) {
    const freshAnalyses = await analyzeSourceFilesForBuild(
      inputs,
      inputs.sourceFiles.filter((filePath) => filesToAnalyze.has(filePath)),
    );
    for (const filePath of filesToAnalyze) {
      analysisEntries.set(filePath, freshAnalyses.get(filePath) ?? null);
    }
  }

  for (const state of inputs.sourceStates) {
    if (!analysisEntries.has(state.filePath)) {
      return null;
    }
    const analysis = analysisEntries.get(state.filePath) ?? null;
    if (
      analysis
      && (
        analysis.filePath !== state.filePath
        || analysis.moduleId !== state.moduleId
        || analysis.language !== state.language
      )
    ) {
      return null;
    }
    if (previousByFile.get(state.filePath)?.analyzerVersion !== undefined
      && previousByFile.get(state.filePath)?.analyzerVersion !== state.analyzerVersion) {
      return null;
    }
  }

  return analysisEntries;
}

export async function tryGitDirtyIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): Promise<RepoIntelligenceIndex | null> {
  if (
    inputs.workspaceSnapshot.source !== 'git'
    || inputs.workspaceSnapshot.hasUncommittedChanges !== true
    || manifest.workspaceSnapshot.source !== 'git'
    || inputs.workspaceSnapshot.head !== manifest.workspaceSnapshot.head
    || inputs.workspaceSnapshot.branch !== manifest.workspaceSnapshot.branch
  ) {
    return null;
  }

  const dirtyPaths = new Set(inputs.dirtyPaths ?? []);
  const dirtySourceHint = await readDirtySourceHint(inputs.storageRoot);
  const previousDirtySourcePaths = new Set(
    dirtySourceHint
    && dirtySourceHint.workspaceRoot === inputs.workspaceRoot
    && dirtySourceHint.head === inputs.workspaceSnapshot.head
    && dirtySourceHint.branch === inputs.workspaceSnapshot.branch
      ? dirtySourceHint.dirtySourcePaths
      : [],
  );
  const previousByFile = mapSourceStatesByFile(manifest.sourceStates);
  const sourceStateMap = new Map<string, RepoSourceFileState>();
  const filesNeedingFreshState = new Set<string>();
  const precomputedDirtyStates = inputs.dirtySourceStateMap ?? new Map<string, RepoSourceFileState>();

  for (const filePath of inputs.sourceFiles) {
    const previousState = previousByFile.get(filePath);
    if (!previousState) {
      if (!dirtyPaths.has(filePath)) {
        return null;
      }
      filesNeedingFreshState.add(filePath);
      continue;
    }

    if (dirtyPaths.has(filePath) || previousDirtySourcePaths.has(filePath)) {
      filesNeedingFreshState.add(filePath);
      continue;
    }

    sourceStateMap.set(filePath, previousState);
  }

  if (filesNeedingFreshState.size > 0) {
    const missingFreshStateFiles = new Set<string>();
    for (const filePath of filesNeedingFreshState) {
      const precomputedState = precomputedDirtyStates.get(filePath);
      if (precomputedState) {
        sourceStateMap.set(filePath, precomputedState);
        continue;
      }
      missingFreshStateFiles.add(filePath);
    }

    if (missingFreshStateFiles.size > 0) {
      const freshStates = await collectSourceFileStateMap(
        inputs.workspaceRoot,
        missingFreshStateFiles,
        inputs.areaByFile,
        inputs.overview.areas,
        inputs.analysisProfile,
      );
      for (const [filePath, state] of freshStates.entries()) {
        sourceStateMap.set(filePath, state);
      }
    }
  }

  const completeInputs = buildCompleteInputsFromSourceStates(inputs, sourceStateMap);
  if (!completeInputs?.sourceStates) {
    return null;
  }

  const changedOrNewFiles = classifyChangedOrNewSourceFiles(completeInputs.sourceStates, previousByFile);
  if (!changedOrNewFiles) {
    return null;
  }

  const analysisEntries = await buildIncrementalAnalysisEntries(
    completeInputs,
    previousByFile,
    fileAnalysisIndex,
    changedOrNewFiles,
  );
  if (!analysisEntries) {
    return null;
  }

  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

export async function tryStatBasedIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): Promise<RepoIntelligenceIndex | null> {
  const freshStateMap = await collectSourceFileStateMap(
    inputs.workspaceRoot,
    inputs.sourceFiles,
    inputs.areaByFile,
    inputs.overview.areas,
    inputs.analysisProfile,
  );
  const completeInputs = buildCompleteInputsFromSourceStates(inputs, freshStateMap);
  if (!completeInputs?.sourceStates) {
    return null;
  }

  const previousByFile = mapSourceStatesByFile(manifest.sourceStates);
  const changedOrNewFiles = classifyChangedOrNewSourceFiles(completeInputs.sourceStates, previousByFile);
  if (!changedOrNewFiles) {
    return null;
  }
  if (changedOrNewFiles.size === 0) {
    return readCompatibleCachedQueryIndex(completeInputs, manifest);
  }

  const analysisEntries = await buildIncrementalAnalysisEntries(
    completeInputs,
    previousByFile,
    fileAnalysisIndex,
    changedOrNewFiles,
  );
  if (!analysisEntries) {
    return null;
  }

  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

export async function tryIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest | null,
): Promise<RepoIntelligenceIndex | null> {
  if (!manifest) {
    return null;
  }
  const fileAnalysisIndex = await readFileAnalysisIndex(inputs.storageRoot);

  if (!fileAnalysisIndex) {
    return null;
  }

  if (!hasCompatibleIncrementalCache(inputs, manifest, fileAnalysisIndex)) {
    return null;
  }

  const gitDirtyResult = await tryGitDirtyIncrementalRepoIntelligenceBuild(inputs, manifest, fileAnalysisIndex);
  if (gitDirtyResult) {
    return gitDirtyResult;
  }

  return tryStatBasedIncrementalRepoIntelligenceBuild(inputs, manifest, fileAnalysisIndex);
}

export async function getRepoIntelligenceIndexFromInputs(
  inputs: RepoIntelligenceWorkspaceInputs,
  refresh = false,
): Promise<RepoIntelligenceIndex> {
  const manifest = !refresh
    ? await readRepoIntelligenceManifest(inputs.storageRoot)
    : null;
  const dirtySourceHint = !refresh && inputs.workspaceSnapshot.source === 'git' && inputs.workspaceSnapshot.hasUncommittedChanges === true
    ? await readDirtySourceHint(inputs.storageRoot)
    : null;

  if (
    manifest
    && canDirectReuseCleanCachedQueryIndex(inputs, manifest)
  ) {
    const cached = await safeReadJson<RepoIntelligenceIndex>(
      path.join(inputs.storageRoot, QUERY_INDEX_FILE),
      isRepoIntelligenceIndexPayload,
    );
    if (
      cached?.schemaVersion === QUERY_SCHEMA_VERSION
      && cached.workspaceRoot === inputs.workspaceRoot
      && cached.overviewGeneratedAt === manifest.overviewGeneratedAt
      && cached.sourceFileCount === manifest.sourceFileCount
      && cached.sourceFingerprint === manifest.sourceFingerprint
    ) {
      return cached;
    }
  }

  if (canDirectReuseDirtyCachedQueryIndex(inputs, dirtySourceHint)) {
    const cached = await safeReadJson<RepoIntelligenceIndex>(
      path.join(inputs.storageRoot, QUERY_INDEX_FILE),
      isRepoIntelligenceIndexPayload,
    );
    if (
      cached?.schemaVersion === QUERY_SCHEMA_VERSION
      && cached.workspaceRoot === inputs.workspaceRoot
      && cached.generatedAt === dirtySourceHint?.queryGeneratedAt
      && cached.sourceFileCount === dirtySourceHint.sourceFileCount
      && cached.sourceFingerprint === dirtySourceHint.sourceFingerprint
    ) {
      return cached;
    }
  }

  if (!refresh) {
    const incrementallyRebuilt = await tryIncrementalRepoIntelligenceBuild(inputs, manifest);
    if (incrementallyRebuilt) {
      return incrementallyRebuilt;
    }
  }

  return buildRepoIntelligenceIndexFromInputs(inputs);
}

export async function getRepoIntelligenceIndexFromSnapshot(
  snapshot: RepoOverviewSnapshot,
  refresh = false,
  profile: RepoIntelligenceAnalysisProfile = 'full',
): Promise<RepoIntelligenceIndex> {
  if (refresh) {
    const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot, { profile });
    return getRepoIntelligenceIndexFromInputs(inputs, true);
  }

  const preflight = await buildRepoIntelligencePreflight(snapshot, profile);
  const cleanCached = await tryDirectReuseCleanCachedQueryIndexFromPreflight(preflight);
  if (cleanCached) {
    return cleanCached;
  }

  const dirtyCached = await tryDirectReuseDirtyCachedQueryIndexFromPreflight(preflight);
  if (dirtyCached) {
    return dirtyCached;
  }

  const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot, {
    preflight,
  });
  return getRepoIntelligenceIndexFromInputs(inputs, false);
}

export async function buildRepoIntelligenceIndex(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean; profile?: RepoIntelligenceAnalysisProfile } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot, {
    profile: options.profile ?? 'full',
  });
  return buildRepoIntelligenceIndexFromInputs(inputs);
}

export async function getRepoIntelligenceIndex(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean; profile?: RepoIntelligenceAnalysisProfile } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  return getRepoIntelligenceIndexFromSnapshot(snapshot, options.refresh === true, options.profile ?? 'full');
}
