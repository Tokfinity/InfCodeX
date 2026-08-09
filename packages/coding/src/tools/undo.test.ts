import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { toolUndo } from './undo.js';
import { toolWrite } from './write.js';

const roots: string[] = [];

afterEach(() => {
  setAgentConfigHome(undefined);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function context(backups: Map<string, string>): KodaXToolExecutionContext {
  return { backups };
}

describe('toolUndo Agent Home hard boundary', () => {
  it('restores the most recently modified file after an A, B, A sequence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-order-'));
    roots.push(root);
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'a0');
    fs.writeFileSync(b, 'b0');
    const ctx = { ...context(new Map()), executionCwd: root };

    await toolWrite({ path: a, content: 'a1' }, ctx);
    await toolWrite({ path: b, content: 'b1' }, ctx);
    await toolWrite({ path: a, content: 'a2' }, ctx);
    await toolUndo({}, ctx);

    expect(fs.readFileSync(a, 'utf8')).toBe('a1');
    expect(fs.readFileSync(b, 'utf8')).toBe('b1');
  });

  it('restores an ordinary Session file from the current execution context', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-open-'));
    roots.push(home);
    setAgentConfigHome(home);
    const target = path.join(home, 'sessions', 'turn.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'current');
    const backups = new Map([[target, 'previous']]);

    await expect(toolUndo({}, context(backups))).resolves.toContain('Restored');
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(backups.has(target)).toBe(false);
  });

  it('restores an explicitly approved sensitive Agent Home file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-sensitive-'));
    roots.push(home);
    setAgentConfigHome(home);
    const target = path.join(home, 'config.json');
    fs.writeFileSync(target, 'current');
    const backups = new Map([[target, 'approved-previous']]);

    await expect(toolUndo({}, context(backups))).resolves.toContain('Restored');
    expect(fs.readFileSync(target, 'utf8')).toBe('approved-previous');
  });

  it('refuses a Runtime target even when a pathless backup selected it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-runtime-'));
    roots.push(home);
    setAgentConfigHome(home);
    const target = path.join(home, 'runtime', 'state.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'runtime-current');
    const backups = new Map([[target, 'attacker-content']]);

    await expect(toolUndo({}, context(backups))).rejects.toThrow('protected KodaX state');
    expect(fs.readFileSync(target, 'utf8')).toBe('runtime-current');
    expect(backups.has(target)).toBe(true);
  });

  it('canonicalizes a Session-path junction before restoring its target', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-junction-'));
    roots.push(home);
    setAgentConfigHome(home);
    const runtime = path.join(home, 'runtime');
    const link = path.join(home, 'sessions', 'runtime-link');
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(runtime, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(link, 'state.json');
    fs.writeFileSync(path.join(runtime, 'state.json'), 'runtime-current');

    await expect(toolUndo({}, context(new Map([[target, 'attacker-content']]))))
      .rejects.toThrow('protected KodaX state');
    expect(fs.readFileSync(path.join(runtime, 'state.json'), 'utf8')).toBe('runtime-current');
  });

  it('refuses restore after the backed-up path is retargeted outside its original identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-undo-identity-'));
    roots.push(root);
    const originalDir = path.join(root, 'workspace', 'target');
    const originalPath = path.join(originalDir, 'file.txt');
    const outside = path.join(root, 'outside');
    const outsidePath = path.join(outside, 'file.txt');
    fs.mkdirSync(originalDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(originalPath, 'current');
    fs.writeFileSync(outsidePath, 'outside-current');
    const backups = new Map([[fs.realpathSync.native(originalPath), 'previous']]);
    fs.rmSync(originalDir, { recursive: true });
    fs.symlinkSync(outside, originalDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(toolUndo({}, context(backups))).rejects.toThrow('identity changed');
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside-current');
    expect(backups.size).toBe(1);
  });
});
