/**
 * Eval: workflow generator — write+verify output contract (FEATURE_2xx "F").
 *
 * ## What this measures
 *
 * The workflow generator prompt was changed so that file-writing / code-
 * implementation requests must generate a `readOnly:false` write child with a
 * `verification: { requiresMutation: true, ... }` postcondition — instead of a
 * report-only fan-out-and-synthesize script (the failure mode that let a run
 * land ZERO files yet report `completed`).
 *
 * This is a LIFT intervention (we WANT generation behavior to change for write
 * requests), so per benchmark/EVAL_GUIDELINES.md it cannot be answered by
 * Layer 1 alone: generator.test.ts validates parsing of FIXED source, not
 * whether the LLM *produces* the write+verify shape. This is a Layer 2 single-
 * turn probe: one generation call per cell, mechanical structural assertion on
 * the generated workflow JSON.
 *
 * ## Cases
 *
 *   Write cases (expect write+verify shape):
 *     W1  land feature-design doc + implement code   (the real failing case)
 *     W2  create a concrete config file + reader module
 *     W3  refactor: split a module into files + update imports
 *   Read cases (boundary — expect NO over-trigger to write+verify):
 *     R1  architecture research → analysis report
 *     R2  security audit → findings list
 *
 * ## Assertion (raw-text structural, ground-truth = model output)
 *
 *   producesWriteVerify =
 *     manifest "readOnly": false  AND
 *     a `verification:` block with `requiresMutation: true`
 *   Write case PASS = producesWriteVerify.
 *   Read  case PASS = !producesWriteVerify (stayed report-only).
 *
 * ## Pre-registered SHIP gate
 *
 *   (a) Efficacy: ≥4/5 aliases pass on ≥2/3 write cases (≥3/4 runs per cell).
 *   (b) No over-trigger: ≥4/5 aliases pass on BOTH read cases (≥3/4 runs).
 *   (a)+(b) met → ship-keep F as-is.
 *   (a) fails → prompt iteration. (b) fails → over-trigger, narrow the prompt.
 *
 * ## Run
 *
 *   Pilot (1 call):   npm run test:eval -- tests/workflow-verify-generator.eval.ts
 *   Full panel:       KODAX_EVAL_PANEL=1 npm run test:eval -- tests/workflow-verify-generator.eval.ts
 *
 * Raw dump → os.tmpdir()/kodax-eval-dumps/workflow-verify-generator/<case>.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, resolveAlias, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
  buildWorkflowGenerationUserPrompt,
  parseWorkflowGeneration,
} from '../packages/coding/src/workflows/generator.js';

/* ---------- panel ---------- */

const PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];
const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const IS_PANEL = process.env.KODAX_EVAL_PANEL === '1';
const RUNS = IS_PANEL ? 4 : 1;

/* ---------- cases ---------- */

interface EvalCase {
  readonly id: string;
  readonly kind: 'write' | 'read';
  readonly request: string;
}

const CASES: readonly EvalCase[] = [
  {
    id: 'W1-feature-doc-and-impl',
    kind: 'write',
    request:
      '探查这个项目的设计语言后，设计一套全量交互动画方案，落地 feature design 文件到 docs/features/ 下并按功能清单追踪的约定更新 docs/FEATURE_LIST.md，然后列出计划并完整实现对应代码。',
  },
  {
    id: 'W2-config-file-and-reader',
    kind: 'write',
    request:
      '为这个项目新增一个应用配置文件 config/app.json（含默认字段），并实现一个读取并校验它的 TypeScript 模块，最后接到启动流程里。',
  },
  {
    id: 'W3-refactor-split-module',
    kind: 'write',
    request:
      '把 utils 里那个过大的工具文件重构拆分成多个高内聚的小文件，更新所有引用它的 import 路径，保证行为不变。',
  },
  {
    id: 'R1-architecture-report',
    kind: 'read',
    request:
      '调研这个代码库的整体架构、模块边界和依赖关系，产出一份结构化的架构分析报告。不要改动任何代码。',
  },
  {
    id: 'R2-security-audit',
    kind: 'read',
    request:
      '审计这个代码库里潜在的安全问题，按严重度列出清单和定位，给出一份只读的审计报告。',
  },
];

/* ---------- structural assertion (raw model output = ground truth) ---------- */

const MANIFEST_READONLY_FALSE = /"readOnly"\s*:\s*false/;
const VERIFICATION_BLOCK = /verification\s*:/;
const REQUIRES_MUTATION = /requiresMutation\s*:\s*true/;

interface CellResult {
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly kind: 'write' | 'read';
  readonly runIndex: number;
  readonly parsedKind: 'generated' | 'declined' | 'parse_error';
  readonly manifestReadOnlyFalse: boolean;
  readonly hasVerification: boolean;
  readonly hasRequiresMutation: boolean;
  readonly producesWriteVerify: boolean;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly text: string;
}

function assessRaw(raw: string): {
  manifestReadOnlyFalse: boolean;
  hasVerification: boolean;
  hasRequiresMutation: boolean;
  producesWriteVerify: boolean;
} {
  const manifestReadOnlyFalse = MANIFEST_READONLY_FALSE.test(raw);
  const hasVerification = VERIFICATION_BLOCK.test(raw);
  const hasRequiresMutation = REQUIRES_MUTATION.test(raw);
  const producesWriteVerify = manifestReadOnlyFalse && hasVerification && hasRequiresMutation;
  return { manifestReadOnlyFalse, hasVerification, hasRequiresMutation, producesWriteVerify };
}

function parsedKindOf(raw: string, request: string): 'generated' | 'declined' | 'parse_error' {
  try {
    const parsed = parseWorkflowGeneration(raw, { request });
    return parsed.kind === 'generated' ? 'generated' : 'declined';
  } catch {
    return 'parse_error';
  }
}

function dumpDir(): string {
  const dir = join(tmpdir(), 'kodax-eval-dumps', 'workflow-verify-generator');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- driver ---------- */

const aliases = IS_PANEL ? availableAliases(...PANEL) : availableAliases(PILOT_ALIAS);
const activeCases = IS_PANEL ? CASES : CASES.filter((c) => c.id === 'W1-feature-doc-and-impl');

describe('workflow generator — write+verify output contract', () => {
  it.skipIf(aliases.length === 0)(
    `probe (${IS_PANEL ? 'panel' : 'pilot'}: ${aliases.length} alias × ${activeCases.length} case × ${RUNS} run)`,
    async () => {
      const all: CellResult[] = [];

      // anti-pattern 3: concurrency=1 per *provider* (ark/v4pro + ark/v4flash
      // share ark-coding quota). Run providers in parallel, aliases+runs within
      // a provider sequentially.
      const byProvider = new Map<string, ModelAlias[]>();
      for (const alias of aliases) {
        const p = resolveAlias(alias).provider;
        byProvider.set(p, [...(byProvider.get(p) ?? []), alias]);
      }

      for (const ev of activeCases) {
        const perProvider = await Promise.all(
          [...byProvider.values()].map(async (group): Promise<CellResult[]> => {
            const rows: CellResult[] = [];
            for (const alias of group) {
              for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
                const out = await runOneShot(alias, {
                  systemPrompt: WORKFLOW_GENERATION_SYSTEM_PROMPT,
                  userMessage: buildWorkflowGenerationUserPrompt(ev.request),
                });
                const a = assessRaw(out.text);
                const passed = ev.kind === 'write' ? a.producesWriteVerify : !a.producesWriteVerify;
                rows.push({
                  alias,
                  caseId: ev.id,
                  kind: ev.kind,
                  runIndex,
                  parsedKind: parsedKindOf(out.text, ev.request),
                  manifestReadOnlyFalse: a.manifestReadOnlyFalse,
                  hasVerification: a.hasVerification,
                  hasRequiresMutation: a.hasRequiresMutation,
                  producesWriteVerify: a.producesWriteVerify,
                  passed,
                  durationMs: out.durationMs,
                  text: out.text,
                });
              }
            }
            return rows;
          }),
        );
        const rows = perProvider.flat();
        all.push(...rows);

        // raw dump per case (re-mkdir guard: Windows tmp cleanup, anti-pattern note)
        const byAlias = aliases.map((alias) => {
          const runs = rows.filter((r) => r.alias === alias);
          const pass = runs.filter((r) => r.passed).length;
          return {
            alias,
            passRate: `${pass}/${runs.length}`,
            runs: runs.map((r) => ({
              runIndex: r.runIndex,
              parsedKind: r.parsedKind,
              manifestReadOnlyFalse: r.manifestReadOnlyFalse,
              hasVerification: r.hasVerification,
              hasRequiresMutation: r.hasRequiresMutation,
              producesWriteVerify: r.producesWriteVerify,
              passed: r.passed,
              durationMs: r.durationMs,
              text: r.text,
            })),
          };
        });
        const file = join(dumpDir(), `${ev.id}.json`);
        writeFileSync(
          file,
          JSON.stringify({ case: ev.id, kind: ev.kind, request: ev.request, aliases: byAlias }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`[dump] ${ev.id} → ${file}`);
      }

      /* ---------- summary table ---------- */
      const header = ['case', 'kind', ...aliases].join(' | ');
      const lines = [header, header.replace(/[^|]/g, '-')];
      for (const ev of activeCases) {
        const cells = aliases.map((alias) => {
          const runs = all.filter((r) => r.caseId === ev.id && r.alias === alias);
          const pass = runs.filter((r) => r.passed).length;
          return runs.length > 0 ? `${pass}/${runs.length}` : '—';
        });
        lines.push([ev.id, ev.kind, ...cells].join(' | '));
      }
      // eslint-disable-next-line no-console
      console.log('\n=== write+verify probe (PASS = correct shape) ===\n' + lines.join('\n') + '\n');
    },
    5_400_000,
  );
});
