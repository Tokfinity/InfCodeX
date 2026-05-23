import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
  ToolDefinitionSource,
  ToolHandler,
  ToolRegistry,
  ToolRegistrationOptions,
} from './types.js';
import {
  defaultToClassifierInput,
  mcpToClassifierInput,
} from './classifier-projection.js';
import { toolRead } from './read.js';
import { toolSkill } from './skill.js';
import { toolWrite } from './write.js';
import { toolEdit } from './edit.js';
import { toolMultiEdit } from './multi-edit.js';
import { toolInsertAfterAnchor } from './insert-after-anchor.js';
import { toolBash } from './bash.js';
import { toolGlob } from './glob.js';
import { toolGrep } from './grep.js';
import { toolUndo } from './undo.js';
import { toolAskUserQuestion } from './ask-user-question.js';
import { toolExitPlanMode } from './exit-plan-mode.js';
import { toolRepoOverview } from './repo-overview.js';
import { toolChangedScope } from './changed-scope.js';
import { toolChangedDiff, toolChangedDiffBundle } from './changed-diff.js';
import { toolModuleContext } from './module-context.js';
import { toolSymbolContext } from './symbol-context.js';
import { toolProcessContext } from './process-context.js';
import { toolImpactEstimate } from './impact-estimate.js';
import { toolEmitManagedProtocol } from './emit-managed-protocol.js';
import { toolWebSearch } from './web-search.js';
import { toolWebFetch } from './web-fetch.js';
import { toolCodeSearch } from './code-search.js';
import { toolSemanticLookup } from './semantic-lookup.js';
import { toolMcpSearch } from './mcp-search.js';
import { toolMcpDescribe } from './mcp-describe.js';
import { toolMcpCall } from './mcp-call.js';
import { toolMcpReadResource } from './mcp-read-resource.js';
import { toolMcpGetPrompt } from './mcp-get-prompt.js';
import { toolWorktreeCreate, toolWorktreeRemove } from './worktree.js';
import { toolDispatchChildTask } from './dispatch-child-tasks.js';
import { toolSendMessage } from './send-message.js';
import { toolTaskStop } from './task-stop.js';
import { toolTaskOutput } from './task-output.js';
// FEATURE_155 v0.7.39 Slice C1 — `await_child_task` removed. Idle-yield
// (default ON since Slice B1.D) is the canonical wait mechanic.
import { TOOL_SEARCH_DEFINITION } from './tool-search.js';
import { toolTodoUpdate } from './todo-update.js';
import { toolTodoList } from './todo-list.js';
import { toolTodoCreate } from './todo-create.js';
import { toolTodoGet } from './todo-get.js';
import {
  toolScaffoldTool,
  toolValidateTool,
  toolStageConstruction,
  toolTestTool,
  toolActivateTool,
} from './construction.js';
import {
  toolScaffoldAgent,
  toolValidateAgent,
  toolStageAgentConstruction,
  toolTestAgent,
  toolActivateAgent,
} from './agent-construction.js';
import {
  toolStageSelfModify,
  SELF_MODIFY_TOOL_NAME,
} from './self-modify-tool.js';

const TOOL_REGISTRY: ToolRegistry = new Map();
let nextToolRegistrationId = 0;

export const REPO_INTELLIGENCE_WORKING_TOOL_NAMES = [
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
] as const;

const REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET = new Set<string>(
  REPO_INTELLIGENCE_WORKING_TOOL_NAMES,
);

export const MCP_TOOL_NAMES = [
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
] as const;

const MCP_TOOL_NAME_SET = new Set<string>(MCP_TOOL_NAMES);

function extractRequiredParams(
  inputSchema: KodaXToolDefinition['input_schema'] | undefined,
): string[] {
  if (
    !inputSchema
    || typeof inputSchema !== 'object'
    || !('required' in inputSchema)
    || !Array.isArray(inputSchema.required)
  ) {
    return [];
  }

  return inputSchema.required.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

function toToolDefinition(definition: RegisteredToolDefinition): KodaXToolDefinition {
  const { handler: _handler, registrationId: _registrationId, requiredParams: _requiredParams, source: _source, ...tool } = definition;
  return tool;
}

function getActiveToolRegistration(name: string): RegisteredToolDefinition | undefined {
  const registrations = TOOL_REGISTRY.get(name);
  if (!registrations || registrations.length === 0) {
    return undefined;
  }
  return registrations[registrations.length - 1];
}

function removeToolRegistration(registrationId: string): void {
  for (const [name, registrations] of TOOL_REGISTRY) {
    const nextRegistrations = registrations.filter(
      (registration) => registration.registrationId !== registrationId,
    );

    if (nextRegistrations.length === registrations.length) {
      continue;
    }

    if (nextRegistrations.length === 0) {
      TOOL_REGISTRY.delete(name);
    } else {
      TOOL_REGISTRY.set(name, nextRegistrations);
    }
    return;
  }
}

function registerToolInternal(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  const registrationId = `tool:${++nextToolRegistrationId}`;
  const source: ToolDefinitionSource = options.source ?? {
    kind: 'extension',
    id: registrationId,
    label: definition.name,
  };

  const registration: RegisteredToolDefinition = {
    ...definition,
    registrationId,
    requiredParams: extractRequiredParams(definition.input_schema),
    source,
  };

  const existing = TOOL_REGISTRY.get(definition.name) ?? [];
  TOOL_REGISTRY.set(definition.name, [...existing, registration]);

  return () => {
    removeToolRegistration(registrationId);
  };
}

/**
 * Classifier projection helper for `stage_*` construction tools whose input
 * is the artifact serialized as a JSON string. Parses opportunistically and
 * extracts `name@version` for the projection; falls back to "<unparseable>"
 * if the input is malformed (the classifier still sees the tool name as
 * context, so a parse failure is informative on its own).
 */
function stageArtifactPreview(artifactJson: string | undefined): string {
  if (typeof artifactJson !== 'string' || artifactJson.length === 0) {
    return '<no-artifact>';
  }
  try {
    const parsed = JSON.parse(artifactJson) as { name?: unknown; version?: unknown };
    const name = typeof parsed?.name === 'string' ? parsed.name : '<no-name>';
    const version = typeof parsed?.version === 'string' ? parsed.version : '<no-version>';
    return `${name}@${version}`;
  } catch {
    return '<unparseable>';
  }
}

const BUILTIN_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  {
    name: 'read',
    description: [
      'Read a file from the local filesystem with bounded output.',
      '- Text files: returns line-numbered content. Large files are capped per call; use offset/limit to continue in smaller slices.',
      '- Image files (PNG, JPG, JPEG, GIF, WEBP): returns the image as inline vision content. The model is multimodal — when an image is delivered through this tool, you can see the picture directly in your next turn. Describe what you see; do NOT claim binary files are unsupported.',
      '- For pasted/attached images already inlined in the user message, you already perceive them via native vision — no `read` call is needed. Use `read` on an image path only when the file is on disk and not yet in the conversation (e.g., a fresh path the user mentioned in text without attaching).',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from (text files only)' },
        limit: { type: 'number', description: 'Number of lines to read (text files only)' },
      },
      required: ['path'],
    },
    handler: toolRead,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'skill',
    description: [
      'Invoke a discovered skill by name. Returns the skill\'s expanded content (variables resolved) as the tool_result so you can follow its instructions in your next turn.',
      '- Use this whenever a skill listed in your "Available Skills" matches the user\'s request. The BLOCKING REQUIREMENT in the skills section binds on THIS tool, not on read.',
      '- DO NOT call `read` on a `SKILL.md` path to load a skill — skill loading is `skill`\'s job; `read` is for plain files.',
      '- `args` is an optional free-form string the skill resolver can substitute into its template (e.g. `args: "123"` for `/review-pr 123`). Most skills ignore it.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name (e.g. "commit", "review-pr"). Leading slash is tolerated.',
        },
        args: {
          type: 'string',
          description: 'Optional arguments forwarded to the skill resolver.',
        },
      },
      required: ['skill'],
    },
    handler: toolSkill,
    sideEffect: 'mutates-state',
    toClassifierInput: () => '',
  },
  {
    name: 'write',
    description:
      'Write a file to the local filesystem. Large diffs may be summarized in the tool result. '
      + 'ALWAYS prefer the `edit` tool over `write` when modifying an existing file — `edit` sends only the '
      + 'diff and avoids output-token pressure. Only use `write` to create new files or for a complete rewrite '
      + 'that the user explicitly asked for. '
      + 'For new files small enough to write in one pass, call `write` directly. For larger files, use this two-step pattern: '
      + '(1) `write(path, skeleton)` — a structural skeleton with placeholder markers like `<!-- SECTION_A -->` or '
      + '`// === SECTION_A ===`; (2) one `edit(path, "<!-- SECTION_A -->", <real content>)` '
      + 'per section. Each edit streams reliably. '
      + 'NEVER fall back to `bash` (python/node heredoc, `echo >`, `cat > file <<EOF`) to generate a source file — '
      + 'it bypasses mutation tracking, loses diff visibility, and recurses the same streaming limit onto the generator '
      + 'script itself. If a `write` failed mid-stream, retry with a smaller skeleton, then `edit` each section. '
      + 'Encoding note: `write` calls Node `fs.writeFile(path, content, "utf-8")` — the content goes directly from your '
      + 'tool_use input to disk WITHOUT passing through any shell. There are NO "Windows shell encoding issues" for `write`. '
      + 'Do NOT switch to `python`/`bash` scripts to "avoid encoding problems" — UTF-8 (including Chinese / emoji / etc.) '
      + 'works correctly through `write` by default, and routing through a shell script adds encoding surface area '
      + 'rather than removing it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    handler: toolWrite,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; content?: string };
      const size = typeof i?.content === 'string' ? i.content.length : 0;
      return `Write ${i?.path ?? '<unknown>'} (${size} bytes)`;
    },
  },
  {
    name: 'edit',
    description:
      'Perform safe exact-or-normalized string replacement in a file. '
      + 'ALWAYS prefer editing an existing file with `edit` over rewriting the whole file with `write` — '
      + '`edit` only sends the diff, avoiding output-token pressure and mid-stream truncation on large files. '
      + 'REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `edit`. '
      + 'If you skip the read, your `old_string` is almost certainly wrong and the edit will fail with an '
      + '"old_string not found" error — forcing a retry that costs more than the initial read. '
      + 'When making multiple independent edits to the same file, use `multi_edit` instead — one tool call '
      + 'batches N edits atomically. '
      + 'If the anchor is unstable, retry with a smaller unique snippet or use `insert_after_anchor`; '
      + 'do NOT fall back to `write` for the whole file as a recovery, because that discards the partial-edit context and re-streams the entire file — exactly what `edit` was designed to avoid.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    handler: toolEdit,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; replace_all?: boolean };
      return `Edit ${i?.path ?? '<unknown>'}${i?.replace_all ? ' [replace_all]' : ''}`;
    },
  },
  {
    name: 'multi_edit',
    description:
      'Apply multiple exact-text replacements to a single file in ONE tool call. '
      + 'Prefer this over N separate `edit` calls when you have several independent edits '
      + 'to the same file — especially when filling in a skeleton you just created with `write`. '
      + 'REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `multi_edit`. '
      + 'Skipping the read means your first failing `old_string` aborts the ENTIRE batch — '
      + 'you pay for all the edits in tokens but land none of them. '
      + 'Edits apply sequentially (each edit sees the result of the previous one), and the '
      + 'whole batch is ATOMIC: if any single old_string fails to match, NO edits are written '
      + 'to disk and you get back an index pointing at the failing edit. '
      + 'ANCHOR WARNING: edits compose — when edits[k] rewrites a region, text inside it stops '
      + 'being a valid anchor for edits[k+1..]. If later edits need to reference text an earlier '
      + 'edit overlaps, either shrink the earlier edit so it preserves that anchor, or merge them '
      + 'into one edit. '
      + 'UNIQUENESS RULE: each `old_string` must be unique in the WHOLE current file, not just in '
      + 'the window you last read. A short snippet from a narrow `read` (a single line, a 6-line '
      + 'window, a common phrase) is the #1 cause of "matched N places" errors. Widen the anchor '
      + 'with a nearby unique landmark (heading, function signature, distinctive comment, or a '
      + 'multi-line block), or set `replace_all: true` if every occurrence should change. '
      + 'Each `edits[i]` has the same semantics as one `edit` call — exact-match first, then '
      + 'safe-normalized anchor fallback; `replace_all: true` per edit for bulk renames. '
      + 'Typical skeleton-then-fill flow: '
      + '(1) `write(path, skeleton_with_<!-- SECTION_A -->_placeholders)`; '
      + '(2) `multi_edit(path, [{SECTION_A, realA}, {SECTION_B, realB}, ...])` — one batched call.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        edits: {
          type: 'array',
          description: 'Sequence of edit operations to apply in order',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'The text to replace (matched exactly, then via normalized fallback)' },
              new_string: { type: 'string', description: 'The replacement text' },
              replace_all: { type: 'boolean', description: 'When true, replace every occurrence of old_string (defaults to false)' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    handler: toolMultiEdit,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; edits?: unknown[] };
      const count = Array.isArray(i?.edits) ? i.edits.length : 0;
      return `MultiEdit ${i?.path ?? '<unknown>'}: ${count} edits`;
    },
  },
  {
    name: 'insert_after_anchor',
    description: 'Insert content after a unique anchor without rewriting the whole file. Prefer this for appending new sections to existing docs or configs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to update' },
        anchor: { type: 'string', description: 'A unique heading or nearby marker to insert after' },
        content: { type: 'string', description: 'The content to insert after the anchor' },
      },
      required: ['path', 'anchor', 'content'],
    },
    handler: toolInsertAfterAnchor,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; anchor?: string };
      const anchor = typeof i?.anchor === 'string' ? i.anchor.slice(0, 40) : '<no-anchor>';
      return `InsertAfterAnchor ${i?.path ?? '<unknown>'} after "${anchor}"`;
    },
  },
  {
    name: 'bash',
    description:
      'Execute a shell command. Use run_in_background for long-running commands. '
      + 'Large output may be truncated to the most relevant tail. '
      + 'When producing a SINGLE file whose content you already have, use the `write` / `edit` tools — '
      + 'do NOT route it through shell (no `cat > file <<EOF`, no `echo ... >`, no PowerShell `Set-Content` / '
      + '`Out-File`, no python/node heredoc). Shell redirection for a known-content file bypasses the mutation tracker, '
      + 'loses diff visibility to downstream verification, and re-encounters the same streaming limit on the generator '
      + 'script itself. Use a shell script ONLY when the output is computed (loops, templating over many files, data '
      + 'transformation of an input you are reading) — e.g. generating 50 similar test fixtures from a template is a '
      + 'legitimate script use; reproducing one hand-written HTML file you already have in memory is not. '
      + 'Appropriate uses of `bash`: tests, builds, lint, git, package managers, grep/ls/cat for inspection, '
      + 'process management, computed/templated multi-file generation.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Clear, concise description of what this command does' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
        run_in_background: {
          type: 'boolean',
          description: 'Run command in background. Returns immediately with output file path. Use read tool to check output later.',
        },
      },
      required: ['command'],
    },
    handler: toolBash,
    sideEffect: 'mutates-shell',
    // FEATURE_149 (v0.7.38) — `interruptBehavior` is intentionally LEFT
    // UNSET (defaults to 'wait'). KodaX mirrors Claude Code's conservative
    // posture here: SIGTERM-mid-bash leaves half-written files, half-pushed
    // git, half-mutated databases — letting a long shell finish + queueing
    // the new prompt is safer than aborting. CC's `BashTool` likewise has
    // no `interruptBehavior` override (default `'block'` in CC = our
    // `'wait'`). The fast-abort path in `InkREPL.tsx:handleSubmit` stays
    // wired so a future side-effect-free wait-only tool (Sleep, Wait,
    // Schedule) can opt in by tagging `'cancel'` — that's the only safe
    // shape for fast-abort.
    toClassifierInput: (input) => {
      const i = input as { command?: string };
      return `Bash: ${typeof i?.command === 'string' ? i.command : '<no-command>'}`;
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
    handler: toolGlob,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern in file contents. Supports context lines, multiline matching, file type filtering, and pagination.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern to search for in file contents' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to current working directory.' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
        type: { type: 'string', description: 'File type to search (e.g. js, ts, py, go, rust, java). More efficient than glob for standard types.' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode. "content" shows matching lines (default), "files_with_matches" shows file paths only, "count" shows match counts.',
        },
        ignore_case: { type: 'boolean', description: 'Case insensitive search (default false)' },
        '-i': { type: 'boolean', description: 'Alias for ignore_case' },
        '-A': { type: 'number', description: 'Number of lines to show after each match. Requires output_mode "content".' },
        '-B': { type: 'number', description: 'Number of lines to show before each match. Requires output_mode "content".' },
        '-C': { type: 'number', description: 'Alias for context' },
        context: { type: 'number', description: 'Number of lines to show before and after each match. Requires output_mode "content".' },
        multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.' },
        head_limit: { type: 'number', description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.' },
        offset: { type: 'number', description: 'Skip first N entries before applying head_limit. Defaults to 0.' },
      },
      required: ['pattern'],
    },
    handler: toolGrep,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'emit_managed_protocol',
    description: 'Internal-only managed-task protocol side-channel for scout/planner/handoff/verdict payloads.',
    input_schema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['scout', 'planner', 'generator', 'evaluator'],
          description: 'Managed worker role emitting a structured protocol payload',
        },
        payload: {
          type: 'object',
          description: 'Role-specific structured protocol payload',
        },
      },
      required: ['role', 'payload'],
    },
    handler: toolEmitManagedProtocol,
    sideEffect: 'mutates-state',
    toClassifierInput: () => '',
  },
  {
    name: 'dispatch_child_task',
    description: 'Execute a single child agent for an independent sub-task. The child runs its own multi-turn investigation loop and returns findings. Call multiple times in parallel for concurrent sub-tasks — each call appears as a separate tool with its own status in the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique child task identifier' },
        objective: { type: 'string', description: 'Detailed multi-step goal for this child agent' },
        readOnly: { type: 'boolean', description: 'true (default): child can only read files. false: child may edit files (Generator/Worker only); use for non-conflicting file-level edits across modules.' },
        scope_summary: { type: 'string', description: 'Optional scope hint (e.g. "packages/llm/src/")' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: 'Optional known evidence: "file:path", "diff:path", or "finding:text"' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
        // FEATURE_120 v0.7.39 Phase 4 — model tier hint. Routing is a
        // no-op for now; FEATURE_102 (v0.7.45) will translate this
        // to a concrete model selection. Surfacing the field now so
        // prompt-eval data starts accumulating.
        model_hint: {
          type: 'string',
          enum: ['fast', 'balanced', 'deep'],
          description: 'Optional hint for routing this child to a tier-appropriate model. "fast" for short lookups (read 1-2 files, simple grep); "balanced" (default; same as omit) for normal subtasks; "deep" for heavy reasoning (multi-file analysis, complex audit). Routing is currently a no-op (every child runs on the parent\'s model); a future routing feature will activate the hint. Mark "fast" only for trivial single-file lookups; mark "deep" only for multi-file research or analytical synthesis; when in doubt, omit.',
        },
        subagent_type: {
          type: 'string',
          description: 'When the task matches a registered specialist (e.g., db-reviewer for SQL changes, e2e-runner for browser tests), dispatch as that specialist instead of a generic child.',
        },
      },
      required: ['objective'],
    },
    handler: toolDispatchChildTask,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as { objective?: string; readOnly?: boolean };
      const obj = typeof i?.objective === 'string' ? i.objective.slice(0, 200) : '<no-objective>';
      const mutability = i?.readOnly === false ? 'mutating' : 'readonly';
      return `Dispatch(${mutability}): ${obj}`;
    },
  },
  // FEATURE_155 v0.7.39 Slice C1 — `await_child_task` registry entry
  // removed. Idle-yield is the canonical wait mechanic (Slice B1.D
  // default flip); the runner-driven outer loop in
  // `runManagedTaskViaRunnerInner` resumes any agent that exits
  // text-only with pending children when a `<task-completed>`
  // notification lands on the message queue.
  {
    name: 'send_message',
    description:
      'Append a refinement instruction to an in-flight child task launched via dispatch_child_task. The child will see your message as a <coordinator-instruction> block at its next LLM turn boundary. Use this when the user adds a follow-up requirement that affects a running child or when you realize the child needs additional context — but use it sparingly (typical pattern: 0-1 send_message per child), because a child needing more context mid-flight is usually a planning failure: you did not brief it well enough up front. Coordinator-only: child agents cannot call this tool. Returns confirmation or an error if the task_id is unknown.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Target child task_id (must match an id returned by a prior dispatch_child_task call). Completed children are auto-cleaned and become invalid targets. Broadcast (to: "*") is not yet supported.',
        },
        content: {
          type: 'string',
          description:
            'Instruction text to append to the child queue. Will be wrapped in a <coordinator-instruction>…</coordinator-instruction> block in the child\'s next user message.',
        },
      },
      required: ['to', 'content'],
    },
    handler: toolSendMessage,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as { to?: string; content?: string };
      const target = typeof i?.to === 'string' ? i.to : '<no-to>';
      const body =
        typeof i?.content === 'string' ? i.content.slice(0, 120) : '<no-content>';
      return `SendMessage(${target}): ${body}`;
    },
  },
  {
    name: 'task_stop',
    description:
      'Request graceful exit of a specific in-flight child task launched via dispatch_child_task. The child finishes its current tool call atomically (no hard kill — a 90s npm test won\'t be interrupted), sees an optional <coordinator-stop-request> message explaining why, then emits a final summary. Use when: child went off-scope (e.g. started writing files when launched read-only), user cancelled the parent task that justified the child, or child is pathologically slow with no progress signal. Coordinator-only: child agents cannot call this tool.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'Target child task_id (from a prior dispatch_child_task call). Completed children are auto-cleaned and become invalid targets.',
        },
        reason: {
          type: 'string',
          description:
            'Optional explanation. When provided, the child receives a <coordinator-stop-request> system-reminder with this reason BEFORE the abort fires, so it can frame its final summary accordingly. Omitting the reason still aborts the child; only the explanation is skipped.',
        },
      },
      required: ['task_id'],
    },
    handler: toolTaskStop,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as { task_id?: string; reason?: string };
      const target = typeof i?.task_id === 'string' ? i.task_id : '<no-task_id>';
      const why = typeof i?.reason === 'string' ? i.reason.slice(0, 80) : '';
      return `TaskStop(${target})${why ? ': ' + why : ''}`;
    },
  },
  {
    name: 'task_output',
    description:
      'Peek at the current state of a child task launched via dispatch_child_task. Returns a structured snapshot (status, iteration count, recent tool-call breadcrumbs, and final text once the child settles). Use when interleaving useful work between idle-yields and you need to decide whether to dispatch a sibling, call task_stop on a stuck child, or just keep waiting. Default block:false returns the current snapshot immediately. Set block:true to wait up to timeout_ms for the child to finish — but prefer idle-yield (end the turn text-only) for waits; block:true is for tightly-scoped synchronous patterns only. Coordinator-only: child agents cannot call this tool. Completed children\'s snapshots remain queryable for the lifetime of the parent runner; very old snapshots may be evicted under a per-runner cap.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'Target child task_id (from a prior dispatch_child_task call). Returns retrieval_status=not_found if the task was never dispatched or its snapshot has been evicted.',
        },
        block: {
          type: 'boolean',
          description:
            'When true, wait for the child to settle (up to timeout_ms) before returning the snapshot. When false (default), return the current snapshot immediately without waiting. Use block:false for status peeks during interleaved work; block:true only for tightly-scoped synchronous patterns. Idle-yield (end turn text-only) is the canonical wait — do not use block:true as a substitute for it, because block:true holds your turn open synchronously while idle-yield ends your turn so the user can chat with you while children run.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Max wait time in milliseconds when block:true. Default 30000 (30s), max 120000 (120s). Ignored when block:false. On timeout, returns the current snapshot with retrieval_status=timeout.',
        },
      },
      required: ['task_id'],
    },
    handler: toolTaskOutput,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as { task_id?: string; block?: boolean };
      const target = typeof i?.task_id === 'string' ? i.task_id : '<no-task_id>';
      const mode = i?.block === true ? ' (block)' : '';
      return `TaskOutput(${target})${mode}`;
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for discovery-oriented results with explicit trust and freshness signaling. Use this for "discover what is out there" queries when you do not yet have a specific URL — researching a library before integrating it, finding canonical docs for an API, identifying current best-practice patterns. Output includes provenance + trust signals; when relaying answers to the user, cite sources back in markdown link format (`[title](url)`). Pair with `web_fetch` to follow up on a specific result. Search results are geographically scoped (US-based) and freshness metadata reflects when each source was last indexed, not the moment of your query — interpret "current X" with that caveat. For finding code or documentation INSIDE the repo, prefer `grep` / `code_search` / `semantic_lookup` — those operate on the local checkout and do not consume network turns.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run' },
        limit: { type: 'number', description: 'Maximum number of search results to return' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed search' },
      },
      required: ['query'],
    },
    handler: toolWebSearch,
    sideEffect: 'mutates-network',
    // Plan mode permits web_search: it's functionally a query (no remote
    // mutation), common in planning workflows ("research the API before
    // I propose the change"). web_fetch is NOT planModeAllowed because
    // it can issue POST/PUT requests that mutate remote state.
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'web_fetch',
    description: 'Fetch a specific remote source by URL and return bounded text with provenance and trust hints. The handler converts HTML to markdown and caches each unique URL for a short window so repeated reads within the same task are free. If the response is a redirect (3xx), the tool stops and reports the new target URL — re-issue `web_fetch` against that new URL rather than chasing the redirect manually, so the cache + provenance line up with what the user actually sees. For GitHub URLs specifically (`github.com/...` / `raw.githubusercontent.com/...`), prefer `bash` with the `gh` CLI when available — `gh api` / `gh pr view` / `gh issue view` are faster, return structured output, and avoid markdown-conversion artifacts; using `web_fetch` on a github.com URL when `gh` would work is the most common "tool waste" pattern in this surface. Despite the `mutates-network` side-effect classification (some providers route POST requests through this surface), the LLM-facing semantics are read-only. Use `web_search` first when you do not yet have a specific URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote URL to fetch' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed fetch' },
        capability_id: { type: 'string', description: 'Optional provider capability id for provider-backed fetch' },
      },
    },
    handler: toolWebFetch,
    sideEffect: 'mutates-network',
    toClassifierInput: (input) => {
      const i = input as { url?: string };
      return `WebFetch ${typeof i?.url === 'string' ? i.url : '<no-url>'}`;
    },
  },
  {
    name: 'code_search',
    description: 'Search local repository code with lower-noise output than ad hoc shell grep. Returns ranked matches with file:line refs and surrounding context, filtered by repo-aware heuristics (skips minified bundles, generated artifacts, lockfiles by default). Prefer `code_search` over `grep` for "find symbol X" / "where is this string used" investigations spanning the whole repo — the noise reduction saves token budget on the result side. Prefer raw `grep` when you need exact byte-level matching (regex anchors, character classes, multiline patterns) or when scoping is already narrow (a known single file or small subdirectory). For symbol-level intelligence (callers, callees, imports), use `symbol_context` instead — it pre-resolves the relationships that a text search would only hint at.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String query to search for' },
        path: { type: 'string', description: 'Optional file or directory scope for the search' },
        limit: { type: 'number', description: 'Maximum number of matches to return' },
        case_sensitive: { type: 'boolean', description: 'Whether the query should be matched case-sensitively' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed code search' },
      },
      required: ['query'],
    },
    handler: toolCodeSearch,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'semantic_lookup',
    description: 'Search repository intelligence for symbol-, module-, or process-aware semantic matches. "Repository intelligence" here is a pre-indexed structural view of the codebase (symbol definitions, module boundaries, process flows); `semantic_lookup` queries that index rather than scanning raw text. Use it when the question is structural ("what does symbol X relate to", "which module owns concept Y", "what flow does entry Z drive") rather than textual. The `kind` parameter narrows the lookup category (`symbol` / `module` / `process` / `auto`); `target_path` scopes to a subtree. `refresh: true` rebuilds the underlying index — expensive — so only set it when you have reason to believe the index is stale (e.g., right after a large bulk edit). For exact text match prefer `grep`; for ranked text search prefer `code_search`; to read a file directly prefer `read`.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic query to resolve inside repository intelligence' },
        kind: {
          type: 'string',
          enum: ['auto', 'symbol', 'module', 'process'],
          description: 'Optional semantic lookup category',
        },
        target_path: { type: 'string', description: 'Optional path hint to scope the semantic lookup' },
        limit: { type: 'number', description: 'Maximum number of semantic matches to return' },
        refresh: { type: 'boolean', description: 'When true, refresh repository intelligence before searching' },
      },
      required: ['query'],
    },
    handler: toolSemanticLookup,
    // sideEffect: 'readonly' — 95% of calls are pure queries against an
    // existing repo-intel index. The `refresh: true` option rebuilds the
    // local index (a derived-data side effect, not a source-tree mutation),
    // which the classifier projection surfaces; plan mode permits the read
    // path and the handler can gate refresh internally if needed.
    sideEffect: 'readonly',
    // refresh: true rebuilds the repo-intel snapshot (disk side effect),
    // so this is not strictly Tier 1 — surface name + truncated input via
    // the helper so the classifier can see when refresh is requested.
    toClassifierInput: (input) => defaultToClassifierInput('semantic_lookup', input),
  },
  {
    name: 'mcp_search',
    description: 'Search active MCP tools, resources, and prompts through the shared capability runtime. The KodaX MCP surface is a meta-tool layer: capabilities live on remote MCP servers, and `mcp_search` is the discovery entry point. Returns capability ids in `server.name` form. Batch-call `mcp_describe` on the ids you actually plan to use rather than describing every result — describing capabilities you will not call wastes a turn. The `kind` filter (`tool` / `resource` / `prompt`) narrows the family: tools are the only family that can mutate remote state via `mcp_call`; resources are reads via `mcp_read_resource`; prompts are templates via `mcp_get_prompt`. The `server` filter scopes to a specific MCP server when multiple are connected.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run against active MCP catalogs' },
        server: { type: 'string', description: 'Optional MCP server id filter' },
        kind: {
          type: 'string',
          enum: ['tool', 'resource', 'prompt'],
          description: 'Optional MCP capability family filter',
        },
        limit: { type: 'number', description: 'Maximum number of search results to return' },
      },
      required: ['query'],
    },
    handler: toolMcpSearch,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'mcp_describe',
    description: 'Describe a specific MCP capability by id, including its full JSON Schema, trust tier, and provenance. Use this when `mcp_search` returned a candidate id and you need to see the exact parameter shape before invoking it. `mcp_describe` is a pure read against the MCP server catalog — safe to call freely, but redundant: only describe capabilities you actually plan to call. The schema returned is the source of truth for `mcp_call.args` / `mcp_get_prompt.args` shape; do not guess argument names from the capability id alone.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpDescribe,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'mcp_call',
    description: 'Invoke an MCP tool capability by id with structured arguments. This is the ONLY side-effecting MCP entry point — the underlying capability can mutate remote state (file writes, database updates, API calls). Treat each `mcp_call` with the same care as a `bash` command against an unfamiliar shell: confirm the capability is what you intend by `mcp_describe` first when uncertain. The `id` is the `server.name` form from `mcp_search`; `args` must match the JSON Schema returned by `mcp_describe`. For pure reads use `mcp_read_resource` (no mutation) or `mcp_get_prompt` (template retrieval) instead — `mcp_call` is overkill when the goal is just reading.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP tool capability id from mcp_search' },
        args: {
          type: 'object',
          description: 'Structured arguments for the MCP tool call',
        },
      },
      required: ['id'],
    },
    handler: toolMcpCall,
    sideEffect: 'mutates-network',
    toClassifierInput: (input) => {
      const i = input as { id?: string; args?: unknown };
      const capability = typeof i?.id === 'string' ? i.id : '<no-id>';
      // Capability id (from mcp_search) is the "server.tool" form already.
      // Split on the first '.' to recover the real server / tool pair so the
      // helper produces `MCP[server.tool]: …` (not `MCP[server.tool.call]`).
      const dotIdx = capability.indexOf('.');
      const server = dotIdx > 0 ? capability.slice(0, dotIdx) : capability;
      const tool = dotIdx > 0 ? capability.slice(dotIdx + 1) : '<no-tool>';
      return mcpToClassifierInput(server, tool, i?.args ?? {});
    },
  },
  {
    name: 'mcp_read_resource',
    description: 'Read an MCP resource capability by id. Resources are server-published read-only data sources — file contents, query results, config snapshots — and `mcp_read_resource` retrieves them without invoking remote code. Unlike `mcp_call`, this entry point cannot mutate remote state, so it is safe to use during plan-mode preview. The `id` is the `server.name` form from `mcp_search` (with `kind="resource"` filter). Use `mcp_call` instead when the capability is registered as a tool (mutation-capable), and `mcp_get_prompt` when it is a templated prompt.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP resource capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpReadResource,
    sideEffect: 'mutates-network',
    // Plan mode permits MCP read-resource: it's a read against the
    // remote server, functionally a query. mcp_call is NOT
    // planModeAllowed because it can invoke arbitrary MCP tools that
    // mutate remote state.
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'mcp_get_prompt',
    description: 'Retrieve an MCP prompt capability by id, expanding any template arguments. Prompts are server-published reusable text templates (system prompt snippets, structured query templates, task framings); `mcp_get_prompt` returns the expanded text after substituting `args`. Read-only with respect to remote state — the server resolves the template but does not run code. The `id` is the `server.name` form from `mcp_search` (with `kind="prompt"` filter); `args` must match the prompt template variables (which `mcp_describe` will list).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP prompt capability id from mcp_search' },
        args: {
          type: 'object',
          description: 'Optional arguments for the MCP prompt',
        },
      },
      required: ['id'],
    },
    handler: toolMcpGetPrompt,
    sideEffect: 'mutates-network',
    // Plan mode permits MCP get-prompt: it's a read of a server-side
    // prompt definition, functionally a query.
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'worktree_create',
    description: 'Create a new git worktree with an isolated branch for safe agent work.',
    input_schema: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: 'Optional explicit branch name' },
        description: { type: 'string', description: 'Optional description to auto-generate branch name from' },
      },
    },
    handler: toolWorktreeCreate,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { branch_name?: string; description?: string };
      const branch = typeof i?.branch_name === 'string'
        ? i.branch_name
        : (typeof i?.description === 'string' ? `<auto from "${i.description.slice(0, 40)}">` : '<auto>');
      return `WorktreeCreate ${branch}`;
    },
  },
  {
    name: 'worktree_remove',
    description: 'Remove a git worktree and optionally its branch.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['keep', 'remove'],
          description: 'Whether to keep or remove the worktree directory and branch',
        },
        worktree_path: { type: 'string', description: 'Absolute path to the worktree directory' },
        discard_changes: {
          type: 'boolean',
          description: 'If true, bypass safety checks for uncommitted changes or local commits',
        },
      },
      required: ['action', 'worktree_path'],
    },
    handler: toolWorktreeRemove,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { action?: string; worktree_path?: string; discard_changes?: boolean };
      const flags = i?.discard_changes ? ' [discard_changes]' : '';
      return `WorktreeRemove ${i?.action ?? '<no-action>'} ${i?.worktree_path ?? '<no-path>'}${flags}`;
    },
  },
  {
    name: 'undo',
    description: 'Revert the last file modification.',
    input_schema: { type: 'object', properties: {} },
    handler: toolUndo,
    sideEffect: 'mutates-fs',
    toClassifierInput: () => 'Undo: revert last file modification',
  },
  {
    name: 'ask_user_question',
    description: 'Ask the user a question. Supports single-select (default), multi-select, or free-text input. When you have multiple independent questions, use the "questions" array — each question is presented separately with its own options. Do NOT combine multiple questions into a single question string, because combining forces the user to mentally disambiguate option combinations themselves, which usually breaks the option-button UI.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user. Use this for a single question. For multiple independent questions, use the "questions" array instead.' },
        questions: {
          type: 'array',
          description: 'Multiple independent questions (1-4). Each question is presented separately with its own options. Use this instead of combining multiple questions into a single "question" string. Takes precedence over "question"+"options" when provided.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text' },
              header: { type: 'string', description: 'Short label (max 12 chars) shown in progress indicator, e.g. "环境" or "Deploy"' },
              options: {
                type: 'array',
                description: 'Available options for this question.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Display label for this option' },
                    description: { type: 'string', description: 'Optional description of this option' },
                    value: { type: 'string', description: 'Optional value to return (defaults to label)' },
                  },
                  required: ['label'],
                },
              },
              multi_select: {
                type: 'boolean',
                description: 'Allow multiple selections for this question.',
              },
            },
            required: ['question', 'options'],
          },
          minItems: 1,
          maxItems: 4,
        },
        kind: {
          type: 'string',
          enum: ['select', 'input'],
          description: 'Interaction kind. "select" (default) shows options for the user to pick from. "input" shows a free-text prompt for the user to type anything. Use "input" when the user needs to provide an open-ended answer (e.g. step combinations like "1,3,5", version numbers, custom text).',
        },
        options: {
          type: 'array',
          description: 'Available options for the user to choose from. Required for kind="select", ignored for kind="input".',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Display label for this option' },
              description: { type: 'string', description: 'Optional description of this option' },
              value: { type: 'string', description: 'Optional value to return (defaults to label)' },
            },
            required: ['label'],
          },
        },
        multi_select: {
          type: 'boolean',
          description: 'Allow the user to select multiple options (space to toggle, enter to confirm). Only applies to kind="select". Returns comma-separated values.',
        },
        default: { type: 'string', description: 'Optional default choice (for select) or default text (for input)' },
      },
      required: ['question'],
    },
    handler: toolAskUserQuestion,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'exit_plan_mode',
    description: 'Exit plan mode by presenting the finalized plan to the user for approval. On approval, the session flips to accept-edits and implementation can proceed. On rejection, the session remains in plan mode so the plan can be revised. Use this tool once the plan is ready for user review — do NOT combine with set_permission_mode. Parent-only: requires an interactive approval UI (wired only in REPL sessions).',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The finalized plan to present to the user. Include the full plan content, not a summary, so the user can make an informed approval decision. Keep the plan tight: at most 40 lines total, 3 bullet-depth levels, one sentence per bullet. If the plan exceeds this budget, split it into phases and present only the current phase — the user can approve phase-by-phase.',
        },
      },
      required: ['plan'],
    },
    handler: toolExitPlanMode,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_update',
    description:
      'Drive the visible plan checklist so the user sees real-time progress — single-item PATCH plus status transition. '
      + '`op="update"` (default; omit `op` for back-compat) is the primary mode: target ONE item by `id` and either change its status, patch its fields, or both in one call.\n\n'
      + 'For ADDING new items (initial plan commitment or mid-task additive growth), use a batch of `todo_create` calls instead — purely additive and safe. The legacy `op="init"` whole-list replace path is reserved for runner-side seeding only; LLMs should not call it because it destructively drops any item not echoed back, which weaker models routinely under-echo and lose completed work.\n\n'
      + 'Status transitions:\n'
      + '- `in_progress` — set BEFORE starting work on an item. When transitioning to `in_progress`, ALWAYS supply `activeForm` (present-continuous rephrasing of the subject, e.g. subject "Run failing tests" → activeForm "Running failing tests") so the spinner shows the user what you are working on right now.\n'
      + '- `completed` — set AFTER finishing that item.\n'
      + '- Only ONE item should be `in_progress` per owner at any time — finish or fail the current item before starting the next.\n'
      + '- `failed` — an attempt clearly failed and needs retry.\n'
      + '- `skipped` — the item turned out to be unnecessary (e.g. planner-driven merging of two obligations into one).\n'
      + '- `cancelled` — you decide mid-execution to drop an item the user no longer needs; UI shows strikethrough as a visible breadcrumb of the discarded record.\n'
      + '- `deleted` — remove the item from the visible list entirely (no breadcrumb). Prefer `deleted` over `cancelled` when the item was wholly off-plan; prefer `cancelled` when the user benefits from seeing the discarded record.\n\n'
      + 'Field patches (status optional when only patching):\n'
      + '- `subject` (non-empty string) replaces the brief imperative title shown in the row.\n'
      + '- `description` (string; empty clears) replaces the fuller context shown by todo_get.\n'
      + '- `evaluator` ("build" | "test" | "lint") replaces the deterministic evaluator hint.\n'
      + '- `metadata` (object | null) — pass null to CLEAR the whole bag; pass an object to shallow-merge keys; inside the object, a value of null DELETES that specific key from existing metadata (mixed merge+delete in one call is supported, e.g. `{newKey: "v", oldKey: null}`).\n'
      + '- Patch fields can be combined with a status transition in a single call.\n\n'
      + 'Error handling:\n'
      + '- `ok=false` with reason "Unknown todo id" — inspect the listed valid ids and retry with a correct one.\n'
      + '- `ok=false` with reason "todo_update is not active" — the current run has no plan list; continue working without further todo_update calls.\n'
      + '- `ok=false` with reason "blocked-by-hook" (or an extension-supplied string) — an extension policy rejected the transition; re-read the visible plan and revise your approach before retrying.',
    input_schema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['init', 'update'],
          description:
            'Operation mode. Default "update" when omitted — mutate one item by `id`. "init" (legacy / runner-side seeding only) replaces the whole list with `items`; LLMs should NOT call it — it destructively drops any item not echoed back. Use a batch of `todo_create` calls for both initial commitment and mid-task plan growth.',
        },
        items: {
          type: 'array',
          description:
            'op="init" (legacy / runner-side only) payload. Each entry: {id: non-empty string (unique within list), subject: non-empty string (brief title), description?: string (fuller context), activeForm?: present-continuous string}. LLMs should use a batch of `todo_create` calls instead.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique non-empty item id (e.g. "todo_1").' },
              subject: { type: 'string', description: 'Brief imperative title shown in the plan-list row (e.g. "Run failing tests").' },
              description: {
                type: 'string',
                description: 'Optional fuller context / work instructions read when this item is later picked up (todo_get surface). Multi-line OK. Skip when subject alone is enough.',
              },
              activeForm: {
                type: 'string',
                description: 'Optional present-continuous form (e.g. "Running failing tests") shown by the spinner when this item flips to in_progress.',
              },
              evaluator: {
                type: 'string',
                enum: ['build', 'test', 'lint'],
                description: 'Optional per-step deterministic evaluator. When set and the item flips to "completed", the runner runs `npm run build` / `npm test` / `npm run lint` accordingly; failure surfaces stderr in your next tool result. Use sparingly — only on milestone steps.',
              },
            },
            required: ['id', 'subject'],
            // Note: ideally we'd set `additionalProperties: false` here so
            // an LLM passing `{id, content, status:'pending'}` (mixing
            // init-item shape with update shape) gets a schema-validation
            // error rather than a silent drop. But `KodaXToolDefinition['input_schema']`
            // does not currently model that field (see `packages/llm/src/types.ts:113`).
            // Runtime validator in `executeInitOp` already destructures only
            // the known keys, so extra fields are dropped harmlessly. Schema-layer
            // hardening tracked as a separate type-extension follow-up.
          },
        },
        id: {
          type: 'string',
          description: 'op="update" only. The id of the todo item to update (e.g. "todo_3"). Must match a current valid id in the plan list.',
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'failed', 'skipped', 'cancelled', 'deleted'],
          description:
            'op="update" only. New status. Optional — when omitted you may still patch subject/description/activeForm/note/evaluator/metadata. '
            + '"pending" is intentionally not allowed — items start as pending automatically and only the runner moves them back to pending after a revise verdict. '
            + '"cancelled" signals a Worker-driven mid-execution decision to drop the item; UI shows strikethrough. '
            + '"deleted" removes the item from the visible list entirely — use when the item turned out to be wholly irrelevant and you do not want a strikethrough breadcrumb. The matching extension event is `todo:deleted`.',
        },
        note: {
          type: 'string',
          description: 'op="update" only. Optional free-text reason or detail. When omitted, any pre-existing note on the item is preserved.',
        },
        activeForm: {
          type: 'string',
          description:
            'op="update" only. Present-continuous form of the item subject (e.g. "Running failing tests"). Required when status="in_progress" so the spinner can show the user what you are doing right now. Omitted on completed/failed/skipped (the previous activeForm is preserved but irrelevant once the item leaves in_progress).',
        },
        subject: {
          type: 'string',
          description:
            'op="update" only. Optional. When provided, REPLACES the brief imperative title shown in the plan-list row. Use for mid-task plan refinement (e.g. "Run failing tests" → "Run failing tests AND clean up tmp"). Must be a non-empty string.',
        },
        description: {
          type: 'string',
          description:
            'op="update" only. Optional. When provided, REPLACES the fuller context (work instruction). Multi-line OK. Pass empty string to clear an existing description.',
        },
        evaluator: {
          type: 'string',
          enum: ['build', 'test', 'lint'],
          description:
            'op="update" only. Optional. When provided, REPLACES the item\'s deterministic evaluator hint. When the item later flips to "completed", the runner runs the corresponding deterministic check and surfaces stderr on failure.',
        },
        metadata: {
          // Note: the handler also accepts JSON `null` as an explicit clear
          // signal (sets metadata back to undefined on the item). JSON Schema
          // `type:'object'` does NOT include null in its strict sense — providers
          // that pre-validate tool inputs against the schema may need a
          // `nullable:true` extension. KodaXToolDefinition['input_schema'] does
          // not currently model that field (see `packages/llm/src/types.ts`);
          // handler is authoritative.
          type: 'object',
          description:
            'op="update" only. Optional opaque key-value bag. Semantics: shallow-merge — top-level keys overwrite (nested objects are NOT deep-merged); a value of `null` inside the object DELETES that key from existing metadata; mixed merge+delete in one call is supported (e.g. `{newKey: "v", oldKey: null}`); pass the whole `metadata` field as `null` (NOT inside an object) to clear ALL metadata (handler accepts top-level null even though the JSON Schema is `type:"object"`). The UI does NOT render metadata; it is for extension hooks / eval harnesses.',
        },
      },
      // No top-level required fields — the handler validates per-op:
      //   op="init"   → requires `items`
      //   op="update" → requires `id` plus at least one of
      //     {status, subject, description, activeForm, note, evaluator, metadata}.
    },
    handler: toolTodoUpdate,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_create',
    description:
      'Insert ONE new pending item into the visible plan list — purely additive, existing items untouched. ' +
      'Use for plan commitment (one call per planned step, batched in the same response) AND for mid-task additive growth when an extra step is needed.\n\n' +
      'Field semantics:\n' +
      '- `subject` (required) — brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers")\n' +
      '- `description` (optional) — fuller context / work instructions read when this item is later picked up via todo_get; multi-line OK; NOT rendered in the compact row\n' +
      '- `activeForm` (optional) — present-continuous form (e.g. "Auditing handleAuth callers") shown by the spinner when this item later flips to `in_progress` via todo_update\n' +
      '- `evaluator` (optional, "build" | "test" | "lint") — runs the corresponding deterministic check when the item flips to "completed". Use sparingly, only on milestone steps with a real ground-truth check\n' +
      '- `metadata` (optional) — opaque key-value bag carried alongside the item for extension hooks / observability; the UI does NOT render it\n\n' +
      'The store auto-generates the id (monotonic `todo_N`). Never pass an id — any caller-supplied id is rejected at the schema layer.\n\n' +
      'Returns {ok: true, id: "todo_<n>"} on success or {ok: false, reason: "..."} when the store is not wired, validation fails, or an extension hook blocks the create.',
    input_schema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").',
        },
        description: {
          type: 'string',
          description: 'Optional fuller context / work instructions read when this item is later picked up via todo_get. Multi-line OK; NOT rendered in the compact row. Skip when subject alone is enough.',
        },
        activeForm: {
          type: 'string',
          description:
            'Optional present-continuous form (e.g. "Running failing tests"). Shown by the spinner when this item later flips to `in_progress`.',
        },
        evaluator: {
          type: 'string',
          enum: ['build', 'test', 'lint'],
          description:
            'Optional per-step deterministic evaluator. When set and the item later flips to "completed" via todo_update, the runner runs `npm run build` / `npm test` / `npm run lint` accordingly; failure surfaces stderr in your next tool result. Use sparingly — only on milestone steps with a real ground-truth check.',
        },
        metadata: {
          type: 'object',
          description:
            'Optional opaque key-value bag carried alongside the item. Used by extension hooks / eval harnesses. The UI does NOT render metadata. Omit if you have nothing structured to attach.',
        },
      },
      required: ['subject'],
    },
    handler: toolTodoCreate,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_list',
    description:
      'Read-only query that returns the current visible plan list as JSON. Use this when you want to confirm what items are pending before deciding the next move, when you need to see the canonical id set after an "Unknown todo id" error, or when refining a plan and want to compare it against the existing list. ' +
      'Returns {ok: true, count: N, items: [{id, subject, status, description?, activeForm?, note?}, ...]} on success; {ok: false, reason: "todo_list is not active ..."} when no plan list infrastructure is wired (no managed task active). ' +
      'This tool is read-only — it never mutates the store. Pair with `todo_create` to add new steps additively, `todo_update` to change item state, or `todo_get` to fetch a single item with full detail (incl. description / metadata / evaluator).',
    input_schema: {
      type: 'object',
      properties: {},
    },
    handler: toolTodoList,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_get',
    description:
      'Read-only single-item lookup. Returns the full TodoItem detail for one id (subject + optional description + status + activeForm + note + evaluator + metadata).\n\n' +
      'When to use:\n' +
      '- BEFORE calling todo_update when uncertain about an item\'s current state — runner-side auto-handlers may have flipped statuses between your turns; mutating on a stale view produces silent no-op patches.\n' +
      '- WHEN PICKING UP an item — the full `description` carries the work instruction; the compact row label (`subject`) alone often is not enough.\n' +
      '- AFTER an "Unknown todo id" error on todo_update — first use todo_list to see all ids, then todo_get to drill into the specific one.\n\n' +
      'Returns {ok: true, item: {...}} on success or {ok: false, reason: "..."} when the store is not wired or the id is unknown (the reason carries the canonical valid-id list).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The todo id to retrieve (e.g. "todo_3"). Must match a current valid id.',
        },
      },
      required: ['id'],
    },
    handler: toolTodoGet,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'repo_overview',
    description: 'Summarize the repository structure, key areas, entry hints, and stored repo-intelligence snapshot for the current workspace. Returns a compact top-down map: monorepo packages or top-level directories, entry files, primary languages, build/test commands. Use this once at session start (or after switching into an unfamiliar area) to orient yourself before issuing targeted reads — calling it at the start of every task is wasteful because the snapshot rarely changes within a session. The `refresh` flag rebuilds the snapshot; expensive, so only set it after a structural change to the workspace (new package added, large directory move). For drilling into a specific module, use `module_context` instead.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild the repo overview snapshot before returning it' },
      },
    },
    handler: toolRepoOverview,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_scope',
    description: 'Analyze which files, areas, and categories are touched by the current git diff or a comparison range. This is the canonical entry point for any review / change-audit / commit-prep workflow — call it first to see the change surface before issuing per-file diffs. Returns files grouped by area/category (e.g., "tests", "docs", "core") with a one-line summary per file. The `scope` parameter selects which change set: `unstaged` (working tree vs HEAD), `staged` (index vs HEAD), `all` (working tree + index vs HEAD, default), `compare` (HEAD vs base_ref). Pair with `changed_diff_bundle` to fetch the actual diffs for the files identified.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        scope: {
          type: 'string',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          description: 'Which git change set to inspect. Defaults to all.',
        },
        base_ref: { type: 'string', description: 'Base ref used when scope=compare. Defaults to HEAD~1.' },
        refresh_overview: { type: 'boolean', description: 'When true, rebuild the repo overview snapshot before analyzing changes' },
      },
    },
    handler: toolChangedScope,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff',
    description: 'Read a paged diff slice for a specific changed file. Prefer this over broad git diff output during large reviews.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        base_ref: { type: 'string', description: 'Optional base git ref for compare-range review' },
        target_ref: { type: 'string', description: 'Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)' },
        path: { type: 'string', description: 'Changed file path to inspect, relative to the workspace root or absolute inside it' },
        offset: { type: 'number', description: '1-based diff line offset for pagination' },
        limit: { type: 'number', description: 'Maximum diff lines to return in this slice' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: ['path'],
    },
    handler: toolChangedDiff,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff_bundle',
    description: 'Read diff slices for multiple changed files in one call. Prefer this for large reviews before drilling down with changed_diff.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        base_ref: { type: 'string', description: 'Optional base git ref for compare-range review' },
        target_ref: { type: 'string', description: 'Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)' },
        paths: {
          type: 'array',
          description: 'Changed file paths to inspect in one bundle, relative to the workspace root or absolute inside it',
          items: { type: 'string' },
        },
        offset: { type: 'number', description: '1-based diff line offset applied to each path in the bundle' },
        limit_per_path: { type: 'number', description: 'Maximum diff lines to return per path in this bundle' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: ['paths'],
    },
    handler: toolChangedDiffBundle,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'module_context',
    description: 'Return a task-shaped module capsule with dependencies, entry files, top-level symbols, test files, docs, and follow-up handles for further drill-down. Use this when about to read 3+ files in the same module — the capsule replaces that exploration round-trip with one structured response. Prefer `module_context` over raw `read`+`grep` for "what does this module do / what depends on what" questions. When the question is about a single function or class, use `symbol_context` instead — it is cheaper because it scopes to one symbol. When you only need exact file content (line numbers, byte-level text), fall back to `read` after the capsule narrows the target. `refresh: true` rebuilds the underlying repo-intel index, which is expensive — only set it when you have reason to believe the index is stale.',
    input_schema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module id, label, or package name to inspect' },
        target_path: { type: 'string', description: 'Optional path used to infer the enclosing module' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the module capsule' },
      },
    },
    handler: toolModuleContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'symbol_context',
    description: 'Return the definition, probable callers/callees, imports, and naming alternatives for a single repository symbol. Use this when tracing the usage of one function, class, or constant — the response pre-resolves the relationships that would otherwise take several `grep -n "symbolName"` + `read` rounds to assemble. Cheaper than `module_context` when the question is symbol-scoped rather than module-scoped (the callers/callees graph is bounded by symbol degree, not module surface). The `module` parameter disambiguates when the same symbol name appears in multiple packages. For "where is this exact string used" without symbol semantics, prefer `grep` or `code_search` instead. For impact estimation before a refactor, use `impact_estimate` — it combines symbol info with changed-scope overlap.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to inspect' },
        module: { type: 'string', description: 'Optional module hint to disambiguate the symbol search' },
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the symbol capsule' },
      },
    },
    handler: toolSymbolContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'process_context',
    description: 'Return an approximate static execution/process capsule for an entry symbol, module, or path. Use this when the question is "how does this flow execute" rather than "what depends on what" — `process_context` traces from an entry point through likely call paths, giving you the sequence of file/symbol transitions without N rounds of follow-up reads. The `entry` parameter is the starting point (function name, file path, or module label); `module` is an optional disambiguating hint. Prefer over `module_context` when you care about runtime sequence, not module structure; prefer over `symbol_context` when you need the multi-hop call chain rather than just direct callers/callees. The trace is static (no runtime sampling), so it captures plausible paths, not actual hit rates.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Entry symbol or file hint for the process to trace' },
        module: { type: 'string', description: 'Optional module hint used to select a process capsule' },
        target_path: { type: 'string', description: 'Optional path used to infer the relevant module or entry file' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the process capsule' },
      },
    },
    handler: toolProcessContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'impact_estimate',
    description: 'Estimate the blast radius of changing a symbol, path, or module — combines repo-intelligence usage graph with current changed-scope overlap. Call this BEFORE planning a rename, refactor, or breaking change, not after the work is started — its purpose is to scope the work up front so the plan reflects reality (which packages need touching, which call sites assume current behavior, which tests must update). Returns ranked impact sites with severity hints. Prefer over guessing impact from a `grep` of the symbol name — `grep` overcounts (matches strings + comments) and undercounts (misses re-exports + structural callers). The `refresh` flag rebuilds the underlying index — expensive — so reserve it for cases where a recent large edit may have invalidated the cached graph.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional symbol to estimate impact for' },
        module: { type: 'string', description: 'Optional module to estimate impact for' },
        path: { type: 'string', description: 'Optional repository-relative or absolute path to estimate impact for' },
        target_path: { type: 'string', description: 'Optional path used to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the impact estimate' },
      },
    },
    handler: toolImpactEstimate,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  // ====================================================================
  // Tool Construction (FEATURE_087 + FEATURE_088, v0.7.28)
  //
  // Five-step staircase the LLM walks through to author and ship a tool
  // at runtime: scaffold → validate → stage → test → activate. The
  // generated artifact lands in `.kodax/constructed/tools/<name>/<version>.json`
  // and the activated handler is registered into TOOL_REGISTRY for use
  // in subsequent turns. Gated at the agent layer: not exposed unless
  // the session is in tool-construction mode.
  // ====================================================================
  {
    name: 'scaffold_tool',
    description:
      'Generate a fillable ConstructionArtifact JSON skeleton for a new tool. Returns a draft you must edit before calling validate_tool / stage_construction. '
      + 'Use this as the FIRST step when authoring a runtime tool — do NOT hand-write the JSON shape from scratch.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name (must match the value the LLM will use to invoke it).' },
        version: { type: 'string', description: 'Semver string. Defaults to "0.1.0".' },
        description: { type: 'string', description: 'One-sentence description of what the tool does.' },
        capabilities: {
          type: 'object',
          description: 'Optional starter capabilities; defaults to {tools: []}.',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Whitelist of builtin tool names the handler may call via ctx.tools.<name>.',
            },
          },
        },
      },
      required: ['name'],
    },
    handler: toolScaffoldTool,
    sideEffect: 'mutates-fs',
    toClassifierInput: () => '',
  },
  {
    name: 'validate_tool',
    description:
      'Dry-run validate a candidate tool artifact JSON: shape sanity + AST hard rules (no-eval / no-Function-constructor / require-handler-signature) + provider schema validation. '
      + 'Does NOT touch disk. Use this BEFORE stage_construction to fail fast on malformed handlers.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full ConstructionArtifact as a JSON string.' },
        provider: {
          type: 'string',
          description: "Provider whose tool-schema constraints are checked. Defaults to 'anthropic'.",
        },
      },
      required: ['artifact_json'],
    },
    handler: toolValidateTool,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'stage_construction',
    description:
      'Persist an artifact to .kodax/constructed/<kind>s/<name>/<version>.json with status=staged. Refuses to overwrite an active artifact at the same name+version (bump the version instead). '
      + 'Run validate_tool first; this tool itself does not re-validate the AST or schema.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full ConstructionArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageConstruction,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageTool: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_tool',
    description:
      'Run the full Phase 2 check pipeline (shape → AST → provider schema → handler materialize) on a staged artifact. Returns ok=true/false plus errors/warnings. '
      + 'On ok=true the artifact is ready for activate_tool. LLM static review is NOT run from this tool — the calling agent must drive that separately if desired.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact name as stored on disk.' },
        version: { type: 'string', description: 'Artifact version as stored on disk.' },
        provider: {
          type: 'string',
          description: "Provider whose tool-schema constraints are checked. Defaults to 'anthropic'.",
        },
      },
      required: ['name', 'version'],
    },
    handler: toolTestTool,
    sideEffect: 'mutates-state',
    toClassifierInput: () => '',
  },
  {
    name: 'activate_tool',
    description:
      'Activate a staged-and-tested artifact. Invokes the construction policy gate, registers the handler into TOOL_REGISTRY, flips status=active. The tool is then immediately callable as `<name>` in subsequent turns. '
      + 'Policy: in the Ink REPL, an approve/reject dialog is shown to the user; in non-interactive surfaces (ACP / single-shot CLI / child agents) activation is rejected by default to prevent silent activation.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact name to activate.' },
        version: { type: 'string', description: 'Artifact version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateTool,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as { name?: string; version?: string };
      return `ActivateTool: ${i?.name ?? '<no-name>'}@${i?.version ?? '<no-version>'}`;
    },
  },
  // ====================================================================
  // FEATURE_089 (v0.7.31) — runtime AGENT construction staircase. Mirrors
  // the FEATURE_088 tool-construction tools above. Each tool produces a
  // manifest under `.kodax/constructed/agents/<name>/<version>.json`.
  // The activated agent goes through `Runner.admit` (FEATURE_101 5-step
  // audit) at test time. Gated at the agent layer:
  // `filterAgentConstructionToolNames` mirrors the tool-construction
  // gate; not exposed unless the session enables agent-construction mode.
  // ====================================================================
  {
    name: 'scaffold_agent',
    description:
      'Generate a fillable AgentArtifact JSON skeleton for a new agent. Returns a draft you must edit before calling validate_agent / stage_agent_construction. '
      + 'Use this as the FIRST step when authoring a runtime agent — do NOT hand-write the JSON shape from scratch.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name (resolver lookup key once activated).' },
        version: { type: 'string', description: 'Semver string. Defaults to "0.1.0".' },
        description: {
          type: 'string',
          description: 'One-sentence description of the agent\'s purpose. Becomes the lead line of `instructions`.',
        },
      },
      required: ['name'],
    },
    handler: toolScaffoldAgent,
    sideEffect: 'mutates-fs',
    toClassifierInput: () => '',
  },
  {
    name: 'validate_agent',
    description:
      'Dry-run admission audit on a candidate agent manifest JSON: schema validation + invariant.admit hooks + tool-capability cap + budget cap + handoff DAG check. '
      + 'Does NOT touch disk. Use this BEFORE stage_agent_construction to fail fast on rejected manifests.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolValidateAgent,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'stage_agent_construction',
    description:
      'Persist an agent manifest to .kodax/constructed/agents/<name>/<version>.json with status=staged. Refuses to overwrite an existing same-name+version (bump the version instead). '
      + 'Run validate_agent first; this tool itself does not re-run admission.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageAgentConstruction,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageAgent: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_agent',
    description:
      'Run the agent test pipeline (manifest shape check + Runner.admit + sandbox case execution) on a staged agent. '
      + 'Returns ok=true/false with errors / warnings. On ok=true the agent is ready for activate_agent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name as stored on disk.' },
        version: { type: 'string', description: 'Agent version as stored on disk.' },
      },
      required: ['name', 'version'],
    },
    handler: toolTestAgent,
    sideEffect: 'mutates-state',
    toClassifierInput: () => '',
  },
  {
    name: 'activate_agent',
    description:
      'Activate a staged-and-tested agent. Invokes the construction policy gate, flips status=active, records contentHash, '
      + 'and registers the agent in the resolver so Runner.run can find it by name. '
      + 'Policy: in the Ink REPL, an approve/reject dialog is shown to the user; in non-interactive surfaces activation is rejected by default.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name to activate.' },
        version: { type: 'string', description: 'Agent version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateAgent,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as { name?: string; version?: string };
      return `ActivateAgent: ${i?.name ?? '<no-name>'}@${i?.version ?? '<no-version>'}`;
    },
  },

  // ====================================================================
  // FEATURE_090 (v0.7.32) — Self-modify staircase. The stage step is
  // separated from `stage_agent_construction` (above) so the LLM picks
  // its intent explicitly: "I am modifying myself" vs "I am creating
  // a different agent." Test/activate are reused from FEATURE_089 —
  // admission audit + sandbox runner work identically regardless of
  // which stage tool produced the manifest.
  // ====================================================================
  {
    name: SELF_MODIFY_TOOL_NAME,
    description:
      'Stage a new version of YOURSELF — the active constructed agent calling this tool. '
      + 'Requires artifact.name === artifact.sourceAgent === your own name, plus an existing active version on disk. '
      + 'Runs hard checks (guardrail ratchet — cannot remove existing guardrails; reasoning ceiling; modification budget) before persisting. '
      + 'Then call test_agent and activate_agent on the staged version. Activation force-prompts the user (no auto-approve for self-modify) and only takes effect on the NEXT Runner.run, never within the run that submitted the change.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: {
          type: 'string',
          description: 'The full AgentArtifact as a JSON string. artifact.name must equal artifact.sourceAgent.',
        },
      },
      required: ['artifact_json'],
    },
    handler: toolStageSelfModify,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageSelfModify: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  // FEATURE_189 Batch 3 B.2 — progressive disclosure bootstrap. Always
  // loaded so the LLM can fetch full schemas for deferred tools (mcp_*,
  // web_*, repo-intel) on demand. See `tool-search.ts` + `deferred-tools.ts`.
  TOOL_SEARCH_DEFINITION,
];

for (const definition of BUILTIN_TOOL_DEFINITIONS) {
  registerToolInternal(definition, {
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  });
}

export const KODAX_TOOLS: KodaXToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.map((definition) => {
  const { handler: _handler, ...tool } = definition;
  return tool;
});

export function registerTool(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  return registerToolInternal(definition, options);
}

export function getTool(name: string): ToolHandler | undefined {
  return getActiveToolRegistration(name)?.handler;
}

export function getToolDefinition(name: string): KodaXToolDefinition | undefined {
  const registration = getActiveToolRegistration(name);
  return registration ? toToolDefinition(registration) : undefined;
}

export function getRegisteredToolDefinition(name: string): RegisteredToolDefinition | undefined {
  return getActiveToolRegistration(name);
}

export function getToolRegistrations(name: string): RegisteredToolDefinition[] {
  return [...(TOOL_REGISTRY.get(name) ?? [])];
}

export function getBuiltinToolDefinition(name: string): KodaXToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  const { handler: _handler, ...tool } = definition;
  return tool;
}

export function getBuiltinRegisteredToolDefinition(
  name: string,
): RegisteredToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }

  return {
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  };
}

export function createBuiltinToolDefinition(
  name: string,
): LocalToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  return {
    ...definition,
    input_schema: definition.input_schema
      ? JSON.parse(JSON.stringify(definition.input_schema))
      : definition.input_schema,
  };
}

export function listBuiltinToolDefinitions(): RegisteredToolDefinition[] {
  return BUILTIN_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  }));
}

/**
 * v0.7.42 — snapshot of every currently-active tool registration.
 *
 * Returns the most-recent registration for each tool name (mirroring
 * {@link getRegisteredToolDefinition}'s single-name semantics across the
 * full registry). Use this to drive metadata-based filters such as:
 *
 *   - SDK embedder permission brokers building a blocklist by side-effect class:
 *     `getAllRegisteredTools().filter(t => t.sideEffect !== 'readonly')`
 *   - UI that displays available tools grouped by category.
 *   - Plan-mode gates that compute their own blocklist from metadata
 *     instead of hardcoded `Set<string>` of names.
 *
 * The returned array is a fresh copy per call (safe to mutate without
 * affecting the registry). Order is registration order (sorted by name
 * within each registration to keep the snapshot deterministic).
 */
export function getAllRegisteredTools(): RegisteredToolDefinition[] {
  const result: RegisteredToolDefinition[] = [];
  for (const [name] of TOOL_REGISTRY) {
    const active = getActiveToolRegistration(name);
    if (active) result.push(active);
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

/**
 * v0.7.42 — plan-mode permit check driven by tool metadata.
 *
 *   - `sideEffect === 'readonly'` ⇒ permitted (unless explicitly
 *     `planModeAllowed: false`).
 *   - `planModeAllowed: true` ⇒ permitted (overrides non-readonly).
 *   - any other sideEffect ⇒ blocked.
 *
 * Returns `false` for unknown tool names (fail-closed). Use this in
 * preference to hardcoded `Set<string>` of tool names — adding a new
 * `'mutates-fs'` builtin will flow through automatically.
 */
export function isToolPlanModeAllowed(name: string): boolean {
  const def =
    getActiveToolRegistration(name)
    ?? BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!def) return false;
  if (def.planModeAllowed === true) return true;
  if (def.planModeAllowed === false) return false;
  return def.sideEffect === 'readonly';
}

/**
 * v0.7.42 — does this tool mutate the filesystem?
 *
 * Wraps `sideEffect === 'mutates-fs'`. Used by the REPL permission
 * pipeline's gitRoot guard and Space's permission broker. Replaces the
 * previous practice of hardcoding `Set(["write", "edit"])`-style lookups
 * scattered across 5+ callsites.
 */
export function isToolFileMutation(name: string): boolean {
  const def =
    getActiveToolRegistration(name)
    ?? BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  return def?.sideEffect === 'mutates-fs';
}

/**
 * v0.7.42 — does this tool mutate anything (FS, shell, network, state)?
 *
 * True for every `sideEffect` except `'readonly'`. Fail-closed (unknown
 * names return `true` — assumed mutating until proven otherwise).
 */
export function isToolMutation(name: string): boolean {
  const def =
    getActiveToolRegistration(name)
    ?? BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!def) return true;
  return def.sideEffect !== 'readonly';
}

export function getRequiredToolParams(name: string): string[] {
  return getActiveToolRegistration(name)?.requiredParams ?? [];
}

export function listTools(): string[] {
  return Array.from(TOOL_REGISTRY.keys())
    .filter((name) => getActiveToolRegistration(name) !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

export function listToolDefinitions(): KodaXToolDefinition[] {
  return listTools()
    .map((name) => getToolDefinition(name))
    .filter((definition): definition is KodaXToolDefinition => definition !== undefined);
}

export function isRepoIntelligenceWorkingToolName(name: string): boolean {
  return REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET.has(name);
}

export function filterRepoIntelligenceWorkingToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isRepoIntelligenceWorkingToolName(name));
}

export function isMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_SET.has(name);
}

export function filterMcpToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isMcpToolName(name));
}

/**
 * Detect whether a handler's return value is an AsyncGenerator (streaming tool).
 * Async generators have Symbol.asyncIterator; Promises do not.
 */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    value !== null
    && value !== undefined
    && typeof value === 'object'
    && Symbol.asyncIterator in (value as object)
  );
}

/**
 * Consume an async generator: forward each yield as a progress update,
 * then return the generator's final return value.
 *
 * NOTE: `for await...of` does NOT capture the return value of a generator.
 * We must use manual .next() iteration to capture `{ done: true, value }`.
 */
async function consumeToolGenerator(
  gen: AsyncGenerator<import('./types.js').ToolProgress, string, void>,
  onProgress?: (message: string) => void,
): Promise<string> {
  let step = await gen.next();
  while (!step.done) {
    const progress = step.value;
    if (progress && typeof progress.message === 'string') {
      onProgress?.(progress.message);
    }
    step = await gen.next();
  }
  // step.done === true → step.value is the return value (string)
  return step.value;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const definition = getRegisteredToolDefinition(name);
  if (!definition) {
    return `[Tool Error] Unknown tool: ${name}. Available tools: ${listTools().join(', ')}`;
  }

  const missing = definition.requiredParams.filter(
    (param) => input[param] === undefined || input[param] === null,
  );
  if (missing.length > 0) {
    return `[Tool Error] ${name}: Missing required parameter(s): ${missing.join(', ')}`;
  }

  try {
    const result = definition.handler(input, ctx);

    // Streaming tool (async generator): consume yields as progress, return final value
    if (isAsyncGenerator(result)) {
      return await consumeToolGenerator(
        result as AsyncGenerator<import('./types.js').ToolProgress, string, void>,
        ctx.reportToolProgress,
      );
    }

    // Standard tool (Promise<string>): await as before
    return await (result as Promise<string>);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('ENOENT')) {
      return `[Tool Error] ${name}: File or directory not found`;
    }
    if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
      return `[Tool Error] ${name}: Permission denied`;
    }
    if (errorMsg.includes('ENOSPC')) {
      return `[Tool Error] ${name}: No space left on device`;
    }
    return `[Tool Error] ${name}: ${errorMsg}`;
  }
}
