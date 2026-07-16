/**
 * Eval: Deferred-tool ADOPTION on ambiguous tasks + does teaching help? —
 * FEATURE_250 follow-up.
 *
 * ## Why this exists (the question the reachability eval could NOT answer)
 *
 * The first eval (`deferred-tool-two-hop-adoption.eval.ts`) proved hint-only
 * deferral does not harm REACHABILITY on CLEAR-need tasks — but it was
 * ceiling-saturated (V_full = 100% everywhere), so it could not see whether
 * hint-only under-adopts on AMBIGUOUS tasks, where the model might default to
 * the `grep`/`read` it knows from pretraining instead of the deferred tool.
 *
 * The only deferred "un-taught" tools with a genuine PROACTIVE-CHOICE quality
 * are `code_search` (ranked repo search, competes with `grep`) and
 * `semantic_lookup` (concept-level search). web_fetch/web_search/goal are
 * REACTIVE (a URL / goal request makes the tool obvious) — no ambiguity, so no
 * teaching value; they stay hint-only. This eval isolates the one place
 * teaching could plausibly matter.
 *
 * ## Design — Layer 2 single-turn probe, 3 variants
 *
 * Ambiguous repo-exploration tasks where `code_search`/`semantic_lookup` is the
 * better-than-grep choice but NOT obvious. Three byte-aligned variants (only
 * the deferred tools' description + an optional prompt block differ):
 *   - `V_full`  — code_search/semantic_lookup (+ module/symbol_context) carry
 *                 their PRODUCTION full description. No teaching block. Upper
 *                 bound: adoption when the model can read the full contract.
 *   - `V_hint`  — those tools carry their PRODUCTION searchHint + tool_search.
 *                 No teaching block. What FEATURE_250 ships today.
 *   - `V_teach` — hint (same as V_hint) + a brief CODE/SEMANTIC SEARCH teaching
 *                 block in the system prompt (mimics the repo-intel teaching
 *                 that lifted floor models +30-40pp in the F7 eval). This is the
 *                 CANDIDATE teaching we would add if it wins.
 *
 * Production tool bytes are IMPORTED (anti-pattern 8), never stubbed.
 *
 * ## Metric (mechanical, binding-first)
 *
 *   adopted = firstTool ∈ {code_search, semantic_lookup, tool_search}
 *             → the model reached for the ranked/semantic tool (or searched it)
 *   grepped = firstTool ∈ {grep, read, glob}   (pretraining default)
 *   other   = firstTool ∈ {module_context, symbol_context}  (a different — also
 *             valid — deferred tool; neither adoption nor grep-fallback)
 *
 * ## Pre-registered decision matrix (LOCKED before any LLM call)
 *
 * Per ALIAS (NOT aggregated):
 *   gap  = V_full.adopted − V_hint.adopted   (does hint-only lose adoption?)
 *   lift = V_teach.adopted − V_hint.adopted  (does teaching recover it?)
 *
 *   HINT_SUFFICIENT : V_hint.adopted ≥ V_full.adopted − 15pp on ≥4/5 aliases
 *                     → hint-only does NOT under-adopt → NO teaching needed
 *                       (adding it would only cost resident tokens).
 *   TEACHING_HELPS  : (gap ≥ 15pp on ≥2 aliases) AND
 *                     (V_teach.adopted ≥ V_full.adopted − 15pp on those aliases)
 *                     → hint-only under-adopts AND teaching recovers it
 *                       → ADD the teaching block for these two tools.
 *   MIXED           : neither clean → inspect raw, iterate wording.
 *
 * ## Budget
 *
 * Pilot (KODAX_EVAL_PILOT=1): ark/v4flash × 4 cases × 3 variants × 1 = 12 calls.
 * Full: 5 canonical × 4 × 3 × 3 = 180 calls (~$4). Worth one "add teaching or
 * not" decision per EVAL_GUIDELINES.
 *
 * ## Run
 *
 *   KODAX_EVAL_PILOT=1 npm run test:eval -- deferred-tool-hard-case-teaching
 *   npm run test:eval -- deferred-tool-hard-case-teaching
 *
 * Raw dumps: os.tmpdir()/kodax-eval-dumps/deferred-hard-case-teaching/<case>.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { getToolDefinition } from '@kodax-ai/coding';

import { DEFERRED_TOOL_HINTS } from '../packages/coding/src/tools/deferred-tools.js';
import { TOOL_SEARCH_DEFINITION } from '../packages/coding/src/tools/tool-search.js';
import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

// --- production tool bytes (imported, not stubbed) ---

function realTool(name: string): KodaXToolDefinition {
  const def = getToolDefinition(name);
  if (!def) throw new Error(`[hard-case-teaching] tool not registered: ${name}`);
  return def;
}
function fullTool(name: string): KodaXToolDefinition {
  return realTool(name);
}
function hintTool(name: string): KodaXToolDefinition {
  const def = realTool(name);
  const hint = DEFERRED_TOOL_HINTS[name];
  if (!hint) throw new Error(`[hard-case-teaching] no hint for: ${name}`);
  return { ...def, description: hint };
}
const TOOL_SEARCH_TOOL: KodaXToolDefinition = {
  name: TOOL_SEARCH_DEFINITION.name,
  description: TOOL_SEARCH_DEFINITION.description,
  input_schema: TOOL_SEARCH_DEFINITION.input_schema,
};

// Deferred tools under test + sibling deferred repo-intel (as realistic
// distractors). grep/read/glob are the pretraining-default fallback.
const DEFERRED_UNDER_TEST = ['code_search', 'semantic_lookup', 'module_context', 'symbol_context'] as const;
const FALLBACK_TOOL_NAMES = ['grep', 'read', 'glob'] as const;
const FALLBACK_TOOLS: readonly KodaXToolDefinition[] = FALLBACK_TOOL_NAMES.map(fullTool);

const ADOPTED_SET = new Set<string>(['code_search', 'semantic_lookup', 'tool_search']);
const GREP_SET = new Set<string>(FALLBACK_TOOL_NAMES);
const OTHER_DEFERRED_SET = new Set<string>(['module_context', 'symbol_context']);

// --- system prompt ---

const WORKER_BASE = [
  "You are the Worker — KodaX's single primary agent for this task.",
  '',
  'Routing decision summary:',
  '- Primary task: investigate',
  '- Work intent: review/explain',
  '- Risk: low',
  '- Complexity: moderate',
  '',
  'Repo context already injected: this workspace is a TypeScript monorepo at',
  '`C:/Works/GitWorks/KodaX-author/KodaX` with many packages under `packages/*`.',
].join('\n');

// CANDIDATE teaching block (added only in V_teach). Mimics the repo-intel
// teaching style (name the tool + when to prefer it over the pretraining
// default). ADR-033: qualitative when-to-use, single-concept lines, no taxonomy.
const CODE_SEARCH_TEACHING = [
  '',
  'CODE / SEMANTIC SEARCH TOOLS (prefer over raw grep for ranked or concept-level exploration):',
  '- `code_search(query)` — ranked text search with noise filtering. Prefer over `grep` when you want the strongest / most-likely matches (a shortlist), not every raw occurrence — e.g. "where is X most likely handled", "what are the main implementations of Y".',
  '- `semantic_lookup(query)` — symbol/module/process-aware semantic query against repo intelligence. Use when you are searching for a concept ("where do we validate auth") rather than an exact string.',
  '- Stick with `grep` for exact-string or all-occurrences needs where ranking does not help.',
].join('\n');

const SYSTEM_BASE = WORKER_BASE;
const SYSTEM_TEACH = WORKER_BASE + '\n' + CODE_SEARCH_TEACHING;

// --- cases: ambiguous repo-exploration where ranked/semantic > grep ---

interface CaseSpec {
  readonly id: string;
  readonly description: string;
  readonly userMessage: string;
}

const CASES: readonly CaseSpec[] = [
  {
    id: 'hc_duplicate_calls',
    description: 'Find likely culprits for duplicate API calls — "most likely" favors ranked code_search over exhaustive grep.',
    userMessage:
      'Something is causing duplicate outbound API calls somewhere in the request pipeline. Find the most likely culprit locations in the codebase so I can review them.',
  },
  {
    id: 'hc_auth_validation',
    description: 'Trace auth-token validation — concept query favors semantic_lookup / code_search over grep.',
    userMessage:
      'We are seeing occasional auth failures. Find where auth tokens are validated across the codebase and the spots where that validation could go wrong.',
  },
  {
    id: 'hc_retry_logic',
    description: 'Locate main retry/backoff implementations — "main implementations" favors ranked search.',
    userMessage:
      'Where in this codebase do we implement retry / backoff behavior? I want to review the main implementations, not every incidental mention.',
  },
  {
    id: 'hc_error_handling',
    description: 'Find inconsistent error handling around network calls — concept-level, favors semantic/ranked.',
    userMessage:
      'I suspect error handling around network calls is inconsistent across the repo. Find the most relevant places I should review to confirm.',
  },
];

// --- multi-syntax first-tool extraction (anti-pattern 7 §4) ---

const ALL_KNOWN = new Set<string>([
  ...DEFERRED_UNDER_TEST,
  ...FALLBACK_TOOL_NAMES,
  'tool_search',
]);
function extractFirstToolNameFromText(text: string): string | null {
  if (!text) return null;
  const cands: Array<{ name: string; pos: number }> = [];
  const re1 = /(?:^|[\s[`"({,>])([a-z_][a-z_0-9]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) cands.push({ name: m[1], pos: m.index });
  const re2 = /"name"\s*:\s*"([a-z_][a-z_0-9]*)"/g;
  while ((m = re2.exec(text)) !== null) cands.push({ name: m[1], pos: m.index });
  const re3 = /<([a-z_][a-z_0-9]*)[\s>]/g;
  while ((m = re3.exec(text)) !== null) cands.push({ name: m[1], pos: m.index });
  const re4 = /\bname\s*[=:]\s*["']?([a-z_][a-z_0-9]*)["']?/g;
  while ((m = re4.exec(text)) !== null) cands.push({ name: m[1], pos: m.index });
  const filtered = cands.filter((c) => ALL_KNOWN.has(c.name));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.pos - b.pos);
  return filtered[0].name;
}

// --- driver ---

type Variant = 'V_full' | 'V_hint' | 'V_teach';

function toolsFor(variant: Variant): readonly KodaXToolDefinition[] {
  const deferred = DEFERRED_UNDER_TEST.map((n) => (variant === 'V_full' ? fullTool(n) : hintTool(n)));
  return [...deferred, TOOL_SEARCH_TOOL, ...FALLBACK_TOOLS];
}
function systemFor(variant: Variant): string {
  return variant === 'V_teach' ? SYSTEM_TEACH : SYSTEM_BASE;
}

const PILOT = process.env.KODAX_EVAL_PILOT === '1';
const PANEL_ALIASES = (
  PILOT ? ['ark/v4flash'] : ['zhipu/glm51', 'ark/k27', 'mmx/m27', 'ark/v4pro', 'ark/v4flash']
) as const;
const RUNS_PER_CELL = PILOT ? 1 : 3;
const STAGE_LABEL = PILOT ? 'pilot-ark-1run' : 'panel-5alias-3runs';
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'deferred-hard-case-teaching');

interface Run {
  runIndex: number;
  firstTool: string | null;
  firstFromBinding: string | null;
  firstFromText: string | null;
  adopted: boolean;
  grepped: boolean;
  otherDeferred: boolean;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  durationMs: number;
  error?: string;
}
interface Cell {
  caseId: string;
  alias: string;
  variant: Variant;
  runs: Run[];
  adoptedRate: number;
}

describe('Eval: Deferred-tool hard-case adoption + teaching effect (FEATURE_250)', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      /* no-op */
    });
    return;
  }

  const overall: Cell[] = [];

  for (const c of CASES) {
    it(`${c.id} — ${STAGE_LABEL}`, { timeout: 45 * 60_000 }, async () => {
      const cellRows: Cell[] = [];
      for (const alias of aliases) {
        for (const variant of ['V_full', 'V_hint', 'V_teach'] as const) {
          const tools = toolsFor(variant);
          const systemPrompt = systemFor(variant);
          const runs: Run[] = [];
          let adoptedHits = 0;
          for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
            try {
              const out = await runOneShot(alias, { systemPrompt, userMessage: c.userMessage, tools });
              const firstFromBinding = out.toolCalls[0]?.name ?? null;
              const firstFromText = extractFirstToolNameFromText(out.text);
              const firstTool = firstFromBinding ?? firstFromText;
              const adopted = firstTool !== null && ADOPTED_SET.has(firstTool);
              const grepped = firstTool !== null && GREP_SET.has(firstTool);
              const otherDeferred = firstTool !== null && OTHER_DEFERRED_SET.has(firstTool);
              if (adopted) adoptedHits++;
              runs.push({
                runIndex, firstTool, firstFromBinding, firstFromText,
                adopted, grepped, otherDeferred,
                text: out.text, toolCalls: out.toolCalls, durationMs: out.durationMs,
              });
            } catch (err) {
              runs.push({
                runIndex, firstTool: null, firstFromBinding: null, firstFromText: null,
                adopted: false, grepped: false, otherDeferred: false,
                text: '', toolCalls: [], durationMs: 0,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const cell: Cell = { caseId: c.id, alias, variant, runs, adoptedRate: adoptedHits / RUNS_PER_CELL };
          cellRows.push(cell);
          overall.push(cell);
        }
      }

      const lines: string[] = [`[hard-case-teaching][${c.id}]`];
      for (const alias of aliases) {
        const f = cellRows.find((r) => r.alias === alias && r.variant === 'V_full');
        const h = cellRows.find((r) => r.alias === alias && r.variant === 'V_hint');
        const t = cellRows.find((r) => r.alias === alias && r.variant === 'V_teach');
        if (!f || !h || !t) continue;
        lines.push(
          `  ${alias.padEnd(13)} full=${Math.round(f.adoptedRate * 100)}% hint=${Math.round(h.adoptedRate * 100)}% teach=${Math.round(t.adoptedRate * 100)}%`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            case: c.id, stage: STAGE_LABEL, description: c.description, userMessage: c.userMessage,
            systemBase: SYSTEM_BASE, teachingBlock: CODE_SEARCH_TEACHING,
            cells: cellRows.map((r) => ({ alias: r.alias, variant: r.variant, adoptedRate: r.adoptedRate, runs: r.runs })),
          },
          null,
          2,
        ),
        'utf8',
      );
      // eslint-disable-next-line no-console
      console.log(`  raw-output dump: ${dumpPath}`);
    });
  }

  it('suite verdict against pre-registered matrix', () => {
    type AliasAgg = {
      alias: string;
      full: number; hint: number; teach: number;
      gapPp: number; liftPp: number;
    };
    const rate = (alias: string, variant: Variant): number => {
      let hits = 0, total = 0;
      for (const cell of overall) {
        if (cell.alias !== alias || cell.variant !== variant) continue;
        for (const r of cell.runs) {
          if (r.error) continue;
          total++;
          if (r.adopted) hits++;
        }
      }
      return total > 0 ? hits / total : 0;
    };
    const perAlias: AliasAgg[] = aliases.map((alias) => {
      const full = rate(alias, 'V_full');
      const hint = rate(alias, 'V_hint');
      const teach = rate(alias, 'V_teach');
      return {
        alias, full, hint, teach,
        gapPp: Math.round((full - hint) * 100),
        liftPp: Math.round((teach - hint) * 100),
      };
    });

    const hintSufficientAliases = perAlias.filter((a) => a.hint >= a.full - 0.15).length;
    const underAdoptAliases = perAlias.filter((a) => a.full - a.hint >= 0.15);
    const teachingRecovers = underAdoptAliases.filter((a) => a.teach >= a.full - 0.15).length;

    let verdict: string;
    if (hintSufficientAliases >= perAlias.length - 1) verdict = 'HINT_SUFFICIENT';
    else if (underAdoptAliases.length >= 2 && teachingRecovers >= 2) verdict = 'TEACHING_HELPS';
    else verdict = 'MIXED';

    mkdirSync(DUMP_ROOT, { recursive: true });
    const summaryPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          stage: STAGE_LABEL, aliases_run: aliases, perAlias,
          hintSufficientAliases, underAdoptAliasCount: underAdoptAliases.length, teachingRecovers,
          verdict,
          decisionMatrix: {
            HINT_SUFFICIENT: 'V_hint >= V_full - 15pp on >=n-1 aliases → no teaching needed',
            TEACHING_HELPS: 'V_hint under-adopts (gap>=15pp) on >=2 aliases AND V_teach recovers to >=V_full-15pp on >=2',
            MIXED: 'neither',
          },
          note: PILOT ? 'PILOT — trigger confirmation only, not a ship verdict.' : 'Full panel — decision verdict.',
        },
        null,
        2,
      ),
      'utf8',
    );

    // eslint-disable-next-line no-console
    console.log('\n=== HARD-CASE TEACHING VERDICT ===');
    // eslint-disable-next-line no-console
    console.log(`  ${verdict}`);
    for (const a of perAlias) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${a.alias.padEnd(13)} full=${Math.round(a.full * 100)}% hint=${Math.round(a.hint * 100)}% teach=${Math.round(a.teach * 100)}%  | gap(F-H)=${a.gapPp >= 0 ? '+' : ''}${a.gapPp}pp lift(T-H)=${a.liftPp >= 0 ? '+' : ''}${a.liftPp}pp`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  suite summary: ${summaryPath}`);
  });
});
