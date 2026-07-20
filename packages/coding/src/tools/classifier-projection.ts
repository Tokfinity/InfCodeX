/**
 * Classifier Projection Helpers — FEATURE_092 (v0.7.33)
 *
 * Typed tools implement `toClassifierInput(input): string` to project their
 * input into a compact action the auto-mode classifier evaluates. Runtime
 * registration supplies a fail-closed semantic fallback for legacy JavaScript,
 * extension, and constructed tools that lack a trusted projector.
 *
 * ============== EXAMPLES BY CATEGORY ==============
 *
 *   --- FILE OPERATIONS (path + size, never raw contents) ---
 *     write.ts:        (i) => `Write ${i.path} (${i.content.length} bytes)`
 *     edit.ts:         (i) => `Edit ${i.path} [${describeEdit(i)}]`
 *     multi-edit:      (i) => `MultiEdit ${i.path}: ${i.edits.length} edits`
 *
 *   --- SHELL / EXEC (command verbatim, ignore noise fields) ---
 *     bash.ts:         (i) => `Bash: ${i.command}`
 *
 *   --- NETWORK (URL is THE risk surface) ---
 *     web_fetch:       (i) => `WebFetch ${i.url}`
 *
 *   --- CHILD AGENT SPAWN (routing + execution controls) ---
 *     spawn_agent:     objective size + scope/read_only/isolation/provider/model
 *
 *   --- MCP CALLS (semantic fields + shape-only unknowns) ---
 *     mcp_call:        (i) => mcpToClassifierInput(i.server, i.tool, i.input)
 *
 *   --- READ-ONLY (Tier 1 — fully skipped) ---
 *     read.ts:         () => ''
 *     grep.ts:         () => ''
 *     glob.ts:         () => ''
 *
 *   --- UNKNOWN / CONSTRUCTED (semantic fail-closed fallback) ---
 *     extension:       (i) => safeFallbackToClassifierInput(name, i)
 *
 * ============== ANTI-PATTERNS ==============
 *
 *   ❌ JSON.stringify(input) as default
 *      → leaks raw content; hard for LLM to scan
 *
 *   ❌ Returning input.description / input.rationale verbatim
 *      → these are LLM-emitted, manipulable; classifier should see facts
 *
 *   ❌ Including raw file contents in Write/Edit projections
 *      → privacy + token cost; use bytes/line count as proxy
 *
 *   ❌ Returning '' for a high-risk tool to "skip the classifier"
 *      → defeats Tier 1's "safe-only" semantics
 *
 *   ❌ Truncating without indicating it ('foo' instead of 'foo…')
 *      → classifier may make decisions on false-complete information
 */

const MAX_PROJECTION_LENGTH = 200;
const MAX_ACTION_VALUE_LENGTH = 200;
const MAX_HISTORY_SUMMARY_LENGTH = 2_048;
const MAX_HISTORY_VALUE_LENGTH = 1_024;
const MAX_HISTORY_SCAN_LENGTH = 4_096;

const SAFE_STRING_FIELDS = [
  'path', 'file_path', 'target_path', 'source_path', 'destination_path',
  'input_path', 'output_path', 'cwd', 'directory', 'root', 'url', 'uri',
  'endpoint', 'origin', 'host', 'command', 'cmd', 'executable', 'program',
  'script', 'pattern',
  'glob', 'query', 'target', 'to', 'task_name', 'scope', 'provider', 'provider_id',
  'model', 'model_hint', 'effort', 'kind', 'method', 'action', 'operation', 'verb',
  'id', 'agent_id', 'capability_id', 'server', 'tool', 'name', 'version', 'status',
  'fork_turns', 'mode', 'branch', 'branch_name', 'worktree_path', 'isolation',
  'classification', 'resumeFromRunId', 'forwarded_message_id', 'repository',
  'repo', 'ref', 'commit', 'tag', 'resource', 'subagent_type', 'format',
  // Common JavaScript/SDK spellings. MCP and extension schemas frequently use
  // camelCase even though KodaX built-ins generally use snake_case.
  'filePath', 'targetPath', 'sourcePath', 'destinationPath', 'inputPath',
  'outputPath', 'workingDirectory', 'baseUrl', 'repositoryUrl', 'taskName',
  'providerId', 'modelHint', 'agentId', 'capabilityId', 'serverId', 'toolName',
  'resourceId', 'forkTurns', 'branchName', 'worktreePath', 'subagentType',
] as const;

const SAFE_STRING_ARRAY_FIELDS = [
  'args', 'argv', 'flags', 'paths', 'targets', 'scopes', 'patterns',
  'arguments', 'filePaths', 'targetPaths', 'inputPaths', 'outputPaths',
  'evidence_refs', 'evidenceRefs',
] as const;

const SAFE_SCALAR_FIELDS = [
  'replace_all', 'read_only', 'recursive', 'force', 'dry_run', 'refresh',
  'run_in_background', 'timeout', 'timeout_ms', 'limit', 'offset', 'depth',
  'max_events', 'max_concurrency', 'planned_agents', 'max_agents',
  'replaceAll', 'readOnly', 'dryRun', 'runInBackground', 'timeoutMs',
  'maxEvents', 'maxConcurrency', 'plannedAgents', 'maxAgents',
  'followRedirects', 'allowNetwork',
] as const;

const BODY_FIELDS = [
  'content', 'old_string', 'new_string', 'objective', 'message', 'prompt',
  'source', 'artifact_json', 'body', 'payload', 'data', 'diff', 'patch',
  'plan', 'instructions', 'rationale', 'reason', 'description', 'justification',
  'oldString', 'newString', 'promptText', 'objectiveText', 'messageText',
  'sourceCode', 'artifactJson', 'approvalSummary',
] as const;

const RECOGNIZED_FIELDS = new Set<string>([
  ...SAFE_STRING_FIELDS,
  ...SAFE_STRING_ARRAY_FIELDS,
  ...SAFE_SCALAR_FIELDS,
  ...BODY_FIELDS,
]);
const MAX_UNKNOWN_FIELDS = 16;

export type ClassifierToolProjectionResolver = (
  toolName: string,
) => ((input: unknown) => string) | undefined;

const HISTORY_STRING_FIELDS = SAFE_STRING_FIELDS;
const HISTORY_STRING_ARRAY_FIELDS = SAFE_STRING_ARRAY_FIELDS;
const HISTORY_SCALAR_FIELDS = SAFE_SCALAR_FIELDS;
const HISTORY_BODY_FIELDS = BODY_FIELDS;

/**
 * Conservative default projection: tool name + truncated JSON of input.
 *
 * Use ONLY when the tool's input is non-sensitive (no raw file contents,
 * no secrets, no LLM-emitted free-form text). For high-risk tools write
 * a custom projection that surfaces the risk-bearing field directly.
 */
export function defaultToClassifierInput(toolName: string, input: unknown): string {
  let json: string;
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) {
      return `${toolName}: [unserializable input]`;
    }
    json = serialized;
  } catch {
    return `${toolName}: [unserializable input]`;
  }
  if (json.length > MAX_PROJECTION_LENGTH) {
    json = json.slice(0, MAX_PROJECTION_LENGTH) + '…';
  }
  return `${toolName}: ${json}`;
}

/**
 * Fail-closed projection for constructed, extension, and otherwise unknown tools.
 * It retains operational locators and control flags, converts free-form bodies
 * to sizes, and describes unknown values only by shape.
 */
export function safeFallbackToClassifierInput(toolName: string, input: unknown): string {
  const prefix = `Tool[${toolName}]`;
  if (input === null) return `${prefix}: null`;
  if (!isPlainRecord(input)) return `${prefix}: input<${describeValueShape(input)}>`;

  const details = projectSafeFields(input);
  const projection = `${prefix}: ${details.length > 0 ? details.join(', ') : '{}'}`;
  return redactClassifierProjection(truncate(projection, MAX_HISTORY_SUMMARY_LENGTH));
}

function projectSafeFields(input: Record<string, unknown>): string[] {
  const details: string[] = [];
  for (const key of SAFE_STRING_FIELDS) {
    const value = readDataProperty(input, key);
    if (value === undefined) continue;
    details.push(typeof value === 'string' && value.length > 0
      ? `${key}=${truncateValue(value, MAX_ACTION_VALUE_LENGTH)}`
      : `${key}<${describeValueShape(value)}>`);
  }
  for (const key of SAFE_STRING_ARRAY_FIELDS) {
    const value = readDataProperty(input, key);
    if (value === undefined) continue;
    details.push(Array.isArray(value)
      ? `${key}=${projectStringArray(value)}`
      : `${key}<${describeValueShape(value)}>`);
  }
  for (const key of SAFE_SCALAR_FIELDS) {
    const value = readDataProperty(input, key);
    if (value === undefined) continue;
    details.push(isSafeScalar(value)
      ? `${key}=${String(value)}`
      : `${key}<${describeValueShape(value)}>`);
  }
  for (const key of BODY_FIELDS) {
    const value = readDataProperty(input, key);
    if (value === undefined) continue;
    details.push(typeof value === 'string'
      ? `${key}_chars=${value.length}`
      : `${key}<${describeValueShape(value)}>`);
  }

  const keys = Object.keys(input);
  const unknownKeys = keys.filter((key) => !RECOGNIZED_FIELDS.has(key));
  for (const key of unknownKeys.slice(0, MAX_UNKNOWN_FIELDS)) {
    const value = readDataProperty(input, key);
    if (value !== undefined) details.push(`${key}<${describeValueShape(value)}>`);
  }
  if (unknownKeys.length > MAX_UNKNOWN_FIELDS) {
    details.push(`+${unknownKeys.length - MAX_UNKNOWN_FIELDS} unknown keys`);
  }
  return details;
}

function projectStringArray(value: readonly unknown[]): string {
  const items = value.slice(0, 8).map((item) => (
    typeof item === 'string'
      ? truncateValue(item, MAX_ACTION_VALUE_LENGTH)
      : `<${describeValueShape(item)}>`
  ));
  return `[${items.join(', ')}${value.length > 8 ? ', …' : ''}]`;
}

function isSafeScalar(value: unknown): value is boolean | number {
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function describeValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === 'string') return `string:${value.length}`;
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite-number';
  if (typeof value === 'object') return `object:${Object.keys(value).length}`;
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safe historical tool context for the classifier side-provider.
 *
 * The tool's canonical action projection carries its risk-bearing semantics.
 * When present, it is stored once and only body sizes / collection counts are
 * appended. Read-only tools with an empty projection retain bounded metadata.
 * Raw free-form fields never cross through the metadata path.
 */
export function projectToolHistoryInput(
  toolName: string,
  input: Record<string, unknown>,
  resolveProjection?: ClassifierToolProjectionResolver,
): Record<string, unknown> {
  const bridged = readToolCallTarget(toolName, input);
  if (bridged) {
    return {
      target_tool: bridged.name,
      ...projectToolHistoryInput(bridged.name, bridged.input, resolveProjection),
    };
  }

  const projected: Record<string, unknown> = {};
  const summary = resolveHistorySummary(toolName, input, resolveProjection);
  if (summary) {
    projected.summary = summary;
    try {
      appendHistoryBodySizes(projected, input);
      const edits = readDataProperty(input, 'edits');
      if (Array.isArray(edits)) projected.edits_count = edits.length;
    } catch {
      projected.__truncated = true;
    }
    return projected;
  }

  try {
    appendHistoryStrings(projected, input);
    appendHistoryScalars(projected, input);
    appendHistoryBodySizes(projected, input);
    const edits = readDataProperty(input, 'edits');
    if (Array.isArray(edits)) projected.edits_count = edits.length;
  } catch {
    projected.__truncated = true;
  }
  return projected;
}

/** Remove common credential forms while retaining the surrounding operation. */
export function redactClassifierProjection(value: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9][A-Z0-9 _-]{0,63})-----[\s\S]*?(?:-----END \1-----|$)/gi,
      '[REDACTED_PEM]',
    )
    .replace(
      /^([ \t]*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)\s*:\s*[>|][-+0-9]*[ \t]*\r?\n)(?:(?:[ \t]+[^\r\n]*(?:\r?\n|$)))+/gim,
      '$1  [REDACTED]\n',
    )
    .replace(
      /\b((?=[a-z0-9_]*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret|token))[a-z_][a-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)["']?)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(--(?:(?:api|access|auth|id|refresh)[_-]?(?:key|token)|authorization|client[_-]?secret|password|private[_-]?key|secret|token))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /((?:-u|--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(bearer\s+)[^\s"';&|]+/gi, '$1[REDACTED]')
    .replace(
      /\b((?:proxy-)?authorization|cookie|x-api-key)(\s*:\s*)(?:bearer\s+|basic\s+)?[^\s"';&|]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|password|secret|token)=)[^&#\s"']*/gi,
      '$1[REDACTED]',
    );
}

function resolveHistorySummary(
  toolName: string,
  input: Record<string, unknown>,
  resolveProjection: ClassifierToolProjectionResolver | undefined,
): string | undefined {
  if (!resolveProjection) return undefined;
  const projector = resolveProjection(toolName);
  if (!projector) {
    return historyTextPreview(
      safeFallbackToClassifierInput(toolName, input),
      MAX_HISTORY_SUMMARY_LENGTH,
    );
  }
  try {
    const value = projector(input);
    if (typeof value !== 'string') {
      return historyTextPreview(safeFallbackToClassifierInput(toolName, input), MAX_HISTORY_SUMMARY_LENGTH);
    }
    const summary = value.trim();
    return summary ? historyTextPreview(summary, MAX_HISTORY_SUMMARY_LENGTH) : undefined;
  } catch {
    return historyTextPreview(safeFallbackToClassifierInput(toolName, input), MAX_HISTORY_SUMMARY_LENGTH);
  }
}

function appendHistoryStrings(
  projected: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  for (const key of HISTORY_STRING_FIELDS) {
    const value = readDataProperty(input, key);
    if (typeof value === 'string' && value.length > 0) {
      projected[key] = historyTextPreview(value, MAX_HISTORY_VALUE_LENGTH);
    }
  }
  for (const key of HISTORY_STRING_ARRAY_FIELDS) {
    const values = readDataProperty(input, key);
    if (!Array.isArray(values)) continue;
    projected[key] = values.slice(0, 16)
      .filter((path): path is string => typeof path === 'string')
      .map((path) => historyTextPreview(path, MAX_HISTORY_VALUE_LENGTH));
  }
}

function readToolCallTarget(
  toolName: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } | undefined {
  if (toolName !== 'tool_call') return undefined;
  const name = readDataProperty(input, 'name');
  const targetInput = readDataProperty(input, 'input');
  if (typeof name !== 'string' || !isPlainRecord(targetInput)) return undefined;
  return { name, input: targetInput };
}

function appendHistoryScalars(
  projected: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  for (const key of HISTORY_SCALAR_FIELDS) {
    const value = readDataProperty(input, key);
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      projected[key] = value;
    }
  }
}

function appendHistoryBodySizes(
  projected: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  for (const key of HISTORY_BODY_FIELDS) {
    const value = readDataProperty(input, key);
    if (typeof value === 'string') projected[`${key}_chars`] = value.length;
  }
}

function readDataProperty(input: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor?.enumerable === true && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function historyTextPreview(value: string, maxLength: number): string {
  const scanned = value.slice(0, MAX_HISTORY_SCAN_LENGTH);
  const redacted = redactClassifierProjection(scanned);
  const truncated = value.length > scanned.length || redacted.length > maxLength;
  if (!truncated) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Semantic projection for MCP calls. Every recognized action/locator field is
 * retained in bounded form, known controls remain scalar, known bodies become
 * sizes, and unknown values are represented only by shape. This avoids both
 * priority hiding (for example method masking command) and arbitrary scalar
 * disclosure.
 *
 * Output shape examples:
 *   `MCP[filesystem.read]: method=fs.readFile, path=/etc/passwd`
 *   `MCP[fetcher.get]: url=https://example.test, headers<object:1>`
 *   `MCP[xxx.yyy]: name=foo, content_chars=42, tags<array:2>`
 *
 * Individual operational strings are truncated to 200 characters and the
 * complete projection is bounded.
 */
export function mcpToClassifierInput(
  server: string,
  tool: string,
  input: unknown,
): string {
  const prefix = `MCP[${server}.${tool}]`;

  if (input === null) return `${prefix}: null`;
  if (!isPlainRecord(input)) return `${prefix}: input<${describeValueShape(input)}>`;

  const details = projectSafeFields(input);
  const projection = `${prefix}: ${details.length > 0 ? details.join(', ') : '{}'}`;
  return redactClassifierProjection(truncate(projection, MAX_HISTORY_SUMMARY_LENGTH));
}

function truncateValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tailLength = Math.min(64, Math.floor((limit - 1) / 3));
  const headLength = limit - tailLength - 1;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}
