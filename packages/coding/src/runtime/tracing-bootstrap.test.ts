/**
 * FEATURE_209 (v0.7.45): tracing activation tests.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _getRegisteredProcessors,
  defaultTracer,
  setTracingProcessors,
  shutdownTracing,
} from '@kodax-ai/agent';

import {
  _resetTracingBootstrap,
  bootstrapTracing,
  TRACING_ENV,
} from './tracing-bootstrap.js';

async function makeTempTraceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kodax-trace-test-'));
}

describe('bootstrapTracing', () => {
  beforeEach(() => {
    _resetTracingBootstrap();
    setTracingProcessors([]);
    vi.stubEnv(TRACING_ENV, '');
    // stubEnv('', '') leaves the var defined-as-empty; delete to get the
    // true "unset" baseline the tests assume.
    delete process.env[TRACING_ENV];
  });

  afterEach(() => {
    _resetTracingBootstrap();
    setTracingProcessors([]);
    vi.unstubAllEnvs();
  });

  it('registers exactly one processor and returns a dispose function', async () => {
    const traceDir = await makeTempTraceDir();
    expect(_getRegisteredProcessors()).toHaveLength(0);

    const dispose = bootstrapTracing({ traceDir });

    expect(typeof dispose).toBe('function');
    expect(_getRegisteredProcessors()).toHaveLength(1);

    dispose?.();
    expect(_getRegisteredProcessors()).toHaveLength(0);
  });

  it('is a no-op when KODAX_TRACING=0', () => {
    vi.stubEnv(TRACING_ENV, '0');

    const dispose = bootstrapTracing();

    expect(dispose).toBeUndefined();
    expect(_getRegisteredProcessors()).toHaveLength(0);
  });

  it('is idempotent — a second call does not register a second processor', async () => {
    const traceDir = await makeTempTraceDir();

    const first = bootstrapTracing({ traceDir });
    const second = bootstrapTracing({ traceDir });

    expect(_getRegisteredProcessors()).toHaveLength(1);
    expect(second).toBe(first);

    first?.();
    expect(_getRegisteredProcessors()).toHaveLength(0);
  });

  it('persists a completed trace to <traceDir>/<traceId>.jsonl', async () => {
    const traceDir = await makeTempTraceDir();
    const dispose = bootstrapTracing({ traceDir });

    const trace = defaultTracer.startTrace({
      name: 'test-run',
      rootSpanData: { kind: 'agent', agentName: 'worker' },
    });
    trace.end();
    await shutdownTracing();

    const files = await fs.readdir(traceDir);
    expect(files).toContain(`${trace.id}.jsonl`);

    const content = await fs.readFile(path.join(traceDir, `${trace.id}.jsonl`), 'utf8');
    expect(content).toContain('"event":"trace:end"');
    expect(content).toContain(trace.id);

    dispose?.();
  });
});
