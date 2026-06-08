/**
 * Eval: FEATURE_218 self-knowledge roundtrip.
 *
 * Single-turn probe: does the model call kodax_manual for KodaX product
 * questions (positive) and skip it for ordinary coding tasks (negative)?
 * Measures the production routing rule + production tool schema.
 *
 * **Run modes** (env `KODAX_F218_PROBE`):
 *   - `pilot` → ark/v4flash × all cases × 1 run (cheap trigger check).
 *   - `scale` → canonical 5-alias × all cases × 3 runs.
 *
 * **Run**:
 *   KODAX_F218_PROBE=pilot npm run test:eval -- self-knowledge-roundtrip
 *   KODAX_F218_PROBE=scale npm run test:eval -- self-knowledge-roundtrip
 *
 * Skips when API keys are absent (FEATURE_104 pattern). Not in regular CI.
 * SHIP decision is made by reading the printed per-case rates, not a hard gate.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  classifyToolCall,
  SYSTEM_PROMPT,
  TOOLS,
} from '../benchmark/datasets/feature-218-self-knowledge/cases.js';

const MODE = process.env.KODAX_F218_PROBE ?? 'pilot';
const SCALE = MODE === 'scale';

const SCALE_PANEL: readonly ModelAlias[] = ['zhipu/glm51', 'kimi', 'mmx/m27', 'ark/v4pro', 'ark/v4flash'];
const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'];
const RUNS = SCALE ? 3 : 1;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-218-self-knowledge');

function dump(file: string, line: string): void {
  // Re-mkdir before each write — Windows tmp cleanup can remove the dir mid-run.
  mkdirSync(DUMP_ROOT, { recursive: true });
  writeFileSync(join(DUMP_ROOT, file), `${line}\n`, { flag: 'a' });
}

describe(`Eval: FEATURE_218 self-knowledge roundtrip (${MODE})`, () => {
  const aliases = availableAliases(...(SCALE ? SCALE_PANEL : PILOT_PANEL));

  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      expect(true).toBe(true);
    });
    return;
  }

  it(
    `runs ${aliases.length} alias × ${CASES.length} case × ${RUNS} run`,
    async () => {
      // perCase[id] = { product, called, total }
      const perCase = new Map<string, { kind: string; called: number; total: number }>();

      for (const alias of aliases) {
        for (const c of CASES) {
          for (let run = 0; run < RUNS; run += 1) {
            const out = await runOneShot(alias, {
              systemPrompt: SYSTEM_PROMPT,
              userMessage: c.prompt,
              tools: TOOLS,
            });
            const calledManual = classifyToolCall(out.toolCalls);

            const agg = perCase.get(c.id) ?? { kind: c.kind, called: 0, total: 0 };
            agg.called += calledManual ? 1 : 0;
            agg.total += 1;
            perCase.set(c.id, agg);

            dump(
              `${alias.replace('/', '_')}.jsonl`,
              JSON.stringify({ alias, case: c.id, kind: c.kind, run, calledManual, text: out.text.slice(0, 400) }),
            );
          }
        }
      }

      // Print per-case rates. Product cases want high call rate; coding cases want low.
      // eslint-disable-next-line no-console
      console.log(`\n[FEATURE_218 ${MODE}] dump: ${DUMP_ROOT}`);
      for (const c of CASES) {
        const agg = perCase.get(c.id)!;
        const pct = Math.round((agg.called / agg.total) * 100);
        // eslint-disable-next-line no-console
        console.log(`  ${c.kind === 'product' ? 'PRODUCT' : 'coding '} ${c.id.padEnd(18)} kodax_manual ${pct}% (${agg.called}/${agg.total})`);
      }

      // Data-validity assertion only — SHIP decision is read off the rates above.
      expect(perCase.size).toBe(CASES.length);
    },
    90 * 60 * 1000,
  );
});
