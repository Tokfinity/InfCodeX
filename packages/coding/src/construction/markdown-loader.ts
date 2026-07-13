/**
 * FEATURE_191 (v0.7.43) — markdown-defined agent loader.
 *
 * Scans two directories for user/project-authored agent definitions
 * (claudecode-style `<name>.md` with YAML frontmatter + body) and
 * registers them as constructed agents via `Runner.admit` →
 * `registerConstructedAgent`. Two-tier path (user first, then project)
 * with `last-write-wins` semantics implements precedence: a project
 * agent of the same name shadows the user agent (the more-specific
 * scope wins).
 *
 * Markdown shape:
 *
 *   ---
 *   name: db-reviewer
 *   description: Reviews DB migrations for safety
 *   tools: [read, grep]
 *   model: claude-sonnet-4-6
 *   effort: high
 *   ---
 *   You are a DB migration reviewer. ...
 *
 * Files without YAML frontmatter, or with a missing `name`, are
 * silently skipped (claudecode-compatible: a `.md` without
 * frontmatter is treated as a reference doc). Files with frontmatter
 * but a missing/invalid `description` are reported as failures so the
 * REPL can surface diagnostics.
 *
 * `mcpServers` / `hooks` / `memory` / `isolation` / `permissionMode` /
 * `maxTurns` / `skills` frontmatter fields are ignored in v0.7.43 — they
 * are intentional non-goals; each one is an independent product
 * decision. Ignoring them silently keeps user `.md` files
 * forward-compatible across future feature versions.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Runner, getAgentConfigHome, type Agent, type AgentManifest } from '@kodax-ai/agent';
import { normalizeReasoningEffortValue } from '@kodax-ai/llm';
import { parseYamlFrontmatter } from '@kodax-ai/agent/capabilities/skills/shared/yaml';

import { buildAdmissionManifest, parseToolNameFromRef } from './admission-bridge.js';
import {
  createConstructedAgentEntry,
  createConstructedAgentScope,
  listConstructedAgents,
  listConstructedAgentsWithSource,
  releaseConstructedAgentEntry,
  registerConstructedAgent,
  type ConstructedAgentEntry,
  type ConstructedAgentRegistration,
  type KodaXAgentScope,
} from './agent-resolver.js';
import type { AgentArtifact, AgentContent, ToolRef } from './types.js';
import { getRegisteredToolDefinition } from '../tools/registry.js';

/**
 * Per-file failure record returned to the boot caller. Mirrors
 * claudecode's `getAgentDefinitionsWithOverrides.failedFiles` shape so
 * the REPL `/agents list` diagnostic can surface per-file reasons
 * instead of a global count.
 */
export interface MarkdownLoadFailure {
  readonly path: string;
  readonly reason: string;
}

export interface LoadAgentsFromMarkdownResult {
  readonly loaded: number;
  readonly failed: readonly MarkdownLoadFailure[];
}

export interface LoadAgentsFromMarkdownOptions {
  /**
   * Project root. Defaults to `process.cwd()`. Project agents live at
   * `<cwd>/.kodax/agents/*.md` and override user-level agents of the
   * same name via last-write-wins (loaded second).
   */
  readonly cwd?: string;
  /**
   * Override for the user-level config home. Defaults to the agent
   * runtime's resolved config home (`getAgentConfigHome()`, e.g.
   * `~/.kodax`). User agents live at `<configHome>/agents/*.md` and
   * are loaded before project agents.
   */
  readonly configHome?: string;
  /** Bind only user-owned definitions. Used by remote serving trust boundaries. */
  readonly userOnly?: boolean;
}

export interface LoadMarkdownAgentScopeOptions extends LoadAgentsFromMarkdownOptions {
  /** Stable host-chosen id for diagnostics. Defaults to the resolved project cwd. */
  readonly id?: string;
}

export interface MarkdownAgentToolFilter {
  readonly name: string;
  readonly reason: 'not-registered' | 'admission-clamped';
}

export interface MarkdownAgentLoadWarning {
  readonly path: string;
  readonly agentName?: string;
  readonly reason: string;
}

export interface LoadedMarkdownAgent {
  readonly name: string;
  readonly description: string;
  readonly source: 'markdown:user' | 'markdown:project';
  readonly path: string;
  readonly requestedTools?: readonly string[];
  readonly effectiveTools?: readonly string[];
  /** Omitted means all trusted effective Skills; [] means none; ['*'] means all. */
  readonly requestedSkills?: readonly string[];
  readonly filteredTools: readonly MarkdownAgentToolFilter[];
  readonly admissionWarnings: readonly string[];
}

export interface LoadMarkdownAgentScopeResult {
  readonly scope: KodaXAgentScope;
  readonly loaded: readonly LoadedMarkdownAgent[];
  readonly failed: readonly MarkdownLoadFailure[];
  readonly warnings: readonly MarkdownAgentLoadWarning[];
  dispose(): Promise<void>;
}

/**
 * FEATURE_197 (v0.7.43) — discovered markdown agent metadata.
 *
 * Read-only counterpart to `ConstructedAgentEntry` exposed by
 * `discoverMarkdownAgents`. Differs from `ConstructedAgentEntry` in
 * three ways: (1) no resolved `Agent` runtime object — discovery is
 * purely file-system-side; (2) `source` is narrowed to the two
 * markdown scopes only; (3) `path` carries the source file location
 * so consumers can offer "open file" affordances.
 */
export interface DiscoveredMarkdownAgent {
  /** Agent name from frontmatter `name` field. */
  readonly name: string;
  /** Agent description from frontmatter `description` field. */
  readonly description: string;
  /** Provenance: which scope the file was found in. */
  readonly source: 'markdown:user' | 'markdown:project';
  /** Absolute path of the markdown file on disk. */
  readonly path: string;
  /**
   * Tool names declared in the frontmatter `tools` field, normalized
   * to a string array. The `builtin:` prefix that the loader applies
   * to `ToolRef`s is NOT applied here — discovery returns the raw
   * names the user wrote.
   */
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  /** Optional model alias from frontmatter `model` field. */
  readonly model?: string;
  /** Optional reasoning effort from frontmatter `effort` field. */
  readonly effort?: string;
}

export interface DiscoverMarkdownAgentsResult {
  /**
   * Well-formed agents found in the scanned directories. Same
   * last-write-wins precedence as `loadAgentsFromMarkdown`: when a
   * name appears in both user and project scopes, the project entry
   * wins and the user entry is omitted. The returned set mirrors
   * exactly what `loadAgentsFromMarkdown` would activate.
   */
  readonly agents: readonly DiscoveredMarkdownAgent[];
  /** Files that had frontmatter but failed validation. */
  readonly failed: readonly MarkdownLoadFailure[];
}

const USER_AGENTS_DIRNAME = 'agents';
const PROJECT_AGENTS_DIRNAME = '.kodax/agents';

function markdownAgentDirectories(
  opts: LoadAgentsFromMarkdownOptions,
): ReadonlyArray<readonly [string, 'markdown:user' | 'markdown:project']> {
  const userDir = join(opts.configHome ?? getAgentConfigHome(), USER_AGENTS_DIRNAME);
  if (opts.userOnly) return [[userDir, 'markdown:user']];
  const projectDir = join(opts.cwd ?? process.cwd(), PROJECT_AGENTS_DIRNAME);
  return [[userDir, 'markdown:user'], [projectDir, 'markdown:project']];
}

/**
 * Entry point. Scans user then project dirs; registers every
 * well-formed agent that passes admission. Failures are accumulated
 * into the result instead of throwing — a single malformed file must
 * not break boot.
 */
export async function loadAgentsFromMarkdown(
  opts: LoadAgentsFromMarkdownOptions = {},
): Promise<LoadAgentsFromMarkdownResult> {
  const failures: MarkdownLoadFailure[] = [];
  let loaded = 0;

  // User dir first, then project — last-write-wins implements
  // precedence (project shadows user when names collide).
  for (const [dir, source] of markdownAgentDirectories(opts)) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const outcome = await loadOneAgentFile(filePath, source);
      if (outcome.ok) {
        loaded += 1;
      } else if (outcome.reason !== null) {
        failures.push({ path: filePath, reason: outcome.reason });
      }
      // outcome.reason === null → silent skip (no frontmatter / no name)
    }
  }

  return { loaded, failed: failures };
}

async function listMarkdownFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir);
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = join(dir, entry);
      try {
        const st = await stat(full);
        if (st.isFile()) out.push(full);
      } catch {
        // Symlink to a deleted target or transient race — skip.
      }
    }
    return out;
  } catch {
    // Directory does not exist (the common case for fresh installs).
    return [];
  }
}

type LoadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string | null };

async function loadOneAgentFile(
  filePath: string,
  source: 'markdown:user' | 'markdown:project',
): Promise<LoadOutcome> {
  const admitted = await admitOneMarkdownAgentFile(
    filePath,
    source,
    () => new Map(listConstructedAgents().map((a) => [a.name, a])),
  );
  if (admitted.kind === 'silent-skip') return { ok: false, reason: null };
  if (admitted.kind === 'fail') return { ok: false, reason: admitted.reason };
  registerConstructedAgent(
    admitted.artifact,
    admitted.registration,
  );
  return { ok: true };
}

export async function loadMarkdownAgentScope(
  opts: LoadMarkdownAgentScopeOptions = {},
): Promise<LoadMarkdownAgentScopeResult> {
  const cwd = opts.cwd ?? process.cwd();

  const failures: MarkdownLoadFailure[] = [];
  const warnings: MarkdownAgentLoadWarning[] = [];
  const entriesByName = new Map<string, ConstructedAgentEntry>();
  const ownedEntriesByName = new Map<string, ConstructedAgentEntry>();
  const loadedByName = new Map<string, LoadedMarkdownAgent>();

  for (const entry of listConstructedAgentsWithSource()) {
    if (entry.source === 'markdown:user' || entry.source === 'markdown:project') {
      continue;
    }
    entriesByName.set(entry.agent.name, entry);
  }

  const activatedAgents = () =>
    new Map(Array.from(entriesByName.values()).map((entry) => [entry.agent.name, entry.agent]));

  for (const [dir, source] of markdownAgentDirectories({ ...opts, cwd })) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const admitted = await admitOneMarkdownAgentFile(filePath, source, activatedAgents);
      if (admitted.kind === 'silent-skip') continue;
      if (admitted.kind === 'fail') {
        failures.push({ path: filePath, reason: admitted.reason });
        warnings.push(...admitted.warnings);
        continue;
      }
      const entry = createConstructedAgentEntry(admitted.artifact, admitted.registration);
      const shadowedOwnedEntry = ownedEntriesByName.get(entry.agent.name);
      if (shadowedOwnedEntry) {
        releaseConstructedAgentEntry(shadowedOwnedEntry);
      }
      entriesByName.set(entry.agent.name, entry);
      ownedEntriesByName.set(entry.agent.name, entry);
      loadedByName.set(entry.agent.name, admitted.loaded);
      warnings.push(...admitted.warnings);
    }
  }

  const ownedEntries = Array.from(ownedEntriesByName.values());
  const scope = createConstructedAgentScope({
    id: opts.id ?? cwd,
    entries: Array.from(entriesByName.values()),
    ownedEntries,
  });

  return {
    scope,
    loaded: Array.from(loadedByName.values()),
    failed: failures,
    warnings,
    dispose: async () => {
      scope.dispose();
    },
  };
}

type ActivatedAgentsProvider = () => Map<string, Agent>;

type AdmitMarkdownOutcome =
  | { readonly kind: 'ok'; readonly artifact: AgentArtifact; readonly registration: ConstructedAgentRegistration; readonly loaded: LoadedMarkdownAgent; readonly warnings: readonly MarkdownAgentLoadWarning[] }
  | { readonly kind: 'silent-skip' }
  | { readonly kind: 'fail'; readonly reason: string; readonly warnings: readonly MarkdownAgentLoadWarning[] };

async function admitOneMarkdownAgentFile(
  filePath: string,
  source: 'markdown:user' | 'markdown:project',
  activatedAgents: ActivatedAgentsProvider,
): Promise<AdmitMarkdownOutcome> {
  const parseOutcome = await parseMarkdownAgentFile(filePath);
  if (parseOutcome.kind === 'silent-skip') return { kind: 'silent-skip' };
  if (parseOutcome.kind === 'fail') {
    return { kind: 'fail', reason: parseOutcome.reason, warnings: [] };
  }

  const { name, description, instructions, toolNames, skillNames, model, effort } = parseOutcome.parsed;
  const filteredTools: MarkdownAgentToolFilter[] = [];
  const warnings: MarkdownAgentLoadWarning[] = [];
  const toolResolution = resolveMarkdownToolRefs(filePath, name, toolNames);
  filteredTools.push(...toolResolution.filteredTools);
  warnings.push(...toolResolution.warnings);
  if (toolResolution.kind === 'fail') {
    return {
      kind: 'fail',
      reason: toolResolution.reason,
      warnings,
    };
  }

  const content: AgentContent = {
    instructions,
    description,
    ...(toolResolution.tools !== undefined ? { tools: toolResolution.tools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };

  const manifest = buildAdmissionManifest({ name, content });
  const verdict = await Runner.admit(manifest, { activatedAgents: activatedAgents() });
  if (!verdict.ok) {
    return { kind: 'fail', reason: `admission rejected: ${verdict.reason}`, warnings };
  }

  const effectiveToolNames = effectiveManifestToolNames(verdict.handle.manifest, toolNames);
  const admissionClampedTools = findAdmissionClampedTools(
    toolResolution.resolvedToolNames,
    effectiveToolNames,
  );
  filteredTools.push(...admissionClampedTools);
  for (const tool of admissionClampedTools) {
    warnings.push({
      path: filePath,
      agentName: name,
      reason: `tool "${tool.name}" was removed by admission`,
    });
  }

  const effectiveContent = withEffectiveTools(content, effectiveToolNames);
  const now = Date.now();
  const artifact: AgentArtifact = {
    kind: 'agent',
    name,
    version: '0.0.0-markdown',
    content: effectiveContent,
    status: 'active',
    createdAt: now,
    testedAt: now,
    activatedAt: now,
  };

  return {
    kind: 'ok',
    artifact,
    registration: {
      bindings: verdict.handle.invariantBindings,
      manifest: verdict.handle.manifest,
      source,
    },
    loaded: {
      name,
      description,
      source,
      path: filePath,
      ...(toolNames !== undefined ? { requestedTools: toolNames } : {}),
      ...(effectiveToolNames !== undefined ? { effectiveTools: effectiveToolNames } : {}),
      ...(skillNames !== undefined ? { requestedSkills: skillNames } : {}),
      filteredTools,
      admissionWarnings: verdict.clampNotes,
    },
    warnings,
  };
}

type ToolResolutionOutcome =
  | {
      readonly kind: 'ok';
      readonly tools?: readonly ToolRef[];
      readonly resolvedToolNames: readonly string[];
      readonly filteredTools: readonly MarkdownAgentToolFilter[];
      readonly warnings: readonly MarkdownAgentLoadWarning[];
    }
  | {
      readonly kind: 'fail';
      readonly reason: string;
      readonly resolvedToolNames: readonly string[];
      readonly filteredTools: readonly MarkdownAgentToolFilter[];
      readonly warnings: readonly MarkdownAgentLoadWarning[];
    };

function resolveMarkdownToolRefs(
  filePath: string,
  agentName: string,
  toolNames: readonly string[] | undefined,
): ToolResolutionOutcome {
  if (toolNames === undefined) {
    return {
      kind: 'ok',
      resolvedToolNames: [],
      filteredTools: [],
      warnings: [],
    };
  }

  if (toolNames.length === 0) {
    return {
      kind: 'ok',
      tools: [],
      resolvedToolNames: [],
      filteredTools: [],
      warnings: [],
    };
  }

  const tools: ToolRef[] = [];
  const resolvedToolNames: string[] = [];
  const filteredTools: MarkdownAgentToolFilter[] = [];
  const warnings: MarkdownAgentLoadWarning[] = [];

  for (const rawName of toolNames) {
    const ref = rawName.includes(':') ? rawName : `builtin:${rawName}`;
    const toolName = parseToolNameFromRef(ref);
    if (!getRegisteredToolDefinition(toolName)) {
      filteredTools.push({ name: rawName, reason: 'not-registered' });
      warnings.push({
        path: filePath,
        agentName,
        reason: `unknown tool ref "${rawName}" was ignored`,
      });
      continue;
    }
    tools.push({ ref });
    resolvedToolNames.push(toolName);
  }

  if (tools.length === 0) {
    return {
      kind: 'fail',
      reason: `frontmatter "tools" did not resolve any registered tools: ${toolNames.join(', ')}`,
      resolvedToolNames,
      filteredTools,
      warnings,
    };
  }

  return {
    kind: 'ok',
    tools,
    resolvedToolNames,
    filteredTools,
    warnings,
  };
}

function effectiveManifestToolNames(
  manifest: AgentManifest,
  requestedTools: readonly string[] | undefined,
): readonly string[] | undefined {
  if (requestedTools === undefined) return undefined;
  return (manifest.tools ?? [])
    .map((tool) => ('name' in tool && typeof tool.name === 'string' ? tool.name : undefined))
    .filter((name): name is string => name !== undefined);
}

function findAdmissionClampedTools(
  resolvedToolNames: readonly string[],
  effectiveToolNames: readonly string[] | undefined,
): readonly MarkdownAgentToolFilter[] {
  if (effectiveToolNames === undefined) return [];
  const effective = new Set(effectiveToolNames);
  return resolvedToolNames
    .filter((name) => !effective.has(name))
    .map((name) => ({ name, reason: 'admission-clamped' as const }));
}

function withEffectiveTools(
  content: AgentContent,
  effectiveToolNames: readonly string[] | undefined,
): AgentContent {
  if (effectiveToolNames === undefined || content.tools === undefined) return content;
  const effective = new Set(effectiveToolNames);
  return {
    ...content,
    tools: content.tools.filter((tool) => effective.has(parseToolNameFromRef(tool.ref))),
  };
}

/**
 * FEATURE_197 (v0.7.43) — read-only counterpart to
 * `loadAgentsFromMarkdown`. Scans the same two-tier path (user dir
 * then project dir) and returns metadata for every well-formed
 * agent found, WITHOUT calling `Runner.admit` or
 * `registerConstructedAgent`. Pure file-system + YAML parse — no
 * mutation of the in-memory agent registry.
 *
 * SDK consumers building an "agent picker" UI call this to preview
 * available agents before deciding whether (and when) to call
 * `loadAgentsFromMarkdown` to activate them.
 *
 * Validation semantics match `loadAgentsFromMarkdown` exactly so
 * that `discoverMarkdownAgents` + `loadAgentsFromMarkdown` agree on
 * which files are well-formed:
 *   - Missing/empty `description` → reported in `failed`
 *   - Empty body → reported in `failed`
 *   - No frontmatter / missing `name` → silently skipped (treated
 *     as reference doc, claudecode parity)
 *   - I/O error on a single file → reported in `failed`
 *
 * Precedence: project entries shadow user entries of the same name
 * (last-write-wins via `Map.set`), matching the loader's effective
 * activation order. Consumers wanting to see shadowed user entries
 * should run a separate pass with `cwd` pointing at a non-existent
 * dir — feature not added by default per YAGNI.
 *
 * Does NOT validate against admission invariants — discovered
 * agents may still be rejected when `loadAgentsFromMarkdown` runs
 * (e.g. unknown tool refs). Validation happens at load time.
 */
export async function discoverMarkdownAgents(
  opts: LoadAgentsFromMarkdownOptions = {},
): Promise<DiscoverMarkdownAgentsResult> {
  const failed: MarkdownLoadFailure[] = [];
  // Map keyed by name → last-write-wins (project shadows user).
  const byName = new Map<string, DiscoveredMarkdownAgent>();

  for (const [dir, source] of markdownAgentDirectories(opts)) {
    const files = await listMarkdownFiles(dir);
    for (const filePath of files) {
      const outcome = await parseMarkdownAgentFile(filePath);
      if (outcome.kind === 'ok') {
        byName.set(outcome.parsed.name, {
          name: outcome.parsed.name,
          description: outcome.parsed.description,
          source,
          path: filePath,
          ...(outcome.parsed.toolNames !== undefined
            ? { tools: outcome.parsed.toolNames }
            : {}),
          ...(outcome.parsed.skillNames !== undefined
            ? { skills: outcome.parsed.skillNames }
            : {}),
          ...(outcome.parsed.model !== undefined ? { model: outcome.parsed.model } : {}),
          ...(outcome.parsed.effort !== undefined ? { effort: outcome.parsed.effort } : {}),
        });
      } else if (outcome.kind === 'fail') {
        failed.push({ path: filePath, reason: outcome.reason });
      }
      // outcome.kind === 'silent-skip' → no-op (reference doc / no name)
    }
  }

  return { agents: Array.from(byName.values()), failed };
}

interface ParsedAgent {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Raw tool names without `builtin:` prefix. */
  readonly toolNames?: readonly string[];
  readonly skillNames?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
}

type ParseOutcome =
  | { readonly kind: 'ok'; readonly parsed: ParsedAgent }
  | { readonly kind: 'silent-skip' }
  | { readonly kind: 'fail'; readonly reason: string };

/**
 * Shared parser for `loadAgentsFromMarkdown` and
 * `discoverMarkdownAgents`. Reads a markdown file, validates the
 * frontmatter, and returns parsed metadata or a discriminated
 * outcome. No file-system writes, no admission, no registration.
 */
async function parseMarkdownAgentFile(filePath: string): Promise<ParseOutcome> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return { kind: 'fail', reason: `read failed: ${errMsg(err)}` };
  }

  const [frontmatter, body] = parseYamlFrontmatter(raw);
  // Files without frontmatter are reference docs (claudecode parity).
  if (!frontmatter) return { kind: 'silent-skip' };

  const nameField = frontmatter.name;
  if (typeof nameField !== 'string' || nameField.trim().length === 0) {
    // Missing/invalid name → silent skip; the file is not advertising
    // itself as an agent definition.
    return { kind: 'silent-skip' };
  }
  const name = nameField.trim();

  const descriptionField = frontmatter.description;
  if (typeof descriptionField !== 'string' || descriptionField.trim().length === 0) {
    return {
      kind: 'fail',
      reason: `frontmatter "description" is required (got ${typeof descriptionField})`,
    };
  }
  const description = descriptionField.trim();

  const instructions = body.trim();
  if (instructions.length === 0) {
    return { kind: 'fail', reason: 'markdown body (instructions) is empty' };
  }

  const toolNames = parseNameListField(frontmatter.tools);
  const skillNames = parseNameListField(frontmatter.skills);
  if (skillNames?.includes('*') && skillNames.length !== 1) {
    return {
      kind: 'fail',
      reason: 'frontmatter "skills" wildcard cannot be mixed with exact names',
    };
  }
  if (skillNames && new Set(skillNames).size !== skillNames.length) {
    return { kind: 'fail', reason: 'frontmatter "skills" contains duplicate names' };
  }

  const modelField = frontmatter.model;
  const model =
    typeof modelField === 'string' && modelField.trim().length > 0
      ? modelField.trim()
      : undefined;
  const effortField = frontmatter.effort;
  let effort: string | undefined;
  if (typeof effortField === 'string' && effortField.trim().length > 0) {
    try {
      effort = normalizeReasoningEffortValue(effortField);
    } catch (err) {
      return { kind: 'fail', reason: `frontmatter "effort" is invalid: ${errMsg(err)}` };
    }
  }

  return {
    kind: 'ok',
    parsed: {
      name,
      description,
      instructions,
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(skillNames !== undefined ? { skillNames } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    },
  };
}

/**
 * Tolerant parsing of the `tools` frontmatter field. Accepts a YAML
 * array of strings (`tools: [read, grep]`) or a comma-separated
 * string (`tools: "read, grep"`). Returns raw names without the
 * `builtin:` prefix — the loader applies the prefix when building
 * `ToolRef`s for admission; discovery exposes the raw names.
 */
function parseNameListField(value: unknown): readonly string[] | undefined {
  if (value == null) return undefined;
  let names: string[] = [];
  if (Array.isArray(value)) {
    names = value.map((v) => String(v).trim()).filter((s) => s.length > 0);
  } else if (typeof value === 'string') {
    names = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    return undefined;
  }
  return names;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
