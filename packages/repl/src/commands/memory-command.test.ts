/**
 * FEATURE_124 (v0.7.43) Phase D — `/memory` slash command tests.
 *
 * Covers the three sub-commands (list / rebuild / open) plus the
 * unknown-subcommand fallthrough. Uses a per-test `tempHome` +
 * `setAgentConfigHome` override so the assertions never touch the real
 * `~/.kodax/projects/.../memory/` tree.
 *
 * What's covered:
 *   1. `list` with no MEMORY.md emits a setup hint
 *   2. `list` with MEMORY.md prints the index content + topic-file count
 *   3. `rebuild` writes a deterministic MEMORY.md (newest mtime first)
 *      and reports malformed frontmatter as a fallback line
 *   4. `rebuild` is a no-op when the directory is empty
 *   5. `open` prints both paths without writing anything
 *   6. unknown subcommand prints help + does NOT throw
 *
 * What's NOT covered (out of scope for this layer):
 *   - claudecode-shape SP injection (Phase B integration test)
 *   - LLM-side adherence to the prompt taxonomy (Phase E smoke eval)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAgentConfigHome, resolveMemoryRoot, resolveMemoryEntrypoint } from '@kodax-ai/agent';

import { memoryCommand } from './memory-command.js';

interface CapturedLog {
  lines: string[];
  contains: (needle: string) => boolean;
}

function captureConsole(): { log: CapturedLog; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return {
    log: {
      lines,
      contains: (needle: string) => lines.some((l) => l.includes(needle)),
    },
    restore: () => spy.mockRestore(),
  };
}

function buildContext(cwd: string) {
  return {
    messages: [],
    runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
  };
}

async function invoke(args: string[], cwd: string) {
  // The command type signature requires 4 args but the handler only
  // reads `args` and `context.runtimeInfo`. Pass empty objects for the
  // unused callbacks + currentConfig — cast through `never` mirrors
  // copy-command.test.ts.
  await memoryCommand.handler(
    args,
    buildContext(cwd) as never,
    {} as never,
    {} as never,
  );
}

describe('FEATURE_124 Phase D — /memory command', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cmd-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cmd-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('list with no MEMORY.md prints a setup hint', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('per-project memory directory')).toBe(true);
    expect(log.contains('MEMORY.md does not exist yet')).toBe(true);
  });

  it('list with MEMORY.md prints index content + topic file count', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'MEMORY.md'),
      '- [User role](user_role.md) — Senior backend engineer\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(memoryDir, 'user_role.md'),
      '---\nname: user_role\ndescription: Senior backend engineer\ntype: user\n---\n\nBody.',
      'utf-8',
    );

    const { log, restore } = captureConsole();
    try {
      await invoke([], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Senior backend engineer')).toBe(true);
    expect(log.contains('1 topic file')).toBe(true);
  });

  it('rebuild writes MEMORY.md sorted by mtime descending', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });

    const olderPath = path.join(memoryDir, 'feedback_old.md');
    const newerPath = path.join(memoryDir, 'user_new.md');
    fs.writeFileSync(
      olderPath,
      '---\nname: Old feedback\ndescription: Older entry\ntype: feedback\n---\nBody.',
      'utf-8',
    );
    fs.writeFileSync(
      newerPath,
      '---\nname: New user note\ndescription: Newer entry\ntype: user\n---\nBody.',
      'utf-8',
    );
    // Force a deterministic mtime ordering (newer entry must rank
    // higher than older). Use stable absolute timestamps so the test
    // does not race the filesystem's mtime resolution.
    const baseTime = new Date('2026-05-01T00:00:00Z');
    fs.utimesSync(olderPath, baseTime, new Date('2026-05-01T00:00:00Z'));
    fs.utimesSync(newerPath, baseTime, new Date('2026-05-02T00:00:00Z'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    const entrypointPath = resolveMemoryEntrypoint(cwd);
    const raw = fs.readFileSync(entrypointPath, 'utf-8');
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('- [New user note](user_new.md) — Newer entry');
    expect(lines[1]).toBe('- [Old feedback](feedback_old.md) — Older entry');
    expect(log.contains('rebuilt MEMORY.md with 2 entries')).toBe(true);
  });

  it('rebuild reports malformed frontmatter as fallback line + warning', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'no_frontmatter.md'), 'just body, no frontmatter', 'utf-8');

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    const raw = fs.readFileSync(resolveMemoryEntrypoint(cwd), 'utf-8');
    expect(raw).toContain('- [no_frontmatter](no_frontmatter.md) — no_frontmatter');
    expect(log.contains('no parsable frontmatter')).toBe(true);
  });

  it('rebuild is a no-op when the directory is empty', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('no topic files found')).toBe(true);
    // MEMORY.md must NOT be created when there's nothing to index.
    expect(fs.existsSync(resolveMemoryEntrypoint(cwd))).toBe(false);
  });

  it('open prints both paths without writing anything', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['open'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('open these paths in your editor')).toBe(true);
    expect(log.contains(resolveMemoryEntrypoint(cwd))).toBe(true);
    expect(log.contains(resolveMemoryRoot(cwd))).toBe(true);
    // No file was created as a side effect.
    expect(fs.existsSync(resolveMemoryEntrypoint(cwd))).toBe(false);
  });

  it('unknown subcommand prints help and does not throw', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['frobnicate'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('unknown subcommand: frobnicate')).toBe(true);
    expect(log.contains('Inspect or rebuild per-project memory')).toBe(true);
  });

  it('help subcommand prints usage', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['help'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('/memory rebuild')).toBe(true);
    expect(log.contains('/memory open')).toBe(true);
  });
});
