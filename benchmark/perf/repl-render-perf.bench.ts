#!/usr/bin/env tsx
/**
 * FEATURE_172 v0.7.41 — REPL render-perf baseline benchmark.
 *
 * Measures the wall-time cost of `buildTranscriptRenderModel` — the function
 * identified by the FEATURE_172 root-cause investigation as the dominant
 * synchronous CPU cost during streaming flushes (80ms tick). See ADR-027.
 *
 * Two scenarios per item-count tier:
 *
 *   - `static-render-model`: pure model build with no streaming state.
 *     Captures the floor cost of the data layer (text wrap + section build).
 *
 *   - `streaming-tick`: simulates the exact pathological case — accumulating
 *     `streamingResponse` triggers full model rebuild on every call (the
 *     useMemo-invalidation pattern that produces 2-3s/frame lag on SSH).
 *
 * Output: `benchmark/perf-baselines/baseline-<git-sha>.json`. This baseline
 * file IS tracked in git (separate dir from `benchmark/results/` which holds
 * prompt-eval dumps and is gitignored). Each Phase commit re-runs the bench
 * and the new baseline anchors the next Phase's gate.
 *
 * Usage:
 *   npm run bench:perf
 *
 * Phase gates (from FEATURE_172 design):
 *   200 items / streaming-tick:
 *     baseline (16609427): ~9-22ms p95
 *     after Phase 2:        ≤5ms p95
 *     after Phase 3+:       ≤2ms p95   (claudecode parity)
 */
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTranscriptRenderModel,
  type TranscriptRenderModelOptions,
} from "../../packages/repl/src/ui/utils/transcript-layout.js";
import { ToolCallStatus, type HistoryItem } from "../../packages/repl/src/ui/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Fixture ===

/**
 * Synthetic 4-cycle pattern: user / assistant / tool_group / thinking.
 * Realistic message size distribution observed in actual long sessions.
 * Fixed seed (loop index) — fully deterministic across runs.
 */
function makeFixtureItems(n: number): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (let i = 0; i < n; i++) {
    const phase = i % 4;
    const ts = 1_000_000 + i;
    if (phase === 0) {
      items.push({
        id: `u-${i}`,
        type: "user",
        text: `User prompt #${i} ${"lorem ipsum dolor sit amet, ".repeat(4)}`,
        timestamp: ts,
      });
    } else if (phase === 1) {
      items.push({
        id: `a-${i}`,
        type: "assistant",
        text:
          `Assistant response #${i}\n` +
          `${"This is a multi-line detailed explanation. ".repeat(8)}\n` +
          `Code block:\n\`\`\`ts\nfunction foo() {\n  return ${i};\n}\n\`\`\``,
        timestamp: ts,
      });
    } else if (phase === 2) {
      items.push({
        id: `t-${i}`,
        type: "tool_group",
        tools: [
          {
            id: `tc-${i}`,
            name: "Read",
            status: ToolCallStatus.Success,
            startTime: ts,
            endTime: ts + 50,
            input: { file_path: `packages/repl/src/file-${i}.ts`, offset: 0, limit: 100 },
            output: `Read ${20 + (i % 30)} lines from packages/repl/src/file-${i}.ts`,
          },
        ],
        timestamp: ts,
      });
    } else {
      items.push({
        id: `th-${i}`,
        type: "thinking",
        text:
          `Thinking step #${i}: considering options.\n` +
          `Maybe approach A: do X first then Y.\n` +
          `Or approach B: parallelize X and Y.\n` +
          `Going with B because of streaming benefit.`,
        timestamp: ts,
      });
    }
  }
  return items;
}

// === Measurement ===

function percentile(arr: ReadonlyArray<number>, p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx] ?? 0;
}

interface ScenarioResult {
  scenario: string;
  items: number;
  iterations: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  max_ms: number;
}

interface BenchSetup {
  scenario: string;
  itemCount: number;
  setup: () => () => void;
  iterations?: number;
}

function runScenario(opts: BenchSetup): ScenarioResult {
  const iterations = opts.iterations ?? 100;
  const fn = opts.setup();
  // Warmup — discard first 10 to let V8 JIT stabilize.
  for (let i = 0; i < 10; i++) fn();
  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }
  return {
    scenario: opts.scenario,
    items: opts.itemCount,
    iterations,
    p50_ms: round(percentile(samples, 50)),
    p95_ms: round(percentile(samples, 95)),
    p99_ms: round(percentile(samples, 99)),
    mean_ms: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    max_ms: round(Math.max(...samples)),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// === Scenarios ===

const VIEWPORT_WIDTH = 120;
const TIERS = [50, 100, 200, 400, 800] as const;

const scenarios: ScenarioResult[] = [];

for (const n of TIERS) {
  const items = makeFixtureItems(n);

  // Scenario A: static render-model build (no streaming state).
  // Captures pure data-layer floor cost.
  scenarios.push(runScenario({
    scenario: "static-render-model",
    itemCount: n,
    setup: () => {
      const opts: TranscriptRenderModelOptions = {
        items,
        viewportWidth: VIEWPORT_WIDTH,
        isLoading: false,
      };
      return () => {
        buildTranscriptRenderModel(opts);
      };
    },
  }));

  // Scenario B: streaming tick.
  // streamingResponse grows by 80 chars per call (≈ 80ms of streaming text),
  // exactly matching the StreamingContext FLUSH_INTERVAL = 80 behavior.
  // This is THE pathological case from the user's SSH lag report.
  scenarios.push(runScenario({
    scenario: "streaming-tick",
    itemCount: n,
    setup: () => {
      let streamingResponse = "";
      const baseOpts: Omit<TranscriptRenderModelOptions, "streamingResponse"> = {
        items,
        viewportWidth: VIEWPORT_WIDTH,
        isLoading: true,
        isThinking: false,
        thinkingCharCount: 0,
        thinkingContent: "",
        showLiveProgressRows: true,
      };
      return () => {
        streamingResponse += "x".repeat(80);
        buildTranscriptRenderModel({ ...baseOpts, streamingResponse });
      };
    },
  }));
}

// === Output ===

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sha = getGitSha();
const output = {
  schema_version: 1,
  feature: "FEATURE_172",
  git_sha: sha,
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  timestamp: new Date().toISOString(),
  viewport_width: VIEWPORT_WIDTH,
  scenarios,
};

const outDir = resolve(__dirname, "../perf-baselines");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `baseline-${sha}.json`);
writeFileSync(outFile, JSON.stringify(output, null, 2));

// Human-readable summary to stderr (script output stays clean for piping)
process.stderr.write(`\nFEATURE_172 perf baseline — git ${sha} · node ${process.version} · ${process.platform}/${process.arch}\n`);
process.stderr.write(`\n${"scenario".padEnd(24)} ${"items".padStart(6)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)} ${"mean".padStart(8)}\n`);
process.stderr.write(`${"-".repeat(80)}\n`);
for (const s of scenarios) {
  process.stderr.write(
    `${s.scenario.padEnd(24)} ${String(s.items).padStart(6)} ` +
    `${(s.p50_ms.toFixed(2) + "ms").padStart(8)} ` +
    `${(s.p95_ms.toFixed(2) + "ms").padStart(8)} ` +
    `${(s.p99_ms.toFixed(2) + "ms").padStart(8)} ` +
    `${(s.max_ms.toFixed(2) + "ms").padStart(8)} ` +
    `${(s.mean_ms.toFixed(2) + "ms").padStart(8)}\n`,
  );
}
process.stderr.write(`\n→ Wrote ${outFile}\n`);

// JSON to stdout for piping / consumption by other tooling.
process.stdout.write(JSON.stringify(output, null, 2));
