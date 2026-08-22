import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { containWindowsEffectProcess } from './windows-effect-job.js';

const DETACHED_CHILD_GATE = String.raw`
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', () => {
  input.close();
  const script = "setTimeout(()=>require('node:fs').writeFileSync(process.env.KODAX_JOB_SENTINEL,'escaped'),1000)";
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env: process.env }).unref();
  process.exit(0);
});
`;

describe.runIf(process.platform === 'win32')('Windows effect Job', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an asynchronous supervisor spawn failure without an unhandled error', async () => {
    vi.stubEnv('SystemRoot', path.join(os.tmpdir(), 'missing-windows-root'));

    await expect(containWindowsEffectProcess(process.pid))
      .rejects.toThrow('supervisor failed to start');
  });

  it('does not publish executable or readiness control files in shared temp', async () => {
    const observedControlFiles: string[] = [];
    const watcher = watch(os.tmpdir(), (_event, fileName) => {
      if (typeof fileName !== 'string') return;
      if (/^kodax-effect-job-.*\.(?:ps1|ready)$/i.test(fileName)) {
        observedControlFiles.push(fileName);
      }
    });
    const gate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      gate.kill();
      await effectJob.drained;
      expect(observedControlFiles).toEqual([]);
    } finally {
      watcher.close();
      gate.kill();
    }
  });

  it('keeps a delayed supervisor failure observable without an unhandled rejection', async () => {
    const gate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      process.kill(effectJob.supervisorPid);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await expect(effectJob.drained).rejects.toThrow('supervisor exited');
    } finally {
      gate.kill();
    }
  });

  it('detaches supervisor handles idempotently without weakening drain proof', async () => {
    const gate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      expect(() => {
        effectJob.unref?.();
        effectJob.unref?.();
      }).not.toThrow();
      gate.kill();
      await effectJob.drained;
    } finally {
      gate.kill();
    }
  });

  it('does not report drained until a detached descendant has been terminated', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-effect-job-'));
    const sentinel = path.join(directory, 'escaped.txt');
    const gate = spawn(process.execPath, ['-e', DETACHED_CHILD_GATE], {
      env: { ...process.env, KODAX_JOB_SENTINEL: sentinel },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      gate.stdin.end('go\n');
      await effectJob.drained;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      gate.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
