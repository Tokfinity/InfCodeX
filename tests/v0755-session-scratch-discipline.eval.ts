/**
 * v0.7.55 SESSION SCRATCH DIRECTORY DISCIPLINE — Layer 2 Probe — 2026-06-23
 *
 * ADR-033 / FEATURE_104 prompt-eval trigger for the v0.7.55 emergency
 * release. The release reworks the Worker workspace-discipline block in
 * `role-prompt.ts` (and the mirrored lines in `worker-role-prompt.ts` /
 * `system.ts`) plus injects a new `Session Scratch Directory: <abs path>`
 * line into the `## Environment` block. The goal of the code change is to
 * stop concurrent same-directory sessions from colliding in the shared
 * `.agent/tmp/` root by giving each session its own
 * `.agent/tmp/sessions/<id>/` scratch directory.
 *
 * ## Layer 1 already covers (no LLM needed)
 *   - getSessionScratchDir path computation — session-scratch.test.ts
 *   - section injected into the capability-section list — capability-sections.test.ts
 *   - `Session Scratch Directory:` line rendered in role prompt — role-prompt.test.ts
 *   - KODAX_SESSION_TMP exported to bash env — bash.test.ts
 * What Layer 1 CANNOT answer: does the reworded discipline still steer the
 * model AWAY from bad scratch locations (project root / system tmp), and
 * does it adopt the session scratch directory when one is shown? That is
 * the LLM-behavioral question this probe answers.
 *
 * ## This is a REGRESSION gate, not a ship/no-ship gate
 * The code is written + unit-tested + shipping in v0.7.55. The decision
 * this eval informs: did the reworded discipline INTRODUCE a workspace
 * regression (scratch now leaking to project root or system tmp) vs the
 * v0.7.54 wording? A bonus signal: does the model adopt the session dir.
 *
 * ## Variants (byte-faithful to role-prompt.ts pre/post v0.7.55)
 *   v_baseline_v0754 — `## Environment` has no scratch line; discipline
 *                       points scratch at `.agent/tmp/` (the git-root root).
 *   v_proposed_v0755 — `## Environment` shows an absolute Session Scratch
 *                       Directory; discipline points scratch there and
 *                       forbids the shared `.agent/tmp/` root directly.
 * The two variants differ ONLY in those two byte-regions. Tool definitions
 * (`write` / `bash` etc.) are production `KodaXToolDefinition.description`
 * bytes, identical across variants (anti-pattern 8).
 *
 * ## Case
 *   C1 forced_scratch_script — the user explicitly asks for a throwaway
 *      helper SCRIPT FILE (not an inline one-liner) and to run it. This
 *      isolates the path-LOCATION decision from the orthogonal
 *      should-I-use-scratch-at-all decision (the model is told to).
 *
 * ## Mechanical assertion (binding-based, per feedback_audit_must_see_binding)
 * Collect candidate scratch paths from write/multi_edit/insert_after_anchor
 * `input.path` and from bash redirect / interpreter targets in
 * `input.command`, then classify:
 *   - session_dir : path under `.agent/tmp/sessions/`
 *   - shared_root : under `.agent/tmp/` but NOT sessions/
 *   - bad_location: project root OR system tmp (the regression we care about)
 *
 * ## Pre-registered decision threshold
 *   - NO-BLOCK (ship as-is): for every alias, v_proposed bad_location rate
 *     <= v_baseline bad_location rate + 1 run. (No NEW leakage to project
 *     root / system tmp introduced by the rewording.)
 *   - BONUS (record only): v_proposed session_dir adoption > 0 where an
 *     absolute scratch path is shown.
 *   - BLOCK (fix wording before release): any alias where v_proposed
 *     bad_location > v_baseline + 1 run.
 *
 * ## Cost
 *   Pilot: ark/v4flash × 1 case × 2 variant × 3 runs = 6 cells (~$0.3).
 *   Panel (if pilot triggers): 5 alias × 1 case × 2 variant × 5 runs
 *          = 50 cells (~$3). Worth it: a workspace-discipline regression
 *          leaks scratch into user repos / system tmp across every managed
 *          run — a $3 regression gate is cheap insurance.
 *
 * ## Run
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- v0755-session-scratch-discipline
 *   Flip PANEL to FULL_PANEL after the pilot confirms the scenario triggers.
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
  'v0755-session-scratch-discipline',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;
const FULL_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
] as const;

// Flip to FULL_PANEL after the pilot confirms the scenario forces a
// scratch-file write and shows baseline-vs-proposed divergence.
const PANEL: readonly ModelAlias[] = process.env.KODAX_EVAL_FULL_PANEL
  ? FULL_PANEL
  : PILOT_PANEL;

const RUNS_PER_CELL = process.env.KODAX_EVAL_FULL_PANEL ? 5 : 3;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
  'ark/v4pro': 'ds/v4pro',
};

// =====================================================================
// Fixed environment facts (POSIX paths keep path-classification simple)
// =====================================================================

const GIT_ROOT = '/repo';
const EXEC_CWD = '/repo';
const SESSION_ID = 'sess-7f3a9c21';
const SCRATCH_DIR = `${GIT_ROOT}/.agent/tmp/sessions/${SESSION_ID}`;

// =====================================================================
// Production tool definitions (byte-aligned tool-definitions.ts 2026-06-23)
// identical across both variants (anti-pattern 8: real description bytes)
// =====================================================================

const WRITE_TOOL: KodaXToolDefinition = {
  name: 'write',
  description:
    'Write content to a file on the local filesystem. Large diffs may be summarized in the tool result.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Creating a NEW file the user explicitly asked for.\n'
    + '- Performing a complete rewrite of an existing file the user explicitly requested.\n'
    + '- Writing a structural skeleton with placeholder markers (e.g. `<!-- SECTION_A -->` or `// === SECTION_A ===`), then filling each section with `edit` / `multi_edit`. This pattern streams reliably for files too large to write in one pass.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- Modifying an existing file — call `edit` (single change) or `multi_edit` (multiple independent changes) instead. `edit` sends only the diff and avoids output-token pressure and mid-stream truncation on large files.\n'
    + '- Generating a known-content file through `bash` heredocs (`cat > file <<EOF`), `echo > file`, PowerShell `Set-Content` / `Out-File`, or python/node heredoc. Shell redirection bypasses mutation tracking, loses diff visibility to downstream verification, and recurses the same streaming limit onto the generator script itself.\n'
    + '- Switching to `python` / `bash` scripts to "avoid encoding problems". `write` calls Node `fs.writeFile(path, content, "utf-8")` — content goes directly from your tool_use input to disk WITHOUT passing through any shell. UTF-8 (Chinese / emoji / etc.) works correctly by default; routing through a shell adds encoding surface area rather than removing it.\n\n'
    + '## Recovery\n\n'
    + 'If a `write` failed mid-stream, retry with a smaller skeleton, then `edit` each section.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path to the file' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['path', 'content'],
  },
};

const BASH_TOOL: KodaXToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command. Use `run_in_background` for long-running commands. Large output may be truncated to the most relevant tail.\n\n'
    + '## When to Use This Tool\n\n'
    + '- Tests, builds, lint, type-checking, package managers.\n'
    + '- Git operations (status, diff, log, blame, commit, push).\n'
    + '- Process inspection / management (ps, kill, top).\n'
    + '- File system queries not covered by dedicated tools — `grep` and `glob` have dedicated tools, but `find` / `du` / `df` etc. go through bash.\n'
    + '- Computed or templated multi-file generation — e.g. generating 50 similar test fixtures from a template script.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- Producing a SINGLE file whose content you already have — call `write` or `edit` instead. Shell redirection (`cat > file <<EOF`, `echo ... >`, PowerShell `Set-Content` / `Out-File`, python/node heredoc) bypasses the mutation tracker, loses diff visibility to downstream verification, and re-encounters the same streaming limit on the generator script itself.\n'
    + '- Reproducing a hand-written file you already have in memory — write it directly with `write`. Use a shell script ONLY when the output is computed (loops, templating over many files, data transformation of an input you are reading).',
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
};

const READ_TOOL: KodaXToolDefinition = {
  name: 'read',
  description: 'Read a file from the local filesystem. Returns the file content with line numbers.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The absolute path to the file' } },
    required: ['path'],
  },
};

const GLOB_TOOL: KodaXToolDefinition = {
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
};

const TOOLS: readonly KodaXToolDefinition[] = [WRITE_TOOL, BASH_TOOL, READ_TOOL, GLOB_TOOL];

// =====================================================================
// Worker system prompt — the two byte-regions that differ in v0.7.55
// (reconstructed byte-faithfully from role-prompt.ts createRolePrompt)
// =====================================================================

const IDENTITY = [
  'You are the Worker — KodaX\'s primary agent for this task.',
  '',
].join('\n');

function environmentBlock(withScratch: boolean): string {
  const lines = [
    '## Environment',
    `Working Directory: ${EXEC_CWD}`,
    // Git Root line is omitted when it equals execution cwd (role-prompt.ts);
    // here GIT_ROOT === EXEC_CWD so we omit it, matching production.
  ];
  if (withScratch) {
    lines.push(`Session Scratch Directory: ${SCRATCH_DIR}`);
  }
  lines.push('Platform: Linux', 'OS Release: 5.15.0', '');
  return lines.join('\n');
}

// sharedWorkerDiscipline block — role-prompt.ts:187-198
function disciplineBlock(withScratch: boolean): string {
  const scratchTarget = withScratch
    ? `the Session Scratch Directory above: ${SCRATCH_DIR}`
    : '`.agent/tmp/` (relative to the git root). That is the designated ephemeral workspace';
  const scratchLine = withScratch
    ? `- If you must write a temporary file, write it under ${scratchTarget}. Do not write directly in the shared \`.agent/tmp/\` root.`
    : `- If you must write a temporary file, write it under ${scratchTarget}.`;
  return [
    'Workspace discipline:',
    '- Helper scripts / scratch files are a last resort, not a default recovery path.',
    scratchLine,
    "- NEVER write scratch files to the project root, to `.agent/` top level (reserved for managed-tasks/, project/, repo-intelligence/), or to the system temp directory. Files in system tmp are invisible to the project and block code review.",
    '- The `write` tool creates parent directories automatically. Calling `mkdir` before `write` is redundant and may fail on Windows shells where `mkdir -p` is unsupported.',
    '- If you truly need an empty directory: `mkdir dir` (Windows) or `mkdir -p dir` (Unix).',
    '',
  ].join('\n');
}

function buildSystemPrompt(withScratch: boolean): string {
  return [
    IDENTITY,
    environmentBlock(withScratch),
    disciplineBlock(withScratch),
  ].join('\n');
}

const SYSTEM_BASELINE = buildSystemPrompt(false);
const SYSTEM_PROPOSED = buildSystemPrompt(true);

// =====================================================================
// Case — user explicitly asks for a throwaway helper SCRIPT FILE
// =====================================================================

const USER_MESSAGE_C1 =
  'I need a quick one-off audit of this monorepo. Write a small throwaway '
  + 'helper script (about 30 lines — write it as an actual script FILE, not '
  + 'an inline `node -e` one-liner) that walks every `package.json` under '
  + '`packages/*/` and prints a table of each package name and its number of '
  + 'dependencies. Then run the script with node and give me the table. '
  + 'The script is disposable scratch — I do not want it committed to the repo.';

// =====================================================================
// Path classification
// =====================================================================

type ScratchClass = 'session_dir' | 'shared_root' | 'bad_location';

function classifyPath(rawPath: string): ScratchClass {
  const p = rawPath.trim().replace(/\\/g, '/').toLowerCase();
  if (p.includes('.agent/tmp/sessions/')) return 'session_dir';
  if (p.includes('.agent/tmp/')) return 'shared_root';
  // system temp
  if (/^\/tmp\//.test(p) || p.includes('/temp/') || p.includes('os.tmpdir') || p.includes('%temp%')) {
    return 'bad_location';
  }
  // everything else (project root, bare filename, /repo/foo.js) is bad
  return 'bad_location';
}

// File-CREATION redirects only. The negative lookbehind drops fd redirects
// (`2>`, `1>`, `&>`) so stderr/stdout sinks like `2>/dev/null` are NOT
// mistaken for scratch writes (anti-pattern 7 — caught a /dev/null false
// positive in the pilot). `/dev/*` sinks are excluded explicitly too.
const REDIRECT_RE = /(?<![0-9&])>>?\s*([^\s;|&'"<>]+)/g;

/**
 * Collect every candidate scratch-file path the model actually CREATED.
 * Authoritative signal is the `write` path; bash redirect targets cover the
 * heredoc / `echo >` escape hatch the write-tool description discourages.
 * We deliberately do NOT scan for bare script filenames in bash commands —
 * `node scratch.js` / `cat pkg.json` reference files without creating scratch
 * and produced false positives in the pilot.
 */
function collectScratchPaths(context?: JudgeContext): string[] {
  const paths: string[] = [];
  for (const tc of context?.toolCalls ?? []) {
    const input = (tc.input ?? {}) as Record<string, unknown>;
    if ((tc.name === 'write' || tc.name === 'multi_edit' || tc.name === 'insert_after_anchor')
      && typeof input.path === 'string') {
      paths.push(input.path);
    }
    if (tc.name === 'bash' && typeof input.command === 'string') {
      const cmd = input.command;
      let m: RegExpExecArray | null;
      REDIRECT_RE.lastIndex = 0;
      while ((m = REDIRECT_RE.exec(cmd)) !== null) {
        const target = m[1];
        if (/^\/dev\//.test(target)) continue; // /dev/null, /dev/stderr, ...
        paths.push(target);
      }
    }
  }
  return paths;
}

/** A run "leaks" if any candidate path lands in a bad location. */
function judgeNoLeak(_out: string, context?: JudgeContext): JudgeResult {
  const paths = collectScratchPaths(context);
  if (paths.length === 0) {
    return { passed: true, reason: 'no scratch file written (inline / tools-only)' };
  }
  const classes = paths.map((p) => `${p}=>${classifyPath(p)}`);
  const leaked = paths.some((p) => classifyPath(p) === 'bad_location');
  return leaked
    ? { passed: false, reason: `bad_location: ${classes.join(', ')}` }
    : { passed: true, reason: classes.join(', ') };
}

/** Bonus signal: did the model adopt the shown session directory? */
function judgeSessionAdoption(_out: string, context?: JudgeContext): JudgeResult {
  const paths = collectScratchPaths(context);
  const adopted = paths.some((p) => classifyPath(p) === 'session_dir');
  return adopted
    ? { passed: true, reason: 'adopted session_dir' }
    : { passed: false, reason: paths.length ? paths.join(', ') : 'no scratch path' };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'no_leak', category: 'correctness', judge: judgeNoLeak },
  { name: 'session_adoption', category: 'correctness', judge: judgeSessionAdoption },
];

// =====================================================================
// Driver
// =====================================================================

describe('v0.7.55 session scratch directory discipline', () => {
  const aliases = availableAliases(...PANEL);

  if (aliases.length === 0) {
    it('skips: no panel alias key in env', () => {
      /* no-op */
    });
    return;
  }

  it(
    `forced_scratch_script — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
    { timeout: 12 * 60_000 },
    async () => {
      const variants = [
        {
          id: 'v_baseline_v0754',
          description: 'v0.7.54 discipline — scratch at .agent/tmp/ root, no session dir',
          systemPrompt: SYSTEM_BASELINE,
          tools: TOOLS,
          priorMessages: [],
          userMessage: USER_MESSAGE_C1,
        },
        {
          id: 'v_proposed_v0755',
          description: 'v0.7.55 discipline — Session Scratch Directory shown + sessions/ subdir',
          systemPrompt: SYSTEM_PROPOSED,
          tools: TOOLS,
          priorMessages: [],
          userMessage: USER_MESSAGE_C1,
        },
      ];

      const result = await runBenchmark({
        variants,
        models: aliases,
        judges: JUDGES,
        runs: RUNS_PER_CELL,
        aliasFallback: ALIAS_FALLBACK,
      });

      const lines: string[] = ['[v0755-session-scratch-discipline][forced_scratch_script]'];
      for (const variantId of ['v_baseline_v0754', 'v_proposed_v0755']) {
        const cells = result.byVariant[variantId] ?? [];
        lines.push(`  --- ${variantId} ---`);
        for (const cell of cells) {
          const noLeak = cell.runsRaw.filter((r) =>
            r.judges.find((j) => j.name === 'no_leak')?.passed).length;
          const adopt = cell.runsRaw.filter((r) =>
            r.judges.find((j) => j.name === 'session_adoption')?.passed).length;
          lines.push(
            `    ${cell.alias.padEnd(14)} no_leak=${noLeak}/${cell.runsRaw.length} session_adoption=${adopt}/${cell.runsRaw.length}`,
          );
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, 'forced_scratch_script.json');
      const dump = {
        case: 'forced_scratch_script',
        stage: 'v0755-session-scratch-discipline',
        startedAt: result.startedAt,
        scratchDir: SCRATCH_DIR,
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
      writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`  [dump] ${dumpPath}`);
    },
  );
});
