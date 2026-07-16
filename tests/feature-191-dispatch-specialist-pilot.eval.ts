/**
 * Pilot — FEATURE_191 dispatch specialist routing.
 *
 * 1 alias (ark/v4flash, cheapest coding-plan floor model) × 4 case ×
 * 1 variant × 1 run = 4 cells, ~$0.10, ~2 min wall.
 *
 * Purpose per `feedback_eval_pilot_before_scale`: confirm that the
 * Worker SP — populated with the FEATURE_191 specialist agents block
 * (A.3) + dispatch routing bullet (A.4) — actually triggers
 * `subagent_type` selection on the canonical cases before scaling to
 * the 5-alias panel.
 *
 * If pilot shows 0/1 dispatch on C1 (clear specialist match) → prompt
 * needs iteration before panel. If pilot shows 1/1 → proceed.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-pilot
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
  'feature-191-dispatch-specialist-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 1;

const TOOL_DOCS = [
  'Tools you have on this turn:',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly?:boolean (default true), model_hint?:"fast"|"deep"|"balanced", subagent_type?:string }',
  '  When `subagent_type` matches a registered specialist (see "Available specialist agents" below), the child runs with that specialist\'s instructions + tool whitelist. Otherwise the child uses the default sub-agent prompt.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

const SPECIALIST_AGENTS_C1_C2 = [
  '=== Available specialist agents ===',
  '- db-reviewer: Reviews DB migrations for safety and best practices',
  '',
  'Dispatch via dispatch_child_task(subagent_type="<name>").',
].join('\n');

const SPECIALIST_AGENTS_C3 = [
  '=== Available specialist agents ===',
  '- db-reviewer: Reviews DB migrations for safety and best practices',
  '',
  'Dispatch via dispatch_child_task(subagent_type="<name>").',
].join('\n');

const SPECIALIST_AGENTS_C4 = [
  '=== Available specialist agents ===',
  '- db-reviewer: Reviews DB migrations for safety and best practices',
  '- security-reviewer: Reviews PR security posture (CSRF, secret handling, authn/authz drift)',
  '',
  'Dispatch via dispatch_child_task(subagent_type="<name>").',
].join('\n');

const DISPATCH_RULES = [
  'DISPATCH RULES (`dispatch_child_task`):',
  '- Read-only fan-out: when you need multiple independent investigations, launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while, dispatch as a child and continue with other tools while it runs.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain (see "Available specialist agents" block above when present), prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

function buildSystemPrompt(specialistsBlock: string): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    specialistsBlock,
    '',
    DISPATCH_RULES,
    '',
    TOOL_DOCS,
  ].join('\n');
}

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly specialistsBlock: string;
  readonly expectedSubagentType: string | null;
  readonly forbiddenSubagentTypes: readonly string[];
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'C1_match',
    userMessage:
      'Review this PR adding migration 0042: ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT \'free\'. The users table has ~50M rows.',
    specialistsBlock: SPECIALIST_AGENTS_C1_C2,
    expectedSubagentType: 'db-reviewer',
    forbiddenSubagentTypes: [],
  },
  {
    id: 'C2_no_match',
    userMessage: 'Fix a small typo in the README: change "behaviour" to "behavior" everywhere.',
    specialistsBlock: SPECIALIST_AGENTS_C1_C2,
    expectedSubagentType: null,
    forbiddenSubagentTypes: ['db-reviewer'],
  },
  {
    id: 'C3_unknown',
    userMessage:
      'Review this design doc for the new image-perception feature: does it cover the multi-resolution case adequately?',
    specialistsBlock: SPECIALIST_AGENTS_C3,
    expectedSubagentType: null,
    forbiddenSubagentTypes: ['design-reviewer', 'db-reviewer'],
  },
  {
    id: 'C4_multi',
    userMessage:
      'Audit this PR — it adds a new migration (drops the legacy `sessions.token` column) AND a new auth-handler middleware that bypasses the existing CSRF check on signed cookies. Check both angles.',
    specialistsBlock: SPECIALIST_AGENTS_C4,
    expectedSubagentType: 'db-reviewer',
    forbiddenSubagentTypes: [],
  },
] as const;

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

function extractSubagentTypesFromBinding(toolCalls: ReadonlyArray<{ name: string; input: unknown }>): string[] {
  const out: string[] = [];
  for (const t of toolCalls) {
    if (t.name !== 'dispatch_child_task') continue;
    const inp = t.input as { subagent_type?: unknown } | null;
    if (inp && typeof inp.subagent_type === 'string' && inp.subagent_type.length > 0) {
      out.push(inp.subagent_type);
    }
  }
  return out;
}

function extractSubagentTypesFromText(text: string): string[] {
  // EVAL_GUIDELINES anti-pattern 7 §4: ≥4 syntax variants. Production
  // panel models emit `subagent_type` arg in any of:
  //   1. JSON          `"subagent_type":"db-reviewer"`
  //   2. YAML no-quote `subagent_type: db-reviewer` (ark/v4flash empirical)
  //   3. HTML-attr     `subagent_type=db-reviewer` / `subagent_type="db-reviewer"`
  //   4. XML tag       `<subagent_type>db-reviewer</subagent_type>`
  //   5. arrow form    `subagent_type => "db-reviewer"` (mmx bracket-arrow)
  const out: string[] = [];
  const patterns: readonly RegExp[] = [
    /["']subagent_type["']\s*:\s*["']([^"'\n]+?)["']/gi,                      // JSON
    /\bsubagent_type\s*:\s*([A-Za-z0-9_-]+)/gi,                                // YAML no-quote
    /\bsubagent_type\s*=\s*["']?([A-Za-z0-9_-]+)["']?/gi,                       // attr (with optional quotes)
    /<subagent_type>\s*([A-Za-z0-9_-]+)\s*<\/subagent_type>/gi,                // XML
    /\bsubagent_type\s*=>\s*["']?([A-Za-z0-9_-]+)["']?/gi,                      // arrow form
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const v = (m[1] ?? '').trim();
      if (v.length > 0) out.push(v);
    }
  }
  return out;
}

function buildJudgeSpecialistDispatch(expected: string | null, forbidden: readonly string[]): PromptJudge {
  return {
    name: 'specialist_dispatch',
    category: 'correctness',
    judge: (out: string, context?: JudgeContext): JudgeResult => {
      const fromBinding = extractSubagentTypesFromBinding(context?.toolCalls ?? []);
      const fromText = extractSubagentTypesFromText(out);
      const types = [...fromBinding, ...fromText];
      // Forbidden invocations are an unambiguous FAIL regardless of expected.
      for (const f of forbidden) {
        if (types.includes(f)) {
          return { passed: false, reason: `forbidden subagent_type="${f}" invoked` };
        }
      }
      if (expected === null) {
        // C2/C3: PASS if NO specialist invocation (generic dispatch is fine).
        if (types.length === 0) return { passed: true };
        return { passed: false, reason: `unexpected subagent_type=${types.join(',')}` };
      }
      if (types.includes(expected)) return { passed: true };
      const anyDispatch = (context?.toolCalls ?? []).some((t) => t.name === 'dispatch_child_task')
        || invokesTool(out, 'dispatch_child_task');
      if (anyDispatch) {
        return { passed: false, reason: `dispatch without subagent_type="${expected}"` };
      }
      return { passed: false, reason: 'no dispatch_child_task invocation' };
    },
  };
}

describe('FEATURE_191 pilot — dispatch specialist routing trigger validation', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 1 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_with_specialists',
            description: 'specialist block + SPECIALIST ROUTING dispatch rule (FEATURE_191 A.3+A.4)',
            systemPrompt: buildSystemPrompt(c.specialistsBlock),
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: [buildJudgeSpecialistDispatch(c.expectedSubagentType, c.forbiddenSubagentTypes)],
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-191-pilot][${c.id}] expected=${c.expectedSubagentType ?? '(none)'}`);
        for (const cell of result.cells) {
          const pass = cell.runsRaw.filter((r) =>
            r.judges.find((j) => j.name === 'specialist_dispatch')?.passed,
          ).length;
          lines.push(`  ${cell.alias.padEnd(14)} specialist_dispatch=${pass}/${cell.runsRaw.length}`);
          for (const run of cell.runsRaw) {
            const types = [
              ...extractSubagentTypesFromBinding(run.toolCalls),
              ...extractSubagentTypesFromText(run.text),
            ];
            lines.push(`    run${run.runIndex} subagent_types=[${types.join(',')}]`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-191-dispatch-specialist-pilot',
          startedAt: result.startedAt,
          expectedSubagentType: c.expectedSubagentType,
          forbiddenSubagentTypes: c.forbiddenSubagentTypes,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
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
