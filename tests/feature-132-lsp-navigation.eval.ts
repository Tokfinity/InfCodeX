/**
 * Eval: FEATURE_132 Phase E — LSP navigation routing.
 *
 * Single-turn probe: given the production `lsp_*` tool descriptions plus the
 * competing repo-intelligence / grep tools, does the model route a precise,
 * position-anchored question to an `lsp_*` tool (positive) and a repo-scope /
 * literal-string question elsewhere (boundary)? Measures the production tool
 * description bytes via the harness `tools` channel (anti-pattern 8).
 *
 * **Layer 1 check**: this cannot be answered without an LLM — it asks how a
 * model ROUTES given competing tool descriptions. The descriptions themselves
 * are unit-tested for registration/shape; routing behaviour needs the probe.
 *
 * **Pre-registered SHIP gate** (read off the printed rates):
 *   (a) lsp cases — ≥4/5 alias reach ≥60% lsp-routing (aggregated over the 4 lsp cases).
 *   (b) boundary cases — ≥4/5 alias reach ≥60% no-over-trigger (over the 3 boundary cases).
 *   Floor-saturation per alias may be evidence-driven overridden (anti-pattern 11);
 *   genuine over-trigger / under-trigger is NOT overridable.
 *
 * **Run modes** (env `KODAX_F132_PROBE`):
 *   - `pilot` → ark/v4flash × all cases × 1 run (cheap trigger check).
 *   - `scale` → canonical 5-alias × all cases × 3 runs.
 *
 * **Run**:
 *   KODAX_F132_PROBE=pilot npm run test:eval -- feature-132-lsp-navigation
 *   KODAX_F132_PROBE=scale npm run test:eval -- feature-132-lsp-navigation
 *
 * Skips when API keys are absent (FEATURE_104 pattern). Not in regular CI.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  collectSelectedTools,
  isAppropriateRouting,
  selectedLspTool,
  SYSTEM_PROMPT,
  TOOLS,
} from '../benchmark/datasets/feature-132-lsp-navigation/cases.js';

const MODE = process.env.KODAX_F132_PROBE ?? 'pilot';
const SCALE = MODE === 'scale';

const SCALE_PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];
const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'];
const RUNS = SCALE ? 3 : 1;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-132-lsp-navigation');

function dump(file: string, line: string): void {
  mkdirSync(DUMP_ROOT, { recursive: true });
  writeFileSync(join(DUMP_ROOT, file), `${line}\n`, { flag: 'a' });
}

describe(`Eval: FEATURE_132 LSP navigation routing (${MODE})`, () => {
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
      // per[alias][kind] = { ok, total } ; perCase for the printed table.
      const perCase = new Map<string, { kind: string; lsp: number; ok: number; exact: number; total: number }>();
      const perAliasKind = new Map<string, { ok: number; total: number }>();

      for (const alias of aliases) {
        for (const c of CASES) {
          for (let run = 0; run < RUNS; run += 1) {
            const out = await runOneShot(alias, {
              systemPrompt: SYSTEM_PROMPT,
              userMessage: c.prompt,
              tools: TOOLS,
            });
            const selected = collectSelectedTools(out.toolCalls, out.text);
            const lsp = selectedLspTool(selected);
            const ok = isAppropriateRouting(c.kind, selected);
            const exact = c.expected ? selected.has(c.expected) : false;

            const agg = perCase.get(c.id) ?? { kind: c.kind, lsp: 0, ok: 0, exact: 0, total: 0 };
            agg.lsp += lsp ? 1 : 0;
            agg.ok += ok ? 1 : 0;
            agg.exact += exact ? 1 : 0;
            agg.total += 1;
            perCase.set(c.id, agg);

            const akKey = `${alias}|${c.kind}`;
            const ak = perAliasKind.get(akKey) ?? { ok: 0, total: 0 };
            ak.ok += ok ? 1 : 0;
            ak.total += 1;
            perAliasKind.set(akKey, ak);

            dump(
              `${alias.replace('/', '_')}.jsonl`,
              JSON.stringify({
                alias,
                case: c.id,
                kind: c.kind,
                run,
                selected: [...selected],
                ok,
                text: out.text.slice(0, 400),
              }),
            );
          }
        }
      }

      // eslint-disable-next-line no-console
      console.log(`\n[FEATURE_132 ${MODE}] dump: ${DUMP_ROOT}`);
      for (const c of CASES) {
        const agg = perCase.get(c.id)!;
        const lspPct = Math.round((agg.lsp / agg.total) * 100);
        const okPct = Math.round((agg.ok / agg.total) * 100);
        // eslint-disable-next-line no-console
        console.log(
          `  ${c.kind === 'lsp' ? 'LSP     ' : 'boundary'} ${c.id.padEnd(18)}` +
            ` lsp ${String(lspPct).padStart(3)}%  routing-OK ${String(okPct).padStart(3)}% (${agg.ok}/${agg.total})` +
            (c.expected ? `  exact ${Math.round((agg.exact / agg.total) * 100)}%` : ''),
        );
      }
      // Per-alias × kind gate view.
      // eslint-disable-next-line no-console
      console.log('\n  per-alias routing-OK by kind:');
      for (const alias of aliases) {
        const lspAk = perAliasKind.get(`${alias}|lsp`);
        const bndAk = perAliasKind.get(`${alias}|boundary`);
        const fmt = (a?: { ok: number; total: number }) =>
          a ? `${Math.round((a.ok / a.total) * 100)}% (${a.ok}/${a.total})` : 'n/a';
        // eslint-disable-next-line no-console
        console.log(`    ${alias.padEnd(14)} lsp ${fmt(lspAk).padEnd(14)} boundary ${fmt(bndAk)}`);
      }

      expect(perCase.size).toBe(CASES.length);
    },
    90 * 60 * 1000,
  );
});
