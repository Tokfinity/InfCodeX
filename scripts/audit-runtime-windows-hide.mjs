import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const CHILD_PROCESS_MODULE = /^(?:node:)?child_process$/;
const CHILD_PROCESS_METHODS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'spawn',
  'spawnSync',
]);

export function auditChildProcessSource(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(file),
  );
  const bindings = collectChildProcessBindings(sourceFile);
  collectPromisifiedAliases(sourceFile, bindings.named);
  const calls = [];

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const method = resolveChildProcessMethod(node.expression, bindings);
    if (!method || !CHILD_PROCESS_METHODS.has(method)) return;
    const options = childProcessOptions(method, node.arguments);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const exception = hiddenWindowException(file, method, node, options, sourceFile);
    calls.push({
      file,
      line,
      method,
      hidden: hasTrueProperty(options, 'windowsHide'),
      reason: exception,
    });
  });

  const exceptions = calls.filter((call) => call.reason !== undefined);
  const violations = calls.filter((call) => !call.hidden && call.reason === undefined);
  return { calls, exceptions, violations };
}

export function auditRuntimeWorkerWindowsHide({ repoRoot, metafile, bundlePath }) {
  const output = runtimeWorkerOutput(metafile);
  const audited = [];
  for (const input of Object.keys(output.inputs ?? {})) {
    const file = path.resolve(repoRoot, input);
    if (!existsSync(file) || !/\.[cm]?[jt]sx?$/i.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('child_process')) continue;
    audited.push(auditChildProcessSource(normalizePath(input), source));
  }

  const violations = audited.flatMap((result) => result.violations);
  if (violations.length > 0) {
    const details = violations
      .map((violation) => (
        `${violation.file}:${violation.line} ${violation.method}() lacks windowsHide: true`
      ))
      .join('\n');
    throw new Error(`Runtime Worker background child-process audit failed:\n${details}`);
  }

  assertEmbeddedWindowsBrokerHidden(bundlePath);
  const calls = audited.flatMap((result) => result.calls);
  return {
    calls,
    exceptions: audited.flatMap((result) => result.exceptions),
  };
}

function collectChildProcessBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    collectImportBindings(statement, named, namespaces);
    collectRequireBindings(statement, named, namespaces);
  }
  return { named, namespaces };
}

function collectImportBindings(statement, named, namespaces) {
  if (
    !ts.isImportDeclaration(statement)
    || !ts.isStringLiteral(statement.moduleSpecifier)
    || !CHILD_PROCESS_MODULE.test(statement.moduleSpecifier.text)
  ) return;
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  if (!bindings || !ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    named.set(element.name.text, (element.propertyName ?? element.name).text);
  }
}

function collectRequireBindings(statement, named, namespaces) {
  if (!ts.isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer;
    if (
      !initializer
      || !ts.isCallExpression(initializer)
      || !ts.isIdentifier(initializer.expression)
      || initializer.expression.text !== 'require'
      || !isChildProcessModuleArgument(initializer.arguments[0])
    ) continue;
    if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
    if (!ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
      named.set(element.name.text, imported);
    }
  }
}

function collectPromisifiedAliases(sourceFile, named) {
  let changed = true;
  while (changed) {
    changed = false;
    visit(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
      const method = aliasedMethod(node.initializer, named);
      if (!method || named.has(node.name.text)) return;
      named.set(node.name.text, method);
      changed = true;
    });
  }
}

function aliasedMethod(initializer, named) {
  if (ts.isIdentifier(initializer)) return named.get(initializer.text);
  if (!ts.isCallExpression(initializer)) return undefined;
  const firstArgument = initializer.arguments[0];
  return firstArgument && ts.isIdentifier(firstArgument)
    ? named.get(firstArgument.text)
    : undefined;
}

function resolveChildProcessMethod(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && bindings.namespaces.has(expression.expression.text)
  ) return expression.name.text;
  return undefined;
}

function childProcessOptions(method, args) {
  if (method === 'spawn' || method === 'spawnSync') {
    return isObjectLiteral(args[1]) ? args[1] : args[2];
  }
  if (method === 'exec' || method === 'execSync') return args[1];
  if (method === 'execFile' || method === 'execFileSync') {
    if (isObjectLiteral(args[2])) return args[2];
    if (isObjectLiteral(args[1])) return args[1];
    return args[2] ?? args[1];
  }
  return undefined;
}

function isObjectLiteral(node) {
  return node !== undefined && ts.isObjectLiteralExpression(node);
}

function hiddenWindowException(file, method, call, options, sourceFile) {
  const normalized = normalizePath(file);
  const command = call.arguments[0]?.getText(sourceFile);
  if (
    command === "'ps'"
    && normalized.endsWith('/agent/dist/runtime/managed-child-processes.js')
  ) return 'POSIX-only process identity probe';
  if (
    command === '"tmux"'
    && normalized.endsWith('/repl/dist/tui/runtime.js')
  ) return 'POSIX-only tmux capability probe';
  if (
    command === 'editor'
    && method === 'spawnSync'
    && normalized.endsWith('/repl/dist/interactive/readline-helpers.js')
    && propertyText(options, 'stdio', sourceFile) === "'inherit'"
  ) return 'explicit interactive external editor';
  if (
    command === 'wrapped'
    && method === 'spawn'
    && normalized.endsWith('src/sandbox-runtime.ts')
    && propertyText(options, 'shell', sourceFile) === 'true'
  ) return 'POSIX-only sandbox branch';
  return undefined;
}

function hasTrueProperty(options, name) {
  const property = objectProperty(options, name);
  return property !== undefined
    && ts.isPropertyAssignment(property)
    && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function propertyText(options, name, sourceFile) {
  const property = objectProperty(options, name);
  return property && ts.isPropertyAssignment(property)
    ? property.initializer.getText(sourceFile)
    : undefined;
}

function objectProperty(options, name) {
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return options.properties.find((property) => (
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && propertyName(property.name) === name
  ));
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function assertEmbeddedWindowsBrokerHidden(bundlePath) {
  const bundle = readFileSync(bundlePath, 'utf8');
  const brokerSpawn = /spawn\(wrapped\.argv\[0\],[\s\S]{0,500}?windowsHide:\s*true/;
  if (!brokerSpawn.test(bundle)) {
    throw new Error('Runtime Worker embedded Windows sandbox broker lacks windowsHide: true.');
  }
}

function runtimeWorkerOutput(metafile) {
  const entry = Object.entries(metafile.outputs ?? {}).find(([output]) => (
    normalizePath(output).endsWith('/dist/runtime-worker.js')
    || normalizePath(output) === 'dist/runtime-worker.js'
  ));
  if (!entry) throw new Error('Runtime Worker output is missing from the esbuild metafile.');
  return entry[1];
}

function isChildProcessModuleArgument(node) {
  return node !== undefined
    && ts.isStringLiteral(node)
    && CHILD_PROCESS_MODULE.test(node.text);
}

function sourceKind(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.ts$/i.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const metaPath = path.join(repoRoot, 'dist', 'bundle-meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const result = auditRuntimeWorkerWindowsHide({
    repoRoot,
    metafile: meta.runtimeWorker,
    bundlePath: path.join(repoRoot, 'dist', 'runtime-worker.js'),
  });
  process.stdout.write(
    `[runtime-windows-hide] ${result.calls.length} child-process calls audited; `
    + `${result.exceptions.length} intentional non-Windows/interactive exceptions.\n`,
  );
  for (const exception of result.exceptions) {
    process.stdout.write(
      `[runtime-windows-hide] exception ${exception.file}:${exception.line}: ${exception.reason}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
