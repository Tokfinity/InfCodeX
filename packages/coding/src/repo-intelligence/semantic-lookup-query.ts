import type {
  ModuleCapsule,
  ProcessCapsule,
  RepoIntelligenceIndex,
  RepoSymbolRecord,
} from './semantic-types.js';
import type { KodaXRepoIntelligenceCapability } from './public-bridge.js';

export type SemanticLookupKind = 'auto' | 'symbol' | 'module' | 'process';

export interface SemanticLookupItem {
  title: string;
  locator: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | boolean | undefined>;
}

export interface SemanticLookupArtifact {
  kind: 'symbol' | 'module' | 'process';
  label: string;
  value: string;
}

export interface SemanticLookupResult {
  items: SemanticLookupItem[];
  artifacts: SemanticLookupArtifact[];
  generatedAt: string;
  sourceFileCount: number;
  capabilityEngine?: string;
  capability?: KodaXRepoIntelligenceCapability;
}

function scoreCandidate(query: string, ...candidates: Array<string | undefined>): number {
  const normalizedQuery = query.trim().toLowerCase();
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = candidate.toLowerCase();
    if (normalized === normalizedQuery) {
      best = Math.max(best, 1);
      continue;
    }
    if (normalized.startsWith(normalizedQuery)) {
      best = Math.max(best, 0.92);
      continue;
    }
    if (normalized.includes(normalizedQuery)) {
      best = Math.max(best, 0.78);
      continue;
    }
    const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryParts.length > 0 && queryParts.every((part) => normalized.includes(part))) {
      best = Math.max(best, 0.66);
    }
  }
  return best;
}

function buildSymbolItem(
  symbol: RepoSymbolRecord,
  score: number,
): { item: SemanticLookupItem; artifact: SemanticLookupArtifact } {
  return {
    item: {
      title: `${symbol.name} (${symbol.kind})`,
      locator: `${symbol.filePath}:${symbol.line}`,
      snippet: symbol.signature,
      score,
      metadata: {
        kind: 'symbol',
        moduleId: symbol.moduleId,
        exported: symbol.exported,
        confidence: symbol.confidence,
      },
    },
    artifact: {
      kind: 'symbol',
      label: symbol.qualifiedName,
      value: `${symbol.filePath}:${symbol.line}`,
    },
  };
}

function buildModuleItem(
  module: ModuleCapsule,
  score: number,
): { item: SemanticLookupItem; artifact: SemanticLookupArtifact } {
  return {
    item: {
      title: module.label,
      locator: module.root,
      snippet: `Module ${module.moduleId} with ${module.symbolCount} symbols and ${module.sourceFileCount} source files.`,
      score,
      metadata: {
        kind: 'module',
        moduleId: module.moduleId,
        confidence: module.confidence,
      },
    },
    artifact: {
      kind: 'module',
      label: module.label,
      value: module.root,
    },
  };
}

function buildProcessItem(
  process: ProcessCapsule,
  score: number,
): { item: SemanticLookupItem; artifact: SemanticLookupArtifact } {
  return {
    item: {
      title: process.label,
      locator: process.entryFile,
      snippet: process.summary,
      score,
      metadata: {
        kind: 'process',
        moduleId: process.moduleId,
        confidence: process.confidence,
      },
    },
    artifact: {
      kind: 'process',
      label: process.label,
      value: process.entryFile,
    },
  };
}

export function collectSemanticLookupItems(
  index: RepoIntelligenceIndex,
  query: string,
  kind: SemanticLookupKind,
  limit: number,
): SemanticLookupResult {
  const matches: Array<{
    score: number;
    item: SemanticLookupItem;
    artifact: SemanticLookupArtifact;
  }> = [];

  if (kind === 'auto' || kind === 'symbol') {
    for (const symbol of index.symbols) {
      const score = scoreCandidate(query, symbol.name, symbol.qualifiedName, symbol.filePath, symbol.signature);
      if (score > 0) {
        matches.push({ score, ...buildSymbolItem(symbol, score) });
      }
    }
  }

  if (kind === 'auto' || kind === 'module') {
    for (const module of index.modules) {
      const score = scoreCandidate(query, module.label, module.moduleId, module.root, ...module.topSymbols);
      if (score > 0) {
        matches.push({ score, ...buildModuleItem(module, score) });
      }
    }
  }

  if (kind === 'auto' || kind === 'process') {
    for (const process of index.processes) {
      const score = scoreCandidate(query, process.label, process.entryFile, process.entrySymbol, process.summary);
      if (score > 0) {
        matches.push({ score, ...buildProcessItem(process, score) });
      }
    }
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.item.title.localeCompare(right.item.title);
  });

  const limited = matches.slice(0, limit);
  return {
    items: limited.map((entry) => entry.item),
    artifacts: limited.map((entry) => entry.artifact),
    generatedAt: index.generatedAt,
    sourceFileCount: index.sourceFileCount,
    capabilityEngine: index.capability?.engine,
  };
}
