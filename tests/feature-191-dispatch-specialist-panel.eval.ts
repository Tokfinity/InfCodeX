/**
 * Layer 2 panel — FEATURE_191 dispatch specialist routing.
 *
 * ## Why
 *
 * v0.7.43 FEATURE_191 introduces:
 *   A.1 — `dispatch_child_task.subagent_type?: string` schema field
 *   A.3 — Worker SP `=== Available specialist agents ===` block
 *         (rendered from `listConstructedAgents()`)
 *   A.4 — Worker `SPECIALIST ROUTING` dispatch bullet
 *
 * This panel verifies the prompt teaches the Worker to route to the
 * correct `subagent_type` when a registered specialist matches, and to
 * avoid fabricating names when none does.
 *
 * ## Scope
 *
 *   5 alias × 4 case × 1 variant × 5 runs = 100 cells, ~$5, ~30 min wall.
 *
 * The panel runs a single `v_with_specialists` variant (not A/B against
 * baseline) because the FEATURE_191 surface is new — the gate question
 * is whether the new behavior triggers, not whether it shifts an existing
 * rate. Baseline = the absence of the block, which by construction
 * cannot dispatch with `subagent_type` (the schema field doesn't exist
 * in pre-FEATURE_191 Worker SP).
 *
 * ## Pre-registered SHIP gate (mirrors design Acceptance §4)
 *
 *   (a) C1 (specialist matches): each alias dispatch with
 *       `subagent_type='db-reviewer'` rate ≥60%.
 *   (b) C3 (unknown name): each alias false-name dispatch rate ≤10%
 *       (must NOT fabricate `subagent_type` when no specialist matches).
 *   (c) C4 (multi-candidate): fan-out includes ≥1 correct
 *       `subagent_type` invocation per alias × 5 runs (≥50% of runs).
 *   (d) Audit disagreement ≤10% → DATA VALID per
 *       `feedback_audit_must_see_binding` + `feedback_regex_judge_semantic_must_align`.
 *   (e) Per-alias hard fail: 4-of-5 alias satisfy (a)+(b)+(c)
 *       (kimi floor on C1 follows
 *       `feedback_model_structural_floor_not_prompt_tunable` —
 *       single-alias DEFER does not block SHIP).
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-panel
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
  'feature-191-dispatch-specialist-panel',
);

const CANONICAL_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4flash',
  'ark/v4pro',
] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
  'ark/v4pro': 'ds/v4pro',
};

const RUNS_PER_CELL = 5;

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
  /** True for C4 — at least one of the registered specialists must be invoked. */
  readonly multiCandidate?: boolean;
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
    // The forbidden list represents names the model might fabricate.
    forbiddenSubagentTypes: ['design-reviewer', 'doc-reviewer', 'spec-reviewer'],
  },
  {
    id: 'C4_multi',
    userMessage:
      'Audit this PR — it adds a new migration (drops the legacy `sessions.token` column) AND a new auth-handler middleware that bypasses the existing CSRF check on signed cookies. Check both angles.',
    specialistsBlock: SPECIALIST_AGENTS_C4,
    expectedSubagentType: 'db-reviewer',
    forbiddenSubagentTypes: [],
    multiCandidate: true,
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
  const out: string[] = [];
  const re = /["']subagent_type["']\s*[:=]\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

function buildJudgeSpecialistDispatch(expected: string | null, forbidden: readonly string[]): PromptJudge {
  return {
    name: 'specialist_dispatch',
    category: 'correctness',
    judge: (out: string, context?: JudgeContext): JudgeResult => {
      const types = [
        ...extractSubagentTypesFromBinding(context?.toolCalls ?? []),
        ...extractSubagentTypesFromText(out),
      ];
      for (const f of forbidden) {
        if (types.includes(f)) {
          return { passed: false, reason: `forbidden subagent_type="${f}" invoked (likely fabrication)` };
        }
      }
      if (expected === null) {
        if (types.length === 0) return { passed: true };
        return { passed: false, reason: `unexpected subagent_type=${types.join(',')} when no specialist matches` };
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

describe('FEATURE_191 — dispatch specialist routing (Layer 2 panel)', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no canonical alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 1 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 45 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_with_specialists',
            description: 'FEATURE_191 A.3 specialist block + A.4 SPECIALIST ROUTING bullet',
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
        lines.push(`[feature-191-panel][${c.id}] expected=${c.expectedSubagentType ?? '(none)'}`);
        lines.push(`  aliases:         ${aliases.join(', ')}`);
        lines.push(`  runs per cell:   ${RUNS_PER_CELL}`);

        let aggPass = 0, aggTotal = 0;
        for (const cell of result.cells) {
          const pass = cell.runsRaw.filter((r) =>
            r.judges.find((j) => j.name === 'specialist_dispatch')?.passed,
          ).length;
          aggPass += pass;
          aggTotal += cell.runsRaw.length;
          const fallbackSamples = cell.runsRaw.filter((r) => r.fallbackUsed);
          const fallbackTag = fallbackSamples.length > 0
            ? ` [fallback→${fallbackSamples[0]!.fallbackUsed} ×${fallbackSamples.length}/${cell.runsRaw.length}]`
            : '';
          lines.push(`    ${cell.alias.padEnd(14)} specialist_dispatch=${pass}/${cell.runsRaw.length}${fallbackTag}`);
        }
        lines.push(
          `  AGGREGATE: specialist_dispatch=${aggPass}/${aggTotal} (${aggTotal > 0 ? ((aggPass/aggTotal)*100).toFixed(0) : 'n/a'}%)`,
        );

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-191-dispatch-specialist-panel',
          startedAt: result.startedAt,
          expectedSubagentType: c.expectedSubagentType,
          forbiddenSubagentTypes: c.forbiddenSubagentTypes,
          multiCandidate: c.multiCandidate ?? false,
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
        // Double-mkdirSync per feedback_audit_dump_dir_vanishes
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
