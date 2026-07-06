import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '../runtime/agent-home.js';
import { resetSkillRegistry } from '../capabilities/skills/index.js';
import {
  readLearningProposalStore,
  upsertLearningProposal,
} from '../learning/store.js';
import type {
  MemoryLearningHandoff,
  ReasoningLearningHandoff,
} from '../learning/types.js';
import type {
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLineage,
} from '../types.js';
import {
  createMemoryControlPlane,
} from './index.js';
import type {
  MemoryItemRef,
} from './types.js';

describe('MemoryControlPlane', () => {
  let tempRoot: string;
  let cwd: string;
  let learningStorePath: string;
  let memoryRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kodax-memory-control-'));
    cwd = join(tempRoot, 'repo');
    learningStorePath = join(tempRoot, 'learning', 'proposals.json');
    memoryRoot = join(tempRoot, 'memory');
    setAgentConfigHome(join(tempRoot, 'home'));
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
    setAgentConfigHome(undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('projects F224 memdir and reasoning handoffs from the same learning store', async () => {
    await upsertLearningProposal(learningStorePath, memoryProposal('p-memory'));
    await upsertLearningProposal(learningStorePath, reasoningProposal('p-reason'));
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const inbox = await controller.listInbox();

    expect(inbox.map((proposal) => proposal.id)).toEqual(['memory:p-memory', 'memory:p-reason']);
    expect(inbox[0]?.action).toBe('write_memdir');
    expect(inbox[1]?.action).toBe('no_op');
    expect(await readLearningProposalStore(learningStorePath)).toMatchObject({
      warnings: [],
    });
  });

  it('approves a memdir handoff with atomic topic/index writes and store status update', async () => {
    await upsertLearningProposal(learningStorePath, memoryProposal('p-apply'));
    const events: string[] = [];
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
      onEvent: (event) => events.push(event.type),
    });
    const proposal = await controller.showProposal('memory:p-apply');
    expect(proposal).toBeDefined();

    const result = await controller.approveProposal('memory:p-apply', proposal?.expectedFingerprints);

    expect(result.applied).toBe(true);
    expect(result.changedPaths).toHaveLength(2);
    const store = await readLearningProposalStore(learningStorePath);
    expect(store.proposals[0]?.status).toBe('approved');
    const topicPath = result.changedPaths.find((path) => path.endsWith('.md') && !path.endsWith('MEMORY.md'));
    expect(topicPath).toBeDefined();
    await expect(readFile(topicPath ?? '', 'utf8')).resolves.toContain('Repo uses npm workspaces.');
    await expect(readFile(join(memoryRoot, 'MEMORY.md'), 'utf8')).resolves.toContain('Repo uses npm workspaces.');
    expect(events).toContain('proposal.approved');
  });

  it('fails closed when approval fingerprints are older than the current preview', async () => {
    await upsertLearningProposal(learningStorePath, memoryProposal('p-stale'));
    await mkdir(memoryRoot, { recursive: true });
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const firstPreview = await controller.showProposal('memory:p-stale');
    await writeFile(join(memoryRoot, 'MEMORY.md'), '- [changed](changed.md) - changed\n', 'utf8');

    const result = await controller.approveProposal('memory:p-stale', firstPreview?.expectedFingerprints);

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toContain('fingerprints');
    const store = await readLearningProposalStore(learningStorePath);
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('builds deterministic packs and excludes pending private stale proposal-only refs', async () => {
    await upsertLearningProposal(learningStorePath, memoryProposal('p-pending'));
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(
      join(memoryRoot, 'project_stack.md'),
      [
        '---',
        'name: Project stack',
        'description: Repo uses npm workspaces',
        'type: project',
        '---',
        '',
        'Repo uses npm workspaces.',
        '',
      ].join('\n'),
      'utf8',
    );
    const extraRefs: readonly MemoryItemRef[] = [
      extraRef('session:stale', 'session_trace', 'stale'),
      extraRef('artifact:private', 'artifact_ledger', 'active', 'private'),
      extraRef('artifact:sensitive', 'artifact_ledger', 'active', 'sensitive'),
      extraRef('memdir:quarantined', 'memdir', 'quarantined'),
    ];
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      extraRefs,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const pack = await controller.buildMemoryPack({
      task: 'Please inspect the project stack and npm setup',
      includeSnippets: true,
      maxHints: 5,
    });

    expect(pack.hints.map((hint) => hint.ref.id)).toContain('memdir:project_stack.md');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('learning_proposal:p-pending');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('session:stale');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('artifact:private');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('artifact:sensitive');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('memdir:quarantined');
    expect(pack.hints[0]?.bodySnippet).toContain('Repo uses npm workspaces.');
    expect(pack.traceMetadata.selectedRefIds).toContain('memdir:project_stack.md');
    expect(pack.traceMetadata.suppressed).toBe(false);
  });

  it('returns an empty pack when the user asks to ignore memory', async () => {
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const pack = await controller.buildMemoryPack({ task: 'Ignore memory for this answer.' });

    expect(pack.hints).toEqual([]);
    expect(pack.omitted).toEqual(['memory intentionally suppressed by request']);
    expect(pack.traceMetadata).toEqual({
      selectedRefIds: [],
      omittedRefIds: [],
      taskFingerprint: pack.taskFingerprint,
      suppressed: true,
    });
  });

  it('projects session trace and artifact ledger refs without adding them to normal packs', async () => {
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'entry-1',
      entries: [{
        id: 'entry-1',
        parentId: null,
        timestamp: '2026-07-06T00:00:00.000Z',
        type: 'message',
        message: { role: 'user', content: 'Please inspect memory governance.' },
      }],
    };
    const artifactLedger: readonly KodaXSessionArtifactLedgerEntry[] = [{
      id: 'artifact-1',
      kind: 'file_read',
      target: 'docs/features/v0.7.62.md',
      summary: 'Read F228 design.',
      sessionEntryId: 'entry-1',
      timestamp: '2026-07-06T00:00:01.000Z',
    }];
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      sessionId: 'session-1',
      sessionLineage: lineage,
      artifactLedger,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:02.000Z',
    });

    const refs = await controller.listRefs({ includePrivate: true });
    const sessionRef = refs.find((ref) => ref.id === 'session_trace:session-1:entry-1');
    const artifactRef = refs.find((ref) => ref.id === 'artifact_ledger:session-1:artifact-1');
    expect(sessionRef).toMatchObject({
      kind: 'session_trace',
      lifecycle: 'provisional',
      authority: 'read_only',
      visibility: 'private',
    });
    expect(artifactRef).toMatchObject({
      kind: 'artifact_ledger',
      lifecycle: 'provisional',
      authority: 'read_only',
      sourceRefs: ['session_trace:session-1:entry-1'],
    });
    const snapshot = await controller.readRef(sessionRef!);
    expect(snapshot.body).toContain('Please inspect memory governance.');

    const pack = await controller.buildMemoryPack({
      task: 'Use the artifact ledger about memory governance',
      includePrivate: true,
      maxHints: 10,
    });

    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('session_trace:session-1:entry-1');
    expect(pack.hints.map((hint) => hint.ref.id)).not.toContain('artifact_ledger:session-1:artifact-1');
  });

  it('lists snapshot-readable project doc and project skill refs', async () => {
    const projectDoc = join(cwd, 'docs', 'PRD.md');
    const skillDir = join(cwd, '.kodax', 'skills', 'memory-audit');
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(projectDoc, '# Product Requirements\n\nMemory governance matters.\n', 'utf8');
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: memory-audit',
        'description: Audit memory refs',
        '---',
        '',
        'Use this skill to audit memory refs.',
        '',
      ].join('\n'),
      'utf8',
    );
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      projectDocs: [projectDoc],
      discoverSkills: true,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const refs = await controller.listRefs();
    const docRef = refs.find((ref) => ref.id === 'project_doc:docs/PRD.md');
    const skillRef = refs.find((ref) => ref.id === 'skill:memory-audit');

    expect(docRef).toMatchObject({
      kind: 'project_doc',
      authority: 'read_only',
      lifecycle: 'readonly',
    });
    expect(skillRef).toMatchObject({
      kind: 'skill',
      authority: 'read_only',
      scope: 'project',
    });
    await expect(controller.readRef(docRef!)).resolves.toMatchObject({
      body: expect.stringContaining('Memory governance matters.'),
    });
    await expect(controller.readRef(skillRef!)).resolves.toMatchObject({
      body: expect.stringContaining('Use this skill to audit memory refs.'),
    });
  });

  it('reports deterministic conflict and orphaned governance findings', async () => {
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      extraRefs: [
        {
          ...extraRef('memdir:alpha.md', 'memdir', 'active'),
          title: 'Shared Memory',
          bodyFingerprint: 'sha256:one',
        },
        {
          ...extraRef('memdir:beta.md', 'memdir', 'active'),
          title: 'Shared Memory',
          bodyFingerprint: 'sha256:two',
        },
        {
          ...extraRef('memdir:orphan.md', 'memdir', 'active'),
          relatedRefs: ['memdir:missing.md'],
          bodyFingerprint: 'sha256:three',
        },
      ],
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const report = await controller.runCurator();

    expect(report.findings.map((finding) => finding.kind)).toContain('conflict');
    expect(report.findings.map((finding) => finding.kind)).toContain('orphaned');
  });

  it('reports duplicate, stale, quarantined, and no-op governance findings', async () => {
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      extraRefs: [
        {
          ...extraRef('memdir:duplicate-a.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
        {
          ...extraRef('memdir:duplicate-b.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
        extraRef('memdir:old.md', 'memdir', 'stale'),
        extraRef('memdir:review.md', 'memdir', 'quarantined'),
      ],
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const cleanController = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const report = await controller.runCurator();
    const cleanReport = await cleanController.runCurator();

    expect(report.findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(['duplicate', 'stale', 'quarantined']),
    );
    expect(cleanReport.findings).toHaveLength(1);
    expect(cleanReport.findings[0]?.kind).toBe('no_op');
  });

  it('auto-runs curator for managed memory refs and persists an audit report', async () => {
    const events: string[] = [];
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      extraRefs: [
        {
          ...extraRef('memdir:duplicate-a.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
        {
          ...extraRef('memdir:duplicate-b.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
      ],
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
      onEvent: (event) => events.push(event.type),
    });

    const result = await controller.maybeRunAutoCurator();

    expect(result.ran).toBe(true);
    expect(result.report?.findings.map((finding) => finding.kind)).toContain('duplicate');
    expect(result.reportPath).toContain('.governance');
    await expect(readFile(result.reportPath ?? '', 'utf8')).resolves.toContain('duplicate-a');
    await expect(readFile(join(memoryRoot, '.governance', 'auto-curate-state.json'), 'utf8'))
      .resolves.toContain('lastRunAt');
    expect(events).toContain('curator.completed');
  });

  it('auto-curator skips when not due or when there are not enough managed refs', async () => {
    const controller = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot,
      extraRefs: [
        {
          ...extraRef('memdir:duplicate-a.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
        {
          ...extraRef('memdir:duplicate-b.md', 'memdir', 'active'),
          bodyFingerprint: 'sha256:duplicate',
        },
      ],
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });
    expect((await controller.maybeRunAutoCurator()).ran).toBe(true);

    const skipped = await controller.maybeRunAutoCurator();

    expect(skipped).toMatchObject({
      ran: false,
      skippedReason: 'not_due',
      nextEligibleAt: '2026-07-07T00:00:00.000Z',
    });

    const sparseMemoryRoot = join(tempRoot, 'sparse-memory');
    const sparseController = createMemoryControlPlane({
      cwd,
      learningStorePath,
      memoryRoot: sparseMemoryRoot,
      extraRefs: [extraRef('memdir:single.md', 'memdir', 'active')],
      discoverSkills: false,
      now: () => '2026-07-06T00:00:00.000Z',
    });

    const sparse = await sparseController.maybeRunAutoCurator();

    expect(sparse).toMatchObject({
      ran: false,
      skippedReason: 'insufficient_refs',
    });
    expect(existsSync(join(sparseMemoryRoot, '.governance'))).toBe(false);
  });
});

function memoryProposal(proposalId: string): MemoryLearningHandoff {
  return {
    destination: 'memdir_handoff',
    proposalId,
    origin: 'background_learning',
    userLabel: 'context_note',
    memoryKind: 'project',
    body: 'Repo uses npm workspaces.\n\nWhy: package.json declares npm workspaces.',
    metadata: {
      writeOrigin: 'background_learning',
      executionContext: 'primary',
      sessionId: 'session-1',
      sourceRefs: ['trace:1'],
      completedTurn: true,
    },
  };
}

function reasoningProposal(proposalId: string): ReasoningLearningHandoff {
  return {
    destination: 'reasoning_handoff',
    proposalId,
    origin: 'background_learning',
    userLabel: 'reasoning_report',
    title: 'Prefer graph-first checks',
    body: 'When repo intelligence is cold, prefer graph-first module checks.',
    sourceTraceIds: ['trace:2'],
  };
}

function extraRef(
  id: string,
  kind: MemoryItemRef['kind'],
  lifecycle: MemoryItemRef['lifecycle'],
  visibility: MemoryItemRef['visibility'] = 'prompt_safe',
): MemoryItemRef {
  return {
    kind,
    id,
    scope: 'session',
    title: id,
    owner: 'project',
    lifecycle,
    authority: 'read_only',
    visibility,
    sourceRefs: [],
    relatedRefs: [],
  };
}
