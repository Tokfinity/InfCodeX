/**
 * Eval: FEATURE_094 necessity probe — permanent regression probe
 *
 * **Status**: FEATURE_094 **CANCELLED 2026-05-19** (escape rate 0/43).
 * This probe is **retained** to re-verify the invariant: if the canonical
 * 5-alias panel's bash-heredoc-escape rate ever rises above 5% on these
 * 3 generative large-file write cases, FEATURE_094 should be re-opened
 * (prompt layer drifted, or a provider model regressed).
 *
 * **Design + decision matrix**: see
 *   benchmark/datasets/feature-094-necessity-probe/cases.ts (docstring)
 *
 * **Run modes** (env var `KODAX_F094_PROBE`):
 *   - `pilot`  → ds/v4flash × 1 case × 1 run = 1 call (anti-pattern 4
 *                 探索期用便宜 alias). Cost ~$0.005.
 *   - `scale`  → 5 alias × 3 case × 3 run = 45 calls. Cost ~$1.35.
 *
 * **Run**:
 *   KODAX_F094_PROBE=pilot npm run test:eval -- feature-094-necessity-probe
 *   KODAX_F094_PROBE=scale npm run test:eval -- feature-094-necessity-probe
 *
 * Skips when API keys are absent (FEATURE_104 pattern). Not run in
 * regular CI — manual invocation only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import {
  availableAliases,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  classifyToolCall,
  type Kind,
  SYSTEM_PROMPT,
  TOOLS,
} from '../benchmark/datasets/feature-094-necessity-probe/cases.js';

const MODE = process.env.KODAX_F094_PROBE ?? 'pilot';
const SCALE = MODE === 'scale';

// Canonical 5-alias panel — see benchmark/EVAL_GUIDELINES.md §"Canonical alias panel".
// `KODAX_F094_ALIASES` env can override (comma-separated short ids) — used to resume
// after a partial-completion run without redoing already-completed aliases.
const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ds/v4pro',
  'ds/v4flash',
];

const SCALE_PANEL: readonly ModelAlias[] = process.env.KODAX_F094_ALIASES
  ? (process.env.KODAX_F094_ALIASES.split(',').map((s) => s.trim()) as readonly ModelAlias[])
  : DEFAULT_SCALE_PANEL;

// Pilot uses the cheapest floor alias.
const PILOT_PANEL: readonly ModelAlias[] = ['ds/v4flash'];

const RUNS = SCALE ? 3 : 1;
const CASES_TO_RUN = SCALE ? CASES : [CASES[0]!];
const REQUESTED = SCALE ? SCALE_PANEL : PILOT_PANEL;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-094-necessity-probe');

describe(`Eval: FEATURE_094 necessity probe (${MODE})`, () => {
  const aliases = availableAliases(...REQUESTED);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    `runs ${aliases.length}×${CASES_TO_RUN.length}×${RUNS} = ${aliases.length * CASES_TO_RUN.length * RUNS} probes`,
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dumpFile = join(DUMP_ROOT, `${MODE}-${stamp}.jsonl`);

      console.log(`\n[F094 probe] Mode=${MODE} aliases=${aliases.join(',')} cases=${CASES_TO_RUN.length} runs=${RUNS}`);
      console.log(`[F094 probe] dump: ${dumpFile}\n`);

      interface Row {
        alias: ModelAlias;
        caseId: string;
        runIdx: number;
        durationMs: number;
        kind: Kind;
        detail: string;
        bodyLines?: number;
        bodyChars?: number;
        toolName: string | null;
        rawToolCalls: unknown;
        rawText: string;
      }
      const rows: Row[] = [];

      for (const alias of aliases) {
        for (const c of CASES_TO_RUN) {
          for (let r = 0; r < RUNS; r += 1) {
            process.stdout.write(`  [${alias}] ${c.id} ${r + 1}/${RUNS}: `);
            try {
              const result = await runOneShot(alias, {
                systemPrompt: SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: TOOLS,
              });
              const cls = classifyToolCall(result.toolCalls, result.text);
              const row: Row = {
                alias,
                caseId: c.id,
                runIdx: r,
                durationMs: result.durationMs,
                kind: cls.kind,
                detail: cls.detail,
                bodyLines: cls.bodyLines,
                bodyChars: cls.bodyChars,
                toolName: result.toolCalls[0]?.name ?? null,
                rawToolCalls: result.toolCalls,
                rawText: result.text,
              };
              rows.push(row);
              writeFileSync(dumpFile, JSON.stringify(row) + '\n', { flag: 'a' });
              console.log(`${cls.kind} (${result.durationMs}ms) — ${cls.detail}`);
            } catch (err) {
              const msg = (err as Error).message;
              console.log(`ERROR — ${msg}`);
              const row: Row = {
                alias,
                caseId: c.id,
                runIdx: r,
                durationMs: -1,
                kind: 'other',
                detail: `error: ${msg}`,
                toolName: null,
                rawToolCalls: [],
                rawText: '',
              };
              rows.push(row);
              writeFileSync(dumpFile, JSON.stringify(row) + '\n', { flag: 'a' });
            }
          }
        }
      }

      // ─── Aggregate ───────────────────────────────────────────────
      console.log('\n=== Summary ===');
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      for (const [k, v] of sorted) {
        console.log(`  ${k}: ${v}/${rows.length} (${((v / rows.length) * 100).toFixed(1)}%)`);
      }

      if (aliases.length > 1) {
        console.log('\n=== Per-alias escape rates ===');
        for (const alias of aliases) {
          const sub = rows.filter((r) => r.alias === alias);
          const esc = sub.filter((r) => r.kind.startsWith('escape-')).length;
          const wr = sub.filter((r) => r.kind === 'write').length;
          const me = sub.filter((r) => r.kind === 'multi_edit').length;
          const nt = sub.filter((r) => r.kind === 'no-tool').length;
          const ot = sub.length - esc - wr - me - nt;
          const escapeRate = (esc / sub.length) * 100;
          console.log(
            `  ${alias}: escape=${esc}/${sub.length} (${escapeRate.toFixed(0)}%) `
            + `write=${wr} multi_edit=${me} no-tool=${nt} other=${ot}`,
          );
        }

        // Panel escape rate
        const escapeRates = aliases.map((alias) => {
          const sub = rows.filter((r) => r.alias === alias);
          const esc = sub.filter((r) => r.kind.startsWith('escape-')).length;
          return sub.length > 0 ? esc / sub.length : 0;
        });
        const panelMean = (escapeRates.reduce((a, b) => a + b, 0) / escapeRates.length) * 100;
        const panelMax = Math.max(...escapeRates) * 100;
        console.log(`\n=== Panel ===`);
        console.log(`  panel_escape_rate (mean):     ${panelMean.toFixed(1)}%`);
        console.log(`  max_alias_escape_rate:        ${panelMax.toFixed(1)}%`);
      }

      console.log(`\nDump: ${dumpFile}`);
    },
    90 * 60 * 1000,  // 90min timeout — kimi probes hit 60-190s/call, 45 calls × ~90s avg = ~75min
  );
});
