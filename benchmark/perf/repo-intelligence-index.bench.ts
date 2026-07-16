#!/usr/bin/env tsx
/**
 * FEATURE_243 repo-intelligence full/light indexing bench.
 *
 * Measures cold and warm in-process repo-intelligence index construction for
 * the current workspace. This is a local perf gate, not an LLM eval.
 *
 * Usage:
 *   npm run bench:repo-intel
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { getRepoIntelligenceIndex } from '../../packages/coding/src/repo-intelligence/runtime.js';

interface MemorySample {
  readonly rssMb: number;
  readonly heapUsedMb: number;
}

interface BenchRun {
  readonly mode: 'full' | 'light';
  readonly phase: 'cold' | 'warm';
  readonly wallMs: number;
  readonly rssDeltaMb: number;
  readonly heapDeltaMb: number;
  readonly rssAfterMb: number;
  readonly heapAfterMb: number;
  readonly sourceFileCount: number;
  readonly moduleCount: number;
  readonly symbolCount: number;
  readonly processCount: number;
}

interface BenchReport {
  readonly bench: 'repo-intelligence-index';
  readonly repoRoot: string;
  readonly storageRoot: string;
  readonly node: string;
  readonly generatedAt: string;
  readonly runs: BenchRun[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readMemory(): MemorySample {
  const memory = process.memoryUsage();
  return {
    rssMb: memory.rss / 1024 / 1024,
    heapUsedMb: memory.heapUsed / 1024 / 1024,
  };
}

async function measureIndex(
  repoRoot: string,
  mode: 'full' | 'light',
  phase: 'cold' | 'warm',
): Promise<BenchRun> {
  const before = readMemory();
  const start = performance.now();
  const index = await getRepoIntelligenceIndex(
    { executionCwd: repoRoot, gitRoot: repoRoot },
    { mode, refresh: phase === 'cold' },
  );
  const end = performance.now();
  const after = readMemory();
  return {
    mode,
    phase,
    wallMs: round(end - start),
    rssDeltaMb: round(after.rssMb - before.rssMb),
    heapDeltaMb: round(after.heapUsedMb - before.heapUsedMb),
    rssAfterMb: round(after.rssMb),
    heapAfterMb: round(after.heapUsedMb),
    sourceFileCount: index.sourceFileCount,
    moduleCount: index.modules.length,
    symbolCount: index.symbols.length,
    processCount: index.processes.length,
  };
}

function writeOptionalOutput(report: BenchReport): void {
  const outputPath = process.env.KODAX_REPO_INTEL_BENCH_OUTPUT?.trim();
  if (!outputPath) return;
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const storageRoot = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-bench-'));
  const previousStorageRoot = process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
  process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = storageRoot;
  try {
    const runs: BenchRun[] = [];
    for (const mode of ['full', 'light'] as const) {
      runs.push(await measureIndex(repoRoot, mode, 'cold'));
      runs.push(await measureIndex(repoRoot, mode, 'warm'));
    }
    const report: BenchReport = {
      bench: 'repo-intelligence-index',
      repoRoot,
      storageRoot,
      node: process.version,
      generatedAt: new Date().toISOString(),
      runs,
    };
    writeOptionalOutput(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (previousStorageRoot === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = previousStorageRoot;
    }
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

await main();
