import { describe, expect, it } from 'vitest';

import { buildToolExecutionContext, resolveResumeFromRunDir } from './tool-execution-context.js';

/**
 * Path-traversal guard for the model-supplied `resumeFromRunId` (FEATURE_246
 * Part D). resolveResumeFromRunDir is the only sanitization before the id is
 * joined onto runsBaseDir, so a regression here would silently reopen a
 * path-escape. These cases pin the charset + the '..' defense.
 */
describe('resolveResumeFromRunDir (path-traversal guard)', () => {
  const BASE = '/runs';

  it('resolves a well-formed run id under the base dir', () => {
    // Normalize slashes so the assertion holds on win32 + posix.
    expect(resolveResumeFromRunDir(BASE, 'run-abc123')?.replace(/\\/g, '/')).toBe('/runs/run-abc123');
    expect(resolveResumeFromRunDir(BASE, 'wf_09f5c105-c08')?.replace(/\\/g, '/')).toBe(
      '/runs/wf_09f5c105-c08',
    );
  });

  it('returns undefined for an absent id (no resume requested)', () => {
    expect(resolveResumeFromRunDir(BASE, undefined)).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '')).toBeUndefined();
  });

  it('rejects a bare ".." that would escape the base dir', () => {
    // Passes the charset (dot is allowed) but must be caught by the includes('..') guard.
    expect(resolveResumeFromRunDir(BASE, '..')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, 'a..b')).toBeUndefined();
  });

  it('rejects ids with slashes, leading separators, or path escapes', () => {
    expect(resolveResumeFromRunDir(BASE, '../etc')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '../../etc/passwd')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, 'a/b')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '/abs')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '.hidden')).toBeUndefined(); // must start alnum
  });
});

describe('F270 actor principal wiring', () => {
  it('creates one root-bound collaboration principal for a standalone AMA run', () => {
    const ctx = buildToolExecutionContext({
      options: { provider: 'mock', agentMode: 'ama' },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.actorControl?.callerPath).toBe('/root');
    expect(ctx.actorControl?.list()).toMatchObject({
      maxConcurrentThreads: 4,
      activeNonRootTurns: 0,
    });
  });

  it('preserves a Runtime-injected actor principal instead of creating a second tree', () => {
    const injected = { callerPath: '/root/injected' } as NonNullable<
      import('../types.js').KodaXContextOptions['actorControl']
    >;
    const ctx = buildToolExecutionContext({
      options: { provider: 'mock', agentMode: 'ama', context: { actorControl: injected } },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.actorControl).toBe(injected);
  });
});
