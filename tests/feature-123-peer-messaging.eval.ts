/**
 * Eval: FEATURE_123 v0.7.44 — Peer-to-Peer SendMessage prompt-signal probe
 *  (SCAFFOLDED for v0.7.44; full panel rerun lands in v0.7.45 alongside
 *  the F192 audit so both new prompts get LLM-judge gate evaluation in
 *  the same window).
 *
 * **Design**: 4 cases × N runs × M alias.
 *   - Positive cases (C1/C2/C3) PASS when the model calls
 *     `send_message` with the right `to=` shape (peer/worker/`*`).
 *   - Negative case (C4) PASSes ONLY when `send_message` is NOT
 *     called (do-no-harm guard against peer chatter spam).
 *
 * **Modes** (env `KODAX_F123_MODE`):
 *   - `pilot`  → ark/v4flash × C1 × 1 run = 1 call (~$0.01).
 *   - `scale`  → 5 alias × 4 case × 5 run = 100 calls (~$3-5).
 *   - default  → SKIP (no env, no spend).
 *
 * **Run**:
 *   KODAX_F123_MODE=pilot npm run test:eval -- feature-123-peer-messaging
 *   KODAX_F123_MODE=scale npm run test:eval -- feature-123-peer-messaging
 *
 * Skips when API keys absent. Not in regular CI — manual invocation only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  EDIT_TOOL,
  PEER_EVAL_CASES,
  PEER_EVAL_SYSTEM_PROMPT,
  READ_TOOL,
  SEND_MESSAGE_TOOL,
  type PeerEvalCase,
} from '../benchmark/datasets/feature-123-peer-messaging/cases.js';

type Mode = 'pilot' | 'scale' | 'skip';
const MODE: Mode = (process.env.KODAX_F123_MODE ?? 'skip') as Mode;

const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
];

const REQUESTED_PANEL: readonly ModelAlias[] =
  MODE === 'pilot' ? (['ark/v4flash'] as const) : DEFAULT_SCALE_PANEL;

const REQUESTED_CASES: readonly PeerEvalCase[] =
  MODE === 'pilot'
    ? PEER_EVAL_CASES.filter((c) => c.id === 'C1_peer_conflict_notify')
    : PEER_EVAL_CASES;

const RUNS = MODE === 'pilot' ? 1 : 5;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-123-peer-messaging');

interface ProbeRow {
  caseId: string;
  alias: ModelAlias;
  runIndex: number;
  durationMs: number;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  observedTargetShape: 'peer' | 'worker' | 'broadcast' | 'none' | 'wrong-tool';
  matchedContentSignals: readonly string[];
  primaryPassed: boolean;
}

/** Classify the first `send_message` call into a routing shape. */
function classifyTargetShape(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): 'peer' | 'worker' | 'broadcast' | 'none' {
  const sendCall = toolCalls.find((t) => t.name === 'send_message');
  if (!sendCall) return 'none';
  const input = sendCall.input as { to?: unknown };
  const to = typeof input?.to === 'string' ? input.to.trim() : '';
  if (to === '*') return 'broadcast';
  if (to === 'worker') return 'worker';
  if (to.length > 0) return 'peer';
  return 'none';
}

function scoreResponse(
  c: PeerEvalCase,
  text: string,
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): {
  observedTargetShape: ProbeRow['observedTargetShape'];
  matchedContentSignals: readonly string[];
  primaryPassed: boolean;
} {
  const observedShape = classifyTargetShape(toolCalls);
  // Negative case: PASS iff no send_message call at all.
  if (c.expectedTarget === 'none') {
    return {
      observedTargetShape: observedShape,
      matchedContentSignals: [],
      primaryPassed: observedShape === 'none',
    };
  }
  // Positive case: shape must match.
  if (observedShape !== c.expectedTarget) {
    return {
      observedTargetShape: observedShape,
      matchedContentSignals: [],
      primaryPassed: false,
    };
  }
  // Shape matches — additionally check content signals on the call body
  // for an extra correctness hint (kept lenient — any signal hits PASS).
  const sendCall = toolCalls.find((t) => t.name === 'send_message');
  const input = (sendCall?.input ?? {}) as { content?: unknown; to?: unknown };
  const body =
    (typeof input.content === 'string' ? input.content : '') +
    ' ' +
    (typeof input.to === 'string' ? input.to : '') +
    '\n' +
    text;
  const matched: string[] = [];
  for (const sig of c.expectedContentSignals) {
    try {
      const re = new RegExp(sig, 'i');
      if (re.test(body)) matched.push(sig);
    } catch {
      if (body.toLowerCase().includes(sig.toLowerCase())) matched.push(sig);
    }
  }
  // Shape match is the primary signal; content signals are a secondary
  // hint. PASS when shape matches AND ≥1 content signal hits (lenient
  // — strict gating waits for LLM-judge audit).
  return {
    observedTargetShape: observedShape,
    matchedContentSignals: matched,
    primaryPassed: c.expectedContentSignals.length === 0 ? true : matched.length > 0,
  };
}

describe(`Eval: FEATURE_123 peer messaging prompt-signal (${MODE})`, () => {
  if (MODE === 'skip') {
    it('skips: KODAX_F123_MODE not set (set pilot|scale to run)', () => {
      // no-op
    });
    return;
  }

  const aliases = availableAliases(...REQUESTED_PANEL);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all probes and dumps raw output',
    { timeout: MODE === 'pilot' ? 600_000 : 3_600_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const rows: ProbeRow[] = [];
      const incrementalDumpPath = join(DUMP_ROOT, `${MODE}-incremental-${Date.now()}.json`);
      const flushIncremental = () => {
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(
          incrementalDumpPath,
          JSON.stringify(
            {
              mode: MODE,
              timestamp: new Date().toISOString(),
              aliases,
              cases: REQUESTED_CASES.map((c) => c.id),
              runs: RUNS,
              completedRows: rows.length,
              expectedRows: REQUESTED_CASES.length * aliases.length * RUNS,
              rows,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };
      // eslint-disable-next-line no-console
      console.log(`[F123] incremental dump: ${incrementalDumpPath}`);

      for (const c of REQUESTED_CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(`[F123] case=${c.id} alias=${alias} run=${runIndex}`);
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: PEER_EVAL_SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: [SEND_MESSAGE_TOOL, READ_TOOL, EDIT_TOOL],
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[F123] error case=${c.id} alias=${alias}: ${(err as Error).message}`,
              );
              continue;
            }
            const score = scoreResponse(c, result.text, result.toolCalls);
            rows.push({
              caseId: c.id,
              alias,
              runIndex,
              durationMs: result.durationMs,
              text: result.text,
              toolCalls: result.toolCalls,
              observedTargetShape: score.observedTargetShape,
              matchedContentSignals: score.matchedContentSignals,
              primaryPassed: score.primaryPassed,
            });
            flushIncremental();
          }
        }
      }

      const cells = new Map<string, { passed: number; total: number }>();
      for (const r of rows) {
        const key = `${r.caseId}|${r.alias}`;
        const cur = cells.get(key) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        cells.set(key, cur);
      }
      const overall = new Map<string, { passed: number; total: number }>();
      for (const r of rows) {
        const cur = overall.get(r.caseId) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        overall.set(r.caseId, cur);
      }

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            mode: MODE,
            timestamp: new Date().toISOString(),
            aliases,
            cases: REQUESTED_CASES.map((c) => c.id),
            runs: RUNS,
            rows,
            cellSummary: Object.fromEntries(cells),
            overallSummary: Object.fromEntries(overall),
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log(`\n=== FEATURE_123 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${dumpPath}`);
      for (const c of REQUESTED_CASES) {
        const o = overall.get(c.id);
        if (!o) continue;
        const pct = ((o.passed / o.total) * 100).toFixed(0);
        // eslint-disable-next-line no-console
        console.log(`\nCase ${c.id} (expect: ${c.expectedTarget}): ${o.passed}/${o.total} (${pct}%) overall`);
        for (const alias of aliases) {
          const cell = cells.get(`${c.id}|${alias}`);
          if (!cell) continue;
          const apct = ((cell.passed / cell.total) * 100).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(`    ${alias}: ${cell.passed}/${cell.total} (${apct}%)`);
        }
      }
    },
  );
});
