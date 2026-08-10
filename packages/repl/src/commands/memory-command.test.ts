/**
 * Natural-language-first `/memory` escape-hatch tests.
 *
 * Covers product-state listing, direct ordinary operations, exceptional
 * decisions, external opening, and hidden repair compatibility. Uses a per-test `tempHome` +
 * `setAgentConfigHome` override so the assertions never touch the real
 * `~/.kodax/projects/.../memory/` tree.
 *
 * `MEMORY.md` is tested only as a derived storage artifact; normal list and
 * natural-language paths use the Memory control plane as source of truth.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimEpisodeReview,
  failEpisodeReviewAttempt,
  persistPendingEpisodeReview,
  setAgentConfigHome,
  resolveLearningProposalStore,
  resolveMemoryRoot,
  resolveMemoryEntrypoint,
  readLearningProposalStore,
  upsertLearningProposal,
  type KodaXSessionLineage,
  type MemoryLearningHandoff,
  type MemoryReviewModelInput,
} from '@kodax-ai/agent';
import { deriveCodingMemoryIdentity, type KodaXOptions } from '@kodax-ai/coding';

import { externalOpenInvocation, memoryCommand } from './memory-command.js';

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
  // Bind the minimal interactive context and optional host callbacks used by
  // each command case; currentConfig is unused by this command.
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

  it('list with no accepted Memory reports the product state instead of a missing index file', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('No accepted memories yet')).toBe(true);
    expect(log.contains('MEMORY.md does not exist yet')).toBe(false);
    expect(log.contains('LLM will create')).toBe(false);
  });

  it('list reads accepted topic content without treating MEMORY.md as source of truth', async () => {
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

    expect(log.contains('user_role')).toBe(true);
    expect(log.contains('Body.')).toBe(true);
    expect(log.contains('1 accepted across 1 storage scope')).toBe(true);
  });

  it('remember stores an ordinary explicit Memory immediately and list shows its body', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke([
        'remember',
        '--kind',
        'procedure',
        '--key',
        'project.release.focused-tests',
        'Use',
        'focused',
        'tests',
        'before',
        'release.',
      ], cwd);
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory remembered')).toBe(true);
    expect(log.contains('Use focused tests before release.')).toBe(true);
    expect(log.contains('pending memory proposals')).toBe(false);
  });

  it('requires the stable displayed handle before forgetting accepted Memory', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke([
        'remember',
        '--kind',
        'preference',
        '--key',
        'user.release-notes.length',
        'Prefer',
        'short',
        'release',
        'notes.',
      ], cwd);
      await invoke(['list'], cwd);
      const handle = log.lines.join('\n').match(/ref: (memdir:[^\s]+\.md)/u)?.[1];
      expect(handle).toBeDefined();
      await invoke(['forget', handle!], cwd);
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory forgotten')).toBe(true);
    expect(log.contains('No accepted memories yet')).toBe(true);
  });

  it('requires an explicit semantic key for slash remember and preserves fact conflicts', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['remember', 'This', 'project', 'uses', 'npm.'], cwd);
      await invoke([
        'remember',
        '--kind',
        'fact',
        '--key',
        'project.package-manager',
        'This',
        'project',
        'uses',
        'npm.',
      ], cwd);
      await invoke([
        'remember',
        '--kind',
        'fact',
        '--key',
        'project.package-manager',
        'This',
        'project',
        'uses',
        'pnpm.',
      ], cwd);
      await invoke(['decisions'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('requires --key')).toBe(true);
    expect(log.contains('Memory remembered')).toBe(true);
    expect(log.contains('needs your decision')).toBe(true);
    expect(log.contains('This project uses pnpm.')).toBe(true);
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

  it('open launches the storage artifact in an external editor without rewriting it', async () => {
    await invoke([
      'remember',
      '--kind',
      'procedure',
      '--key',
      'project.testing.focused',
      'Use',
      'focused',
      'tests.',
    ], cwd);
    const before = fs.readFileSync(resolveMemoryEntrypoint(cwd), 'utf8');
    const openExternalPath = vi.fn().mockResolvedValue(undefined);
    const { log, restore } = captureConsole();
    try {
      await invoke(['open'], cwd, { openExternalPath });
    } finally {
      restore();
    }

    expect(log.contains('opened in your external editor/file browser')).toBe(true);
    expect(log.contains(resolveMemoryEntrypoint(cwd))).toBe(true);
    expect(openExternalPath).toHaveBeenCalledWith(resolveMemoryEntrypoint(cwd));
    expect(fs.readFileSync(resolveMemoryEntrypoint(cwd), 'utf8')).toBe(before);
  });

  it('open launches the current external Memory directory even before the first memory exists', async () => {
    const openExternalPath = vi.fn().mockResolvedValue(undefined);

    await invoke(['open'], cwd, { openExternalPath });

    expect(openExternalPath).toHaveBeenCalledWith(resolveMemoryRoot(cwd));
    expect(fs.statSync(resolveMemoryRoot(cwd)).isDirectory()).toBe(true);
  });

  it('builds a Windows external-open invocation without PowerShell argument ambiguity', () => {
    const target = 'C:\\Users\\ADMIN\\.kodax\\projects\\project with spaces\\memory\\MEMORY.md';
    const invocation = externalOpenInvocation('win32', target);

    expect(invocation.executable.toLowerCase()).toMatch(/\\explorer\.exe$/);
    expect(invocation.args).toEqual([target]);
  });

  it('unknown subcommand prints help and does not throw', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['frobnicate'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('unknown subcommand: frobnicate')).toBe(true);
    expect(log.contains('View and manage durable Memory')).toBe(true);
  });

  it('help subcommand prints usage', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['help'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('/memory remember')).toBe(true);
    expect(log.contains('/memory rebuild')).toBe(false);
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

    expect(log.contains('decisions that need you')).toBe(true);
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
    expect(log.contains('changed after preview')).toBe(true);
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
      await invoke(['show', 'memory:p-review-reject'], cwd, callbacks);
      await invoke(['reject', 'memory:p-review-reject', 'wrong', 'memory'], cwd, callbacks);
    } finally {
      restore();
    }

    expect(log.contains('rejected memory:p-review-reject')).toBe(true);
    expect(log.contains('review actions: 0')).toBe(true);
    expect(received?.trigger).toBe('proposal_rejected');
    expect(received?.userFeedback).toBe('wrong memory');
  });

  it('manual acceptance path covers pending, show, reject, and approve', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-apply'));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-reject'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
      await invoke(['show', 'memory:p-accept-apply'], cwd);
      await invoke(['show', 'memory:p-accept-reject'], cwd);
      await invoke(['reject', 'memory:p-accept-reject', 'not', 'useful'], cwd);
      await invoke(['approve', 'memory:p-accept-apply'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('decisions that need you')).toBe(true);
    expect(log.contains('memory:p-accept-apply')).toBe(true);
    expect(log.contains('rejected memory:p-accept-reject')).toBe(true);
    expect(log.contains('approved and applied memory:p-accept-apply')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    const statuses = new Map(store.proposals.map((proposal) => [proposal.proposalId, proposal.status]));
    expect(statuses.get('p-accept-apply')).toBe('approved');
    expect(statuses.get('p-accept-reject')).toBe('rejected');
  });

  it('keeps accepted Memory and decision number namespaces unambiguous', async () => {
    await invoke([
      'remember',
      '--kind',
      'preference',
      '--key',
      'user.release-notes.length',
      'Prefer',
      'compact',
      'release',
      'notes.',
    ], cwd);
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-number-space'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', '1'], cwd);
      await invoke(['show', 'memory:1'], cwd);
      await invoke(['show', 'decision:1'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory or decision not found: 1')).toBe(true);
    expect(log.contains('Prefer compact release notes.')).toBe(true);
    expect(log.contains('memory:p-number-space')).toBe(true);
  });
});

describe('FEATURE_289 §3.5 — /memory status', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-status-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-status-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function invokeStatus(
    contextOverrides: Record<string, unknown>,
    callbacks: Partial<MemoryCommandCallbacks>,
  ) {
    const context = {
      messages: [],
      runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
      sessionId: 'session-status-test',
      ...contextOverrides,
    };
    await memoryCommand.handler(
      ['status'],
      context as never,
      callbacks as MemoryCommandCallbacks,
      {} as never,
    );
  }

  const configuredCallbacks: Partial<MemoryCommandCallbacks> = {
    createKodaXOptions: () => ({
      provider: 'anthropic',
      memoryReviewer: async (input: MemoryReviewModelInput) => ({
        trigger: input.trigger,
        createdAt: '2026-08-01T00:00:00.000Z',
        sourceRefs: input.sourceRefs,
        candidateRefs: input.candidateRefs,
        actions: [],
        warnings: input.warnings,
      }),
    } as KodaXOptions),
  };

  it('renders zero values on an empty project without throwing', async () => {
    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('per-project memory directory')).toBe(true);
    expect(log.contains('this-session pipeline')).toBe(true);
    expect(log.contains('outcome digests : 0')).toBe(true);
    expect(log.contains('review receipts : 0')).toBe(true);
    expect(log.contains('client notices  : 0')).toBe(true);
    expect(log.contains('pending: 0')).toBe(true);
    expect(log.contains('configured (custom reviewer bound)')).toBe(true);
    // digests == 0 => capture segment diagnosis.
    expect(log.contains('capture segment')).toBe(true);
  });

  it('flags the review segment when digests exist but no review completed', async () => {
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries: [
        {
          id: 'digest-1',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'memory_outcome_digest',
          digest: {
            id: 'digest-1',
            reviewKey: 'review:digest-1',
            sessionId: 'session-status-test',
            branchId: 'main',
            sequence: 1,
            objective: 'objective',
            approach: 'approach',
            outcome: 'succeeded',
            summary: 'summary',
            evidenceRefs: [],
            visibility: 'prompt_safe',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        },
        {
          id: 'notice-1',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'client_notice',
          source: 'memory-agent',
          content: 'Memory updated: x',
        },
        {
          id: 'notice-2',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'client_notice',
          source: 'other-agent',
          content: 'not a memory notice',
        },
      ],
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({ lineage }, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('outcome digests : 1')).toBe(true);
    expect(log.contains('review receipts : 0')).toBe(true);
    // Only client_notice entries with source 'memory-agent' are counted.
    expect(log.contains('client notices  : 1')).toBe(true);
    expect(log.contains('review segment: digests captured but no review completed')).toBe(true);
    expect(log.contains('capture segment')).toBe(false);
  });

  it('diagnoses a previous-session backlog as a review problem', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const previousIdentity = deriveCodingMemoryIdentity(options, cwd, 'previous-session');
    await persistPendingEpisodeReview(previousIdentity, {
      id: 'digest-previous-session',
      reviewKey: 'review:previous-session',
      sessionId: previousIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'diagnose a cross-session backlog',
      approach: 'persist before opening a new session',
      outcome: 'succeeded',
      summary: 'waiting for review',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('pending: 1')).toBe(true);
    expect(log.contains('review segment: pending reviews from earlier sessions are waiting')).toBe(true);
    expect(log.contains('capture segment')).toBe(false);
  });

  it('does not claim that no review completed when a receipt exists beside a backlog', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const previousIdentity = deriveCodingMemoryIdentity(options, cwd, 'pending-sibling-session');
    await persistPendingEpisodeReview(previousIdentity, {
      id: 'digest-pending-sibling',
      reviewKey: 'review:pending-sibling',
      sessionId: previousIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'retain a separate pending review',
      approach: 'persist in a sibling session',
      outcome: 'succeeded',
      summary: 'still waiting',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries: [{
        id: 'digest-completed',
        parentId: null,
        timestamp: '2026-08-01T01:00:00.000Z',
        type: 'memory_outcome_digest',
        digest: {
          id: 'digest-completed',
          reviewKey: 'review:completed',
          sessionId: 'session-status-test',
          branchId: 'main',
          sequence: 1,
          objective: 'complete a review',
          approach: 'review it',
          outcome: 'succeeded',
          summary: 'completed',
          evidenceRefs: [],
          visibility: 'prompt_safe',
          createdAt: '2026-08-01T01:00:00.000Z',
        },
      }, {
        id: 'receipt-completed',
        parentId: null,
        timestamp: '2026-08-01T01:01:00.000Z',
        type: 'memory_review_receipt',
        reviewKey: 'review:completed',
        proposalIds: [],
        status: 'no_action',
        completedAt: '2026-08-01T01:01:00.000Z',
      }],
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({ lineage }, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('review receipts : 1')).toBe(true);
    expect(log.contains('review segment: pending reviews are still waiting')).toBe(true);
    expect(log.contains('no review ever completed')).toBe(false);
  });

  it('reports a missing reviewer when the provider is not configured', async () => {
    const callbacks: Partial<MemoryCommandCallbacks> = {
      // An unresolvable provider name is deterministically unconfigured.
      createKodaXOptions: () => ({ provider: 'definitely-unconfigured-provider' } as KodaXOptions),
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, callbacks);
    } finally {
      restore();
    }

    expect(log.contains('MISSING — provider "definitely-unconfigured-provider" is not configured')).toBe(true);
    expect(log.contains('reviewer missing')).toBe(true);
  });

  it('renders an unavailable note when KodaX options are not bound', async () => {
    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, {});
    } finally {
      restore();
    }

    expect(log.contains('unavailable — KodaX options are not bound in this session')).toBe(true);
  });
  it('lists persisted episode-review jobs separately from memory proposals', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    for (const [sequence, sessionId] of [[1, 'review-session-a'], [2, 'review-session-b']] as const) {
      const identity = deriveCodingMemoryIdentity(options, cwd, sessionId);
      await persistPendingEpisodeReview(identity, {
        id: `digest-${sequence}`,
        reviewKey: `review:digest-${sequence}`,
        sessionId,
        branchId: 'main',
        sequence,
        objective: 'inspect the memory backlog',
        approach: 'persist an episode review',
        outcome: 'succeeded',
        summary: `pending review ${sequence}`,
        evidenceRefs: [],
        visibility: 'prompt_safe',
        createdAt: `2026-08-0${sequence}T00:00:00.000Z`,
      });
    }

    const context = {
      messages: [],
      runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
      sessionId: 'session-status-test',
    };
    const { log, restore } = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews', '1'],
        context as never,
        configuredCallbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      restore();
    }

    expect(log.contains('[memory] episode-review jobs')).toBe(true);
    expect(log.contains('showing 1 of 2')).toBe(true);
    expect(log.contains('review:digest-1')).toBe(true);
    expect(log.contains('review:digest-2')).toBe(false);
    expect(log.contains('kodax memory review-drain')).toBe(true);
  });

  it('separates attention jobs from the automatic review queue', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const identity = deriveCodingMemoryIdentity(options, cwd, 'attention-session');
    const persisted = await persistPendingEpisodeReview(identity, {
      id: 'digest-attention',
      reviewKey: 'review:attention',
      sessionId: identity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'surface an exhausted review',
      approach: 'exhaust provider retries',
      outcome: 'failed',
      summary: 'operator intervention required',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    for (const minute of [1, 2, 7, 37]) {
      const now = new Date(`2026-08-01T00:${String(minute).padStart(2, '0')}:00.000Z`);
      const claim = await claimEpisodeReview(identity, persisted.entry.jobId, { now });
      if (claim === undefined) throw new Error('test setup expected a claim');
      await failEpisodeReviewAttempt(identity, claim, {
        kind: 'provider_error',
        message: 'review provider failed',
      }, now);
    }

    const statusOutput = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      statusOutput.restore();
    }
    expect(statusOutput.log.contains('pending: 1')).toBe(true);
    expect(statusOutput.log.contains('automatic queue: 0')).toBe(true);
    expect(statusOutput.log.contains('needs attention: 1')).toBe(true);
    expect(statusOutput.log.contains('cannot be processed by review-drain')).toBe(true);
    expect(statusOutput.log.contains('Run `kodax memory review-drain`')).toBe(false);

    const reviewsOutput = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'session-status-test',
        } as never,
        configuredCallbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      reviewsOutput.restore();
    }
    expect(reviewsOutput.log.contains('needs attention: 1')).toBe(true);
    expect(reviewsOutput.log.contains('Process this queue with')).toBe(false);
  });

  it('does not recommend a current-project drain for another project backlog', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const currentIdentity = deriveCodingMemoryIdentity(options, cwd, 'foreign-project-session');
    await persistPendingEpisodeReview({
      ...currentIdentity,
      projectId: 'remote:foreign.example/other-project',
    }, {
      id: 'digest-foreign-project',
      reviewKey: 'review:foreign-project',
      sessionId: currentIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'belong to another project',
      approach: 'persist under a foreign project identity',
      outcome: 'succeeded',
      summary: 'must not be advertised as locally drainable',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const statusOutput = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      statusOutput.restore();
    }
    expect(statusOutput.log.contains('pending: 0')).toBe(true);
    expect(statusOutput.log.contains('Run `kodax memory review-drain`')).toBe(false);

    const reviewsOutput = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'session-status-test',
        } as never,
        configuredCallbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      reviewsOutput.restore();
    }
    expect(reviewsOutput.log.contains('showing 0 of 0')).toBe(true);
    expect(reviewsOutput.log.contains('(none)')).toBe(true);
    expect(reviewsOutput.log.contains('review:foreign-project')).toBe(false);
  });

  it('uses the production execution cwd for local review ownership', async () => {
    const executionCwd = path.join(cwd, 'nested-execution-cwd');
    fs.mkdirSync(executionCwd, { recursive: true });
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd },
        memoryReviewer: configuredCallbacks.createKodaXOptions?.().memoryReviewer,
      } as KodaXOptions),
    };
    const options = callbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const owner = deriveCodingMemoryIdentity(options, executionCwd, 'nested-session');
    await persistPendingEpisodeReview(owner, {
      id: 'digest-nested-cwd',
      reviewKey: 'review:nested-cwd',
      sessionId: owner.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'retain local ownership from a nested cwd',
      approach: 'persist with the production execution cwd',
      outcome: 'succeeded',
      summary: 'visible from the matching review drain',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd },
          sessionId: 'session-status-test',
        } as never,
        callbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 1 of 1')).toBe(true);
    expect(output.log.contains('review:nested-cwd')).toBe(true);
  });

  it('honors a host-provided production memory identity', async () => {
    const customIdentity = {
      configHome: tempHome,
      tenantId: 'tenant-host-bound',
      userId: 'user-host-bound',
      workspaceId: 'workspace-host-bound',
      agentId: 'agent-host-bound',
      projectId: 'remote:host.example/project',
      sessionId: 'session-host-bound',
    } as const;
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd: cwd, memoryIdentity: customIdentity },
      } as KodaXOptions),
    };
    await persistPendingEpisodeReview(customIdentity, {
      id: 'digest-host-bound',
      reviewKey: 'review:host-bound',
      sessionId: customIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'use a host-provided owner identity',
      approach: 'persist under the production owner',
      outcome: 'succeeded',
      summary: 'visible to the matching embedded REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'different-repl-session',
        } as never,
        callbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 1 of 1')).toBe(true);
    expect(output.log.contains('review:host-bound')).toBe(true);
  });

  it('keeps a host-provided project-less identity scoped to ownerless reviews', async () => {
    const projectlessIdentity = {
      configHome: tempHome,
      tenantId: 'tenant-host-projectless',
      agentId: 'agent-host-projectless',
      sessionId: 'session-host-projectless',
    } as const;
    const foreignIdentity = {
      ...projectlessIdentity,
      projectId: 'remote:host.example/foreign-project',
    } as const;
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd: cwd, memoryIdentity: projectlessIdentity },
      } as KodaXOptions),
    };
    await persistPendingEpisodeReview(projectlessIdentity, {
      id: 'digest-host-projectless',
      reviewKey: 'review:host-projectless',
      sessionId: projectlessIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'query only ownerless reviews',
      approach: 'use the host-provided owner identity',
      outcome: 'succeeded',
      summary: 'visible to the matching embedded REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await persistPendingEpisodeReview(foreignIdentity, {
      id: 'digest-host-foreign-project',
      reviewKey: 'review:host-foreign-project',
      sessionId: foreignIdentity.sessionId,
      branchId: 'main',
      sequence: 2,
      objective: 'keep another project private',
      approach: 'persist under a project-owned identity',
      outcome: 'failed',
      summary: 'must not appear in the project-less REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:01:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'different-repl-session',
        } as never,
        callbacks as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 1 of 1')).toBe(true);
    expect(output.log.contains('review:host-projectless')).toBe(true);
    expect(output.log.contains('review:host-foreign-project')).toBe(false);
  });

  it('labels pending as the proposal compatibility alias', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('compatibility alias for /memory decisions')).toBe(true);
    expect(log.contains('episode-review jobs: /memory reviews')).toBe(false);
    expect(log.contains('decisions that need you')).toBe(true);
  });
});

function memoryProposal(proposalId: string): MemoryLearningHandoff {  return {
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
