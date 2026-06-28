import fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';
import type { RepoAreaOverview } from './public-bridge.js';
import type {
  RepoSymbolKind,
  RepoSymbolRecord,
  RepoSymbolReference,
} from './semantic-types.js';
import {
  CALL_KEYWORDS,
  MAX_FILE_BYTES,
  MAX_RELATED_RESULTS,
  MAX_SYMBOLS_PER_FILE,
  baseConfidenceForTier,
  capabilityTierForLanguage,
  findAreaForFile,
  languageFromFile,
  normalizeRelativePath,
  type FileAnalysis,
} from './semantic-shared.js';
import { isTypeScriptLikeLanguage } from './semantic-workspace.js';
import {
  rankReferenceReason,
  resolveImportToModule,
} from './semantic-fallback-analyzer.js';

export interface TypeScriptSymbolDraft {
  record: RepoSymbolRecord;
  declaration: ts.Node;
  body?: ts.Node;
}

export function scriptKindFromFilePath(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
    default:
      return ts.ScriptKind.JS;
  }
}

export function getNodeLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function getDeclarationKey(workspaceRoot: string, declaration: ts.Node): string {
  const sourceFile = declaration.getSourceFile();
  const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  const filePath = normalizeRelativePath(path.relative(workspaceRoot, sourceFile.fileName));
  return `${filePath}:${lineAndCharacter.line + 1}:${lineAndCharacter.character + 1}:${declaration.kind}`;
}

export function getSignatureSnippet(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const end = sourceFile.text.indexOf('\n', start);
  const snippet = sourceFile.text.slice(start, end === -1 ? undefined : end).trim();
  return snippet || node.getText(sourceFile).split(/\r?\n/, 1)[0]?.trim() || '<unknown>';
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

export function isExportedDeclaration(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    return true;
  }

  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)) {
    return isExportedDeclaration(node.parent.parent);
  }

  return false;
}

export function getPropertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

export function getCallExpressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }

  return null;
}

export function collectTypeScriptImportPaths(sourceFile: ts.SourceFile): string[] {
  const imports = new Set<string>();

  const addImport = (value: string | undefined): void => {
    if (value?.trim()) {
      imports.add(value.trim());
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addImport(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteralLike(reference.expression)) {
        addImport(reference.expression.text);
      }
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      addImport(node.arguments[0]!.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return Array.from(imports).slice(0, 12);
}

export function registerTypeScriptSymbol(
  workspaceRoot: string,
  drafts: TypeScriptSymbolDraft[],
  analysis: FileAnalysis,
  sourceFile: ts.SourceFile,
  declaration: ts.Node,
  name: string,
  kind: RepoSymbolKind,
  exported: boolean,
  confidenceBoost: number,
  declarationMap: Map<string, RepoSymbolRecord>,
  qualifier?: string,
): void {
  if (!name.trim()) {
    return;
  }

  const line = getNodeLine(sourceFile, declaration);
  const qualifiedName = qualifier ? `${analysis.filePath}:${qualifier}.${name}` : `${analysis.filePath}:${name}`;
  const record: RepoSymbolRecord = {
    id: `${analysis.filePath}#${qualifier ? `${qualifier}.` : ''}${name}:${line}`,
    name,
    qualifiedName,
    kind,
    filePath: analysis.filePath,
    moduleId: analysis.moduleId,
    language: analysis.language,
    capabilityTier: analysis.capabilityTier,
    line,
    signature: getSignatureSnippet(sourceFile, declaration),
    exported,
    calls: [],
    callTargets: [],
    importPaths: analysis.importPaths,
    confidence: Math.min(0.99, baseConfidenceForTier(analysis.capabilityTier) + confidenceBoost),
  };

  const duplicate = analysis.symbols.find((candidate) => candidate.id === record.id);
  if (duplicate) {
    return;
  }
  if (analysis.symbols.length >= MAX_SYMBOLS_PER_FILE) {
    return;
  }

  analysis.symbols.push(record);
  let body: ts.Node | undefined;
  if (
    ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration)
    || ts.isGetAccessorDeclaration(declaration)
    || ts.isSetAccessorDeclaration(declaration)
    || ts.isFunctionExpression(declaration)
    || ts.isArrowFunction(declaration)
  ) {
    body = declaration.body ?? undefined;
  } else if (ts.isVariableDeclaration(declaration)) {
    body = declaration.initializer ?? undefined;
  } else if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    body = declaration;
  }

  drafts.push({
    record,
    declaration,
    body,
  });
  declarationMap.set(getDeclarationKey(workspaceRoot, declaration), record);
}

export function resolveTypeScriptCallSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name) ?? checker.getSymbolAtLocation(expression);
  }

  if (ts.isElementAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.argumentExpression) ?? checker.getSymbolAtLocation(expression);
  }

  return checker.getSymbolAtLocation(expression);
}

export async function analyzeTypeScriptFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
  sourceFileSet: Set<string>,
  moduleAliases: Map<string, string>,
): Promise<FileAnalysis[]> {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
    allowSyntheticDefaultImports: true,
  };

  const rootNames = sourceFiles.map((filePath) => path.join(workspaceRoot, filePath));
  const program = ts.createProgram(rootNames, compilerOptions);
  const checker = program.getTypeChecker();
  const analyses = new Map<string, FileAnalysis>();
  const declarationMap = new Map<string, RepoSymbolRecord>();
  const drafts: TypeScriptSymbolDraft[] = [];

  for (const filePath of sourceFiles) {
    const language = languageFromFile(filePath);
    if (!isTypeScriptLikeLanguage(language)) {
      continue;
    }

    const sourceFile = program.getSourceFile(path.join(workspaceRoot, filePath));
    if (!sourceFile) {
      continue;
    }

    const analysis: FileAnalysis = {
      filePath,
      moduleId: findAreaForFile(filePath, overviewAreas).id,
      language,
      capabilityTier: capabilityTierForLanguage(language),
      importPaths: collectTypeScriptImportPaths(sourceFile),
      symbols: [],
    };
    analyses.set(filePath, analysis);

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'function',
          isExportedDeclaration(statement),
          0.1,
          declarationMap,
        );
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const variableName = getPropertyNameText(declaration.name);
          if (!variableName) {
            continue;
          }
          if (
            declaration.initializer
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          ) {
            registerTypeScriptSymbol(
              workspaceRoot,
              drafts,
              analysis,
              sourceFile,
              declaration,
              variableName,
              'function',
              isExportedDeclaration(declaration),
              0.08,
              declarationMap,
            );
          }
        }
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'class',
          isExportedDeclaration(statement),
          0.1,
          declarationMap,
        );

        for (const member of statement.members) {
          if (
            (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
            && getPropertyNameText(member.name)
          ) {
            registerTypeScriptSymbol(
              workspaceRoot,
              drafts,
              analysis,
              sourceFile,
              member,
              getPropertyNameText(member.name)!,
              'method',
              false,
              0.05,
              declarationMap,
              statement.name.text,
            );
          }
        }
        continue;
      }

      if (ts.isInterfaceDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'interface',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'type',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
        continue;
      }

      if (ts.isEnumDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'enum',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
      }
    }
  }

  for (const draft of drafts) {
    const importedModules = new Set<string>();
    for (const importPath of draft.record.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        draft.record.filePath,
        sourceFileSet,
        overviewAreas,
        moduleAliases,
      );
      if (resolvedModule) {
        importedModules.add(resolvedModule);
      }
    }

    const calls = new Set<string>();
    const preciseTargets = new Map<string, RepoSymbolReference>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = getCallExpressionName(node.expression);
        if (name && !CALL_KEYWORDS.has(name)) {
          calls.add(name);
        }

        const targetSymbol = resolveTypeScriptCallSymbol(checker, node.expression);
        const declaration = targetSymbol?.declarations?.[0];
        if (declaration) {
          const target = declarationMap.get(getDeclarationKey(workspaceRoot, declaration));
          if (target && target.id !== draft.record.id) {
            preciseTargets.set(target.id, {
              symbolId: target.id,
              name: target.name,
              filePath: target.filePath,
              moduleId: target.moduleId,
              reason: rankReferenceReason(draft.record.moduleId, target.moduleId, importedModules),
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(draft.body ?? draft.declaration);
    draft.record.calls = Array.from(calls).slice(0, 24);
    draft.record.callTargets = Array.from(preciseTargets.values()).slice(0, MAX_RELATED_RESULTS);
    draft.record.confidence = Math.min(0.99, draft.record.confidence + (draft.record.callTargets.length > 0 ? 0.03 : 0));
  }

  return Array.from(analyses.values());
}
