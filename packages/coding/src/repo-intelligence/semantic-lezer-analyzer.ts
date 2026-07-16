import fs from 'fs/promises';
import path from 'path';
import type { SyntaxNode } from '@lezer/common';
import { parser as goParser } from '@lezer/go';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import type { RepoAreaOverview } from './public-bridge.js';
import type { RepoLanguageId, RepoSymbolRecord } from './semantic-types.js';
import {
  CALL_KEYWORDS,
  MAX_FILE_BYTES,
  MAX_SYMBOLS_PER_FILE,
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

export function extractGoReceiverQualifier(receiver: string): string | undefined {
  const parts = receiver
    .replace(/[\*\[\]]/g, ' ')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1];
}

export function normalizeRustQualifier(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const cleaned = raw
    .replace(/<[^>]+>/g, '')
    .split('::')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/[&*]/g, '')
    .trim();
  return cleaned || undefined;
}

export function forEachSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  callback: (child: SyntaxNode) => void,
): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    callback(child);
  }
}

export function getSyntaxNodeText(
  source: string,
  node: Pick<SyntaxNode, 'from' | 'to'>,
): string {
  return source.slice(node.from, node.to);
}

export function getPythonNodeLine(
  source: string,
  node: Pick<SyntaxNode, 'from'>,
): number {
  return source.slice(0, node.from).split(/\r?\n/).length;
}

export function getPythonSignature(
  lines: string[],
  line: number,
): string {
  return lines[line - 1]?.trim() || '<unknown>';
}

export function collectPythonImports(
  source: string,
  topNode: Pick<SyntaxNode, 'firstChild'>,
): string[] {
  const imports: string[] = [];
  forEachSyntaxChild(topNode, (child) => {
    if (child.type.name !== 'ImportStatement') {
      return;
    }
    const text = getSyntaxNodeText(source, child).trim();
    let match = /^from\s+([.\w]+)\s+import\b/.exec(text);
    if (match?.[1]) {
      imports.push(match[1]);
      return;
    }
    match = /^import\s+(.+)$/.exec(text);
    if (match?.[1]) {
      imports.push(
        ...match[1]
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/i)[0] ?? '')
          .filter(Boolean),
      );
    }
  });
  return dedupeStrings(imports, 12);
}

export function getPythonCallName(
  source: string,
  node: SyntaxNode,
): string | null {
  if (node.type.name === 'VariableName' || node.type.name === 'PropertyName') {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'MemberExpression') {
    let propertyName: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getPythonCallName(source, child);
      if (candidate) {
        propertyName = candidate;
      }
    });
    return propertyName;
  }

  const firstChild = node.firstChild;
  return firstChild ? getPythonCallName(source, firstChild) : null;
}

export function collectPythonCallNames(
  source: string,
  node: SyntaxNode,
): string[] {
  const calls = new Set<string>();
  const walk = (current: SyntaxNode): void => {
    if (current.type.name === 'CallExpression') {
      const callee = current.firstChild;
      const name = callee ? getPythonCallName(source, callee) : null;
      if (name && !CALL_KEYWORDS.has(name)) {
        calls.add(name);
      }
    }
    forEachSyntaxChild(current, walk);
  };
  walk(node);
  return Array.from(calls).slice(0, 24);
}

export async function analyzePythonFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = pythonParser.parse(content);
    const topNode = tree.topNode;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = collectPythonImports(content, topNode);
    const symbols: RepoSymbolRecord[] = [];
    const moduleId = findAreaForFile(filePath, overviewAreas).id;

    forEachSyntaxChild(topNode, (child) => {
      if (child.type.name === 'FunctionDefinition') {
        let functionName: string | null = null;
        forEachSyntaxChild(child, (member) => {
          if (member.type.name === 'VariableName' && !functionName) {
            functionName = getSyntaxNodeText(content, member).trim();
          }
        });

        if (!functionName) {
          return;
        }
        const resolvedFunctionName = functionName as string;

        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${resolvedFunctionName}:${line}`,
          name: resolvedFunctionName,
          qualifiedName: `${filePath}:${resolvedFunctionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: !resolvedFunctionName.startsWith('_'),
          calls: collectPythonCallNames(content, child),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.99, baseConfidence + 0.1),
        });
        return;
      }

      if (child.type.name !== 'ClassDefinition') {
        return;
      }

      let className: string | null = null;
      let classBody: typeof child | null = null;
      forEachSyntaxChild(child, (member) => {
        if (member.type.name === 'VariableName' && !className) {
          className = getSyntaxNodeText(content, member).trim();
        } else if (member.type.name === 'Body') {
          classBody = member;
        }
      });

      if (!className) {
        return;
      }
      const resolvedClassName = className as string;

      const classLine = getPythonNodeLine(content, child);
      symbols.push({
        id: `${filePath}#${resolvedClassName}:${classLine}`,
        name: resolvedClassName,
        qualifiedName: `${filePath}:${resolvedClassName}`,
        kind: 'class',
        filePath,
        moduleId,
        language,
        capabilityTier,
        line: classLine,
        signature: getPythonSignature(lines, classLine),
        exported: !resolvedClassName.startsWith('_'),
        calls: [],
        callTargets: [],
        importPaths: imports,
        confidence: Math.min(0.99, baseConfidence + 0.08),
      });

      if (!classBody) {
        return;
      }

      forEachSyntaxChild(classBody, (member) => {
        if (member.type.name !== 'FunctionDefinition') {
          return;
        }

        let methodName: string | null = null;
        forEachSyntaxChild(member, (part) => {
          if (part.type.name === 'VariableName' && !methodName) {
            methodName = getSyntaxNodeText(content, part).trim();
          }
        });

        if (!methodName) {
          return;
        }
        const resolvedMethodName = methodName as string;

        const line = getPythonNodeLine(content, member);
        symbols.push({
          id: `${filePath}#${resolvedClassName}.${resolvedMethodName}:${line}`,
          name: resolvedMethodName,
          qualifiedName: `${filePath}:${resolvedClassName}.${resolvedMethodName}`,
          kind: 'method',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: !resolvedMethodName.startsWith('_'),
          calls: collectPythonCallNames(content, member),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.99, baseConfidence + 0.06),
        });
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}

export function findFirstSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (!matched && predicate(child)) {
      matched = child;
    }
  });
  return matched;
}

export function findLastSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (predicate(child)) {
      matched = child;
    }
  });
  return matched;
}

export function findSyntaxDescendant(
  node: SyntaxNode,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  if (predicate(node)) {
    return node;
  }

  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (!matched) {
      matched = findSyntaxDescendant(child, predicate);
    }
  });
  return matched;
}

export function collectLezerCallNames(
  source: string,
  node: SyntaxNode,
  getCallName: (source: string, node: SyntaxNode) => string | null,
): string[] {
  const calls = new Set<string>();
  const walk = (current: SyntaxNode): void => {
    if (current.type.name === 'CallExpr' || current.type.name === 'CallExpression') {
      const callee = current.firstChild;
      const name = callee ? getCallName(source, callee) : null;
      if (name && !CALL_KEYWORDS.has(name)) {
        calls.add(name);
      }
    }
    forEachSyntaxChild(current, walk);
  };
  walk(node);
  return Array.from(calls).slice(0, 24);
}

export function getGoCallName(source: string, node: SyntaxNode): string | null {
  if (
    node.type.name === 'VariableName'
    || node.type.name === 'FieldName'
    || node.type.name === 'TypeName'
  ) {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'SelectorExpr') {
    let selector: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getGoCallName(source, child);
      if (candidate) {
        selector = candidate;
      }
    });
    return selector;
  }

  const firstChild = node.firstChild;
  return firstChild ? getGoCallName(source, firstChild) : null;
}

export function getRustCallName(source: string, node: SyntaxNode): string | null {
  if (
    node.type.name === 'Identifier'
    || node.type.name === 'FieldIdentifier'
    || node.type.name === 'TypeIdentifier'
    || node.type.name === 'BoundIdentifier'
  ) {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'FieldExpression') {
    let selector: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getRustCallName(source, child);
      if (candidate) {
        selector = candidate;
      }
    });
    return selector;
  }

  const firstChild = node.firstChild;
  return firstChild ? getRustCallName(source, firstChild) : null;
}

export function findSyntaxNodeText(
  source: string,
  node: Pick<SyntaxNode, 'firstChild'>,
  typeName: string,
): string | null {
  const matched = findFirstSyntaxChild(node, (child) => child.type.name === typeName);
  return matched ? getSyntaxNodeText(source, matched).trim() : null;
}

export function isRustExported(source: string, node: Pick<SyntaxNode, 'from' | 'to'>): boolean {
  return /^pub(?:\([^)]*\))?\s/.test(getSyntaxNodeText(source, node).trimStart());
}

export async function analyzeGoFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = goParser.parse(content);
    const moduleId = findAreaForFile(filePath, overviewAreas).id;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = extractImports(content, language);
    const symbols: RepoSymbolRecord[] = [];

    forEachSyntaxChild(tree.topNode, (child) => {
      if (child.type.name === 'TypeDecl') {
        const typeSpec = findFirstSyntaxChild(child, (member) => member.type.name === 'TypeSpec');
        const typeName = typeSpec ? findSyntaxNodeText(content, typeSpec, 'DefName') : null;
        if (!typeSpec || !typeName) {
          return;
        }
        const kind = findFirstSyntaxChild(typeSpec, (member) => member.type.name === 'InterfaceType')
          ? 'interface'
          : 'struct';
        const line = getPythonNodeLine(content, typeSpec);
        symbols.push({
          id: `${filePath}#${typeName}:${line}`,
          name: typeName,
          qualifiedName: `${filePath}:${typeName}`,
          kind,
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: /^[A-Z]/.test(typeName),
          calls: [],
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
        return;
      }

      if (child.type.name === 'FunctionDecl') {
        const functionName = findSyntaxNodeText(content, child, 'DefName');
        if (!functionName) {
          return;
        }
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${functionName}:${line}`,
          name: functionName,
          qualifiedName: `${filePath}:${functionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: /^[A-Z]/.test(functionName),
          calls: collectLezerCallNames(content, child, getGoCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
        return;
      }

      if (child.type.name !== 'MethodDecl') {
        return;
      }

      const receiverParameters = findFirstSyntaxChild(child, (member) => member.type.name === 'Parameters');
      const methodName = findSyntaxNodeText(content, child, 'FieldName');
      const receiverTypeNode = receiverParameters
        ? findSyntaxDescendant(receiverParameters, (member) => member.type.name === 'TypeName')
        : null;
      const receiverType = receiverTypeNode ? getSyntaxNodeText(content, receiverTypeNode).trim() : undefined;
      if (!methodName) {
        return;
      }
      const line = getPythonNodeLine(content, child);
      symbols.push({
        id: `${filePath}#${receiverType ? `${receiverType}.` : ''}${methodName}:${line}`,
        name: methodName,
        qualifiedName: `${filePath}:${receiverType ? `${receiverType}.` : ''}${methodName}`,
        kind: 'method',
        filePath,
        moduleId,
        language,
        capabilityTier,
        line,
        signature: getPythonSignature(lines, line),
        exported: /^[A-Z]/.test(methodName),
        calls: collectLezerCallNames(content, child, getGoCallName),
        callTargets: [],
        importPaths: imports,
        confidence: Math.min(0.97, baseConfidence + 0.08),
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}

export async function analyzeRustFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = rustParser.parse(content);
    const moduleId = findAreaForFile(filePath, overviewAreas).id;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = extractImports(content, language);
    const symbols: RepoSymbolRecord[] = [];

    forEachSyntaxChild(tree.topNode, (child) => {
      if (child.type.name === 'StructItem' || child.type.name === 'TraitItem' || child.type.name === 'EnumItem') {
        const typeName = findSyntaxNodeText(content, child, 'TypeIdentifier');
        if (!typeName) {
          return;
        }
        const kind = child.type.name === 'TraitItem'
          ? 'trait'
          : child.type.name === 'EnumItem'
            ? 'enum'
            : 'struct';
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${typeName}:${line}`,
          name: typeName,
          qualifiedName: `${filePath}:${typeName}`,
          kind,
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, child),
          calls: [],
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.06),
        });
        return;
      }

      if (child.type.name === 'FunctionItem') {
        const functionName = findSyntaxNodeText(content, child, 'BoundIdentifier');
        if (!functionName) {
          return;
        }
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${functionName}:${line}`,
          name: functionName,
          qualifiedName: `${filePath}:${functionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, child),
          calls: collectLezerCallNames(content, child, getRustCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.06),
        });
        return;
      }

      if (child.type.name !== 'ImplItem') {
        return;
      }

      const qualifierNode = findLastSyntaxChild(child, (member) => member.type.name === 'TypeIdentifier');
      const qualifier = qualifierNode
        ? normalizeRustQualifier(getSyntaxNodeText(content, qualifierNode).trim())
        : undefined;
      const declarationList = findFirstSyntaxChild(child, (member) => member.type.name === 'DeclarationList');
      if (!qualifier || !declarationList) {
        return;
      }

      forEachSyntaxChild(declarationList, (member) => {
        if (member.type.name !== 'FunctionItem') {
          return;
        }
        const methodName = findSyntaxNodeText(content, member, 'BoundIdentifier');
        if (!methodName) {
          return;
        }
        const line = getPythonNodeLine(content, member);
        symbols.push({
          id: `${filePath}#${qualifier}.${methodName}:${line}`,
          name: methodName,
          qualifiedName: `${filePath}:${qualifier}.${methodName}`,
          kind: 'method',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, member),
          calls: collectLezerCallNames(content, member, getRustCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}
