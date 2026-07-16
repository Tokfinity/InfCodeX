/**
 * FEATURE_189-extended Tier 4 §6 layered restructure — Pilot Eval — 2026-05-25
 *
 * Verifies the §6 claudecode-style layered restructure of the 4 file-
 * mutation tools (write / edit / multi_edit / bash) doesn't regress
 * tool-selection behavior. Per Phase A audit Tier 4:
 *
 *   V21 write       — ~800 char monolithic → layered When/When-not
 *   V22 edit        — ~700 char monolithic → layered When/When-not
 *   V23 multi_edit  — ~1.4KB monolithic → layered When/When-not/Atomicity/Uniqueness
 *   V24 bash        — ~900 char monolithic → layered When/When-not
 *
 * Same content reorganized into `## When to Use` / `## When NOT to Use`
 * sections, mirroring the v0.7.43 todo_* layered restructure pattern.
 *
 * Variants delivered via harness `tools` param (production
 * KodaXToolDefinition bytes per EVAL_GUIDELINES anti-pattern 8):
 *   v_baseline_monolithic       — pre-Tier-4 descriptions
 *   v_proposed_claudecode_layered — post-Tier-4 descriptions
 *
 * Cases (sample 2 to validate "edit-vs-write" and "edit-vs-bash"
 * decision boundaries — the most consequential per-pair distinctions):
 *
 *   C1 modify_existing_file       — user asks to change one line in
 *      an existing file. Expects `edit` (not `write` for whole file,
 *      not `bash sed`). Tests edit's "When to Use" pull + write's
 *      "When NOT to Use" deflect.
 *   C2 generate_known_content     — user provides full content for a
 *      new file. Expects `write`. Tests write's "When to Use" +
 *      bash's "When NOT to Use" (shell redirection deflect).
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells.
 * Estimated cost: ~$0.5.
 *
 * Pre-registered SHIP gate:
 *   A: Both cases proposed ≥ baseline − 1 cell → ship as batch
 *   B: Any case proposed ≤ baseline − 2 cells → bisect to identify
 *      problematic tool description and revert that one
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-extended-tier4-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-extended-tier4-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

const SYSTEM_PROMPT = [
  "You are the Worker — KodaX's primary agent for this task.",
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  '',
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial.',
  '- Prefer `edit` over `write` for existing files.',
  '- For multiple edits to one file, batch with `multi_edit`.',
  '- NEVER route a single known-content file through `bash` heredocs.',
].join('\n');

// =====================================================================
// V_BASELINE — pre-Tier-4 monolithic descriptions
// =====================================================================

const WRITE_BASELINE: KodaXToolDefinition = {
  name: 'write',
  description:
    'Write a file to the local filesystem. Large diffs may be summarized in the tool result. '
    + 'ALWAYS prefer the `edit` tool over `write` when modifying an existing file — `edit` sends only the '
    + 'diff and avoids output-token pressure. Only use `write` to create new files or for a complete rewrite '
    + 'that the user explicitly asked for. '
    + 'NEVER fall back to `bash` (python/node heredoc, `echo >`, `cat > file <<EOF`) to generate a source file — '
    + 'it bypasses mutation tracking, loses diff visibility, and recurses the same streaming limit onto the generator '
    + 'script itself. Encoding note: `write` calls Node `fs.writeFile(path, content, "utf-8")` — UTF-8 (including '
    + 'Chinese / emoji / etc.) works correctly through `write` by default.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
};

const EDIT_BASELINE: KodaXToolDefinition = {
  name: 'edit',
  description:
    'Perform safe exact-or-normalized string replacement in a file. '
    + 'ALWAYS prefer editing an existing file with `edit` over rewriting the whole file with `write` — '
    + '`edit` only sends the diff. REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `edit`. '
    + 'If you skip the read, your `old_string` is almost certainly wrong and the edit will fail with an '
    + '"old_string not found" error. When making multiple independent edits to the same file, use `multi_edit` instead.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

const MULTI_EDIT_BASELINE: KodaXToolDefinition = {
  name: 'multi_edit',
  description:
    'Apply multiple exact-text replacements to a single file in ONE tool call. '
    + 'Prefer this over N separate `edit` calls when you have several independent edits to the same file. '
    + 'REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `multi_edit`. '
    + 'Edits apply sequentially, and the whole batch is ATOMIC: if any single old_string fails to match, NO edits are written.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
};

const BASH_BASELINE: KodaXToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command. Use run_in_background for long-running commands. '
    + 'When producing a SINGLE file whose content you already have, use the `write` / `edit` tools — '
    + 'do NOT route it through shell (no `cat > file <<EOF`, no `echo ... >`). Shell redirection for a known-content '
    + 'file bypasses the mutation tracker. Use a shell script ONLY when the output is computed (loops, templating '
    + 'over many files). Appropriate uses of `bash`: tests, builds, lint, git, package managers, grep/ls/cat for '
    + 'inspection, process management, computed/templated multi-file generation.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  },
};

// =====================================================================
// V_PROPOSED — post-Tier-4 claudecode-style layered descriptions
// =====================================================================

const WRITE_PROPOSED: KodaXToolDefinition = {
  name: 'write',
  description:
    'Write content to a file on the local filesystem. Large diffs may be summarized in the tool result.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Creating a NEW file the user explicitly asked for.\n'
    + '- Performing a complete rewrite of an existing file the user explicitly requested.\n'
    + '- Writing a structural skeleton with placeholder markers, then filling each section with `edit` / `multi_edit`. This pattern streams reliably for files too large to write in one pass.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- Modifying an existing file — call `edit` (single change) or `multi_edit` (multiple independent changes) instead. `edit` sends only the diff and avoids output-token pressure and mid-stream truncation on large files.\n'
    + '- Generating a known-content file through `bash` heredocs (`cat > file <<EOF`), `echo > file`, PowerShell `Set-Content` / `Out-File`, or python/node heredoc. Shell redirection bypasses mutation tracking, loses diff visibility, and recurses the same streaming limit onto the generator script itself.\n'
    + '- Switching to `python` / `bash` scripts to "avoid encoding problems". `write` calls Node `fs.writeFile(path, content, "utf-8")` — UTF-8 works correctly by default.',
  input_schema: WRITE_BASELINE.input_schema,
};

const EDIT_PROPOSED: KodaXToolDefinition = {
  name: 'edit',
  description:
    'Replace exact (or normalized) text in an existing file. The most efficient way to modify a file — only the diff is sent.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Modifying an existing file with one targeted text change.\n'
    + '- Renaming a single occurrence; use `replace_all: true` only when every match in the file should change.\n'
    + '- Filling in one placeholder produced by a prior `write(path, skeleton)`.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- Without first calling `read` on the file in this conversation — your `old_string` will almost certainly be wrong and the edit will fail with "old_string not found", costing a retry round-trip more expensive than the initial read.\n'
    + '- For multiple independent edits to the same file — call `multi_edit` instead, which batches N edits atomically in one tool call.\n'
    + '- As a recovery from a failed `edit` by rewriting the whole file via `write` — that discards the partial-edit context and re-streams the entire file, which is exactly what `edit` was designed to avoid.',
  input_schema: EDIT_BASELINE.input_schema,
};

const MULTI_EDIT_PROPOSED: KodaXToolDefinition = {
  name: 'multi_edit',
  description:
    'Apply multiple exact-text replacements to a single file in ONE atomic tool call.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Several independent edits to the same file — especially when filling in a skeleton you just created with `write`.\n'
    + '- Bulk renames within one file (use `replace_all: true` per edit).\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- For a single change — call `edit` directly; the extra wrapping is unnecessary overhead.\n'
    + '- Without first calling `read` on the file in this conversation — your first failing `old_string` aborts the ENTIRE batch.\n\n'
    + '## Atomicity\n\n'
    + 'The whole batch is atomic: if any single `old_string` fails to match, NO edits are written to disk.',
  input_schema: MULTI_EDIT_BASELINE.input_schema,
};

const BASH_PROPOSED: KodaXToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command. Use `run_in_background` for long-running commands. Large output may be truncated to the most relevant tail.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Tests, builds, lint, type-checking, package managers.\n'
    + '- Git operations (status, diff, log, blame, commit, push).\n'
    + '- Process inspection / management.\n'
    + '- Computed or templated multi-file generation — e.g. generating 50 similar test fixtures from a template script.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- Producing a SINGLE file whose content you already have — call `write` or `edit` instead. Shell redirection (`cat > file <<EOF`, `echo ... >`, PowerShell `Set-Content` / `Out-File`, python/node heredoc) bypasses the mutation tracker, loses diff visibility, and re-encounters the same streaming limit.\n'
    + '- Reproducing a hand-written file you already have in memory — write it directly with `write`.',
  input_schema: BASH_BASELINE.input_schema,
};

// =====================================================================
// Shared (read tool — needed for the modify case)
// =====================================================================

const READ_TOOL: KodaXToolDefinition = {
  name: 'read',
  description: 'Read a file from disk.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const BASELINE_TOOLS: readonly KodaXToolDefinition[] = [
  READ_TOOL,
  WRITE_BASELINE,
  EDIT_BASELINE,
  MULTI_EDIT_BASELINE,
  BASH_BASELINE,
];

const PROPOSED_TOOLS: readonly KodaXToolDefinition[] = [
  READ_TOOL,
  WRITE_PROPOSED,
  EDIT_PROPOSED,
  MULTI_EDIT_PROPOSED,
  BASH_PROPOSED,
];

// =====================================================================
// User messages
// =====================================================================

const USER_MESSAGE_C1_MODIFY =
  'In `/repo/packages/auth/src/login.ts`, change the variable `usrName` to `userName` on line 42 — just that one occurrence.';

const USER_MESSAGE_C2_GENERATE =
  'Create a new config file at `/repo/.kodax/myconfig.json` with this exact content:\n\n```\n{\n  "feature": "demo",\n  "enabled": true,\n  "threshold": 0.75\n}\n```';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly judgeKind: 'edit_not_write_not_bash' | 'write_not_bash';
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'modify_existing_file',
    userMessage: USER_MESSAGE_C1_MODIFY,
    judgeKind: 'edit_not_write_not_bash',
  },
  {
    id: 'generate_known_content',
    userMessage: USER_MESSAGE_C2_GENERATE,
    judgeKind: 'write_not_bash',
  },
] as const;

// =====================================================================
// Judges
// =====================================================================

function judgeEditNotWriteNotBash(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const mutationCalls = toolCalls.filter((t) => ['write', 'edit', 'multi_edit', 'bash'].includes(t.name));
  if (mutationCalls.length === 0) {
    return { passed: false, reason: 'no mutation tool invoked' };
  }
  const firstMutation = mutationCalls[0];
  if (firstMutation.name === 'edit') return { passed: true };
  if (firstMutation.name === 'multi_edit') return { passed: true, reason: 'multi_edit acceptable variant' };
  if (firstMutation.name === 'write') {
    return { passed: false, reason: 'wrote whole file instead of edit for single-line change' };
  }
  // bash
  const cmd = typeof firstMutation.input === 'object' && firstMutation.input && 'command' in firstMutation.input
    ? String((firstMutation.input as { command?: string }).command ?? '')
    : '';
  if (/sed|awk|perl\s+-i|>\s*\/repo/.test(cmd)) {
    return { passed: false, reason: 'used bash sed/awk/redirect instead of edit' };
  }
  return { passed: false, reason: 'used bash for a single-line modification' };
}

function judgeWriteNotBash(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const mutationCalls = toolCalls.filter((t) => ['write', 'edit', 'multi_edit', 'bash'].includes(t.name));
  if (mutationCalls.length === 0) {
    return { passed: false, reason: 'no mutation tool invoked' };
  }
  const firstMutation = mutationCalls[0];
  if (firstMutation.name === 'write') return { passed: true };
  if (firstMutation.name === 'bash') {
    const cmd = typeof firstMutation.input === 'object' && firstMutation.input && 'command' in firstMutation.input
      ? String((firstMutation.input as { command?: string }).command ?? '')
      : '';
    if (/cat\s*>|echo\s*.*>|tee\s|heredoc|<<\s*EOF/.test(cmd)) {
      return { passed: false, reason: 'used bash shell redirection instead of write for known content' };
    }
    return { passed: false, reason: 'used bash for known-content file generation' };
  }
  return { passed: false, reason: `used ${firstMutation.name} instead of write for new file` };
}

const JUDGES_EDIT: readonly PromptJudge[] = [
  { name: 'edit_not_write_not_bash', category: 'correctness', judge: judgeEditNotWriteNotBash },
];

const JUDGES_WRITE: readonly PromptJudge[] = [
  { name: 'write_not_bash', category: 'correctness', judge: judgeWriteNotBash },
];

// =====================================================================
// Driver
// =====================================================================

describe('FEATURE_189-extended Tier 4 §6 layered restructure — pilot', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => {
      /* no-op */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_monolithic',
            description: 'pre-Tier-4 monolithic write/edit/multi_edit/bash descriptions',
            systemPrompt: SYSTEM_PROMPT,
            tools: BASELINE_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_claudecode_layered',
            description: 'post-Tier-4 claudecode-style layered descriptions',
            systemPrompt: SYSTEM_PROMPT,
            tools: PROPOSED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges = c.judgeKind === 'edit_not_write_not_bash' ? JUDGES_EDIT : JUDGES_WRITE;
        const judgeName = c.judgeKind === 'edit_not_write_not_bash' ? 'edit_not_write_not_bash' : 'write_not_bash';

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-189-extended-tier4-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_monolithic', 'v_proposed_claudecode_layered']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const passCount = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === judgeName)?.passed,
            ).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} ${judgeName}=${passCount}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-extended-tier4-pilot',
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
            toolCount: v.tools.length,
            userMessage: v.userMessage,
          })),
          aliases: result.cells.map((cell) => ({
            alias: cell.alias,
            variantId: cell.variantId,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              toolCalls: run.toolCalls,
              durationMs: run.durationMs,
              error: run.error,
              fallbackUsed: run.fallbackUsed,
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
            })),
          })),
        };
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
