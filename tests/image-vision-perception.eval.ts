/**
 * Eval: image vision perception — regression guard for Fix B (image
 * perception block in `sharedWorkerDiscipline`).
 *
 * ## Background
 *
 * Bug report (2026-05-19): user pasted a PNG into KodaX REPL (Worker on
 * `kimi-code`). Worker thinking emitted "用户发了一张中国地图的PNG图片给我，但
 * 我无法直接读取/查看PNG图片内容（read工具不支持二进制文件）" and reached for
 * `agent-browser` to open the file via shell, instead of describing what it
 * saw in the attached image content block.
 *
 * Wire-level probe (4 transport variants against `api.kimi.com/coding/`)
 * confirmed Kimi K2-for-coding sees images natively. So the bug is upstream
 * of the wire — KodaX's agentic prompt + 30+ tool catalog primes the model
 * into tool-mode where it never realises it has native vision and tries to
 * "open" the image with a file-reading tool.
 *
 * Initial single-turn Layer 2 probe (V1 baseline on kimi) did NOT reproduce
 * the bug on a fresh agentic context — kimi passed cleanly. The likely
 * production trigger is multi-turn priming and/or compaction-stale `[Image:
 * filename.png]` markers that we can't deterministically synthesise.
 *
 * ## Shipped fix
 *
 * `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`
 * `sharedWorkerDiscipline` gains a third "Image perception:" section
 * alongside the existing "Workspace discipline:" and "Cross-platform shell:"
 * sections. The block tells every AMA role (Scout/Planner/Generator/Worker/
 * Evaluator):
 *   1. Image content blocks are visible via native vision; no tool needed.
 *   2. Do NOT reach for `agent-browser` / `read` / etc to "open" them.
 *   3. If a prior turn replaced the image with a `[Image: filename]` text
 *      marker (compaction), surface that and ask user to re-attach — don't
 *      hallucinate content.
 *
 * Fix A (remove `[Image #N]` anchor) was DROPPED after audit: anchors are
 * load-bearing for multi-image disambiguation ("describe @a vs @b" would
 * become "describe  vs ").
 *
 * ## This eval — regression guard, not failure reproducer
 *
 * Because the bug doesn't reproduce single-turn, this eval can't directly
 * validate the fix. What it CAN do is guard against regressions:
 *
 *   R1 (vision still works): on cases with an image attached, V_fix
 *       passRate ≥ V_baseline passRate (Δ ≥ -10pp, accounting for noise).
 *
 *   R2 (no over-trigger): on the text-only negative case (NO image
 *       attached), V_fix doesn't introduce hallucination ("I see / 我看到
 *       图片" type phrases) over V_baseline. Hallucination rate Δ ≤ +10pp.
 *
 * If both regression guards hold, Fix B is safe to ship as defensive
 * parity with claudecode (which has no anchor and explicit vision priming
 * by default per Anthropic's tuning).
 *
 * ## Variants
 *
 *   V_baseline: agentic system (SYSTEM_PROMPT + buildWorkerInstructions +
 *               SKILLS_SECTION) + KODAX_TOOLS, NO image-perception block.
 *
 *   V_fix:      V_baseline + the exact `Image perception:` text shipped in
 *               `sharedWorkerDiscipline`.
 *
 * ## Cases
 *
 *   case_diagram (image): `C:/tmp/page04_v2.png` — bilingual split-screen
 *       diagram. Positive: SVG markup OR image-specific terms.
 *
 *   case_counter (image): `C:/tmp/counter-demo-initial.png` — UI screenshot
 *       with "Counter Demo — L0 联动" + Slot A/B iframes. Positive: SVG
 *       markup OR image-specific terms.
 *
 *   case_text_only (no image): plain text task explaining a counter
 *       component. Negative regression check: model must not claim to see
 *       an image that wasn't attached.
 *
 * ## Mechanical assertion
 *
 *   Image cases (case_diagram / case_counter):
 *     PASS: ≥1 positive keyword (SVG markup OR image-specific) AND no
 *           negative keyword (denial / tool-reach).
 *
 *   Text-only case (case_text_only):
 *     PASS: no hallucination marker (no claim of "the image shows / 我看到
 *           你发的图 / based on the screenshot you attached").
 *
 *   Per EVAL_GUIDELINES.md anti-pattern 7: regex result is paired with
 *   self-judge audit (orchestrating Claude reads raw dump). Disagreement
 *   >10% → data void.
 *
 * ## Sample size + budget
 *
 *   Pilot (`pilot` describe): kimi × 3 case × 2 variant × 1 run = 6 calls
 *     (free under subscription). Confirms cases run + regex behaves.
 *
 *   Panel (`panel` describe): 3 vision-capable alias × 3 case × 2 variant
 *     × 3 run = 54 calls. zhipu/kimi/mmx — all subscription, ~$0 marginal.
 *     ds/v4flash + ds/v4pro intentionally OMITTED because deepseek's API
 *     400s on `image_url` content (separate provider-registry bug worth
 *     filing).
 *
 * ## Run
 *
 *   Pilot only:  npm run test:eval -- image-vision-perception -t pilot
 *   Full panel:  npm run test:eval -- image-vision-perception -t panel
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  getProvider,
  type KodaXContentBlock,
  type KodaXMessage,
  type KodaXTaskRoutingDecision,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KODAX_TOOLS, SYSTEM_PROMPT } from '@kodax-ai/coding';

import {
  availableAliases,
  resolveAlias,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';
import { buildWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';

// ---------------------------------------------------------------------------
// Dump dir (EVAL_GUIDELINES.md §Raw output preservation — must be OS tmpdir).
// ---------------------------------------------------------------------------

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'image-vision-perception');
mkdirSync(DUMP_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

const IMAGE_USER_QUESTION =
  '请根据这张图的内容，输出对应的 SVG path 代码（只需要 <path d="..."/> 元素，能勾勒出图中所示主要图形即可）。如果你确实看不见图片，直接说 "NO_IMAGE_PERCEIVED"。';

const TEXT_ONLY_USER_QUESTION =
  '用 100 字以内解释一下：如果要在 React 里实现一个会计数的 Counter 组件，最少需要哪几个状态/事件？不要假设我发过任何截图或图片，纯文字回答即可。';

interface VisionCase {
  readonly id: string;
  readonly imagePath?: string;
  readonly mediaType?: 'image/png' | 'image/jpeg';
  readonly userQuestion: string;
  readonly positiveKeywords: readonly RegExp[];
  readonly negativeKeywords: readonly RegExp[];
  readonly minPositiveMatches: number;
}

// Shared denial / tool-reach phrases. Used on image cases (these would be
// the literal failure mode the bug report described).
const IMAGE_DENIAL_NEGATIVES: readonly RegExp[] = [
  /NO_IMAGE_PERCEIVED/,
  /无法.{0,6}(直接)?(读取|查看|看见|看到)/,
  /我.{0,4}看不(?:到|见)/,
  /cannot\s+(see|read|view|access).{0,20}image/i,
  /unable\s+to\s+(see|read|view).{0,20}image/i,
  /\bread\b.{0,4}工具/,
  /agent[-_]browser/i,
  /不支持二进制/,
  /binary.{0,10}not\s+supported/i,
];

// Hallucination markers — claims of having seen an image when none was
// attached. These trigger on the text-only case (regression check for
// Fix B over-trigger).
const HALLUCINATION_NEGATIVES: readonly RegExp[] = [
  /你(发|给|附|上传|提供|贴)了?.{0,8}(图|截图|图片|image|screenshot)/i,
  /我看到(?:你?发?的?).{0,6}(图|截图|图片)/,
  /the\s+(image|screenshot|diagram|picture)\s+you\s+(sent|attached|provided|shared)/i,
  /based\s+on\s+the\s+(image|screenshot|attached|picture)/i,
  /(in|from)\s+the\s+(image|screenshot|attached|diagram)/i,
  /图(里|中|上).{0,8}(显示|可以看到|展示)/,
];

const SVG_MARKUP_REGEXES: readonly RegExp[] = [
  /<path[\s>]/i,
  /\bd\s*=\s*["']\s*[MmLlHhVvCcSsQqTtAaZz][^"']{4,}/,
  /<svg[\s>]/i,
];

const CASES: readonly VisionCase[] = [
  {
    id: 'case_diagram',
    imagePath: 'C:/tmp/page04_v2.png',
    mediaType: 'image/png',
    userQuestion: IMAGE_USER_QUESTION,
    positiveKeywords: [
      ...SVG_MARKUP_REGEXES,
      /屏幕内外/,
      /split[-\s]?screen/i,
      /(human|人类).{0,12}(AI|视角)/i,
      /数字矩阵|玻璃屏幕/,
      /perspective/i,
    ],
    negativeKeywords: IMAGE_DENIAL_NEGATIVES,
    minPositiveMatches: 1,
  },
  {
    id: 'case_counter',
    imagePath: 'C:/tmp/counter-demo-initial.png',
    mediaType: 'image/png',
    userQuestion: IMAGE_USER_QUESTION,
    positiveKeywords: [
      ...SVG_MARKUP_REGEXES,
      /counter[\s—–\-]{0,3}demo/i,
      /L0[\s—–\-]{0,3}联动/,
      /\biframe/i,
      /slot[\s—–\-]{0,3}[ab]\b/i,
      /sandbox/i,
    ],
    negativeKeywords: IMAGE_DENIAL_NEGATIVES,
    minPositiveMatches: 1,
  },
  {
    id: 'case_text_only',
    // No imagePath — text-only message. Regression guard for Fix B
    // over-trigger: model must NOT hallucinate having seen an image.
    userQuestion: TEXT_ONLY_USER_QUESTION,
    // No positive requirement — the assertion is "no negative match".
    positiveKeywords: [],
    negativeKeywords: HALLUCINATION_NEGATIVES,
    minPositiveMatches: 0,
  },
];

// ---------------------------------------------------------------------------
// Variants — V_baseline vs V_fix.
// ---------------------------------------------------------------------------

// EXACT text shipped in `sharedWorkerDiscipline` (role-prompt.ts:231).
// Kept in sync manually — small enough that drift is obvious in PR diff.
const SHIPPED_IMAGE_PERCEPTION_BLOCK = [
  'Image perception:',
  '- When a user message contains an image content block (pasted screenshot, diagram, photo, sketch, UI mockup), you can see the image directly through native vision. Describe what you see and answer the question — do NOT claim you cannot read PNG/JPEG/binary files, and do NOT say the `read` tool is needed.',
  '- Do NOT invoke `agent-browser`, `read`, `view`, or any other tool to "open" or "decode" an attached image. `agent-browser` is for live web URLs only; no tool call can decode an image that is already inlined into the conversation.',
  '- If the user attached an image to clarify intent (e.g. "describe this", "convert to SVG", "what is wrong here"), execute the task against the image directly. If a prior turn replaced an image with a text marker like `[Image: filename.png]` (history compaction), say so and ask the user to re-attach — do not invent content.',
].join('\n');

// Representative skills snippet mirroring what the user's session loaded.
// Captures the BLOCKING REQUIREMENT phrasing the production
// `getSystemPromptSnippet` (packages/skills/src/skill-registry.ts:171) emits,
// plus the `agent-browser` skill's actual description.
const SKILLS_SECTION = [
  '## Available Skills',
  '',
  'When users ask you to perform tasks, check if any of the available skills below match the request. Skills provide specialized capabilities and step-by-step instructions for specific workflows.',
  '',
  'When users reference a "slash command" or "/<something>" (e.g. "/feature-list-tracker", "/skill:foo"), they are referring to a skill. Use the read tool to load the skill\'s `SKILL.md` and follow its instructions.',
  '',
  "**BLOCKING REQUIREMENT**: When a skill matches the user's request, you MUST read the relevant skill's `SKILL.md` BEFORE generating any other response about the task. Loading the skill is not optional and not something to defer — it is the FIRST action you take.",
  '',
  'NEVER mention a skill without actually reading its `SKILL.md`. Do not guess at skill names — only use skills listed below.',
  '',
  '- agent-browser: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task.',
  '  (Location: ~/.claude/skills/agent-browser/SKILL.md)',
  '',
].join('\n');

const PROBE_DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'review',
  workIntent: 'review',
  complexity: 'multi-step',
  riskLevel: 'low',
  harnessProfile: 'H0_DIRECT',
  recommendedMode: 'agentic',
  recommendedThinkingDepth: 'balanced',
  requiresBrainstorm: false,
  confidence: 0.9,
  reason: 'image vision regression guard (Layer 2 eval)',
};

function workerLikeSystemPrompt(includeFixB: boolean): string {
  const workerInstructions = buildWorkerInstructions(PROBE_DECISION, undefined, false);
  const parts = [SYSTEM_PROMPT, workerInstructions, SKILLS_SECTION];
  if (includeFixB) parts.push(SHIPPED_IMAGE_PERCEPTION_BLOCK);
  return parts.join('\n\n');
}

interface VariantSpec {
  readonly id: 'V_baseline' | 'V_fix';
  readonly system: string;
  readonly tools: readonly KodaXToolDefinition[];
}

function buildVariants(): readonly VariantSpec[] {
  return [
    { id: 'V_baseline', system: workerLikeSystemPrompt(false), tools: KODAX_TOOLS },
    { id: 'V_fix', system: workerLikeSystemPrompt(true), tools: KODAX_TOOLS },
  ];
}

// ---------------------------------------------------------------------------
// One-shot call.
// ---------------------------------------------------------------------------

interface CellRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly durationMs: number;
  readonly regexPassed: boolean;
  readonly regexReason: string;
  readonly errorMessage?: string;
}

interface CellResult {
  readonly alias: ModelAlias;
  readonly variantId: VariantSpec['id'];
  readonly caseId: string;
  readonly runs: readonly CellRun[];
  readonly passRate: number;
}

function judgeResponse(
  c: VisionCase,
  text: string,
  toolCalls: readonly { name: string; input: unknown }[],
): { passed: boolean; reason: string } {
  const haystack = [
    text,
    ...toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.input)})`),
  ].join('\n');

  const negativeMatches = c.negativeKeywords.filter((re) => re.test(haystack));
  if (negativeMatches.length > 0) {
    return {
      passed: false,
      reason: `negative match: ${negativeMatches.map((re) => re.source).join(' | ')}`,
    };
  }
  if (c.minPositiveMatches === 0) {
    return {
      passed: true,
      reason: 'no-image case: no hallucination marker matched',
    };
  }
  const positiveMatches = c.positiveKeywords.filter((re) => re.test(haystack));
  if (positiveMatches.length < c.minPositiveMatches) {
    return {
      passed: false,
      reason: `positive keyword count ${positiveMatches.length} < ${c.minPositiveMatches} (matched: ${positiveMatches.map((re) => re.source).join(', ') || 'none'})`,
    };
  }
  return {
    passed: true,
    reason: `matched ${positiveMatches.length} positive keywords: ${positiveMatches.map((re) => re.source).join(', ')}`,
  };
}

async function runCell(
  alias: ModelAlias,
  variant: VariantSpec,
  c: VisionCase,
  runs: number,
): Promise<CellResult> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);

  const userContent: KodaXContentBlock[] = c.imagePath && c.mediaType
    ? [
      { type: 'text', text: `[Image #1] ${c.userQuestion}` },
      { type: 'image', path: c.imagePath, mediaType: c.mediaType },
    ]
    : [{ type: 'text', text: c.userQuestion }];

  const messages: KodaXMessage[] = [{ role: 'user', content: userContent }];

  const runResults: CellRun[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const startedAt = Date.now();
    try {
      const result = await provider.stream(
        messages as KodaXMessage[],
        variant.tools as KodaXToolDefinition[],
        variant.system,
        undefined,
        { modelOverride: target.model },
      );
      const durationMs = Date.now() - startedAt;
      const text = result.textBlocks.map((b) => b.text).join('').trim();
      const toolCalls = result.toolBlocks.map((b) => ({
        name: b.name,
        input: b.input,
      }));
      const judged = judgeResponse(c, text, toolCalls);
      runResults.push({
        runIndex,
        text,
        toolCalls,
        durationMs,
        regexPassed: judged.passed,
        regexReason: judged.reason,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      runResults.push({
        runIndex,
        text: '',
        toolCalls: [],
        durationMs,
        regexPassed: false,
        regexReason: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const passCount = runResults.filter((r) => r.regexPassed).length;
  return {
    alias,
    variantId: variant.id,
    caseId: c.id,
    runs: runResults,
    passRate: runResults.length > 0 ? passCount / runResults.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------

async function runSuite(
  label: 'pilot' | 'panel',
  aliases: readonly ModelAlias[],
  runsPerCell: number,
): Promise<{
  cells: readonly CellResult[];
  dumpPath: string;
}> {
  const variants = buildVariants();
  const cells: CellResult[] = [];

  for (const c of CASES) {
    for (const variant of variants) {
      for (const alias of aliases) {
        // eslint-disable-next-line no-console
        console.log(`[${label}] ${alias} × ${variant.id} × ${c.id} × ${runsPerCell}-run starting...`);
        const cell = await runCell(alias, variant, c, runsPerCell);
        cells.push(cell);
        // eslint-disable-next-line no-console
        console.log(
          `[${label}] ${alias} × ${variant.id} × ${c.id} → passRate=${(cell.passRate * 100).toFixed(0)}%`,
        );
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = join(DUMP_ROOT, `${label}-${stamp}.json`);
  writeFileSync(
    dumpPath,
    JSON.stringify(
      {
        label,
        timestamp: new Date().toISOString(),
        cases: CASES.map((c) => ({
          id: c.id,
          imagePath: c.imagePath ?? null,
          mediaType: c.mediaType ?? null,
          userQuestion: c.userQuestion,
          positiveKeywords: c.positiveKeywords.map((re) => re.source),
          negativeKeywords: c.negativeKeywords.map((re) => re.source),
          minPositiveMatches: c.minPositiveMatches,
        })),
        variants: variants.map((v) => ({
          id: v.id,
          systemPromptLength: v.system.length,
          toolsCount: v.tools.length,
        })),
        cells,
      },
      null,
      2,
    ),
    'utf8',
  );
  // eslint-disable-next-line no-console
  console.log(`[${label}] raw dump: ${dumpPath}`);
  return { cells, dumpPath };
}

function summarize(label: string, cells: readonly CellResult[]): string {
  const variantIds = Array.from(new Set(cells.map((c) => c.variantId)));
  const caseIds = Array.from(new Set(cells.map((c) => c.caseId)));
  const aliases = Array.from(new Set(cells.map((c) => c.alias)));

  const lines: string[] = [];
  lines.push(`\n=== ${label} summary ===`);
  for (const caseId of caseIds) {
    lines.push(`\n[case: ${caseId}]`);
    lines.push(
      `${'variant'.padEnd(14)} ${aliases.map((a) => a.padStart(14)).join(' ')}`,
    );
    for (const vid of variantIds) {
      const row = aliases.map((alias) => {
        const cell = cells.find(
          (c) => c.variantId === vid && c.caseId === caseId && c.alias === alias,
        );
        return cell
          ? `${(cell.passRate * 100).toFixed(0).padStart(3)}% (${
              cell.runs.filter((r) => r.regexPassed).length
            }/${cell.runs.length})`.padStart(14)
          : '—'.padStart(14);
      });
      lines.push(`${vid.padEnd(14)} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const PILOT_ALIAS: ModelAlias = 'kimi';
const PANEL_ALIASES: readonly ModelAlias[] = ['zhipu/glm51', 'kimi', 'mmx/m27'];

describe('Eval: image vision perception (Fix B regression guard)', () => {
  describe('pilot', () => {
    const aliases = availableAliases(PILOT_ALIAS);
    if (aliases.length === 0) {
      it('skips: pilot alias api key missing', () => {});
      return;
    }
    it(
      'kimi × 3 cases × 2 variants × 1 run',
      { timeout: 30 * 60_000 },
      async () => {
        const { cells } = await runSuite('pilot', aliases, 1);
        // eslint-disable-next-line no-console
        console.log(summarize('pilot', cells));
        expect(cells.length).toBeGreaterThan(0);
      },
    );
  });

  describe('panel', () => {
    const aliases = availableAliases(...PANEL_ALIASES);
    if (aliases.length === 0) {
      it('skips: no panel alias api keys present', () => {});
      return;
    }
    it(
      `2 variants × 3 cases × ${aliases.length}-alias × 3 runs/cell`,
      { timeout: 90 * 60_000 },
      async () => {
        const { cells, dumpPath } = await runSuite('panel', aliases, 3);
        // eslint-disable-next-line no-console
        console.log(summarize('panel', cells));
        // eslint-disable-next-line no-console
        console.log(`\nFull raw dump at: ${dumpPath}`);
        // eslint-disable-next-line no-console
        console.log(
          'Run self-judge audit (orchestrating Claude) on the dump per EVAL_GUIDELINES §Judge before treating regex pass-rate as decision input.',
        );
        expect(cells.length).toBeGreaterThan(0);
      },
    );
  });
});
