/**
 * Eval: Deferred-tool two-hop reachability — FEATURE_250 managed-path
 * progressive-disclosure gate.
 *
 * ## The question this answers
 *
 * FEATURE_250 proposes deferring tool DESCRIPTIONS on the managed (AMA/AMAW)
 * path: a deferred tool appears in the wire `tools[]` with a one-line
 * `searchHint` instead of its full description (schema/`input_schema`
 * UNCHANGED, so the tool stays directly callable). The full teaching is
 * fetched on demand via `tool_search`.
 *
 * The user's concern (and the adversarial panel's confirmed risk):
 *   > does routing tool teaching through `tool_search` hurt tool-call
 *   > reachability on weaker coding-plan models — will some models fail to
 *   > reach a tool they need when it is shown hint-only?
 *
 * NO existing eval measures this. `repointel-tool-adoption.eval.ts` and
 * `tool-schema-slim*.eval.ts` are BOTH zero-hop (full description always
 * resident). This file is the missing two-hop harness.
 *
 * ## Design — Layer 2 single-turn probe (per EVAL_GUIDELINES §Layer 2)
 *
 * Why not Layer 1: reachability is a model-behavior question — whether a
 * floor model, seeing only a hint, still heads toward the deferred
 * capability (directly OR via `tool_search`) rather than falling back to
 * read/grep. Code-reading cannot answer it.
 *
 * Two POPULATIONS (the two-part FEATURE_250 split):
 *   - REPO_INTEL — the 6 repo-intelligence deferred tools. Their WHEN-to-call
 *     teaching ALSO lives, unconditionally, in the Worker role prompt
 *     (worker-role-prompt.ts REPO INTELLIGENCE TOOLS section). So the system
 *     prompt in this population INCLUDES that teaching. Deferring their
 *     description should be quality-safe BY CONSTRUCTION (the WHEN signal
 *     never came from the description). This population VERIFIES that claim.
 *   - UNTAUGHT — deferred tools with NO resident prompt teaching (web_fetch,
 *     code_search, get_goal as representatives). Their teaching lives ONLY in
 *     the description. Hint-swapping it away is the panel's flagged risk. The
 *     system prompt here does NOT teach them (matches production).
 *
 * Two VARIANTS per case (byte-aligned per anti-pattern 8 §2 — only the
 * deferred tools' `description` field differs; `input_schema` identical):
 *   - `V_full` — deferred tools carry their PRODUCTION full description.
 *     (Current managed-path behavior.)
 *   - `V_hint` — deferred tools carry their PRODUCTION `DEFERRED_TOOL_HINTS`
 *     one-liner. (What FEATURE_250 deferral produces.)
 * Both variants also carry `tool_search` + read/grep/glob/bash (the fallback
 * path the model knows from pretraining). Production tool bytes are IMPORTED
 * (`getToolDefinition`, `DEFERRED_TOOL_HINTS`, `TOOL_SEARCH_DEFINITION`), never
 * hand-stubbed (anti-pattern 8).
 *
 * ## Metric (mechanical, first tool call — reused multi-syntax extractor)
 *
 *   reached  = firstTool ∈ (population deferred names ∪ {tool_search})
 *              → the model headed toward the deferred capability class
 *   viaSearch    = firstTool === 'tool_search'   (initiated the two-hop)
 *   directDefer  = firstTool ∈ population deferred names (called off hint/desc)
 *   fellBack     = firstTool ∈ {read, grep, glob, bash}
 *
 * `reached` is the reachability answer. The viaSearch/directDefer split shows
 * whether models actually two-hop or shortcut-call off the hint (KodaX keeps
 * the tool callable, so a correct direct call still counts as reached).
 *
 * ## Pre-registered decision matrix (LOCKED before any LLM call)
 *
 * Per POPULATION, per ALIAS (NOT aggregated — aggregate masks single-alias
 * floor per anti-pattern 11 / feedback_pre_registered_gate_saturation):
 *
 *   DEFER_SAFE   : V_hint `reached` ≥ V_full `reached` − 15pp on ≥4/5 aliases
 *                  → hint-only does NOT break reachability for that population.
 *   DEFER_RISKY  : V_hint `reached` drops >15pp vs V_full on ≥2 aliases
 *                  → that population needs its teaching relocated (or kept
 *                    resident) before deferral.
 *   MIXED        : neither → iterate hint wording / re-scope per-tool.
 *
 * Expected (hypothesis, not assumed): REPO_INTEL → DEFER_SAFE (prompt carries
 * teaching); UNTAUGHT → DEFER_RISKY or MIXED (only the name+hint carry it).
 * A saturated V_full (model already fails to reach even WITH full desc) means
 * the case is a bad probe, not a deferral signal — flagged in the dump.
 *
 * ## Budget
 *
 * Pilot (KODAX_EVAL_PILOT=1): ark/v4flash × 6 cases × 2 variants × 1 run =
 * 12 calls (~$0.3) — confirms the probe triggers before scaling.
 * Full: 5 canonical × 6 × 2 × 3 = 180 calls (~$4). Worth one ship/gate
 * decision per EVAL_GUIDELINES "$5 换一条 production prompt/ship 决定".
 *
 * ## Scope note (anti-pattern "no silent caps")
 *
 * mcp_* tools are NOT probed here: without a live MCP runtime a task cannot
 * naturally require them, and the panel recommends keeping mcp_call resident
 * regardless (mutation risk). Their deferral is gated separately. This eval
 * characterizes repo-intel + web/code/goal reachability only.
 *
 * ## Run
 *
 *   KODAX_EVAL_PILOT=1 npm run test:eval -- deferred-tool-two-hop-adoption   # pilot
 *   npm run test:eval -- deferred-tool-two-hop-adoption                       # full panel
 *
 * Raw dumps: os.tmpdir()/kodax-eval-dumps/deferred-tool-two-hop/<case>.json
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

// ---------------------------------------------------------------------------
// Production tool bytes — imported, never stubbed (EVAL_GUIDELINES anti-pattern 8).
// ---------------------------------------------------------------------------

function realTool(name: string): KodaXToolDefinition {
  const def = getToolDefinition(name);
  if (!def) throw new Error(`[deferred-two-hop] tool not registered: ${name}`);
  return def;
}

/** V_full: production full description (current managed-path behavior). */
function fullTool(name: string): KodaXToolDefinition {
  return realTool(name);
}

/** V_hint: production searchHint in place of the description; schema unchanged. */
function hintTool(name: string): KodaXToolDefinition {
  const def = realTool(name);
  const hint = DEFERRED_TOOL_HINTS[name];
  if (!hint) throw new Error(`[deferred-two-hop] no DEFERRED_TOOL_HINTS entry for: ${name}`);
  return { ...def, description: hint };
}

const TOOL_SEARCH_TOOL: KodaXToolDefinition = {
  name: TOOL_SEARCH_DEFINITION.name,
  description: TOOL_SEARCH_DEFINITION.description,
  input_schema: TOOL_SEARCH_DEFINITION.input_schema,
};

// Fallback path the model knows from pretraining. Real production bytes.
const BASE_TOOL_NAMES = ['read', 'grep', 'glob', 'bash'] as const;
const BASE_TOOLS: readonly KodaXToolDefinition[] = BASE_TOOL_NAMES.map(fullTool);

// ---------------------------------------------------------------------------
// Populations — the two halves of the FEATURE_250 split.
// ---------------------------------------------------------------------------

// Prompt-taught: teaching ALSO lives in the Worker role prompt, so deferral
// is expected quality-safe. All are in DEFERRED_TOOL_HINTS.
const REPO_INTEL_DEFERRED = [
  'repo_overview',
  'changed_scope',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
] as const;

// Un-taught: teaching lives ONLY in the description. web_fetch (intuitive
// name), code_search (confusable with grep), get_goal (opt-in). semantic_lookup
// + web_search included as sibling distractors so the model must discriminate.
const UNTAUGHT_DEFERRED = [
  'web_search',
  'web_fetch',
  'code_search',
  'semantic_lookup',
  'get_goal',
] as const;

// ---------------------------------------------------------------------------
// System prompts. REPO_INTEL variant carries the production Worker
// "REPO INTELLIGENCE TOOLS" teaching (copied faithfully from
// packages/coding/src/agents/worker-role-prompt.ts:232-269). UNTAUGHT does
// NOT teach its tools (matches production — those tools are never named in
// resident prose).
// ---------------------------------------------------------------------------

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
  '`C:/Works/GitWorks/KodaX-author/KodaX`. Active modules include',
  '`packages/coding/src/*`, `packages/repl/src/*`, `packages/agent/src/*`.',
].join('\n');

const REPO_INTEL_TEACHING = [
  '',
  'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
  '- `relationship_scan(symbol|module|path|entry)` - single entrypoint for upstream/downstream, callers/callees, dependencies, process links, and impact. Use first for "what calls this", "what depends on this", blast-radius questions.',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what depends on what".',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports for one symbol. Replaces multiple `grep -n "symbolName"` + `read` rounds when tracing usage.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate combining symbol/module info with current changed-scope overlap. Use BEFORE planning a rename/refactor instead of guessing from grep.',
  '- `process_context(entry|module)` — static execution trace from an entry point. Use to understand "how does this flow execute" instead of chasing N file reads.',
  '- `repo_overview()` — workspace-wide structure snapshot. Use ONCE when onboarding to a new area.',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '',
  'WHEN TO PREFER REPO-INTEL TOOLS:',
  '- About to read 3+ files in the same module → call `module_context` first.',
  "- About to grep for a symbol's callers → call `symbol_context` first.",
  '- About to estimate impact of a change → call `impact_estimate` first.',
  '- About to review a multi-file change → call `changed_scope` first.',
].join('\n');

const SYSTEM_REPO_INTEL = WORKER_BASE + '\n' + REPO_INTEL_TEACHING;
const SYSTEM_UNTAUGHT = WORKER_BASE;

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

type Population = 'repo_intel' | 'untaught';

interface CaseSpec {
  readonly id: string;
  readonly population: Population;
  readonly description: string;
  readonly userMessage: string;
  /** Deferred tools that would be a "good" first pick for this task. */
  readonly preferredTools: readonly string[];
}

const CASES: readonly CaseSpec[] = [
  // --- REPO_INTEL (system prompt teaches these) ---
  {
    id: 'ri_module_understanding',
    population: 'repo_intel',
    description: 'Understand an unfamiliar module — classic module_context case.',
    userMessage:
      'Help me understand the `packages/coding/src/context` module — what does it do, what files are entry points, and what does it depend on? I have not touched this area before.',
    preferredTools: ['module_context', 'repo_overview'],
  },
  {
    id: 'ri_symbol_usage_trace',
    population: 'repo_intel',
    description: 'Find callers of a function — classic symbol_context case.',
    userMessage:
      'Find all callers of the function `buildWorkerInstructions` in `packages/coding/src/agents/worker-role-prompt.ts`. I want to know which roles invoke it.',
    preferredTools: ['symbol_context', 'impact_estimate'],
  },
  {
    id: 'ri_review_changes',
    population: 'repo_intel',
    description: 'Review uncommitted changes — classic changed_scope case.',
    userMessage:
      'Review the uncommitted changes in the current working directory. Tell me what files changed, what areas they touch, and whether the diff looks risky.',
    preferredTools: ['changed_scope'],
  },
  // --- UNTAUGHT (system prompt does NOT teach these) ---
  {
    id: 'ut_fetch_url',
    population: 'untaught',
    description: 'Fetch + summarize a specific URL — web_fetch (intuitive name).',
    userMessage:
      'Read the page at https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md and summarize how to install and initialize the client.',
    preferredTools: ['web_fetch'],
  },
  {
    id: 'ut_ranked_code_search',
    population: 'untaught',
    description: 'Ranked/noise-filtered repo search — code_search (confusable with grep).',
    userMessage:
      'Across this whole repository, find the most relevant places where token-budget accounting is implemented — I want a ranked shortlist of the strongest matches, not every raw hit.',
    preferredTools: ['code_search', 'semantic_lookup'],
  },
  {
    id: 'ut_goal_status',
    population: 'untaught',
    description: 'Check persistent /goal budget — get_goal (opt-in family).',
    userMessage:
      'What is the status of my current goal — how much of the token budget has been used, and how much time has elapsed?',
    preferredTools: ['get_goal'],
  },
];

function deferredNamesFor(pop: Population): readonly string[] {
  return pop === 'repo_intel' ? REPO_INTEL_DEFERRED : UNTAUGHT_DEFERRED;
}

function systemPromptFor(pop: Population): string {
  return pop === 'repo_intel' ? SYSTEM_REPO_INTEL : SYSTEM_UNTAUGHT;
}

function toolsFor(pop: Population, variant: 'V_full' | 'V_hint'): readonly KodaXToolDefinition[] {
  const deferred = deferredNamesFor(pop).map((name) =>
    variant === 'V_full' ? fullTool(name) : hintTool(name),
  );
  return [...deferred, TOOL_SEARCH_TOOL, ...BASE_TOOLS];
}

// ---------------------------------------------------------------------------
// Multi-syntax first-tool extraction (anti-pattern 7 §4). Prefer the provider
// binding; fall back to text regex covering tool_name(, "name":"tool_name",
// <tool_name>, name=tool_name / name: tool_name.
// ---------------------------------------------------------------------------

const ALL_KNOWN_TOOL_NAMES = new Set<string>([
  ...REPO_INTEL_DEFERRED,
  ...UNTAUGHT_DEFERRED,
  'tool_search',
  ...BASE_TOOL_NAMES,
  'relationship_scan',
]);

function extractFirstToolNameFromText(text: string): string | null {
  if (!text) return null;
  const candidates: Array<{ name: string; pos: number }> = [];
  const re1 = /(?:^|[\s[`"({,>])([a-z_][a-z_0-9]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re2 = /"name"\s*:\s*"([a-z_][a-z_0-9]*)"/g;
  while ((m = re2.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re3 = /<([a-z_][a-z_0-9]*)[\s>]/g;
  while ((m = re3.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re4 = /\bname\s*[=:]\s*["']?([a-z_][a-z_0-9]*)["']?/g;
  while ((m = re4.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const filtered = candidates.filter((c) => ALL_KNOWN_TOOL_NAMES.has(c.name));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.pos - b.pos);
  return filtered[0].name;
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

const PILOT = process.env.KODAX_EVAL_PILOT === '1';
// kimi covered via ark-coding (`ark/k27` = kimi-k2.7-code) since the direct
// kimi-code key is absent in this environment — same Moonshot family, on a
// coding-plan gateway with a present key.
const PANEL_ALIASES = (
  PILOT
    ? ['ark/v4flash']
    : ['zhipu/glm51', 'ark/k27', 'mmx/m27', 'ark/v4pro', 'ark/v4flash']
) as const;
const RUNS_PER_CELL = PILOT ? 1 : 3;
const STAGE_LABEL = PILOT ? 'pilot-ark-1run' : 'panel-5alias-3runs';
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'deferred-tool-two-hop');

type Variant = 'V_full' | 'V_hint';

interface Run {
  runIndex: number;
  firstTool: string | null;
  firstFromBinding: string | null;
  firstFromText: string | null;
  reached: boolean;
  viaSearch: boolean;
  directDefer: boolean;
  fellBack: boolean;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  durationMs: number;
  error?: string;
}

interface Cell {
  caseId: string;
  population: Population;
  alias: string;
  variant: Variant;
  runs: Run[];
  reachedRate: number;
}

describe('Eval: Deferred-tool two-hop reachability (FEATURE_250 gate)', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      /* no-op makes skip visible */
    });
    return;
  }

  const overall: Cell[] = [];

  for (const c of CASES) {
    it(
      `${c.id} [${c.population}] — ${STAGE_LABEL}`,
      { timeout: 45 * 60_000 },
      async () => {
        const deferredSet = new Set(deferredNamesFor(c.population));
        const baseSet = new Set<string>(BASE_TOOL_NAMES);
        const systemPrompt = systemPromptFor(c.population);
        const cellRows: Cell[] = [];

        for (const alias of aliases) {
          for (const variant of ['V_full', 'V_hint'] as const) {
            const tools = toolsFor(c.population, variant);
            const runs: Run[] = [];
            let reachedHits = 0;

            for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
              try {
                const out = await runOneShot(alias, {
                  systemPrompt,
                  userMessage: c.userMessage,
                  tools,
                });
                const firstFromBinding = out.toolCalls[0]?.name ?? null;
                const firstFromText = extractFirstToolNameFromText(out.text);
                const firstTool = firstFromBinding ?? firstFromText;
                const viaSearch = firstTool === 'tool_search';
                const directDefer = firstTool !== null && deferredSet.has(firstTool);
                const fellBack = firstTool !== null && baseSet.has(firstTool);
                const reached = viaSearch || directDefer;
                if (reached) reachedHits++;
                runs.push({
                  runIndex,
                  firstTool,
                  firstFromBinding,
                  firstFromText,
                  reached,
                  viaSearch,
                  directDefer,
                  fellBack,
                  text: out.text,
                  toolCalls: out.toolCalls,
                  durationMs: out.durationMs,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                runs.push({
                  runIndex,
                  firstTool: null,
                  firstFromBinding: null,
                  firstFromText: null,
                  reached: false,
                  viaSearch: false,
                  directDefer: false,
                  fellBack: false,
                  text: '',
                  toolCalls: [],
                  durationMs: 0,
                  error: msg,
                });
              }
            }

            const cell: Cell = {
              caseId: c.id,
              population: c.population,
              alias,
              variant,
              runs,
              reachedRate: reachedHits / RUNS_PER_CELL,
            };
            cellRows.push(cell);
            overall.push(cell);
          }
        }

        // Per-case console summary.
        const lines: string[] = [`[deferred-two-hop][${c.id}] (${c.population}) preferred=${c.preferredTools.join(',')}`];
        for (const alias of aliases) {
          const full = cellRows.find((r) => r.alias === alias && r.variant === 'V_full');
          const hint = cellRows.find((r) => r.alias === alias && r.variant === 'V_hint');
          if (!full || !hint) continue;
          const drop = Math.round((full.reachedRate - hint.reachedRate) * 100);
          lines.push(
            `  ${alias.padEnd(13)} V_full=${Math.round(full.reachedRate * 100)}% V_hint=${Math.round(hint.reachedRate * 100)}%  drop=${drop >= 0 ? '+' : ''}${drop}pp`,
          );
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Per-case raw dump (re-mkdir every write — Windows tmp cleaner).
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          dumpPath,
          JSON.stringify(
            {
              case: c.id,
              population: c.population,
              stage: STAGE_LABEL,
              description: c.description,
              preferredTools: c.preferredTools,
              userMessage: c.userMessage,
              systemPrompt,
              cells: cellRows.map((r) => ({
                alias: r.alias,
                variant: r.variant,
                reachedRate: r.reachedRate,
                runs: r.runs,
              })),
            },
            null,
            2,
          ),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }

  it('suite verdict against pre-registered matrix', () => {
    type PopAliasAgg = {
      population: Population;
      alias: string;
      full: { hits: number; total: number; rate: number };
      hint: { hits: number; total: number; rate: number };
      dropPp: number;
      viaSearchHintRate: number;
      directDeferHintRate: number;
    };

    const populations: Population[] = ['repo_intel', 'untaught'];
    const perPopAlias: PopAliasAgg[] = [];

    for (const pop of populations) {
      for (const alias of aliases) {
        const agg = (variant: Variant) => {
          let hits = 0;
          let total = 0;
          let viaSearch = 0;
          let directDefer = 0;
          for (const cell of overall) {
            if (cell.population !== pop || cell.alias !== alias || cell.variant !== variant) continue;
            for (const r of cell.runs) {
              if (r.error) continue;
              total++;
              if (r.reached) hits++;
              if (r.viaSearch) viaSearch++;
              if (r.directDefer) directDefer++;
            }
          }
          return { hits, total, rate: total > 0 ? hits / total : 0, viaSearch, directDefer };
        };
        const full = agg('V_full');
        const hint = agg('V_hint');
        perPopAlias.push({
          population: pop,
          alias,
          full: { hits: full.hits, total: full.total, rate: full.rate },
          hint: { hits: hint.hits, total: hint.total, rate: hint.rate },
          dropPp: Math.round((full.rate - hint.rate) * 100),
          viaSearchHintRate: hint.total > 0 ? hint.viaSearch / hint.total : 0,
          directDeferHintRate: hint.total > 0 ? hint.directDefer / hint.total : 0,
        });
      }
    }

    // Pre-registered per-population verdict. Pre-registered threshold was
    // "safe on >=4/5 aliases" = "all but at most one". kimi's key is absent in
    // this environment, so the panel is 4 not 5; the faithful generalization
    // of "all but at most one" is `safe >= aliasesRun - 1` (NOT a
    // results-driven change — it tracks panel size, not outcomes).
    const verdictFor = (pop: Population): { verdict: string; safeAliases: number; riskyAliases: number; total: number } => {
      const rows = perPopAlias.filter((r) => r.population === pop);
      const safeAliases = rows.filter((r) => r.hint.rate >= r.full.rate - 0.15).length;
      const riskyAliases = rows.filter((r) => r.full.rate - r.hint.rate > 0.15).length;
      let verdict: string;
      if (safeAliases >= rows.length - 1) verdict = 'DEFER_SAFE';
      else if (riskyAliases >= 2) verdict = 'DEFER_RISKY';
      else verdict = 'MIXED';
      return { verdict, safeAliases, riskyAliases, total: rows.length };
    };

    const repoIntel = verdictFor('repo_intel');
    const untaught = verdictFor('untaught');

    mkdirSync(DUMP_ROOT, { recursive: true });
    const summaryPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          stage: STAGE_LABEL,
          aliases_run: aliases,
          perPopAlias,
          verdicts: { repo_intel: repoIntel, untaught },
          decisionMatrix: {
            DEFER_SAFE: 'V_hint reached >= V_full reached - 15pp on >=4/5 aliases',
            DEFER_RISKY: 'V_hint reached drops >15pp vs V_full on >=2 aliases',
            MIXED: 'neither',
          },
          note: PILOT
            ? 'PILOT run (1 alias × 1 run) — trigger confirmation only, NOT a ship verdict.'
            : 'Full panel — ship/gate verdict.',
        },
        null,
        2,
      ),
      'utf8',
    );

    // eslint-disable-next-line no-console
    console.log('\n=== DEFERRED TWO-HOP SUITE VERDICT ===');
    for (const pop of populations) {
      const v = pop === 'repo_intel' ? repoIntel : untaught;
      // eslint-disable-next-line no-console
      console.log(`  [${pop}] ${v.verdict}  (safe ${v.safeAliases}/${v.total}, risky ${v.riskyAliases}/${v.total})`);
      for (const r of perPopAlias.filter((x) => x.population === pop)) {
        // eslint-disable-next-line no-console
        console.log(
          `    ${r.alias.padEnd(13)} full=${Math.round(r.full.rate * 100)}% hint=${Math.round(r.hint.rate * 100)}% drop=${r.dropPp >= 0 ? '+' : ''}${r.dropPp}pp  | hint: viaSearch=${Math.round(r.viaSearchHintRate * 100)}% direct=${Math.round(r.directDeferHintRate * 100)}%`,
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  suite summary: ${summaryPath}`);
    if (PILOT) {
      // eslint-disable-next-line no-console
      console.log('  (PILOT — trigger confirmation only; not a ship verdict)');
    }
  });
});
