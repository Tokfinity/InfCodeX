#!/usr/bin/env tsx
/**
 * FEATURE_172 ADR-028 — REPL end-to-end render-pipeline wall-time bench.
 *
 * Replaces the original `repl-render-perf.bench.ts` measurement scope.
 * The original bench only measured `buildTranscriptRenderModel` (the data
 * layer, ~3-5% of total per-frame cost). This bench measures the
 * **complete render pipeline** via KodaX's actual engine:
 *
 *   rerender(newTree)
 *     → React reconciliation (concurrent=false → sync commit)
 *     → reconciler.resetAfterCommit
 *       → rootNode.onComputeLayout  (Yoga calculateLayout — engine.js:344)
 *       → rootNode.onRender (throttled, leading: true → fires sync on idle window)
 *           → engine.onRender                    (engine.js:347)
 *               → render(rootNode, ...)          (internals/renderer.js:20)
 *                   → renderNodeToOutput         (render-node-to-output.js:71)
 *                   → outputToScreen             (output-to-screen.ts:174)
 *               → applyCellFrame(frame)          (apply-cell-frame.ts:51)
 *                   → cellLogUpdate.render       (cell-renderer.ts:100)
 *                       → diffEach + shouldFullReset
 *                   → applyDiff(stdout, diff)    (apply-diff.ts:92)
 *                       → stdout.write(buf)      ← THE END
 *
 * The mock stdout captures every write() call with timestamp + byte count
 * so we measure ALL of the above. The `onRender` callback fires right at
 * the end of `engine.onRender` (engine.js:379), so `rerender(...) → onRender
 * callback fires` is the full pipeline wall-time.
 *
 * Throttle: KodaX engine has `maxFps=30` default (33ms window). On the
 * leading edge of an idle window, throttled callback fires sync. We sleep
 * >40ms between bench iterations so each `rerender()` hits leading edge.
 *
 * Output: `benchmark/perf-baselines/baseline-e2e-<git-sha>.json` — anchors
 * ADR-028 Phase A-E gates.
 *
 * Usage:
 *   npx tsx benchmark/perf/repl-render-engine-e2e.bench.ts
 */
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "../../packages/repl/src/tui/core/root.js";
import { MessageList } from "../../packages/repl/src/ui/components/MessageList.js";
import {
  ToolCallStatus,
  type HistoryItem,
} from "../../packages/repl/src/ui/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Mock stdout / stderr / stdin (NodeJS.WriteStream compatible subset) ===

class MockStdout extends EventEmitter {
  public readonly writes: Array<{ ts: number; len: number }> = [];
  public readonly isTTY = true;
  public columns: number;
  public rows: number;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string | Uint8Array): boolean {
    const len =
      typeof data === "string"
        ? Buffer.byteLength(data, "utf8")
        : data.length;
    this.writes.push({ ts: performance.now(), len });
    return true;
  }

  // satisfy WriteStream surface that engine.js touches
  off(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  snapshot() {
    return {
      writeCount: this.writes.length,
      totalBytes: this.writes.reduce((a, b) => a + b.len, 0),
      lastTs: this.writes.length > 0 ? this.writes[this.writes.length - 1]!.ts : 0,
    };
  }
}

const mockStderr = {
  isTTY: false,
  write: () => true,
  on: () => undefined,
  off: () => undefined,
} as unknown as NodeJS.WriteStream;

const mockStdin = {
  isTTY: false,
  isRaw: false,
  on: () => undefined,
  off: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  setRawMode: () => undefined,
} as unknown as NodeJS.ReadStream;

// === Fixture (identical to repl-render-perf.bench.ts for direct compare) ===

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
            input: {
              file_path: `packages/repl/src/file-${i}.ts`,
              offset: 0,
              limit: 100,
            },
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

// === Async helpers ===

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function percentile(arr: ReadonlyArray<number>, p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx] ?? 0;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// === Scenario runner ===

interface FrameMetric {
  wallTime_ms: number;
  rendererTime_ms: number;
  writeCount: number;
  bytes: number;
}

interface ScenarioResult {
  scenario: string;
  items: number;
  ticks: number;
  // wall-time = rerender call → cell renderer write to stdout complete
  wallTime_p50_ms: number;
  wallTime_p95_ms: number;
  wallTime_p99_ms: number;
  wallTime_max_ms: number;
  wallTime_mean_ms: number;
  // rendererTime = engine's own internal startTime → end (engine.js:370-379),
  // excludes applyDiff and stdout.write
  rendererTime_p50_ms: number;
  rendererTime_p95_ms: number;
  // bytes / writes per tick
  bytes_p50: number;
  bytes_p95: number;
  bytes_mean: number;
  writes_p50: number;
  writes_p95: number;
}

async function runStreamingScenario(opts: {
  itemCount: number;
  ticks: number;
  windowed: boolean;
  viewportCols: number;
  viewportRows: number;
}): Promise<ScenarioResult> {
  const { itemCount, ticks, windowed, viewportCols, viewportRows } = opts;
  const items = makeFixtureItems(itemCount);
  const stdout = new MockStdout(viewportCols, viewportRows);

  let lastRendererTime = 0;
  let onRenderFiredAt = 0;
  let onRenderCount = 0;

  function buildTree(streamingResponse: string): React.ReactElement {
    return React.createElement(MessageList, {
      items,
      viewportWidth: viewportCols,
      viewportRows,
      maxLines: 1000,
      isLoading: true,
      streamingResponse,
      windowed,
    });
  }

  const instance = render(buildTree(""), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: mockStderr,
    stdin: mockStdin,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 30,
    onRender: (metrics: { renderTime: number }) => {
      lastRendererTime = metrics.renderTime;
      onRenderFiredAt = performance.now();
      onRenderCount++;
    },
  });

  // Settle initial render — wait for first onRender + 50ms idle
  await sleep(80);

  const metrics: FrameMetric[] = [];
  let streaming = "";

  for (let i = 0; i < ticks; i++) {
    // Sleep > 33ms (throttle window) so each rerender lands on leading edge
    await sleep(45);
    streaming += "x".repeat(80); // ~80 chars per 80ms flush, ADR-027 stream-tick model
    const beforeWrites = stdout.snapshot();
    const beforeCount = onRenderCount;
    const t0 = performance.now();

    instance.rerender(buildTree(streaming));

    // Wait for onRender callback to fire (leading edge — typically sync, but
    // give microtask + worst-case throttle window a chance)
    let waited = 0;
    while (onRenderCount === beforeCount && waited < 200) {
      await sleep(2);
      waited += 2;
    }
    const wallTime = (onRenderFiredAt || performance.now()) - t0;
    const afterWrites = stdout.snapshot();
    metrics.push({
      wallTime_ms: wallTime,
      rendererTime_ms: lastRendererTime,
      writeCount: afterWrites.writeCount - beforeWrites.writeCount,
      bytes: afterWrites.totalBytes - beforeWrites.totalBytes,
    });
  }

  instance.unmount();
  instance.cleanup();

  const wallTimes = metrics.map((m) => m.wallTime_ms);
  const rendererTimes = metrics.map((m) => m.rendererTime_ms);
  const allBytes = metrics.map((m) => m.bytes);
  const allWrites = metrics.map((m) => m.writeCount);

  return {
    scenario: windowed
      ? "streaming-tick-e2e-windowed"
      : "streaming-tick-e2e-mainscreen",
    items: itemCount,
    ticks,
    wallTime_p50_ms: round(percentile(wallTimes, 50)),
    wallTime_p95_ms: round(percentile(wallTimes, 95)),
    wallTime_p99_ms: round(percentile(wallTimes, 99)),
    wallTime_max_ms: round(Math.max(...wallTimes)),
    wallTime_mean_ms: round(wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length),
    rendererTime_p50_ms: round(percentile(rendererTimes, 50)),
    rendererTime_p95_ms: round(percentile(rendererTimes, 95)),
    bytes_p50: Math.round(percentile(allBytes, 50)),
    bytes_p95: Math.round(percentile(allBytes, 95)),
    bytes_mean: Math.round(allBytes.reduce((a, b) => a + b, 0) / allBytes.length),
    writes_p50: Math.round(percentile(allWrites, 50)),
    writes_p95: Math.round(percentile(allWrites, 95)),
  };
}

// === Main ===

async function main() {
  const TIERS = [50, 100, 200, 400, 800] as const;
  const TICKS_PER_TIER = 30; // 30 ticks × ~50ms = ~1.5s per tier; 5 tiers ≈ 8s

  // Viewport: env-configurable. Default 120×40; override via
  //   KODAX_BENCH_VIEWPORT=148x43 npm run bench:perf:e2e
  // The default approximates a typical local terminal; the override lets users
  // match a specific SSH client viewport (e.g. the 148×43 from the trace that
  // surfaced FEATURE_172's real root cause).
  const viewportEnv = process.env.KODAX_BENCH_VIEWPORT?.trim();
  let viewportCols = 120;
  let viewportRows = 40;
  if (viewportEnv) {
    const m = /^(\d+)[x×](\d+)$/i.exec(viewportEnv);
    if (m) {
      viewportCols = Number(m[1]);
      viewportRows = Number(m[2]);
    } else {
      process.stderr.write(
        `Warning: KODAX_BENCH_VIEWPORT='${viewportEnv}' invalid (expected WxH, e.g. 148x43); using default ${viewportCols}x${viewportRows}\n`,
      );
    }
  }

  process.stderr.write(
    `FEATURE_172 ADR-028 — end-to-end render pipeline bench\n` +
      `Node ${process.version} · ${process.platform}/${process.arch} · viewport ${viewportCols}×${viewportRows}\n` +
      `Each tick = rerender(streaming += 80 chars) → onRender callback fires\n` +
      `Wall-time covers: React reconcile + Yoga + renderNodeToOutput + outputToScreen + cellLogUpdate.render + applyDiff + stdout.write\n\n`,
  );

  const scenarios: ScenarioResult[] = [];
  // Two modes per tier:
  //   - mainscreen: `windowed: false` — KodaX main-screen path (Windows SSH +
  //     KODAX_FULLSCREEN=0). Uses <Static> to commit history to scrollback.
  //   - windowed: `windowed: true` — KodaX virtual fullscreen path (Linux SSH +
  //     native VT default). <Static> bypassed; visibleRows clipping kicks in.
  // The two paths have fundamentally different per-frame work. Both matter.
  for (const mode of ["mainscreen", "windowed"] as const) {
    const windowed = mode === "windowed";
    process.stderr.write(`\n[${mode}]\n`);
    for (const n of TIERS) {
      process.stderr.write(
        `  Running tier: ${n} items × ${TICKS_PER_TIER} ticks ... `,
      );
      const t0 = performance.now();
      const result = await runStreamingScenario({
        itemCount: n,
        ticks: TICKS_PER_TIER,
        windowed,
        viewportCols,
        viewportRows,
      });
      const elapsed = (performance.now() - t0) / 1000;
      process.stderr.write(`done in ${elapsed.toFixed(1)}s\n`);
      scenarios.push(result);
    }
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
    adr: "ADR-028",
    bench_type: "end-to-end",
    git_sha: sha,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    timestamp: new Date().toISOString(),
    viewport: { width: viewportCols, height: viewportRows },
    ticks_per_tier: TICKS_PER_TIER,
    scenarios,
  };

  const outDir = resolve(__dirname, "../perf-baselines");
  mkdirSync(outDir, { recursive: true });
  const vSuffix = `${viewportCols}x${viewportRows}`;
  const outFile = resolve(outDir, `baseline-e2e-${sha}-${vSuffix}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  // Human-readable summary
  process.stderr.write(
    `\n${"scenario".padEnd(28)} ${"items".padStart(6)}  ${"wallP50".padStart(10)} ${"wallP95".padStart(10)} ${"wallP99".padStart(10)} ${"rendP95".padStart(10)} ${"bytesP95".padStart(10)} ${"writes".padStart(8)}\n`,
  );
  process.stderr.write(`${"-".repeat(100)}\n`);
  for (const s of scenarios) {
    process.stderr.write(
      `${s.scenario.padEnd(28)} ` +
        `${String(s.items).padStart(6)}  ` +
        `${(s.wallTime_p50_ms.toFixed(2) + "ms").padStart(10)} ` +
        `${(s.wallTime_p95_ms.toFixed(2) + "ms").padStart(10)} ` +
        `${(s.wallTime_p99_ms.toFixed(2) + "ms").padStart(10)} ` +
        `${(s.rendererTime_p95_ms.toFixed(2) + "ms").padStart(10)} ` +
        `${(String(s.bytes_p95) + "B").padStart(10)} ` +
        `${String(s.writes_p50).padStart(8)}\n`,
    );
  }
  process.stderr.write(
    `\nLegend:\n` +
      `  wallTime = rerender() call → onRender callback fires (full pipeline)\n` +
      `  rendererTime = engine.onRender internal startTime → end (excludes applyDiff + stdout.write)\n` +
      `  bytesP95 = ANSI bytes written to stdout per tick (p95)\n` +
      `  writes = stdout.write() call count per tick (p50; nearly always 1 for cell-renderer path)\n\n` +
      `→ Wrote ${outFile}\n`,
  );

  process.stdout.write(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  process.stderr.write(`\nBench failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
