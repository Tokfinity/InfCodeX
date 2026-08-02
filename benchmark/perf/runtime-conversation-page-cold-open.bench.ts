#!/usr/bin/env tsx
/**
 * Cold finite-page benchmark for the canonical SDK conversation view.
 *
 * Session creation and prepared-cache construction are outside the timer. The
 * legacy scenario deletes only the derived cache so the canonical fallback is
 * measured against the exact same persisted Session.
 *
 * Smoke run:
 *   npx tsx benchmark/perf/runtime-conversation-page-cold-open.bench.ts --samples=3
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { KodaXSessionEntry, KodaXSessionLineage } from '../../packages/agent/src/index.js';
import { createSessionManager } from '../../packages/repl/src/session/public-api.js';
import { createKodaXRuntime } from '../../src/sdk-runtime.js';

const COUNTS = [2, 200, 2_000, 5_000] as const;
const PAGE_LIMIT = 20;

function sampleCount(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--samples='))
    ?.slice('--samples='.length);
  if (raw === undefined) return 5;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 50) {
    throw new Error('--samples must be an integer between 1 and 50');
  }
  return value;
}

function lineage(count: number): KodaXSessionLineage {
  const entries: KodaXSessionEntry[] = Array.from({ length: count }, (_, index) => ({
    type: 'message',
    id: `entry-${index}`,
    logicalId: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: '2026-08-01T00:00:00.000Z',
    message: {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}-${'x'.repeat(230)}`,
    },
  }));
  return { version: 2, activeEntryId: entries.at(-1)?.id ?? null, entries };
}

async function removePreparedCache(sessionFile: string): Promise<void> {
  const directory = path.dirname(sessionFile);
  const prefix = `${path.basename(sessionFile, '.jsonl')}.conversation-cache.`;
  await Promise.all((await fs.readdir(directory))
    .filter((name) => name.startsWith(prefix))
    .map((name) => fs.rm(path.join(directory, name), { force: true })));
}

async function sessionFile(sessionsDir: string, sessionId: string): Promise<string> {
  for (const entry of await fs.readdir(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionsDir, entry.name, `${sessionId}.jsonl`);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Session file not found: ${sessionId}`);
}

async function measure(
  homeDir: string,
  sessionsDir: string,
  sessionId: string,
): Promise<number> {
  const runtime = await createKodaXRuntime({
    homeDir,
    sessionsDir,
    sharedDaemonHost: true,
  });
  try {
    const startedAt = performance.now();
    const page = await runtime.sessions.conversationPage({ sessionId, limit: PAGE_LIMIT });
    const wallMs = performance.now() - startedAt;
    if (page?.entries.length !== Math.min(PAGE_LIMIT, Number(sessionId.split('-').at(-1)))) {
      throw new Error('Conversation page fixture returned an unexpected entry count');
    }
    return wallMs;
  } finally {
    await runtime.close();
  }
}

function summary(values: readonly number[]): Record<string, number> {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ] ?? 0;
  const round = (value: number): number => Math.round(value * 1_000) / 1_000;
  return {
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-conversation-page-bench-'));
const samples = sampleCount();
const results: Array<Record<string, unknown>> = [];
try {
  for (const count of COUNTS) {
    for (const scenario of ['prepared', 'legacy-fallback'] as const) {
      const homeDir = path.join(root, `${scenario}-${count}`);
      const sessionsDir = path.join(homeDir, 'sessions');
      const sessionId = `conversation-${scenario}-${count}`;
      const fixtureLineage = lineage(count);
      const manager = createSessionManager({ sessionsDir });
      await manager.storage.save(sessionId, {
        title: 'Conversation page benchmark',
        gitRoot: homeDir,
        scope: 'user',
        runtimeInfo: { surface: 'repl' },
        lineage: fixtureLineage,
        messages: fixtureLineage.entries.flatMap((entry) =>
          entry.type === 'message' ? [entry.message] : []),
      });
      const persistedSessionFile = await sessionFile(sessionsDir, sessionId);
      if (scenario === 'legacy-fallback') await removePreparedCache(persistedSessionFile);
      await measure(homeDir, sessionsDir, sessionId);
      const timings: number[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        if (scenario === 'legacy-fallback') await removePreparedCache(persistedSessionFile);
        timings.push(await measure(homeDir, sessionsDir, sessionId));
      }
      results.push({ scenario, entries: count, samples, ...summary(timings) });
    }
  }
  process.stdout.write(`${JSON.stringify({
    benchmark: 'runtime-conversation-page-cold-open',
    platform: process.platform,
    node: process.version,
    pageLimit: PAGE_LIMIT,
    admission: 'shared-daemon-host',
    results,
  }, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
