import fs from 'fs/promises';
import path from 'path';
import type { RepoAreaOverview } from './public-bridge.js';
import type {
  ModuleCapsule,
  ProcessCapsule,
  ProcessStep,
  RepoLanguageId,
  RepoSymbolRecord,
  RepoSymbolReference,
} from './semantic-types.js';
import {
  CALL_KEYWORDS,
  MAX_FILE_BYTES,
  MAX_PROCESS_STEPS,
  MAX_RELATED_RESULTS,
  MAX_SYMBOLS_PER_FILE,
  SOURCE_EXTENSIONS,
  baseConfidenceForTier,
  capabilityTierForLanguage,
  dedupeStrings,
  extractImports,
  findAreaForFile,
  languageFromFile,
  normalizeRelativePath,
  type ExtractedSymbol,
  type FileAnalysis,
} from './semantic-shared.js';
import {
  extractGoReceiverQualifier,
  normalizeRustQualifier,
} from './semantic-lezer-analyzer.js';

export function countOccurrences(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

export function countBraceDelta(value: string): number {
  return countOccurrences(value, /\{/g) - countOccurrences(value, /\}/g);
}

export function extractSymbolBody(
  lines: string[],
  language: RepoLanguageId,
  entry: ExtractedSymbol,
  allEntries: ExtractedSymbol[],
  index: number,
): string {
  const startIndex = Math.max(0, entry.line - 1);
  const fallbackEndLine = Math.max(entry.line, (allEntries[index + 1]?.line ?? (lines.length + 1)) - 1);

  if (language === 'python') {
    const declarationIndent = lines[startIndex]?.match(/^\s*/)?.[0]?.length ?? 0;
    let endIndex = startIndex + 1;
    while (endIndex < lines.length) {
      const line = lines[endIndex] ?? '';
      const trimmed = line.trim();
      if (!trimmed) {
        endIndex += 1;
        continue;
      }
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      if (indent <= declarationIndent && !trimmed.startsWith('#')) {
        break;
      }
      endIndex += 1;
    }
    return lines.slice(startIndex, endIndex).join('\n');
  }

  let braceDepth = 0;
  let openedBrace = false;
  let endIndex = startIndex;
  for (let cursor = startIndex; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? '';
    braceDepth += countBraceDelta(line);
    if (line.includes('{')) {
      openedBrace = true;
    }
    endIndex = cursor;
    if (openedBrace && braceDepth <= 0 && cursor > startIndex) {
      break;
    }
    if (!openedBrace && cursor + 1 >= fallbackEndLine) {
      break;
    }
  }

  const sliceEnd = openedBrace ? endIndex + 1 : fallbackEndLine;
  return lines.slice(startIndex, sliceEnd).join('\n');
}

export function extractCallNames(content: string): string[] {
  const names = new Set<string>();
  const patterns = [/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, /\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (!name || CALL_KEYWORDS.has(name)) {
        continue;
      }
      names.add(name);
      if (names.size >= 24) {
        break;
      }
    }
  }

  return Array.from(names);
}

export function pushSymbol(
  entries: ExtractedSymbol[],
  keySet: Set<string>,
  value: ExtractedSymbol,
): void {
  const key = `${value.line}:${value.kind}:${value.name}`;
  if (keySet.has(key)) {
    return;
  }
  keySet.add(key);
  entries.push(value);
}

export function extractSymbolsFromLines(lines: string[], language: RepoLanguageId): ExtractedSymbol[] {
  const entries: ExtractedSymbol[] = [];
  const keySet = new Set<string>();
  const javaContextStack: Array<{ name: string; depth: number }> = [];
  const cppContextStack: Array<{ name: string; depth: number }> = [];
  const rustContextStack: Array<{ name?: string; depth: number }> = [];
  let braceDepth = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let match: RegExpExecArray | null = null;
    if (language === 'typescript' || language === 'javascript') {
      match = /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.08,
        });
        continue;
      }

      match = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^=]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.06,
        });
        continue;
      }

      match = /^(export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
        ?? /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
        ?? /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(line)
        ?? /^(export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
      if (match) {
        const kind = line.includes('interface')
          ? 'interface'
          : line.includes('type ')
            ? 'type'
            : line.includes('enum ')
              ? 'enum'
              : 'class';
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind,
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.08,
        });
      }
      continue;
    }

    if (language === 'python') {
      match = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: !match[1]!.startsWith('_'),
          confidenceBoost: 0.08,
        });
        continue;
      }

      match = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'class',
          line: index + 1,
          signature: line,
          exported: !match[1]!.startsWith('_'),
          confidenceBoost: 0.08,
        });
      }
      continue;
    }

    if (language === 'go') {
      match = /^func\s+\(([^)]+)\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'method',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[2]!),
          confidenceBoost: 0.08,
          qualifier: extractGoReceiverQualifier(match[1]!),
        });
        continue;
      }

      match = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[1]!),
          confidenceBoost: 0.07,
        });
        continue;
      }

      match = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: line.includes('interface') ? 'interface' : 'struct',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[1]!),
          confidenceBoost: 0.07,
        });
      }
      continue;
    }

    if (language === 'rust') {
      const rustContext = rustContextStack[rustContextStack.length - 1];
      match = /^impl(?:<[^>]+>)?\s+(?:[A-Za-z0-9_:<&>\[\]]+\s+for\s+)?([A-Za-z_][A-Za-z0-9_:<>]*)/.exec(line);
      if (match) {
        const qualifier = normalizeRustQualifier(match[1]);
        rustContextStack.push({
          name: qualifier,
          depth: braceDepth + countBraceDelta(rawLine),
        });
      }

      match = /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: rustContext?.name ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: line.startsWith('pub '),
          confidenceBoost: rustContext?.name ? 0.07 : 0.06,
          qualifier: rustContext?.name,
        });
        braceDepth += countBraceDelta(rawLine);
        while (rustContextStack.length > 0 && braceDepth < (rustContextStack[rustContextStack.length - 1]?.depth ?? 0)) {
          rustContextStack.pop();
        }
        continue;
      }

      match = /^(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] as 'struct' | 'enum' | 'trait',
          line: index + 1,
          signature: line,
          exported: line.startsWith('pub '),
          confidenceBoost: 0.06,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (rustContextStack.length > 0 && braceDepth < (rustContextStack[rustContextStack.length - 1]?.depth ?? 0)) {
        rustContextStack.pop();
      }
      continue;
    }

    if (language === 'java') {
      match = /^(?:public\s+)?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] === 'interface' ? 'interface' : match[1] === 'enum' ? 'enum' : 'class',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.05,
        });
        javaContextStack.push({
          name: match[2]!,
          depth: braceDepth + countBraceDelta(rawLine),
        });
        braceDepth += countBraceDelta(rawLine);
        while (javaContextStack.length > 0 && braceDepth < (javaContextStack[javaContextStack.length - 1]?.depth ?? 0)) {
          javaContextStack.pop();
        }
        continue;
      }

      match = /^(?:public|protected|private|static|final|synchronized|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[1]!)) {
        const qualifier = javaContextStack[javaContextStack.length - 1]?.name;
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: qualifier ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: line.startsWith('public'),
          confidenceBoost: 0.03,
          qualifier,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (javaContextStack.length > 0 && braceDepth < (javaContextStack[javaContextStack.length - 1]?.depth ?? 0)) {
        javaContextStack.pop();
      }
      continue;
    }

    if (language === 'cpp') {
      match = /^(class|struct|enum)(?:\s+(?:class|struct))?\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] === 'enum' ? 'enum' : match[1] === 'struct' ? 'struct' : 'class',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.03,
        });
        if (match[1] !== 'enum') {
          cppContextStack.push({
            name: match[2]!,
            depth: braceDepth + countBraceDelta(rawLine),
          });
        }
        braceDepth += countBraceDelta(rawLine);
        while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
          cppContextStack.pop();
        }
        continue;
      }

      match = /^(?:[\w:&*<>,~]+\s+)+([A-Za-z_~][A-Za-z0-9_]*)::([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[2]!)) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'method',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.04,
          qualifier: match[1]!.split('::').at(-1),
        });
        braceDepth += countBraceDelta(rawLine);
        while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
          cppContextStack.pop();
        }
        continue;
      }

      match = /^(?:[\w:&*<>,~]+\s+)+([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[1]!)) {
        const qualifier = cppContextStack[cppContextStack.length - 1]?.name;
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: qualifier ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: qualifier ? 0.03 : 0.02,
          qualifier,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
        cppContextStack.pop();
      }
    }
  }

  return entries.slice(0, MAX_SYMBOLS_PER_FILE);
}

export async function analyzeSourceFile(
  workspaceRoot: string,
  filePath: string,
  moduleId: string,
): Promise<FileAnalysis | null> {
  const absolutePath = path.join(workspaceRoot, filePath);
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FILE_BYTES) {
    return null;
  }

  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const language = languageFromFile(filePath);
  const capabilityTier = capabilityTierForLanguage(language);
  const imports = extractImports(content, language);
  const symbolMatches = extractSymbolsFromLines(lines, language);
  const baseConfidence = baseConfidenceForTier(capabilityTier);

  const symbols: RepoSymbolRecord[] = symbolMatches.map((entry, index, allEntries) => {
    const symbolBody = extractSymbolBody(lines, language, entry, allEntries, index);
    const calls = entry.calls ?? extractCallNames(symbolBody);
    return {
      id: `${filePath}#${entry.qualifier ? `${entry.qualifier}.` : ''}${entry.name}:${entry.line}`,
      name: entry.name,
      qualifiedName: `${filePath}:${entry.qualifier ? `${entry.qualifier}.` : ''}${entry.name}`,
      kind: entry.kind,
      filePath,
      moduleId,
      language,
      capabilityTier,
      line: entry.line,
      signature: entry.signature,
      exported: entry.exported,
      calls,
      callTargets: [],
      importPaths: imports,
      confidence: Math.min(0.97, baseConfidence + entry.confidenceBoost),
    };
  });

  return {
    filePath,
    moduleId,
    language,
    capabilityTier,
    importPaths: imports,
    symbols,
  };
}

export function buildModuleAliases(modules: RepoAreaOverview[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const module of modules) {
    aliases.set(module.id.toLowerCase(), module.id);
    aliases.set(module.label.toLowerCase(), module.id);
    aliases.set(path.posix.basename(module.root).toLowerCase(), module.id);
  }
  return aliases;
}

export function resolveRelativeImport(importPath: string, filePath: string, sourceFileSet: Set<string>): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }

  const baseDir = path.posix.dirname(filePath);
  let baseTarget: string;
  if (!importPath.includes('/')) {
    const leadingDots = importPath.match(/^\.+/)?.[0]?.length ?? 0;
    const relativeModule = importPath.slice(leadingDots).replace(/\./g, '/');
    let resolvedBaseDir = baseDir;
    for (let index = 1; index < leadingDots; index += 1) {
      resolvedBaseDir = path.posix.dirname(resolvedBaseDir);
    }
    baseTarget = normalizeRelativePath(path.posix.join(resolvedBaseDir, relativeModule));
  } else {
    baseTarget = normalizeRelativePath(path.posix.join(baseDir, importPath));
  }
  const candidates = [baseTarget];
  for (const ext of SOURCE_EXTENSIONS) {
    candidates.push(`${baseTarget}${ext}`);
    candidates.push(`${baseTarget}/index${ext}`);
  }

  for (const candidate of candidates) {
    if (sourceFileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveImportToModule(
  importPath: string,
  filePath: string,
  sourceFileSet: Set<string>,
  modules: RepoAreaOverview[],
  aliases: Map<string, string>,
): string | null {
  const relativeFile = resolveRelativeImport(importPath, filePath, sourceFileSet);
  if (relativeFile) {
    return findAreaForFile(relativeFile, modules).id;
  }

  const normalizedImport = importPath.toLowerCase();
  for (const [alias, moduleId] of aliases.entries()) {
    if (
      normalizedImport === alias
      || normalizedImport.startsWith(`${alias}/`)
      || normalizedImport.endsWith(`/${alias}`)
    ) {
      return moduleId;
    }
  }

  return null;
}

export function rankReferenceReason(
  sourceModuleId: string,
  targetModuleId: string,
  importedModules: Set<string>,
): RepoSymbolReference['reason'] {
  if (sourceModuleId === targetModuleId) {
    return 'same-module';
  }
  if (importedModules.has(targetModuleId)) {
    return 'imported-module';
  }
  return 'name-match';
}

export function buildProcessCapsules(
  modules: ModuleCapsule[],
  symbols: RepoSymbolRecord[],
): ProcessCapsule[] {
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByModule = new Map<string, RepoSymbolRecord[]>();
  for (const symbol of symbols) {
    const bucket = symbolsByModule.get(symbol.moduleId) ?? [];
    bucket.push(symbol);
    symbolsByModule.set(symbol.moduleId, bucket);
  }

  const processes: ProcessCapsule[] = [];
  for (const module of modules) {
    const moduleSymbols = symbolsByModule.get(module.moduleId) ?? [];
    const entryFiles = module.entryFiles.length > 0 ? module.entryFiles : module.sampleFiles;
    for (const entryFile of entryFiles.slice(0, 2)) {
      const entrySymbol = moduleSymbols.find((symbol) => symbol.filePath === entryFile && symbol.exported)
        ?? moduleSymbols.find((symbol) => symbol.filePath === entryFile)
        ?? moduleSymbols[0];

      if (!entrySymbol) {
        continue;
      }

      const steps: ProcessStep[] = [{
        kind: 'entry',
        symbolName: entrySymbol.name,
        symbolId: entrySymbol.id,
        filePath: entrySymbol.filePath,
        line: entrySymbol.line,
        note: `Entry symbol ${entrySymbol.name} in ${entrySymbol.filePath}`,
      }];

      for (const importPath of entrySymbol.importPaths.slice(0, 3)) {
        steps.push({
          kind: 'imports',
          symbolName: importPath,
          filePath: entrySymbol.filePath,
          note: `Imports ${importPath}`,
        });
      }

      const firstHopTargets = entrySymbol.callTargets.slice(0, 3);
      for (const target of firstHopTargets) {
        const resolved = symbolsById.get(target.symbolId);
        steps.push({
          kind: 'calls',
          symbolName: target.name,
          symbolId: target.symbolId,
          filePath: target.filePath,
          line: resolved?.line,
          note: `Calls ${target.name} (${target.reason})`,
        });
      }

      const secondHopSymbols = firstHopTargets
        .map((target) => symbolsById.get(target.symbolId))
        .filter((symbol): symbol is RepoSymbolRecord => symbol !== undefined)
        .flatMap((symbol) => symbol.callTargets.slice(0, 2))
        .slice(0, 2);
      for (const target of secondHopSymbols) {
        const resolved = symbolsById.get(target.symbolId);
        steps.push({
          kind: 'calls',
          symbolName: target.name,
          symbolId: target.symbolId,
          filePath: target.filePath,
          line: resolved?.line,
          note: `Then reaches ${target.name} (${target.reason})`,
        });
      }

      const dedupedSteps = steps.slice(0, MAX_PROCESS_STEPS);
      const touchedModules = dedupeStrings(
        dedupedSteps
          .map((step) => symbolsById.get(step.symbolId ?? '')?.moduleId)
          .filter((value): value is string => typeof value === 'string'),
        4,
      );

      const processId = `${module.moduleId}::${path.posix.basename(entryFile)}`;
      processes.push({
        id: processId,
        label: `${module.label} entry via ${path.posix.basename(entryFile)}`,
        moduleId: module.moduleId,
        entryFile,
        entrySymbol: entrySymbol.name,
        summary: touchedModules.length > 0
          ? `${entrySymbol.name} fans into ${dedupeStrings(firstHopTargets.map((target) => target.name), 4).join(', ') || 'local work'} and touches modules ${touchedModules.join(', ')}.`
          : `${entrySymbol.name} starts the main path for ${module.label}.`,
        steps: dedupedSteps,
        confidence: Math.min(0.95, entrySymbol.confidence - 0.02 + firstHopTargets.length * 0.03),
      });
    }
  }

  return processes;
}
