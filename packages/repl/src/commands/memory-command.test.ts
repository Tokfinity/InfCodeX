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

import {
  setAgentConfigHome,
  resolveLearningProposalStore,
  resolveMemoryRoot,
  resolveMemoryEntrypoint,
  readLearningProposalStore,
  upsertLearningProposal,
  type MemoryLearningHandoff,
  type MemoryReviewModelInput,
} from '@kodax-ai/agent';
import type { KodaXOptions } from '@kodax-ai/coding';

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

type MemoryCommandCallbacks = Parameters<typeof memoryCommand.handler>[2];

async function invoke(
  args: string[],
  cwd: string,
  callbacks: Partial<MemoryCommandCallbacks> = {},
) {
  // The command type signature requires 4 args but the handler only
  // reads `args` and `context.runtimeInfo`. Pass empty objects for the
  // unused callbacks + currentConfig — cast through `never` mirrors
  // copy-command.test.ts.
  await memoryCommand.handler(
    args,
    buildContext(cwd) as never,
    callbacks as MemoryCommandCallbacks,
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
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('pending/show/approve use the memory control plane over the F224 store', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-memory-command'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
      await invoke(['show', 'memory:p-memory-command'], cwd);
      await invoke(['approve', 'memory:p-memory-command'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('pending memory proposals')).toBe(true);
    expect(log.contains('memory:p-memory-command')).toBe(true);
    expect(log.contains('approved and applied memory:p-memory-command')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('approved');
    expect(fs.readFileSync(resolveMemoryEntrypoint(cwd), 'utf8')).toContain('Memory command stores project facts.');
  });

  it('requires a shown preview before approving a memory proposal', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-direct-approve'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['approve', 'memory:p-direct-approve'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('preview required before approve')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('expires shown preview fingerprints before approving a memory proposal', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-expired-preview'));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', 'memory:p-expired-preview'], cwd);
      nowSpy.mockReturnValue(1_000 + 16 * 60 * 1000);
      await invoke(['approve', 'memory:p-expired-preview'], cwd);
    } finally {
      restore();
      nowSpy.mockRestore();
    }

    expect(log.contains('preview required before approve')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('fails closed when MEMORY.md changes after the shown preview', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-stale-preview'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', 'memory:p-stale-preview'], cwd);
      const memoryDir = resolveMemoryRoot(cwd);
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(
        resolveMemoryEntrypoint(cwd),
        '- [Changed](changed.md) - changed after preview\n',
        'utf8',
      );
      await invoke(['approve', 'memory:p-stale-preview'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('was not applied')).toBe(true);
    expect(log.contains('MEMORY.md changed after preview')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('passes rejection feedback to the injected memory reviewer', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-review-reject'));
    let received: MemoryReviewModelInput | undefined;
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        memoryReviewer: async (input) => {
          received = input;
          return {
            trigger: input.trigger,
            createdAt: '2026-07-06T00:00:00.000Z',
            sourceRefs: input.sourceRefs,
            candidateRefs: input.candidateRefs,
            actions: [],
            warnings: input.warnings,
          };
        },
      } as KodaXOptions),
    };

    const { log, restore } = captureConsole();
    try {
      await invoke(['reject', 'memory:p-review-reject', 'wrong', 'memory'], cwd, callbacks);
    } finally {
      restore();
    }

    expect(log.contains('rejected memory:p-review-reject')).toBe(true);
    expect(log.contains('review actions: 0')).toBe(true);
    expect(received?.trigger).toBe('proposal_rejected');
    expect(received?.userFeedback).toBe('wrong memory');
  });

  it('manual acceptance path covers pending, show, reject, approve, and curate', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-apply'));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-reject'));
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    const duplicateBody = '---\nname: Duplicate note\ndescription: Same content\ntype: project\n---\n\nSame body.\n';
    fs.writeFileSync(path.join(memoryDir, 'duplicate_a.md'), duplicateBody, 'utf8');
    fs.writeFileSync(path.join(memoryDir, 'duplicate_b.md'), duplicateBody, 'utf8');

    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
      await invoke(['show', 'memory:p-accept-apply'], cwd);
      await invoke(['reject', 'memory:p-accept-reject', 'not', 'useful'], cwd);
      await invoke(['approve', 'memory:p-accept-apply'], cwd);
      await invoke(['curate'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('pending memory proposals')).toBe(true);
    expect(log.contains('memory:p-accept-apply')).toBe(true);
    expect(log.contains('rejected memory:p-accept-reject')).toBe(true);
    expect(log.contains('approved and applied memory:p-accept-apply')).toBe(true);
    expect(log.contains('governance report')).toBe(true);
    expect(log.contains('duplicate')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    const statuses = new Map(store.proposals.map((proposal) => [proposal.proposalId, proposal.status]));
    expect(statuses.get('p-accept-apply')).toBe('approved');
    expect(statuses.get('p-accept-reject')).toBe('rejected');
  });
});

function memoryProposal(proposalId: string): MemoryLearningHandoff {
  return {
    destination: 'memdir_handoff',
    proposalId,
    origin: 'background_learning',
    userLabel: 'context_note',
    memoryKind: 'project',
    body: 'Memory command stores project facts.',
    metadata: {
      writeOrigin: 'background_learning',
      executionContext: 'primary',
      sessionId: 'session-memory-command',
      sourceRefs: ['turn:memory-command'],
      completedTurn: true,
    },
  };
}
