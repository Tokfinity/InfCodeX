/**
 * FEATURE_124 (v0.7.43) Phase E — memory subsystem behavioural smoke eval.
 *
 * **Status**: smoke test, NOT a SHIP-gate prompt-eval.
 * **Layer**: EVAL_GUIDELINES Layer 2 single-turn probe.
 *
 * **What it measures**: when the agent is configured with the FEATURE_124
 * memory subsystem (memory-rules teaching text + project-memory index in
 * the system prompt) plus the Write/Edit/Read/Grep/Glob tools, does it:
 *   S1 WRITE: a user feedback statement triggers a Write into the memory
 *      directory with a feedback_* filename?
 *   S2 READ : MEMORY.md pre-seeded with a `user_role` entry → user asks a
 *      stack-relevant question → agent Reads or Greps inside the memory
 *      directory before answering?
 *   S3 NO-DUP: a feedback memory already exists + user repeats it → agent
 *      does NOT Write a duplicate file (no Write to memory dir is the
 *      pass; Edit on the existing file is also acceptable).
 *
 * **Topology**: 2 aliases (`ark/v4flash` + `zhipu/glm51`) × 3 cases ×
 * 2 runs = 12 cells. Budget ~$1-2. Per design doc v0.7.43.md §Step E.
 *
 * **Why deterministic regex judge (not LLM judge)**: the PASS criteria
 * are structural — the model invoked a specific tool with a specific
 * path prefix. Path prefix containment is uncontroversial; an LLM judge
 * would add $1+ of cost for zero signal lift. The audit is "did the tool
 * call land in the memory directory" — a string operation.
 *
 * **Pass policy**: this is a smoke test. Failure → tune memory-rules
 * prompt then re-run. Does NOT block FEATURE_124 ship. See
 * `docs/features/v0.7.43.md` §"Phase 实施状态" — the design table marks
 * this as Phase E with soft-gate semantics on purpose: the eval-validated
 * claudecode wording is the strong prior; this eval just verifies the
 * KodaX-specific deltas (PREPEND-to-top, AGENTS.md ref, displayed
 * memory-dir path) don't disrupt that prior.
 *
 * **Why this is NOT a FEATURE_104 SHIP-gate eval**:
 *   - The teaching text is mostly verbatim from claudecode (eval-validated
 *     wording reused). The cost of a full 5-alias × 3-variant × 5-run
 *     panel + 3-judge audit would re-pay claudecode's eval cost for no
 *     additional signal.
 *   - The KodaX-specific deltas (per-project path, AGENTS.md ref) are
 *     verified by deterministic substrate tests (Phase A/B/C — 50 + 13
 *     + 5 = 68 unit/integration tests).
 *   - This smoke eval guards against "the prompt loads but the model
 *     ignores it" — a binary outcome the simple regex judge resolves.
 *
 * Skips when neither ARK_API_KEY nor ZHIPU_API_KEY is set.
 * Run: `npm run test:eval -- tests/memory-smoke.eval.ts`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import {
  setAgentConfigHome,
  resolveMemoryRoot,
  resolveMemoryEntrypoint,
} from '@kodax-ai/agent';
import { buildSystemPrompt } from '@kodax-ai/coding';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const REQUESTED: readonly ModelAlias[] = ['ark/v4flash', 'zhipu/glm51'];
const RUNS = 2;
const DUMP_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-124-memory-smoke');

// ── Tool schemas the LLM may pick ─────────────────────────────────────────
// Match the shape KodaX's production tools advertise (path / pattern /
// content fields) — we don't need to wire them to real impls because the
// harness records `toolCalls` without executing them.
const TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'Write',
    description: 'Write a file to disk. Use this to create a new file or overwrite an existing one.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to write.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit an existing file by string replacement.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact substring to replace.' },
        new_string: { type: 'string', description: 'Replacement substring.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from disk and return its content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for a regex pattern across files in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern.' },
        path: { type: 'string', description: 'Directory or file to search.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'List files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. *.md).' },
        path: { type: 'string', description: 'Directory to search in.' },
      },
      required: ['pattern'],
    },
  },
];

interface MemoryCase {
  readonly id: 'S1_write' | 'S2_read' | 'S3_no_duplicate';
  readonly description: string;
  readonly userMessage: string;
  /** Pre-seed memory dir before the case runs. */
  readonly seed: (memoryDir: string) => void;
  /**
   * Classify the model's tool calls. PASS = at least one tool call lands
   * with a `path` inside `memoryDir`, with the per-case shape constraint.
   *
   * S3 is inverted — PASS means "no Write created a NEW topic file
   * inside the memory dir". Edit on the existing file counts as PASS.
   */
  readonly classify: (
    toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
    memoryDir: string,
  ) => { passed: boolean; reason: string };
}

function readPath(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'path' in input) {
    const value = (input as { path: unknown }).path;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isInsideMemoryDir(p: string | undefined, memoryDir: string): boolean {
  if (!p) return false;
  const normalised = path.resolve(p);
  return normalised.startsWith(memoryDir + path.sep) || normalised === memoryDir;
}

const CASES: readonly MemoryCase[] = [
  {
    id: 'S1_write',
    description: 'feedback-style user message triggers Write to memory dir',
    userMessage:
      "Don't mock the database in these tests — we got burned last quarter when " +
      'mocked tests passed but the production migration silently failed. ' +
      'Please remember this for future work.',
    seed: () => {
      // No pre-state — memory dir starts empty so the model has to
      // both create the topic file AND seed MEMORY.md.
    },
    classify: (toolCalls, memoryDir) => {
      const writeCall = toolCalls.find((c) => c.name === 'Write');
      if (!writeCall) {
        return { passed: false, reason: 'no Write call' };
      }
      const target = readPath(writeCall.input);
      if (!isInsideMemoryDir(target, memoryDir)) {
        return { passed: false, reason: `Write target outside memory dir: ${target}` };
      }
      // Soft check: feedback memories conventionally use feedback_* names.
      // We only LOG the convention match — not gate PASS on it, since
      // the model is allowed to pick another reasonable name as long as
      // it lands inside the memory dir.
      const looksLikeFeedback = /feedback[_-]/i.test(path.basename(target!));
      return {
        passed: true,
        reason: `Write to ${target}${looksLikeFeedback ? ' (feedback_*)' : ' (non-feedback name)'}`,
      };
    },
  },
  {
    id: 'S2_read',
    description: 'pre-seeded user_role memory → user question triggers Read/Grep',
    userMessage:
      'I am about to refactor a service in this project. What stack and what ' +
      "patterns should I prioritise for? Consider the user's background.",
    seed: (memoryDir) => {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, 'MEMORY.md'),
        '- [User role](user_role.md) — Senior backend engineer; Go + PostgreSQL focus\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(memoryDir, 'user_role.md'),
        [
          '---',
          'name: User role',
          'description: Senior backend engineer; Go + PostgreSQL focus',
          'type: user',
          '---',
          '',
          'The user is a senior backend engineer working primarily in Go with PostgreSQL. ',
          'They prefer idiomatic Go (composition over inheritance, small interfaces, ',
          'context plumbing) and PostgreSQL-flavoured SQL (CTEs, EXPLAIN ANALYZE).',
        ].join('\n'),
        'utf-8',
      );
    },
    classify: (toolCalls, memoryDir) => {
      const readish = toolCalls.find(
        (c) =>
          (c.name === 'Read' || c.name === 'Grep' || c.name === 'Glob') &&
          isInsideMemoryDir(readPath(c.input), memoryDir),
      );
      if (!readish) {
        return { passed: false, reason: 'no Read/Grep/Glob into memory dir' };
      }
      return {
        passed: true,
        reason: `${readish.name} ${readPath(readish.input)}`,
      };
    },
  },
  {
    id: 'S3_no_duplicate',
    description: 'duplicate feedback already in memory → model does NOT Write a new topic file',
    userMessage:
      "Don't mock the database in our tests — it caused that migration regression. " +
      'Please remember.',
    seed: (memoryDir) => {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, 'MEMORY.md'),
        '- [No mock DB](feedback_no_mock_db.md) — Don\'t mock DB in tests (prod migration regression)\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(memoryDir, 'feedback_no_mock_db.md'),
        [
          '---',
          'name: No mock DB',
          "description: Don't mock DB in tests (prod migration regression)",
          'type: feedback',
          '---',
          '',
          "Integration tests must hit a real database, not mocks. Reason: prior ",
          'incident where mock/prod divergence masked a broken migration.',
        ].join('\n'),
        'utf-8',
      );
    },
    classify: (toolCalls, memoryDir) => {
      // Scan ALL Write calls inside the memory dir — using `.find` on
      // the first match would order-dependently miss a duplicate Write
      // that comes AFTER a Write to the seeded file or MEMORY.md (the
      // model is allowed to update the existing memory + MEMORY.md
      // index; what we're guarding against is the creation of a NEW
      // topic file with a different filename).
      const duplicateWrites: string[] = [];
      for (const c of toolCalls) {
        if (c.name !== 'Write') continue;
        const target = readPath(c.input);
        if (!isInsideMemoryDir(target, memoryDir)) continue;
        const base = path.basename(target!);
        // Acceptable Writes inside memory dir: the existing seeded
        // file (update) or MEMORY.md (index update). Anything else is
        // a duplicate-creation FAIL.
        if (base !== 'feedback_no_mock_db.md' && base !== 'MEMORY.md') {
          duplicateWrites.push(base);
        }
      }
      if (duplicateWrites.length > 0) {
        return {
          passed: false,
          reason: `created duplicate file(s) in memory dir: ${duplicateWrites.join(', ')}`,
        };
      }
      return { passed: true, reason: 'no duplicate Write' };
    },
  },
];

interface ProbeRow {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly runIndex: number;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly memoryDir: string;
  readonly passed: boolean;
  readonly reason: string;
}

describe('FEATURE_124 Phase E — memory subsystem smoke eval', () => {
  const aliases = availableAliases(...REQUESTED);
  if (aliases.length === 0) {
    it('skips: no provider API keys for ark/v4flash or zhipu/glm51', () => {
      // no-op
    });
    return;
  }

  it(
    'runs 12-cell smoke matrix and dumps raw output',
    { timeout: 900_000 },
    async () => {
      fs.mkdirSync(DUMP_ROOT, { recursive: true });
      const rows: ProbeRow[] = [];
      const incrementalDump = path.join(DUMP_ROOT, `incremental-${Date.now()}.json`);

      const flush = (): void => {
        fs.writeFileSync(
          incrementalDump,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              aliases,
              runs: RUNS,
              completedRows: rows.length,
              expectedRows: CASES.length * aliases.length * RUNS,
              rows,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };
      // eslint-disable-next-line no-console
      console.log(`[F124] incremental dump: ${incrementalDump}`);

      for (const c of CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // Per-cell temp home + temp cwd so cases / runs don't leak
            // memory state into each other.
            const tempHome = fs.mkdtempSync(
              path.join(os.tmpdir(), `kodax-mem-smoke-home-${c.id}-`),
            );
            const tempCwd = fs.mkdtempSync(
              path.join(os.tmpdir(), `kodax-mem-smoke-cwd-${c.id}-`),
            );
            setAgentConfigHome(tempHome);

            try {
              const memoryDir = resolveMemoryRoot(tempCwd);
              c.seed(memoryDir);

              const systemPrompt = await buildSystemPrompt(
                {
                  provider: 'openai',
                  context: { executionCwd: tempCwd, gitRoot: tempCwd },
                },
                true,
              );

              // eslint-disable-next-line no-console
              console.log(`[F124] case=${c.id} alias=${alias} run=${runIndex}`);

              let result;
              try {
                result = await runOneShot(alias, {
                  systemPrompt,
                  userMessage: c.userMessage,
                  tools: TOOLS,
                });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  `[F124] error case=${c.id} alias=${alias}: ${(err as Error).message}`,
                );
                continue;
              }

              const verdict = c.classify(result.toolCalls, memoryDir);
              rows.push({
                caseId: c.id,
                alias,
                runIndex,
                durationMs: result.durationMs,
                text: result.text,
                toolCalls: result.toolCalls,
                memoryDir,
                passed: verdict.passed,
                reason: verdict.reason,
              });
              flush();
            } finally {
              setAgentConfigHome(undefined);
              fs.rmSync(tempHome, { recursive: true, force: true });
              fs.rmSync(tempCwd, { recursive: true, force: true });
            }
          }
        }
      }

      // Final summary
      const summary: Record<string, Record<string, { passed: number; total: number }>> = {};
      for (const r of rows) {
        summary[r.caseId] ??= {};
        summary[r.caseId]![r.alias] ??= { passed: 0, total: 0 };
        const s = summary[r.caseId]![r.alias]!;
        s.total++;
        if (r.passed) s.passed++;
      }

      const finalDump = path.join(DUMP_ROOT, `final-${Date.now()}.json`);
      const overallTotal = rows.length;
      const overallPassed = rows.filter((r) => r.passed).length;
      fs.writeFileSync(
        finalDump,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            aliases,
            runs: RUNS,
            totalCells: overallTotal,
            passedCells: overallPassed,
            passRate: overallTotal > 0 ? overallPassed / overallTotal : 0,
            rows,
            summary,
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log('\n=== FEATURE_124 Phase E smoke ===');
      // eslint-disable-next-line no-console
      console.log(`Dump: ${finalDump}`);
      // eslint-disable-next-line no-console
      console.log(`Overall: ${overallPassed}/${overallTotal} cells PASS`);
      for (const caseId of Object.keys(summary).sort()) {
        // eslint-disable-next-line no-console
        console.log(`\nCase ${caseId}:`);
        for (const a of Object.keys(summary[caseId]!).sort()) {
          const s = summary[caseId]![a]!;
          const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
          // eslint-disable-next-line no-console
          console.log(`  ${a}: ${s.passed}/${s.total} (${pct}%)`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        '\nNote: SMOKE TEST — failures here are signals to tune memory-rules ' +
          'prompt, NOT ship blockers. The substrate (Phase A/B/C/D) ships with ' +
          '68 deterministic unit + integration tests.',
      );
    },
  );
});
