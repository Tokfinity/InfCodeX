/**
 * v0.7.35.1 FEATURE_142 Batch E — Capability Context Sections.
 *
 * Single source of truth for the 13 capability-context prompt sections
 * the SA path (`buildSystemPromptSnapshot` in `builder.ts`) assembles.
 * Extracted to dedupe with a future AMA worker integration (Batch F /
 * v0.7.36 FEATURE_143). Each section's id, order, content shape, and
 * inclusion condition is preserved byte-equivalently from
 * builder.ts:32-181 (pre-Batch E).
 *
 * The 13 sections, in order:
 *   1.  base-system               (always)
 *   2.  base-system-suffix        (when SYSTEM_PROMPT has `{context}` marker)
 *   3.  environment-context       (always)
 *   4.  runtime-fact              (when provider or model is set)
 *   5.  working-directory         (always)
 *   6.  git-context               (when isNewSession AND repo has git output)
 *   7.  project-snapshot          (when isNewSession)
 *   8.  repo-intelligence-context (when context.repoIntelligenceContext)
 *   9.  mcp-capability-context    (when extensionRuntime returns mcp ctx)
 *   10. prompt-overlay            (when context.promptOverlay)
 *   11. project-agents            (when AGENTS.md / CLAUDE.md found)
 *   12. skills-addendum           (when context.skillsPrompt)
 *   13. tool-construction         (when toolConstructionMode includes it)
 *
 * Why this lives in `@kodax-ai/coding/src/prompts/` and NOT
 * `@kodax-ai/agent/`:
 *   - All callers (builder.ts SA path + future AMA role-prompt) are
 *     coding-internal. A future `@kodax-ai/data-analysis-agent` would
 *     have its own builder + role-prompt with its own section set
 *     (e.g. `prompt-overlay` is coding-routing-specific). Cross-agent
 *     reuse is at the **pattern** level (each agent has its own
 *     `capability-sections.ts`), not the **content** level.
 *   - Hoisting to `@kodax-ai/agent/` would force `@kodax-ai/agent` →
 *     `@kodax-ai/agent` / `@kodax-ai/agent` cross-package dependencies,
 *     breaking the "agent doesn't depend on application-layer
 *     packages" promise.
 *   - The drift problem this batch solves is "SA / AMA assemble the
 *     same content twice" — a coding-internal duplication, not a
 *     cross-package boundary issue.
 *
 * Behavior contract: the SA path's emitted sections array (and thus
 * `KodaXPromptSnapshot.rendered`) MUST stay byte-equivalent to the
 * pre-Batch E `buildSystemPromptSnapshot` output. `builder.test.ts` is
 * the integration-level guard for this contract.
 */

import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { loadAgentsFiles, formatAgentsForPrompt } from '../context/agents-loader.js';
import { listConstructedAgents } from '../construction/agent-resolver.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import type { KodaXOptions } from '../types.js';

import { buildMemoryRulesSection } from './memory-rules.js';
import { buildMemorySection } from './memory-section.js';
import { createPromptSection, type KodaXPromptSection } from './sections.js';
import { SYSTEM_PROMPT } from './system.js';
import {
  TOOL_CONSTRUCTION_PROMPT,
  shouldIncludeToolConstructionSection,
} from './tool-construction.js';

const execAsync = promisify(exec);
const SYSTEM_CONTEXT_MARKER = '{context}';

/**
 * Build the full ordered set of capability-context prompt sections for
 * the given options + session state. The caller is responsible for
 * passing the result to `buildPromptSnapshot()` (or whatever assembler
 * the agent uses); this helper only emits the section list.
 *
 * `executionCwd` is OPTIONAL — when omitted, this helper calls
 * `resolveExecutionCwd(options.context)` internally. Passing it
 * explicitly is supported as a perf shortcut for callers that have
 * already resolved cwd for other purposes (e.g. `builder.ts` uses the
 * same value to populate the snapshot's `executionCwd` field), but
 * **the explicit value MUST equal `resolveExecutionCwd(options.context)`
 * or the `working-directory` section will diverge from the snapshot
 * metadata** — a subtle source of drift if a future caller resolves
 * cwd differently. Prefer the no-arg form unless you have a documented
 * reason to override.
 */
export async function buildCapabilityContextSections(
  options: KodaXOptions,
  isNewSession: boolean,
  executionCwdOverride?: string,
): Promise<KodaXPromptSection[]> {
  const executionCwd = executionCwdOverride ?? resolveExecutionCwd(options.context);
  const sections: KodaXPromptSection[] = [];
  const { prefix: systemPromptPrefix, suffix: systemPromptSuffix } =
    splitSystemPromptTemplate(SYSTEM_PROMPT);

  sections.push(
    createPromptSection(
      'base-system',
      systemPromptPrefix,
      'Always include the stable base identity and safety baseline.',
    ),
  );
  if (systemPromptSuffix) {
    sections.push(
      createPromptSection(
        'base-system-suffix',
        systemPromptSuffix,
        'Preserve any trailing stable base prompt instructions that follow the context placeholder.',
      ),
    );
  }
  sections.push(
    createPromptSection(
      'environment-context',
      getEnvContext(),
      'Always disclose runtime platform details so shell guidance stays accurate.',
    ),
  );
  const runtimeFact = getRuntimeFact(options);
  if (runtimeFact) {
    sections.push(
      createPromptSection(
        'runtime-fact',
        runtimeFact,
        'Always disclose the active provider and model so identity questions can be answered truthfully instead of guessed from pretraining.',
      ),
    );
  }
  sections.push(
    createPromptSection(
      'working-directory',
      `Working Directory: ${executionCwd}`,
      'Always disclose the resolved execution directory for deterministic file operations.',
    ),
  );

  if (isNewSession) {
    const gitContext = await getGitContext(executionCwd);
    if (gitContext) {
      sections.push(
        createPromptSection(
          'git-context',
          gitContext,
          'Include repository state when the session starts so the agent can orient itself quickly.',
        ),
      );
    }

    const projectSnapshot = await getProjectSnapshot(executionCwd);
    if (projectSnapshot) {
      sections.push(
        createPromptSection(
          'project-snapshot',
          projectSnapshot,
          'Include a lightweight project snapshot at the start of a session.',
        ),
      );
    }
  }

  if (options.context?.repoIntelligenceContext?.trim()) {
    sections.push(
      createPromptSection(
        'repo-intelligence-context',
        options.context.repoIntelligenceContext,
        'Include repository-intelligence capability truth only when it is active for this runtime.',
      ),
    );
  }

  const mcpCapabilityContext = await options.extensionRuntime?.getCapabilityPromptContext('mcp');
  if (mcpCapabilityContext?.trim()) {
    sections.push(
      createPromptSection(
        'mcp-capability-context',
        mcpCapabilityContext,
        'Include runtime-owned MCP capability truth only when active MCP servers are configured.',
      ),
    );
  }

  // FEATURE_191 — registered specialist agents available for
  // `dispatch_child_task(subagent_type=<name>)` routing. Conditional
  // include matches the mcp-capability-context pattern: empty registry
  // → not injected (saves tokens + keeps prompt cache stable for
  // single-user runs that never register a specialist). When non-empty,
  // surfaces each agent's name + description so the Worker LLM can
  // choose a specialist whose curated instructions / tool whitelist
  // fits the task.
  const specialistBlock = buildSpecialistAgentsBlock();
  if (specialistBlock) {
    sections.push(
      createPromptSection(
        'specialist-agents',
        specialistBlock,
        'List registered specialist agents the Worker can dispatch via dispatch_child_task(subagent_type) so curated prompts and tool whitelists get reused instead of duplicated.',
      ),
    );
  }

  if (options.context?.promptOverlay?.trim()) {
    sections.push(
      createPromptSection(
        'prompt-overlay',
        options.context.promptOverlay,
        'Append runtime harness, routing, and provider truth for the current execution plan.',
      ),
    );
  }

  const agentsFiles = loadAgentsFiles({
    cwd: executionCwd,
    projectRoot: options.context?.gitRoot ?? undefined,
  });
  const agentsContent = formatAgentsForPrompt(agentsFiles);
  if (agentsContent) {
    sections.push(
      createPromptSection(
        'project-agents',
        agentsContent,
        'Append project-scoped AI rules after runtime truth so local constraints keep higher precedence than skills.',
      ),
    );
  }

  // FEATURE_124 (v0.7.43) Phase C — `memory-rules` LLM teaching text.
  // Sits between AGENTS.md (project-agents, order 100) and the MEMORY.md
  // index (project-memory, order 200) in the project-rules slot so the
  // LLM reads "what to save / how to save / when to access" BEFORE it
  // sees the current index content. Always emitted — the teaching text
  // is path-stable so prompt cache remains valid across sessions.
  sections.push(
    createPromptSection(
      'memory-rules',
      buildMemoryRulesSection(executionCwd),
      'Teach the agent the 4-type memory taxonomy, save procedure, and recall etiquette so writes are consistent across sessions and providers.',
    ),
  );

  // FEATURE_124 (v0.7.43) Phase B — `project-memory` section.
  // MEMORY.md index injected after the teaching text so the agent has
  // the rules in hand when it reads the current entries. Section is
  // ALWAYS emitted — fallback "currently empty" text tells the LLM the
  // subsystem is active even when no entries exist yet.
  const memory = buildMemorySection(executionCwd);
  sections.push(
    createPromptSection(
      'project-memory',
      memory.content,
      'Inject the per-project MEMORY.md index so the agent has cross-session recall without re-asking the user for previously-given context.',
    ),
  );

  if (options.context?.skillsPrompt?.trim()) {
    sections.push(
      createPromptSection(
        'skills-addendum',
        options.context.skillsPrompt,
        'Append skill-specific guidance after project rules as a bounded dynamic addendum.',
      ),
    );
  }

  if (shouldIncludeToolConstructionSection(options.context?.toolConstructionMode)) {
    sections.push(
      createPromptSection(
        'tool-construction',
        TOOL_CONSTRUCTION_PROMPT,
        'Append the tool-construction staircase guidance only when self-construction is authorized for this session.',
      ),
    );
  }

  return sections;
}

/**
 * FEATURE_191 A.3 — render the `specialist-agents` section content from
 * the constructed-agent registry, or null when the registry is empty.
 *
 * Format mirrors the claudecode `loadAgentsDir` pattern: one line per
 * specialist with `name: description`, followed by a single dispatch
 * hint. Specialists without a `description` field render with a
 * `(no description)` placeholder so the line shape stays consistent —
 * AgentContent.description is optional for FEATURE_089 backward
 * compatibility (the LLM-driven minimal-agent shape only requires
 * `instructions`).
 *
 * Returning null when empty signals to the caller that the section
 * should not be pushed at all — saves ~80 tokens per turn for the
 * common single-user case that never registered a specialist, and
 * keeps the prompt cache key stable across sessions that don't touch
 * the registry.
 */
function buildSpecialistAgentsBlock(): string | null {
  const agents = listConstructedAgents();
  if (agents.length === 0) {
    return null;
  }
  const lines = agents
    .map((agent) => {
      // Agent.description propagated from AgentContent.description by
      // buildAgentFromContent. Falls back to a placeholder so the line
      // shape stays consistent for legacy FEATURE_089 minimal-agent
      // fixtures that pre-date the description field.
      return `- ${agent.name}: ${agent.description?.trim() || '(no description)'}`;
    })
    .join('\n');
  return [
    '=== Available specialist agents ===',
    lines,
    '',
    'Dispatch via dispatch_child_task(subagent_type="<name>").',
  ].join('\n');
}

function splitSystemPromptTemplate(template: string): {
  prefix: string;
  suffix: string;
} {
  if (!template.includes(SYSTEM_CONTEXT_MARKER)) {
    return {
      prefix: template.trim(),
      suffix: '',
    };
  }

  const [prefix, ...rest] = template.split(SYSTEM_CONTEXT_MARKER);
  return {
    prefix: prefix.trim(),
    suffix: rest.join(SYSTEM_CONTEXT_MARKER).trim(),
  };
}

function getEnvContext(): string {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const commandHint = isWindows
    ? 'Use: dir, move, copy, del'
    : 'Use: ls, mv, cp, rm';
  return `Platform: ${
    isWindows ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
  }\n${commandHint}\nNode: ${process.version}`;
}

function getRuntimeFact(options: KodaXOptions): string | null {
  const provider = options.provider?.trim();
  const model = (options.modelOverride ?? options.model)?.trim();
  if (!provider && !model) {
    return null;
  }
  const parts: string[] = [];
  if (provider) parts.push(`provider=${provider}`);
  if (model) parts.push(`model=${model}`);
  return `[Runtime] ${parts.join('; ')}.`;
}

async function getGitContext(cwd: string): Promise<string> {
  try {
    const { stdout: check } = await execAsync(
      'git rev-parse --is-inside-work-tree',
      { cwd },
    );
    if (!check.trim()) {
      return '';
    }

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current', {
        cwd,
      });
      if (branch.trim()) {
        lines.push(`Git Branch: ${branch.trim()}`);
      }
    } catch {
      // Ignore git branch lookup failures in non-standard worktrees.
    }

    try {
      const { stdout: status } = await execAsync('git status --short', { cwd });
      if (status.trim()) {
        const statusLines = status.trim().split('\n').slice(0, 10);
        lines.push(
          `Git Status:\n${statusLines.map((line) => `  ${line}`).join('\n')}`,
        );
        const totalLines = status.trim().split('\n').length;
        if (totalLines > 10) {
          lines.push('  ... (more changes)');
        }
      }
    } catch {
      // Ignore git status failures so the prompt can still build.
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

async function getProjectSnapshot(
  cwd: string,
  maxDepth = 2,
  maxFiles = 50,
): Promise<string> {
  const fs = await import('fs/promises');
  const ignoreDirs = new Set([
    '.git',
    '__pycache__',
    'node_modules',
    '.venv',
    'venv',
    'dist',
    'build',
    '.idea',
    '.vscode',
  ]);
  const ignoreExts = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.bin']);
  const lines = [`Project: ${path.basename(cwd)}`];
  let fileCount = 0;

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || fileCount >= maxFiles) {
      return;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !ignoreDirs.has(entry.name) &&
          !entry.name.startsWith('.')
        ) {
          dirs.push(entry.name);
        } else if (
          entry.isFile() &&
          !ignoreExts.has(path.extname(entry.name))
        ) {
          files.push(entry.name);
        }
      }

      const indent = '  '.repeat(depth);
      const relative = path.relative(cwd, dir);
      if (relative && relative !== '.') {
        lines.push(`${indent}${relative}/`);
      }

      for (const file of files.sort().slice(0, 20)) {
        lines.push(`${indent}  ${file}`);
        fileCount += 1;
        if (fileCount >= maxFiles) {
          lines.push('  ... (more files)');
          return;
        }
      }

      for (const childDir of dirs.sort()) {
        await walk(path.join(dir, childDir), depth + 1);
      }
    } catch {
      // Ignore unreadable directories in best-effort project snapshots.
    }
  }

  await walk(cwd, 0);
  return lines.join('\n');
}
