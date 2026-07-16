import { describe, expect, it } from 'vitest';

import { spawnLspProcess } from './spawn.js';

describe('spawnLspProcess', () => {
  it('does not expose a stale Electron bootstrap switch to a JavaScript server', async () => {
    const child = spawnLspProcess(process.execPath, [
      '--eval',
      'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "absent")',
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));

    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString('utf8')).toBe('absent');
  });
});
