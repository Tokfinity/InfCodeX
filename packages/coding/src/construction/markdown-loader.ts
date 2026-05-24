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

import { Runner, getAgentConfigHome } from '@kodax-ai/agent';
import { parseYamlFrontmatter } from '@kodax-ai/agent/capabilities/skills/shared/yaml';

import { buildAdmissionManifest } from './admission-bridge.js';
import {
  listConstructedAgents,
  registerConstructedAgent,
  type ConstructedAgentSource,
} from './agent-resolver.js';
import type { AgentArtifact, AgentContent, ToolRef } from './types.js';

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
}

const USER_AGENTS_DIRNAME = 'agents';
const PROJECT_AGENTS_DIRNAME = '.kodax/agents';

/**
 * Entry point. Scans user then project dirs; registers every
 * well-formed agent that passes admission. Failures are accumulated
 * into the result instead of throwing — a single malformed file must
 * not break boot.
 */
export async function loadAgentsFromMarkdown(
  opts: LoadAgentsFromMarkdownOptions = {},
): Promise<LoadAgentsFromMarkdownResult> {
  const userDir = join(opts.configHome ?? getAgentConfigHome(), USER_AGENTS_DIRNAME);
  const projectDir = join(opts.cwd ?? process.cwd(), PROJECT_AGENTS_DIRNAME);

  const failures: MarkdownLoadFailure[] = [];
  let loaded = 0;

  // User dir first, then project — last-write-wins implements
  // precedence (project shadows user when names collide).
  for (const [dir, source] of [
    [userDir, 'markdown:user' as const],
    [projectDir, 'markdown:project' as const],
  ] satisfies ReadonlyArray<readonly [string, ConstructedAgentSource]>) {
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
  source: ConstructedAgentSource,
): Promise<LoadOutcome> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `read failed: ${errMsg(err)}` };
  }

  const [frontmatter, body] = parseYamlFrontmatter(raw);
  // Files without frontmatter are reference docs (claudecode parity).
  if (!frontmatter) return { ok: false, reason: null };

  const nameField = frontmatter.name;
  if (typeof nameField !== 'string' || nameField.trim().length === 0) {
    // Missing/invalid name → silent skip; the file is not advertising
    // itself as an agent definition.
    return { ok: false, reason: null };
  }
  const name = nameField.trim();

  const descriptionField = frontmatter.description;
  if (typeof descriptionField !== 'string' || descriptionField.trim().length === 0) {
    return {
      ok: false,
      reason: `frontmatter "description" is required (got ${typeof descriptionField})`,
    };
  }
  const description = descriptionField.trim();

  const instructions = body.trim();
  if (instructions.length === 0) {
    return { ok: false, reason: 'markdown body (instructions) is empty' };
  }

  const toolsField = frontmatter.tools;
  const tools = parseToolsField(toolsField);

  const modelField = frontmatter.model;
  const model = typeof modelField === 'string' && modelField.trim().length > 0
    ? modelField.trim()
    : undefined;

  const content: AgentContent = {
    instructions,
    description,
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
  };

  const manifest = buildAdmissionManifest({ name, content });
  const activatedAgents = new Map(listConstructedAgents().map((a) => [a.name, a]));
  const verdict = await Runner.admit(manifest, { activatedAgents });
  if (!verdict.ok) {
    return { ok: false, reason: `admission rejected: ${verdict.reason}` };
  }

  const artifact: AgentArtifact = {
    kind: 'agent',
    name,
    version: '0.0.0-markdown',
    content,
    status: 'active',
    createdAt: Date.now(),
    testedAt: Date.now(),
    activatedAt: Date.now(),
  };
  registerConstructedAgent(
    artifact,
    {
      bindings: verdict.handle.invariantBindings,
      manifest: verdict.handle.manifest,
      source,
    },
  );
  return { ok: true };
}

/**
 * Tolerant parsing of the `tools` frontmatter field. Accepts a YAML
 * array of strings (`tools: [read, grep]`) or a comma-separated
 * string (`tools: "read, grep"`). Each entry is mapped to a
 * `builtin:<name>` ToolRef so admission's tool-permission invariant
 * sees them in the same shape as `.kodax/constructed/agents/`
 * artifacts.
 */
function parseToolsField(value: unknown): readonly ToolRef[] | undefined {
  if (value == null) return undefined;
  let names: string[] = [];
  if (Array.isArray(value)) {
    names = value.map((v) => String(v).trim()).filter((s) => s.length > 0);
  } else if (typeof value === 'string') {
    names = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    return undefined;
  }
  if (names.length === 0) return undefined;
  return names.map((n) => ({ ref: n.includes(':') ? n : `builtin:${n}` }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
