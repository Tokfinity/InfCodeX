import { createRequire } from 'node:module';
import type * as tsTypes from 'typescript';

import type { WorkflowScriptManifest } from './manifest.js';

type TypeScriptModule = typeof import('typescript');
const requireModule = createRequire(import.meta.url);
let cachedTypeScript: TypeScriptModule | undefined;
const ts = new Proxy({} as TypeScriptModule, {
  get(_target, property) {
    cachedTypeScript ??= requireModule('typescript') as TypeScriptModule;
    return Reflect.get(cachedTypeScript, property) as unknown;
  },
});

export type WorkflowQualityLintSeverity = 'error' | 'warning';

export interface WorkflowQualityLintFinding {
  readonly code: string;
  readonly severity: WorkflowQualityLintSeverity;
  readonly message: string;
}

export interface WorkflowQualityLintOptions {
  readonly manifest?: WorkflowScriptManifest;
  readonly filename?: string;
  readonly hostMaxAgents?: number;
}

type WorkflowCommandMethod =
  | 'artifact'
  | 'runAgent'
  | 'spawnAgent'
  | 'synthesize'
  | 'wait'
  | 'workflow';

interface SchemaResultInfo {
  readonly variable: string;
  readonly fields: readonly string[];
}

interface SchemaCollectionInfo {
  readonly variable: string;
  readonly fields: readonly string[];
}

interface PropertyReadInfo {
  readonly variable: string;
  readonly field: string;
  readonly node: tsTypes.PropertyAccessExpression;
}

interface WorkflowSourceFacts {
  readonly sourceFile: tsTypes.SourceFile;
  readonly unawaitedCommandVariables: ReadonlyMap<string, WorkflowCommandMethod>;
  readonly schemaResults: ReadonlyMap<string, SchemaResultInfo>;
  readonly schemaCollections: ReadonlyMap<string, SchemaCollectionInfo>;
  readonly propertyReads: readonly PropertyReadInfo[];
  readonly topLevelSchemaFieldReads: readonly {
    readonly variable: string;
    readonly field: string;
  }[];
  readonly literalFanouts: readonly {
    readonly method: 'parallel' | 'pipeline';
    readonly count: number;
  }[];
}

const WORKFLOW_COMMANDS: ReadonlySet<string> = new Set([
  'artifact',
  'runAgent',
  'spawnAgent',
  'synthesize',
  'wait',
  'workflow',
]);
const RESULT_FIELDS = new Set([
  'digest',
  'digestFailed',
  'digestPending',
  'finalText',
  'limitReached',
  'model',
  'name',
  'provider',
  'status',
  'structured',
  'taskId',
  'usage',
  'verification',
]);

function parseWorkflowSource(source: string, filename?: string): tsTypes.SourceFile {
  return ts.createSourceFile(
    filename ?? 'workflow-quality-lint.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function propertyNameText(name: tsTypes.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function objectProperty(
  object: tsTypes.ObjectLiteralExpression,
  key: string,
): tsTypes.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      if (propertyNameText(property.name) === key) return property.initializer;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) {
      return property.name;
    }
  }
  return undefined;
}

function workflowMethodName(call: tsTypes.CallExpression): string | undefined {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'wf') {
    return undefined;
  }
  return expression.name.text;
}

function workflowCommandMethod(call: tsTypes.CallExpression): WorkflowCommandMethod | undefined {
  const method = workflowMethodName(call);
  if (!method || !WORKFLOW_COMMANDS.has(method)) return undefined;
  return method as WorkflowCommandMethod;
}

function staticFanoutCount(expression: tsTypes.Expression): number | undefined {
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.length;
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return undefined;
  const receiver = callee.expression;
  return ts.isArrayLiteralExpression(receiver) ? receiver.elements.length : undefined;
}

function isWorkflowAgentCall(call: tsTypes.CallExpression): call is tsTypes.CallExpression {
  const method = workflowMethodName(call);
  return method === 'runAgent' || method === 'spawnAgent';
}

function nodeContainsWorkflowAgentCall(node: tsTypes.Node): boolean {
  let found = false;
  const visit = (current: tsTypes.Node): void => {
    if (found) return;
    if (ts.isCallExpression(current) && isWorkflowAgentCall(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function unwrapAwait(expression: tsTypes.Expression): {
  readonly expression: tsTypes.Expression;
  readonly awaited: boolean;
} {
  if (ts.isAwaitExpression(expression)) {
    return { expression: expression.expression, awaited: true };
  }
  return { expression, awaited: false };
}

function assignedVariableForCall(call: tsTypes.CallExpression): {
  readonly variable: string;
  readonly awaited: boolean;
} | undefined {
  let node: tsTypes.Node = call;
  let awaited = false;
  if (ts.isAwaitExpression(node.parent) && node.parent.expression === node) {
    awaited = true;
    node = node.parent;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return { variable: parent.name.text, awaited };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left)
  ) {
    return { variable: parent.left.text, awaited };
  }
  return undefined;
}

function workflowResultVariableForAgentCall(
  call: tsTypes.CallExpression,
  directAssignment: { readonly variable: string; readonly awaited: boolean } | undefined,
): string | undefined {
  if (directAssignment?.awaited === true) return directAssignment.variable;

  let current: tsTypes.Node | undefined = call.parent;
  while (current !== undefined) {
    if (ts.isCallExpression(current)) {
      const method = workflowMethodName(current);
      if (method === 'parallel' || method === 'pipeline' || method === 'phase') {
        const assigned = assignedVariableForCall(current);
        if (assigned?.awaited === true) return assigned.variable;
      }
    }
    current = current.parent;
  }
  return undefined;
}

function schemaFields(schemaExpression: tsTypes.Expression | undefined): readonly string[] {
  if (!schemaExpression || !ts.isObjectLiteralExpression(schemaExpression)) return [];
  const properties = objectProperty(schemaExpression, 'properties');
  if (!properties || !ts.isObjectLiteralExpression(properties)) return [];
  return properties.properties
    .map((property) => {
      if (!ts.isPropertyAssignment(property)) return undefined;
      return propertyNameText(property.name);
    })
    .filter((item): item is string => item !== undefined);
}

function expressionContainsIdentifier(expression: tsTypes.Expression, names: ReadonlySet<string>): string | undefined {
  let found: string | undefined;
  const visit = (node: tsTypes.Node): void => {
    if (found !== undefined) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = node.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function baseIdentifierOfExpression(expression: tsTypes.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return baseIdentifierOfExpression(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)) {
    return baseIdentifierOfExpression(expression.expression);
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    return baseIdentifierOfExpression(expression.expression.expression);
  }
  return undefined;
}

function schemaCollectionForCallbackParameter(
  read: PropertyReadInfo,
  collections: ReadonlyMap<string, SchemaCollectionInfo>,
): SchemaCollectionInfo | undefined {
  let current: tsTypes.Node | undefined = read.node.parent;
  while (current !== undefined) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parameter = current.parameters[0]?.name;
      if (!parameter || !ts.isIdentifier(parameter) || parameter.text !== read.variable) {
        return undefined;
      }
      const parent = current.parent;
      if (!ts.isCallExpression(parent)) return undefined;
      const expression = parent.expression;
      if (!ts.isPropertyAccessExpression(expression)) return undefined;
      if (!['map', 'flatMap', 'forEach', 'some', 'every', 'filter'].includes(expression.name.text)) {
        return undefined;
      }
      const collectionVariable = baseIdentifierOfExpression(expression.expression);
      return collectionVariable ? collections.get(collectionVariable) : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function mergeSchemaCollectionFields(
  collections: Map<string, SchemaCollectionInfo>,
  variable: string,
  fields: readonly string[],
): void {
  const existing = collections.get(variable);
  const merged = [...new Set([...(existing?.fields ?? []), ...fields])];
  collections.set(variable, { variable, fields: merged });
}

function collectFacts(source: string, options: WorkflowQualityLintOptions): WorkflowSourceFacts {
  const sourceFile = parseWorkflowSource(source, options.filename);
  const unawaitedCommandVariables = new Map<string, WorkflowCommandMethod>();
  const schemaResults = new Map<string, SchemaResultInfo>();
  const schemaCollections = new Map<string, SchemaCollectionInfo>();
  const propertyReads: PropertyReadInfo[] = [];
  const topLevelSchemaFieldReads: Array<{ readonly variable: string; readonly field: string }> = [];
  const literalFanouts: Array<{ readonly method: 'parallel' | 'pipeline'; readonly count: number }> = [];

  const recordUnawaitedCommandVariable = (variable: string, expression: tsTypes.Expression): void => {
    const unwrapped = unwrapAwait(expression);
    if (!ts.isCallExpression(unwrapped.expression)) return;
    const method = workflowCommandMethod(unwrapped.expression);
    if (method && !unwrapped.awaited) {
      unawaitedCommandVariables.set(variable, method);
    }
  };

  const visit = (node: tsTypes.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      recordUnawaitedCommandVariable(node.name.text, node.initializer);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      recordUnawaitedCommandVariable(node.left.text, node.right);
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const variable = node.expression.text;
      const field = node.name.text;
      propertyReads.push({ variable, field, node });
      if (field !== 'structured' && !RESULT_FIELDS.has(field) && schemaResults.has(variable)) {
        topLevelSchemaFieldReads.push({ variable, field });
      }
    }

    if (ts.isCallExpression(node)) {
      const method = workflowMethodName(node);
      if ((method === 'parallel' || method === 'pipeline') && node.arguments.length > 0) {
        const first = node.arguments[0];
        const count = staticFanoutCount(first);
        const maySpawnAgents = method === 'parallel'
          ? nodeContainsWorkflowAgentCall(first)
          : node.arguments.slice(1).some(nodeContainsWorkflowAgentCall);
        if (count !== undefined && maySpawnAgents) {
          literalFanouts.push({ method, count });
        }
      }

      if (isWorkflowAgentCall(node)) {
        const callMethod = workflowMethodName(node) as 'runAgent' | 'spawnAgent';
        const first = node.arguments[0];
        const input = first && ts.isObjectLiteralExpression(first) ? first : undefined;
        const outputSchema = input ? objectProperty(input, 'outputSchema') : undefined;
        const assigned = assignedVariableForCall(node);
        const resultVariable = workflowResultVariableForAgentCall(node, assigned);
        const outputFields = schemaFields(outputSchema);
        if (callMethod === 'runAgent' && outputSchema !== undefined && assigned?.awaited === true) {
          schemaResults.set(assigned.variable, {
            variable: assigned.variable,
            fields: outputFields,
          });
        } else if (callMethod === 'runAgent' && outputSchema !== undefined && resultVariable) {
          mergeSchemaCollectionFields(schemaCollections, resultVariable, outputFields);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    sourceFile,
    unawaitedCommandVariables,
    schemaResults,
    schemaCollections,
    propertyReads,
    topLevelSchemaFieldReads,
    literalFanouts,
  };
}

function addFinding(
  findings: WorkflowQualityLintFinding[],
  finding: WorkflowQualityLintFinding,
): void {
  if (findings.some((item) => item.code === finding.code && item.message === finding.message)) {
    return;
  }
  findings.push(finding);
}

function lintUnawaitedBooleanUse(
  facts: WorkflowSourceFacts,
  findings: WorkflowQualityLintFinding[],
): void {
  const names = new Set(facts.unawaitedCommandVariables.keys());
  if (names.size === 0) return;

  const report = (expression: tsTypes.Expression): void => {
    const variable = expressionContainsIdentifier(expression, names);
    if (!variable) return;
    const method = facts.unawaitedCommandVariables.get(variable);
    addFinding(findings, {
      code: 'unawaited-command-boolean',
      severity: 'error',
      message:
        `workflow command variable "${variable}" from wf.${method ?? 'command'} must be awaited before boolean checks; ` +
        `write "const ${variable} = await wf.${method ?? 'command'}(...)" before using it in if/&&/||/?: conditions.`,
    });
  };

  const visit = (node: tsTypes.Node): void => {
    if (ts.isIfStatement(node)) report(node.expression);
    if (ts.isConditionalExpression(node)) report(node.condition);
    if (ts.isWhileStatement(node)) report(node.expression);
    if (ts.isDoStatement(node)) report(node.expression);
    if (ts.isForStatement(node) && node.condition) report(node.condition);
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      report(node.operand);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      report(node.left);
      report(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(facts.sourceFile);
}

function lintSchemaUse(
  facts: WorkflowSourceFacts,
  findings: WorkflowQualityLintFinding[],
): void {
  for (const read of facts.topLevelSchemaFieldReads) {
    const schema = facts.schemaResults.get(read.variable);
    const knownField = schema?.fields.includes(read.field) === true ? read.field : 'field';
    addFinding(findings, {
      code: 'output-schema-top-level-field',
      severity: 'error',
      message:
        `schema-bearing workflow result "${read.variable}" stores declared fields under ` +
        `${read.variable}.structured; use ${read.variable}.structured.${knownField} instead of ` +
        `${read.variable}.${read.field}.`,
    });
  }

  for (const read of facts.propertyReads) {
    if (read.field === 'structured' || RESULT_FIELDS.has(read.field)) continue;
    const collection = schemaCollectionForCallbackParameter(read, facts.schemaCollections);
    if (!collection) continue;
    const knownField = collection.fields.includes(read.field) ? read.field : 'field';
    addFinding(findings, {
      code: 'output-schema-top-level-field',
      severity: 'error',
      message:
        `schema-bearing workflow result item "${read.variable}" from "${collection.variable}" stores declared fields under ` +
        `${read.variable}.structured; use ${read.variable}.structured.${knownField} instead of ` +
        `${read.variable}.${read.field}.`,
    });
  }

}

function lintFanoutBounds(
  facts: WorkflowSourceFacts,
  options: WorkflowQualityLintOptions,
  findings: WorkflowQualityLintFinding[],
): void {
  const manifestMax = options.manifest?.maxAgents;
  const hostMax = options.hostMaxAgents;
  const limits = [manifestMax, hostMax].filter((value): value is number => value !== undefined);
  if (limits.length === 0) return;
  const limit = Math.min(...limits);
  for (const fanout of facts.literalFanouts) {
    if (fanout.count <= limit) continue;
    addFinding(findings, {
      code: 'literal-fanout-exceeds-max-agents',
      severity: 'error',
      message:
        `literal fanout wf.${fanout.method} has ${fanout.count} item(s), exceeding the ` +
        `${limit} maxAgents cap; shrink the array or raise the manifest/host cap before starting.`,
    });
  }
}

export function lintRestrictedWorkflowSource(
  source: string,
  options: WorkflowQualityLintOptions = {},
): readonly WorkflowQualityLintFinding[] {
  const facts = collectFacts(source, options);
  const findings: WorkflowQualityLintFinding[] = [];
  lintUnawaitedBooleanUse(facts, findings);
  lintSchemaUse(facts, findings);
  lintFanoutBounds(facts, options, findings);
  return findings;
}

export function assertRestrictedWorkflowQuality(
  source: string,
  options: WorkflowQualityLintOptions = {},
): void {
  const errors = lintRestrictedWorkflowSource(source, options)
    .filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return;
  throw new Error(
    [
      'inline workflow source failed pre-flight quality validation:',
      ...errors.map((finding) => finding.message),
    ].join('\n'),
  );
}
