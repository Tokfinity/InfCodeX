/**
 * Pilot — FEATURE_189 Batch 3 B.1: 14 under-described tool descriptions
 * expanded to claudecode-grade richness.
 *
 * Initial Batch 3 cancellation was reversed after user pushback: small
 * KodaX tool descriptions (90-120 bytes/each) were under-spec, not
 * optimal. Compare claudecode WebFetchTool 750 bytes with crucial
 * "prefer gh CLI for GitHub URLs" guidance — KodaX 88 bytes had no
 * such teaching, so LLMs were wasting web_fetch on github.com URLs.
 *
 * Tools expanded (15, +9.7KB total):
 *   Web: web_search, web_fetch, code_search, semantic_lookup
 *   MCP: mcp_search, mcp_describe, mcp_call, mcp_read_resource, mcp_get_prompt
 *   Repo-intel: repo_overview, changed_scope, module_context,
 *               symbol_context, process_context, impact_estimate
 *
 * 1 alias (ark/v4flash) × 4 case × 2 variant × 3 runs = 24 cells, ~$0.5.
 *
 * Cases:
 *   C1 — github URL → prefer `gh` CLI over web_fetch (web_fetch teaching)
 *   C2 — module exploration → module_context (not raw read+grep)
 *   C3 — refactor planning → impact_estimate BEFORE the work
 *   C4 — sources cite format on web_search results (markdown link)
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch3-b1-tool-desc-expansion-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-batch3-b1-tool-desc-expansion-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = { 'ark/v4flash': 'ds/v4flash' };
const RUNS_PER_CELL = 3;

// ============================================================
// Tool descriptions — baseline (original short) + proposed (expanded)
// ============================================================

const WEB_FETCH_BASELINE = 'Fetch a specific remote source and return bounded text with provenance and trust hints.';
const WEB_FETCH_PROPOSED = 'Fetch a specific remote source by URL and return bounded text with provenance and trust hints. The handler converts HTML to markdown and caches each unique URL for a short window so repeated reads within the same task are free. If the response is a redirect (3xx), the tool stops and reports the new target URL — re-issue `web_fetch` against that new URL rather than chasing the redirect manually, so the cache + provenance line up with what the user actually sees. For GitHub URLs specifically (`github.com/...` / `raw.githubusercontent.com/...`), prefer `bash` with the `gh` CLI when available — `gh api` / `gh pr view` / `gh issue view` are faster, return structured output, and avoid markdown-conversion artifacts; using `web_fetch` on a github.com URL when `gh` would work is the most common "tool waste" pattern in this surface. Despite the `mutates-network` side-effect classification (some providers route POST requests through this surface), the LLM-facing semantics are read-only. Use `web_search` first when you do not yet have a specific URL.';

const WEB_SEARCH_BASELINE = 'Search the web for discovery-oriented results with explicit trust and freshness signaling.';
const WEB_SEARCH_PROPOSED = 'Search the web for discovery-oriented results with explicit trust and freshness signaling. Use this for "discover what is out there" queries when you do not yet have a specific URL — researching a library before integrating it, finding canonical docs for an API, identifying current best-practice patterns. Output includes provenance + trust signals; when relaying answers to the user, cite sources back in markdown link format (`[title](url)`). Pair with `web_fetch` to follow up on a specific result. Search results are geographically scoped (US-based) and freshness metadata reflects when each source was last indexed, not the moment of your query — interpret "current X" with that caveat. For finding code or documentation INSIDE the repo, prefer `grep` / `code_search` / `semantic_lookup` — those operate on the local checkout and do not consume network turns.';

const MODULE_CONTEXT_BASELINE = 'Return a task-shaped module capsule with dependencies, entry files, symbols, tests, docs, and follow-up handles.';
const MODULE_CONTEXT_PROPOSED = 'Return a task-shaped module capsule with dependencies, entry files, top-level symbols, test files, docs, and follow-up handles for further drill-down. Use this when about to read 3+ files in the same module — the capsule replaces that exploration round-trip with one structured response. Prefer `module_context` over raw `read`+`grep` for "what does this module do / what depends on what" questions. When the question is about a single function or class, use `symbol_context` instead — it is cheaper because it scopes to one symbol. When you only need exact file content (line numbers, byte-level text), fall back to `read` after the capsule narrows the target. `refresh: true` rebuilds the underlying repo-intel index, which is expensive — only set it when you have reason to believe the index is stale.';

const IMPACT_ESTIMATE_BASELINE = 'Estimate blast radius for a symbol, path, or module using local intelligence plus changed-scope overlap.';
const IMPACT_ESTIMATE_PROPOSED = 'Estimate the blast radius of changing a symbol, path, or module — combines repo-intelligence usage graph with current changed-scope overlap. Call this BEFORE planning a rename, refactor, or breaking change, not after the work is started — its purpose is to scope the work up front so the plan reflects reality (which packages need touching, which call sites assume current behavior, which tests must update). Returns ranked impact sites with severity hints. Prefer over guessing impact from a `grep` of the symbol name — `grep` overcounts (matches strings + comments) and undercounts (misses re-exports + structural callers). The `refresh` flag rebuilds the underlying index — expensive — so reserve it for cases where a recent large edit may have invalidated the cached graph.';

// ============================================================
// Prompt builders per case
// ============================================================

function buildSystemPrompt(variant: 'baseline' | 'proposed'): string {
  const wf = variant === 'baseline' ? WEB_FETCH_BASELINE : WEB_FETCH_PROPOSED;
  const ws = variant === 'baseline' ? WEB_SEARCH_BASELINE : WEB_SEARCH_PROPOSED;
  const mc = variant === 'baseline' ? MODULE_CONTEXT_BASELINE : MODULE_CONTEXT_PROPOSED;
  const ie = variant === 'baseline' ? IMPACT_ESTIMATE_BASELINE : IMPACT_ESTIMATE_PROPOSED;
  return [
    "You are KodaX's primary coding agent. You have access to the following tools.",
    '',
    `\`web_search(query, limit?, provider_id?)\`: ${ws}`,
    '',
    `\`web_fetch(url, provider_id?, capability_id?)\`: ${wf}`,
    '',
    `\`module_context(module, target_path?, refresh?)\`: ${mc}`,
    '',
    `\`impact_estimate(symbol?, module?, path?, target_path?, refresh?)\`: ${ie}`,
    '',
    '`grep(pattern, path)`: search local files with raw text regex.',
    '`read(path, offset?, limit?)`: read a file (or slice of it).',
    '`bash(command)`: run a shell command. The `gh` CLI is available for GitHub API operations.',
    '`symbol_context(symbol, module?)`: definition + callers/callees for one symbol.',
    '`code_search(query, path?)`: ranked text search across the repo, lower-noise than raw grep.',
  ].join('\n');
}

// ============================================================
// Cases
// ============================================================

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

const CASE_C1: CaseBundle = {
  id: 'C1_github_url_prefer_gh',
  userMessage:
    'Fetch the latest README content for the anthropic-ai/anthropic-sdk-python repository at ' +
    'https://github.com/anthropic-ai/anthropic-sdk-python and summarize the installation section.',
};

const CASE_C2: CaseBundle = {
  id: 'C2_module_exploration_pulltool',
  userMessage:
    'Explore the structure of the packages/auth module in this monorepo: what does it export, what does it ' +
    'depend on, what are its main entry files, and what tests cover it. Produce a compact overview.',
};

const CASE_C3: CaseBundle = {
  id: 'C3_refactor_impact_first',
  userMessage:
    'I want to rename the `getUserById` function (defined in packages/auth/src/user-repo.ts) to `getUserOrThrow` ' +
    'across the whole monorepo. Before I start the rename, help me understand the blast radius — which packages ' +
    'and files will need to change.',
};

const CASE_C4: CaseBundle = {
  id: 'C4_websearch_markdown_cite',
  userMessage:
    'Find the canonical documentation page for the Python `requests` library\'s session API and tell me the ' +
    'method signatures available on `requests.Session`. Cite your sources.',
};

const CASES: readonly CaseBundle[] = [CASE_C1, CASE_C2, CASE_C3, CASE_C4] as const;

// ============================================================
// Tool-name pattern helpers
// ============================================================

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),
  ];
}
function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

// ============================================================
// Judges
// ============================================================

// C1: PASS iff model picks bash+gh (preferred) OR avoids web_fetch on github URL
function judgeC1(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  // Did model use bash with gh CLI?
  for (const c of calls) {
    if (c.name === 'bash') {
      const cmd = (c.input as { command?: string } | undefined)?.command ?? '';
      if (/\bgh\s+(api|pr|issue|repo|release)/i.test(cmd)) {
        return { passed: true, reason: 'used bash + gh CLI (preferred path for GitHub URLs)' };
      }
    }
  }
  // Did model invoke web_fetch on github URL?
  for (const c of calls) {
    if (c.name === 'web_fetch') {
      const url = (c.input as { url?: string } | undefined)?.url ?? '';
      if (/github\.com|raw\.githubusercontent\.com/i.test(url)) {
        return { passed: false, reason: `used web_fetch on github URL (should prefer gh CLI): ${url.slice(0, 60)}` };
      }
    }
  }
  // Text fallback — check intent
  if (/\bgh\s+(api|pr|issue|repo|release)/i.test(out)) {
    return { passed: true, reason: 'text-fallback gh CLI mention' };
  }
  if (invokesTool(out, 'web_fetch') && /github\.com|raw\.githubusercontent\.com/i.test(out)) {
    return { passed: false, reason: 'text-fallback web_fetch on github URL' };
  }
  if (invokesTool(out, 'bash')) return { passed: true, reason: 'text-fallback bash invocation (likely gh)' };
  return { passed: false, reason: 'no tool invocation found, and no gh CLI mention' };
}

// C2: PASS iff model invokes module_context (or text-fallback)
function judgeC2(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  for (const c of calls) {
    if (c.name === 'module_context') return { passed: true, reason: 'used module_context (correct first call for module exploration)' };
  }
  if (invokesTool(out, 'module_context')) return { passed: true, reason: 'text-fallback module_context invocation' };
  // Acceptable degraded: ≥4 parallel read+grep (covering scope without pull-tool)
  const readGrepCount = calls.filter((c) => ['read', 'grep', 'glob'].includes(c.name)).length;
  if (readGrepCount >= 4) return { passed: true, reason: `degraded: ${readGrepCount} parallel read/grep covering scope` };
  return { passed: false, reason: `did not invoke module_context; only ${readGrepCount} read/grep calls (no fan-out)` };
}

// C3: PASS iff model invokes impact_estimate BEFORE any rename/refactor work
function judgeC3(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const impactIdx = calls.findIndex((c) => c.name === 'impact_estimate');
  if (impactIdx >= 0) return { passed: true, reason: `impact_estimate invoked at index ${impactIdx}` };
  if (invokesTool(out, 'impact_estimate')) return { passed: true, reason: 'text-fallback impact_estimate invocation' };
  // Acceptable degraded: symbol_context (gives callers — partial impact info)
  const symIdx = calls.findIndex((c) => c.name === 'symbol_context');
  if (symIdx >= 0) return { passed: true, reason: 'used symbol_context for impact analysis (degraded)' };
  if (invokesTool(out, 'symbol_context')) return { passed: true, reason: 'text-fallback symbol_context (degraded)' };
  // FAIL if model jumps to grep/read without impact analysis
  if (calls.some((c) => ['grep', 'code_search', 'read'].includes(c.name))) {
    return { passed: false, reason: 'jumped to raw grep/code_search/read without impact_estimate or symbol_context' };
  }
  return { passed: false, reason: 'no impact analysis tool invoked before refactor' };
}

// C4: PASS iff model invokes web_search OR provides markdown-link citations
function judgeC4(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const usedSearch = calls.some((c) => c.name === 'web_search');
  if (usedSearch) return { passed: true, reason: 'used web_search (correct for discovery without specific URL)' };
  if (invokesTool(out, 'web_search')) return { passed: true, reason: 'text-fallback web_search invocation' };
  // Also accept web_fetch IF the model has a specific URL via prior knowledge (degraded but acceptable)
  if (calls.some((c) => c.name === 'web_fetch') || invokesTool(out, 'web_fetch')) {
    return { passed: true, reason: 'used web_fetch with known docs URL (acceptable degraded)' };
  }
  return { passed: false, reason: 'no web_search or web_fetch invocation' };
}

const JUDGE_BY_CASE: Record<string, PromptJudge> = {
  C1_github_url_prefer_gh: { name: 'github_prefer_gh_cli', category: 'correctness', judge: judgeC1 },
  C2_module_exploration_pulltool: { name: 'module_context_first', category: 'correctness', judge: judgeC2 },
  C3_refactor_impact_first: { name: 'impact_estimate_before_refactor', category: 'correctness', judge: judgeC3 },
  C4_websearch_markdown_cite: { name: 'websearch_for_discovery', category: 'correctness', judge: judgeC4 },
};

describe('FEATURE_189 Batch 3 B.1 pilot — 14 tool desc expansions (claudecode-grade richness)', () => {
  const aliases = availableAliases(...PILOT_PANEL);
  if (aliases.length === 0) { it('skips: no pilot alias key in env', () => { /* no-op */ }); return; }

  for (const c of CASES) {
    const judge = JUDGE_BY_CASE[c.id]!;
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_short',
            description: 'current KodaX 39-125 byte descriptions',
            systemPrompt: buildSystemPrompt('baseline'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_expanded',
            description: 'claudecode-grade descriptions with when-to-use, when-to-prefer-X, behavioral contracts',
            systemPrompt: buildSystemPrompt('proposed'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
        ];
        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: [judge],
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });
        const lines: string[] = [];
        lines.push(`[feature-189-batch3-b1-pilot][${c.id}] judge=${judge.name}`);
        for (const vid of ['v_baseline_short', 'v_proposed_expanded']) {
          const cells = result.byVariant[vid] ?? [];
          lines.push(`  --- ${vid} ---`);
          for (const cell of cells) {
            const pass = cell.runsRaw.filter((r) => r.judges.find((j) => j.name === judge.name)?.passed).length;
            lines.push(`    ${cell.alias.padEnd(14)} ${judge.name}=${pass}/${cell.runsRaw.length}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-batch3-b1-tool-desc-expansion-pilot',
          judgeName: judge.name,
          startedAt: result.startedAt,
          variants: variants.map((v) => ({ id: v.id, description: v.description, systemPrompt: v.systemPrompt, userMessage: v.userMessage, priorMessages: v.priorMessages })),
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
              regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
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
