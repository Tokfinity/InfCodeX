import path from 'path';
import fs from 'fs/promises';
import type { RepoAreaOverview, RepoOverviewSnapshot } from './public-bridge.js';
import type { RepoLanguageId } from './semantic-types.js';
import {
  SOURCE_EXTENSIONS,
  analyzerVersionForLanguage,
  capabilityTierForLanguage,
  computeFileFingerprint,
  computeOverviewFingerprint,
  computePathFingerprint,
  computeSourceFingerprint,
  ensureStorageDir,
  exists,
  findAreaForFile,
  isDocFile,
  isTestFile,
  languageFromFile,
  normalizeRelativePath,
  type CachedFileAnalysisEntry,
  type FileAnalysis,
  type RepoIntelligenceAnalysisProfile,
  type RepoIntelligencePreflight,
  type RepoSourceFileState,
  type SourceFileBuckets,
  workspaceSnapshotFromOverview,
} from './semantic-shared.js';

export function buildAreaFileLookups(
  files: string[],
  areas: RepoAreaOverview[],
): {
  areaByFile: Map<string, RepoAreaOverview>;
  filesByAreaId: Map<string, string[]>;
  testFilesByAreaId: Map<string, string[]>;
  docFilesByAreaId: Map<string, string[]>;
} {
  const areaByFile = new Map<string, RepoAreaOverview>();
  const filesByAreaId = new Map<string, string[]>();
  const testFilesByAreaId = new Map<string, string[]>();
  const docFilesByAreaId = new Map<string, string[]>();

  for (const filePath of files) {
    const area = findAreaForFile(filePath, areas);
    areaByFile.set(filePath, area);

    const filesBucket = filesByAreaId.get(area.id) ?? [];
    filesBucket.push(filePath);
    filesByAreaId.set(area.id, filesBucket);

    if (isTestFile(filePath)) {
      const testsBucket = testFilesByAreaId.get(area.id) ?? [];
      testsBucket.push(filePath);
      testFilesByAreaId.set(area.id, testsBucket);
    }

    if (isDocFile(filePath)) {
      const docsBucket = docFilesByAreaId.get(area.id) ?? [];
      docsBucket.push(filePath);
      docFilesByAreaId.set(area.id, docsBucket);
    }
  }

  return {
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
  };
}

export async function buildRepoIntelligencePreflight(
  snapshot: RepoOverviewSnapshot,
  profile: RepoIntelligenceAnalysisProfile = 'full',
): Promise<RepoIntelligencePreflight> {
  const workspaceRoot = snapshot.workspaceRoot;
  const storageRoot = await ensureStorageDir(workspaceRoot, profile);
  const workspaceSnapshot = workspaceSnapshotFromOverview(snapshot.overview);
  const dirtyPaths = snapshot.dirtyPaths
    ? Array.from(new Set(snapshot.dirtyPaths.map((filePath) => normalizeRelativePath(filePath))))
      .sort((left, right) => left.localeCompare(right))
    : undefined;
  const dirtyPathsFingerprint = dirtyPaths
    ? computePathFingerprint(dirtyPaths)
    : undefined;
  const dirtySourcePaths = (dirtyPaths ?? [])
    .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
  const existingDirtySourcePaths: string[] = [];
  for (const filePath of dirtySourcePaths) {
    if (await exists(path.join(workspaceRoot, filePath))) {
      existingDirtySourcePaths.push(filePath);
    }
  }
  const dirtySourceStateMap = existingDirtySourcePaths.length > 0
    ? await collectSourceFileStateMap(
      workspaceRoot,
      existingDirtySourcePaths,
      new Map<string, RepoAreaOverview>(),
      snapshot.overview.areas,
      profile,
    )
    : undefined;

  return {
    analysisProfile: profile,
    workspaceRoot,
    storageRoot,
    workspaceSnapshot,
    overviewGeneratedAt: snapshot.overview.generatedAt,
    overviewFingerprint: computeOverviewFingerprint(
      snapshot.overview,
      snapshot.inventory?.allFiles ?? snapshot.overview.areas.flatMap((area) => area.sampleFiles),
    ),
    dirtyPaths,
    dirtyPathsFingerprint,
    dirtySourcePaths,
    dirtySourceStateMap,
    dirtySourceFingerprint: dirtyPaths
      ? computeSourceFingerprint(
        dirtySourceStateMap
          ? Array.from(dirtySourceStateMap.values()).sort((left, right) => left.filePath.localeCompare(right.filePath))
          : [],
      )
      : undefined,
  };
}

export async function collectSourceFileStates(
  workspaceRoot: string,
  sourceFiles: string[],
  areaByFile: Map<string, RepoAreaOverview>,
  overviewAreas: RepoAreaOverview[],
  profile: RepoIntelligenceAnalysisProfile = 'full',
): Promise<RepoSourceFileState[]> {
  const states: RepoSourceFileState[] = [];
  for (const filePath of sourceFiles) {
    const normalizedFilePath = normalizeRelativePath(filePath);
    const stat = await fs.stat(path.join(workspaceRoot, normalizedFilePath));
    const language = languageFromFile(normalizedFilePath);
    states.push({
      filePath: normalizedFilePath,
      fileFingerprint: computeFileFingerprint(normalizedFilePath, stat.size, stat.mtimeMs),
      language,
      moduleId: areaByFile.get(normalizedFilePath)?.id ?? findAreaForFile(normalizedFilePath, overviewAreas).id,
      analyzerVersion: analyzerVersionForLanguage(language, profile),
    });
  }
  return states.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export async function collectSourceFileStateMap(
  workspaceRoot: string,
  sourceFiles: Iterable<string>,
  areaByFile: Map<string, RepoAreaOverview>,
  overviewAreas: RepoAreaOverview[],
  profile: RepoIntelligenceAnalysisProfile = 'full',
): Promise<Map<string, RepoSourceFileState>> {
  const normalizedFiles = Array.from(new Set(
    Array.from(sourceFiles, (filePath) => normalizeRelativePath(filePath)),
  )).sort((left, right) => left.localeCompare(right));
  const states = await collectSourceFileStates(workspaceRoot, normalizedFiles, areaByFile, overviewAreas, profile);
  return new Map(states.map((state) => [state.filePath, state]));
}

export function serializeCachedFileAnalysisEntry(analysis: FileAnalysis | null): CachedFileAnalysisEntry | null {
  if (!analysis) {
    return null;
  }

  return {
    importPaths: analysis.importPaths,
    symbols: analysis.symbols.map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      line: symbol.line,
      signature: symbol.signature,
      exported: symbol.exported,
      calls: symbol.calls,
      confidence: symbol.confidence,
    })),
  };
}

export function hydrateCachedFileAnalysis(
  filePath: string,
  state: RepoSourceFileState,
  cached: CachedFileAnalysisEntry | null,
): FileAnalysis | null {
  if (!cached) {
    return null;
  }

  return {
    filePath,
    moduleId: state.moduleId,
    language: state.language,
    capabilityTier: capabilityTierForLanguage(state.language),
    importPaths: cached.importPaths,
    symbols: cached.symbols.map((symbol) => ({
      ...symbol,
      filePath,
      moduleId: state.moduleId,
      language: state.language,
      capabilityTier: capabilityTierForLanguage(state.language),
      importPaths: cached.importPaths,
      callTargets: [],
    })),
  };
}

export function bucketSourceFiles(sourceFiles: string[]): SourceFileBuckets {
  return {
    typeScriptFiles: sourceFiles.filter((filePath) => isTypeScriptLikeLanguage(languageFromFile(filePath))),
    pythonFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'python'),
    goFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'go'),
    rustFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'rust'),
    fallbackFiles: sourceFiles.filter((filePath) => {
      const language = languageFromFile(filePath);
      return !isTypeScriptLikeLanguage(language) && language !== 'python' && language !== 'go' && language !== 'rust';
    }),
  };
}

export function isTypeScriptLikeLanguage(language: RepoLanguageId): boolean {
  return language === 'typescript' || language === 'javascript';
}
