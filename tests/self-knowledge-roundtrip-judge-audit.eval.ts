/**
 * Audit: FEATURE_218 self-knowledge roundtrip — 3-judge majority (anti-pattern 7 §3).
 *
 * The panel (self-knowledge-roundtrip.eval.ts) classifies each cell by BINDING
 * (did the model call kodax_manual?). This audit independently LLM-judges
 * whether the model's tool routing was APPROPRIATE, then compares the 3-judge
 * majority to the binding classification. Disagreement > 10% = DATA INVALID.
 *
 * Judges are panel-internal (zhipu/glm51 + ds/v4pro + kimi) — NEVER
 * anthropic/openai (Judge-model constraint). The binding is given to the judge
 * as ABSOLUTE GROUND TRUTH so empty-text binding-only models are not misjudged
 * (per feedback_audit_must_see_binding + feedback_audit_binding_priority_in_prompt).
 *
 * **Run** (after the panel has produced its dump):
 *   npm run test:eval -- self-knowledge-roundtrip-judge-audit
 *
 * Env `KODAX_F218_AUDIT_RUNS` (default '0'): comma-separated run indices to
 * audit (default run 0 of every case×alias = 60 cells × 3 judges = 180 calls).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  isAppropriateRouting,
  type Kind,
} from '../benchmark/datasets/feature-218-self-knowledge/cases.js';

// Panel-internal judges (coding-plan; NEVER anthropic/openai per anti-pattern 7).
// These three carry keys in the canonical panel, so the audit does not skip.
const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-218-self-knowledge');
const AUDIT_RUNS = new Set((process.env.KODAX_F218_AUDIT_RUNS ?? '0').split(',').map((s) => Number(s.trim())));

interface Cell {
  readonly alias: string;
  readonly caseId: string;
  readonly kind: Kind;
  readonly run: number;
  readonly calledManual: boolean;
  readonly toolNames: readonly string[];
  readonly text: string;
}

const PROMPT_BY_ID = new Map(CASES.map((c) => [c.id, c.prompt]));

function readCells(): Cell[] {
  let files: string[] = [];
  try {
    files = readdirSync(DUMP_ROOT).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const cells: Cell[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(DUMP_ROOT, f), 'utf-8').trim().split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line) as Cell & { case: string };
      if (!AUDIT_RUNS.has(r.run)) continue;
      cells.push({
        alias: r.alias,
        caseId: r.case,
        kind: r.kind,
        run: r.run,
        calledManual: r.calledManual,
        toolNames: r.toolNames ?? [],
        text: r.text ?? '',
      });
    }
  }
  return cells;
}

function buildJudgePrompt(cell: Cell): { systemPrompt: string; userMessage: string } {
  const prompt = PROMPT_BY_ID.get(cell.caseId) ?? '(unknown)';
  const systemPrompt =
    'You are an independent judge auditing whether an AI coding agent routed a user request to the correct tool. ' +
    'Reply with ONE line of JSON only — no markdown, no preamble.';
  const userMessage =
    `CRITICAL RULE: the TOOL-CALL BINDING below is the ABSOLUTE GROUND TRUTH for which tools the agent invoked. ` +
    `Empty agent text does NOT mean no tool was called — trust the binding, not the text.\n\n` +
    `The agent had these tools available:\n` +
    `  - kodax_manual: looks up KodaX's own product manual (how to use/install/configure/troubleshoot KodaX).\n` +
    `  - read / edit / grep: read, modify, and search files in the user's codebase.\n\n` +
    `Routing rule being audited: kodax_manual is correct ONLY for questions about how to use/configure/` +
    `install/troubleshoot KodaX itself. For ordinary coding tasks (editing a file, explaining code), the agent ` +
    `should use read/edit/grep or answer directly — NOT kodax_manual.\n\n` +
    `User request:\n"${prompt}"\n\n` +
    `TOOL-CALL BINDING (ground truth) — tools the agent invoked this turn: [${cell.toolNames.join(', ') || '(none)'}]\n` +
    `Agent text (may be empty for binding-only models):\n"${cell.text}"\n\n` +
    `Was the agent's tool routing APPROPRIATE for this request?\n` +
    `Reply PASS if correct (kodax_manual for a KodaX product question; NOT kodax_manual for a coding task), FAIL otherwise.\n` +
    `JSON: {"judgment":"PASS","reason":"<=80 chars"} or {"judgment":"FAIL","reason":"<=80 chars"}`;
  return { systemPrompt, userMessage };
}

type Verdict = 'PASS' | 'FAIL' | 'UNCLEAR';

function parseVerdict(raw: string): Verdict {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return 'UNCLEAR';
  try {
    const j = String((JSON.parse(m[0]) as { judgment?: string }).judgment ?? '').toUpperCase();
    return j === 'PASS' || j === 'FAIL' ? j : 'UNCLEAR';
  } catch {
    return 'UNCLEAR';
  }
}

function majority(vs: readonly Verdict[]): Verdict {
  const pass = vs.filter((v) => v === 'PASS').length;
  const fail = vs.filter((v) => v === 'FAIL').length;
  if (pass >= 2) return 'PASS';
  if (fail >= 2) return 'FAIL';
  return 'UNCLEAR';
}

describe('Audit: FEATURE_218 self-knowledge routing — 3-judge majority (anti-pattern 7)', () => {
  const judges = availableAliases(...JUDGES);

  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  it(
    'audits routing cells with a 3-judge majority and reports disagreement vs binding',
    async () => {
      const cells = readCells();
      expect(cells.length, 'no dump cells found — run the panel first').toBeGreaterThan(0);

      let agree = 0;
      let disagree = 0;
      let unclear = 0;
      const disagreements: string[] = [];

      for (const cell of cells) {
        const { systemPrompt, userMessage } = buildJudgePrompt(cell);
        const verdicts: Verdict[] = [];
        for (const judge of judges) {
          const out = await runOneShot(judge, { systemPrompt, userMessage });
          verdicts.push(parseVerdict(out.text));
        }
        const judgeMajority = majority(verdicts);
        const bindingPass = isAppropriateRouting(cell.kind, cell.calledManual);

        if (judgeMajority === 'UNCLEAR') {
          unclear += 1;
        } else if ((judgeMajority === 'PASS') === bindingPass) {
          agree += 1;
        } else {
          disagree += 1;
          disagreements.push(
            `${cell.alias}/${cell.caseId} binding=${bindingPass ? 'PASS' : 'FAIL'} judges=${judgeMajority} called=[${cell.toolNames.join(',')}]`,
          );
        }
      }

      const total = cells.length;
      const disagreePct = Math.round((disagree / total) * 1000) / 10;
      // eslint-disable-next-line no-console
      console.log(
        `\n[FEATURE_218 audit] cells=${total} agree=${agree} disagree=${disagree} unclear=${unclear}` +
          ` disagreement=${disagreePct}% → ${disagreePct < 10 ? 'DATA VALID' : 'DATA INVALID'}`,
      );
      for (const d of disagreements) {
        // eslint-disable-next-line no-console
        console.log(`  DISAGREE: ${d}`);
      }

      // Anti-pattern 7 gate: < 10% disagreement = the binding classification is trustworthy.
      expect(disagreePct, 'judge↔binding disagreement exceeds 10% (DATA INVALID)').toBeLessThan(10);
    },
    90 * 60 * 1000,
  );
});
