#!/usr/bin/env tsx
/**
 * Issue 247: tiny terminal Session cold-observation wall-clock benchmark.
 *
 * Fixtures are written as pre-existing JSONL before a fresh Runtime is
 * constructed. This deliberately avoids warming the process-level Session
 * locator, admission cache, or transcript materialization through SDK writes.
 * Direct, list-indexed, and list-indexed-after-an-unrelated-legacy-write paths
 * are reported independently. Module startup and setup are outside the timer.
 *
 * macOS comparison run:
 *   npm run bench:session-cold-open -- --projects=10,10000 --samples=5
 * Smoke run:
 *   npm run bench:session-cold-open -- --projects=10 --samples=1
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  createSessionLineage,
  withKodaXFileLock,
} from '../../packages/agent/src/index.js';
import { deriveProjectKeyFromRoot } from '../../packages/repl/src/interactive/project-key.js';
import { createKodaXRuntime } from '../../src/sdk-runtime.js';

const SNAPSHOT_DIR_PREFIX = 'kodax-transcript-snapshots-';
const DEFAULT_SAMPLES = 10;
const DEFAULT_PROJECT_COUNTS = [10] as const;
const WARMUP_SAMPLES_PER_SCENARIO = 1;
const PROJECT_SETUP_BATCH = 250;

type ColdOpenScenario =
  | 'cold-direct'
  | 'list-indexed'
  | 'list-indexed-after-unrelated-write';

interface SeededTinySession {
  readonly unrelatedPath: string;
  readonly unrelatedPayload: string;
  readonly unrelatedLockPath: string;
}

interface ColdOpenSample {
  readonly scenario: ColdOpenScenario;
  readonly projectCount: number;
  readonly sample: number;
  readonly indexWallMs?: number;
  readonly wallMs: number;
  readonly transcriptEntries: number;
  readonly snapshotFilesAtObservation: number;
  readonly snapshotBytesAtObservation: number;
  readonly snapshotFilesAfterClose: number;
}

interface ColdOpenSummary {
  readonly scenario: ColdOpenScenario;
  readonly projectCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanIndexMs?: number;
  readonly materializedEverySample: boolean;
  readonly cleanupLeakSamples: number;
}

interface ColdOpenReport {
  readonly benchmark: 'runtime-tiny-session-cold-open';
  readonly primaryPlatform: 'darwin';
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly node: string;
  readonly osRelease: string;
  readonly cpu: string;
  readonly generatedAt: string;
  readonly fixture: 'preexisting-jsonl-before-fresh-runtime';
  readonly warmupsPerScenario: number;
  readonly samples: readonly ColdOpenSample[];
  readonly summaries: readonly ColdOpenSummary[];
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function sampleCount(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--samples='))
    ?.slice('--samples='.length);
  if (raw === undefined) return DEFAULT_SAMPLES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new Error('--samples must be an integer between 1 and 100');
  }
  return parsed;
}

function projectCounts(): readonly number[] {
  const raw = process.argv.find((argument) => argument.startsWith('--projects='))
    ?.slice('--projects='.length);
  if (raw === undefined) return DEFAULT_PROJECT_COUNTS;
  const parsed = raw.split(',').map((value) => Number(value));
  if (
    parsed.length === 0
    || parsed.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 10_000)
  ) {
    throw new Error('--projects must be a comma-separated list of integers from 1 to 10000');
  }
  return [...new Set(parsed)];
}

async function snapshotFiles(root: string): Promise<Array<{ path: string; bytes: number }>> {
  const files: Array<{ path: string; bytes: number }> = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_DIR_PREFIX)) continue;
    const snapshotDir = path.join(root, entry.name);
    for (const file of await fs.readdir(snapshotDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.entries')) continue;
      const filePath = path.join(snapshotDir, file.name);
      files.push({ path: filePath, bytes: (await fs.stat(filePath)).size });
    }
  }
  return files;
}

async function createProjectDirectories(
  sessionsDir: string,
  targetProjectDir: string,
  projectCount: number,
): Promise<void> {
  const decoyCount = projectCount - 1;
  for (let offset = 0; offset < decoyCount; offset += PROJECT_SETUP_BATCH) {
    const end = Math.min(decoyCount, offset + PROJECT_SETUP_BATCH);
    await Promise.all(Array.from({ length: end - offset }, (_unused, index) =>
      fs.mkdir(path.join(sessionsDir, `decoy-${offset + index}`), { recursive: true })));
  }
  await fs.mkdir(targetProjectDir, { recursive: true });
}

function tinySessionPayload(sessionId: string, gitRoot: string): string {
  const lineage = createSessionLineage([
    { role: 'user', content: 'tiny query' },
    { role: 'assistant', content: 'tiny answer' },
  ]);
  const lines = [
    JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Tiny cold-open benchmark',
      gitRoot,
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: lineage.activeEntryId,
      lineageEntryCount: lineage.entries.length,
      activeMessageCount: 2,
    }),
    ...lineage.entries.map((entry) => JSON.stringify({ _type: 'lineage_entry', entry })),
  ];
  return `${lines.join('\n')}\n`;
}

async function seedPreexistingTinySession(
  homeDir: string,
  sessionsDir: string,
  sessionId: string,
  projectCount: number,
): Promise<SeededTinySession> {
  const gitRoot = path.join(homeDir, 'target-workspace');
  const identity = deriveProjectKeyFromRoot(gitRoot);
  const projectDir = path.join(sessionsDir, identity.key);
  await createProjectDirectories(sessionsDir, projectDir, projectCount);
  const unrelatedId = `${sessionId}-unrelated`;
  const unrelatedPath = path.join(projectDir, `${unrelatedId}.jsonl`);
  const unrelatedPayload = tinySessionPayload(unrelatedId, gitRoot);
  const unrelatedLockKey = createHash('sha256').update(unrelatedId, 'utf8').digest('hex');
  const unrelatedLockPath = path.join(
    sessionsDir,
    '.write-locks',
    `${unrelatedLockKey}.lock`,
  );
  await fs.mkdir(`${unrelatedLockPath}.queue`, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    tinySessionPayload(sessionId, gitRoot),
    'utf8',
  );
  await fs.writeFile(unrelatedPath, unrelatedPayload, 'utf8');
  return { unrelatedPath, unrelatedPayload, unrelatedLockPath };
}

async function measureColdOpen(
  benchmarkRoot: string,
  scenario: ColdOpenScenario,
  projectCount: number,
  sample: number,
): Promise<ColdOpenSample> {
  const homeDir = path.join(
    benchmarkRoot,
    `${scenario}-${projectCount}-projects-sample-${sample}`,
  );
  const sessionsDir = path.join(homeDir, 'sessions');
  const sessionId = `tiny-cold-open-${scenario}-${projectCount}-${sample}`;
  const seeded = await seedPreexistingTinySession(
    homeDir,
    sessionsDir,
    sessionId,
    projectCount,
  );
  const runtime = await createKodaXRuntime({ homeDir, sessionsDir });
  let observation: Awaited<ReturnType<typeof runtime.sessions.observe>> | undefined;
  try {
    let indexWallMs: number | undefined;
    if (scenario !== 'cold-direct') {
      const indexStart = performance.now();
      await runtime.sessions.list({ limit: 1 });
      indexWallMs = round(performance.now() - indexStart);
    }
    if (scenario === 'list-indexed-after-unrelated-write') {
      await withKodaXFileLock(seeded.unrelatedLockPath, () => fs.writeFile(
        seeded.unrelatedPath,
        seeded.unrelatedPayload,
        'utf8',
      ));
    }

    const start = performance.now();
    observation = await runtime.sessions.observe(sessionId, () => undefined);
    const wallMs = performance.now() - start;
    const materialized = await snapshotFiles(benchmarkRoot);
    const result: ColdOpenSample = {
      scenario,
      projectCount,
      sample,
      ...(indexWallMs === undefined ? {} : { indexWallMs }),
      wallMs: round(wallMs),
      transcriptEntries: observation.snapshot.transcript.entries.length,
      snapshotFilesAtObservation: materialized.length,
      snapshotBytesAtObservation: materialized.reduce(
        (total, file) => total + file.bytes,
        0,
      ),
      snapshotFilesAfterClose: 0,
    };
    observation.close();
    observation = undefined;
    await runtime.close();
    const afterClose = await snapshotFiles(benchmarkRoot);
    return { ...result, snapshotFilesAfterClose: afterClose.length };
  } finally {
    observation?.close();
    await runtime.close().catch(() => undefined);
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function summarize(samples: readonly ColdOpenSample[]): readonly ColdOpenSummary[] {
  const groups = new Map<string, ColdOpenSample[]>();
  for (const sample of samples) {
    const key = `${sample.scenario}:${sample.projectCount}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const walls = group.map((sample) => sample.wallMs);
    const indexWalls = group.flatMap((sample) =>
      sample.indexWallMs === undefined ? [] : [sample.indexWallMs]);
    return {
      scenario: group[0]!.scenario,
      projectCount: group[0]!.projectCount,
      p50Ms: round(percentile(walls, 50)),
      p95Ms: round(percentile(walls, 95)),
      meanMs: round(walls.reduce((sum, value) => sum + value, 0) / walls.length),
      minMs: round(Math.min(...walls)),
      maxMs: round(Math.max(...walls)),
      ...(indexWalls.length === 0
        ? {}
        : { meanIndexMs: round(indexWalls.reduce((sum, value) => sum + value, 0) / indexWalls.length) }),
      materializedEverySample: group.every((sample) => sample.snapshotFilesAtObservation > 0),
      cleanupLeakSamples: group.filter((sample) => sample.snapshotFilesAfterClose > 0).length,
    };
  });
}

async function writeOptionalOutput(report: ColdOpenReport): Promise<void> {
  const output = process.env.KODAX_TINY_SESSION_BENCH_OUTPUT?.trim();
  if (!output) return;
  const resolved = path.resolve(output);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const originalTemp = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const benchmarkRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kodax-tiny-session-cold-open-'),
  );
  process.env.TMPDIR = benchmarkRoot;
  process.env.TMP = benchmarkRoot;
  process.env.TEMP = benchmarkRoot;
  try {
    const scenarios: readonly ColdOpenScenario[] = [
      'cold-direct',
      'list-indexed',
      'list-indexed-after-unrelated-write',
    ];
    const counts = projectCounts();
    for (const scenario of scenarios) {
      for (let warmup = 0; warmup < WARMUP_SAMPLES_PER_SCENARIO; warmup += 1) {
        await measureColdOpen(benchmarkRoot, scenario, counts[0]!, -(warmup + 1));
      }
    }
    const samples: ColdOpenSample[] = [];
    for (const projectCount of counts) {
      for (const scenario of scenarios) {
        for (let sample = 1; sample <= sampleCount(); sample += 1) {
          samples.push(await measureColdOpen(
            benchmarkRoot,
            scenario,
            projectCount,
            sample,
          ));
        }
      }
    }
    const report: ColdOpenReport = {
      benchmark: 'runtime-tiny-session-cold-open',
      primaryPlatform: 'darwin',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      generatedAt: new Date().toISOString(),
      fixture: 'preexisting-jsonl-before-fresh-runtime',
      warmupsPerScenario: WARMUP_SAMPLES_PER_SCENARIO,
      samples,
      summaries: summarize(samples),
    };
    await writeOptionalOutput(report);
    if (process.platform !== 'darwin') {
      process.stderr.write(
        'Note: macOS is the primary comparison platform; this run is a smoke measurement.\n',
      );
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    for (const [key, value] of Object.entries(originalTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(benchmarkRoot, { recursive: true, force: true });
  }
}

await main();
