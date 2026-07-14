import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applySkillMutationProposal,
} from './skill-safe-apply.js';

import {
  computeSkillConsumerImpact,
  applySkillLearningProposal,
  approveStoredLearningProposal,
  canMarkCreatedByAgent,
  decideSkillGovernance,
  readLearningProposalStore,
  readSkillTrustLedger,
  readSkillUsageLedger,
  recordCompletedTurnLearning,
  recordProceduralLearning,
  recordSkillUsage,
  resolveSkillSnapshotLocation,
  resolveSkillTrustLedger,
  resolveSkillUsageLedger,
  triageProceduralLearning,
  updateLearningProposalStatus,
  updateSkillTrustLedger,
  upsertLearningProposal,
  type SkillConsumerImpact,
} from './index.js';

const tempDirs: string[] = [];

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const noConsumerImpact: SkillConsumerImpact = {
  workflowCapsules: [],
  savedWorkflows: [],
  constructedAgents: [],
  promptReferences: [],
  action: 'none',
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('procedural learning triage', () => {
  it('discards interrupted turns before any durable proposal is created', () => {
    const result = triageProceduralLearning({
      proposalId: 'p-interrupted',
      origin: 'background_learning',
      completedTurn: false,
      sourceRefs: ['turn:1'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'The user corrected the release note structure repeatedly.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add the release-note checklist.',
        confidence: 0.9,
      },
    });

    expect(result.destination).toBe('discard');
    expect(result.reason).toContain('completed turn');
  });

  it('routes durable skill lessons to method guide proposals', () => {
    const result = triageProceduralLearning({
      proposalId: 'p-skill',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:2', 'skill:release-notes'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Three completed tasks needed the same changelog checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Patch the existing checklist with billing/auth sections.',
        confidence: 0.82,
      },
    });

    expect(result.destination).toBe('skill_patch');
    expect(result.userLabel).toBe('method_guide');
    if (result.destination === 'skill_patch') {
      expect(result.skillName).toBe('release-notes');
      expect(result.whyDurable).toContain('Three completed tasks');
    }
  });

  it('uses env-configured confidence defaults for skill proposals', () => {
    const previous = process.env.KODAX_LEARNING_DEFAULT_CONFIDENCE;
    process.env.KODAX_LEARNING_DEFAULT_CONFIDENCE = '0.72';
    try {
      const result = triageProceduralLearning({
        proposalId: 'p-skill-env-confidence',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['turn:env-confidence'],
        candidate: {
          kind: 'skill_patch',
          skillName: 'release-notes',
          whyDurable: 'The same release-note checklist was reused.',
          trigger: 'When drafting release notes.',
          changeSummary: 'Patch the checklist.',
        },
      });

      expect(result.destination).toBe('skill_patch');
      if (result.destination === 'skill_patch') {
        expect(result.confidence).toBe(0.72);
      }
    } finally {
      restoreEnv('KODAX_LEARNING_DEFAULT_CONFIDENCE', previous);
    }
  });

  it('uses env-configured confidence floor for active suggestions', () => {
    const previous = process.env.KODAX_LEARNING_CONFIDENCE_FLOOR;
    process.env.KODAX_LEARNING_CONFIDENCE_FLOOR = '0.8';
    try {
      const result = triageProceduralLearning({
        proposalId: 'p-skill-env-floor',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['turn:env-floor'],
        candidate: {
          kind: 'skill_patch',
          skillName: 'release-notes',
          whyDurable: 'The same release-note checklist was reused.',
          trigger: 'When drafting release notes.',
          changeSummary: 'Patch the checklist.',
          confidence: 0.7,
        },
      });

      expect(result.destination).toBe('trace_only');
      if (result.destination === 'trace_only') {
        expect(result.reason).toContain('confidence');
      }
    } finally {
      restoreEnv('KODAX_LEARNING_CONFIDENCE_FLOOR', previous);
    }
  });

  it('emits workflow handoffs only for completed workflow runs', () => {
    const cancelled = triageProceduralLearning({
      proposalId: 'p-workflow-cancelled',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['workflow:wf-1'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-1',
        workflowStatus: 'stopped',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The lesson depends on a repeatable multi-agent phase graph.',
        requiredWorkflowEvidence: ['completed synthesis', 'stable phase list'],
        risk: 'low',
        consumerImpact: noConsumerImpact,
      },
    });

    const completed = triageProceduralLearning({
      proposalId: 'p-workflow-completed',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['workflow:wf-2'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-2',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The lesson depends on a repeatable multi-agent phase graph.',
        requiredWorkflowEvidence: ['completed synthesis', 'stable phase list'],
        risk: 'low',
        consumerImpact: noConsumerImpact,
      },
    });

    expect(cancelled.destination).toBe('discard');
    expect(cancelled.reason).toContain('completed workflow');
    expect(completed.destination).toBe('workflow_handoff');
    if (completed.destination === 'workflow_handoff') {
      expect(completed.evidenceRunIds).toEqual(['wf-2']);
      expect(completed.suggestedAction).toBe('save_from_run');
    }
  });

  it('keeps memory handoffs reviewable and includes lineage metadata', () => {
    const result = triageProceduralLearning({
      proposalId: 'p-memory',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:3'],
      candidate: {
        kind: 'memdir_handoff',
        memoryKind: 'project',
        body: 'This repository keeps feature implementation notes in docs/features/v{VERSION}.md.',
        metadata: {
          writeOrigin: 'background_learning',
          executionContext: 'primary',
          sessionId: 'session-1',
          parentSessionId: 'session-parent',
          sourceRefs: ['turn:3'],
          completedTurn: true,
        },
      },
    });

    expect(result.destination).toBe('memdir_handoff');
    if (result.destination === 'memdir_handoff') {
      expect(result.metadata.sessionId).toBe('session-1');
      expect(result.userLabel).toBe('context_note');
    }
  });
});

describe('skill governance policy', () => {
  it('separates telemetry from mutation authority', () => {
    expect(decideSkillGovernance({
      action: 'record_usage',
      source: 'builtin',
      ownership: 'system',
      origin: 'background_learning',
    })).toMatchObject({ allowed: true, mode: 'telemetry' });

    expect(decideSkillGovernance({
      action: 'patch',
      source: 'plugin',
      ownership: 'system',
      origin: 'background_learning',
    })).toMatchObject({ allowed: true, mode: 'overlay_proposal' });

    expect(decideSkillGovernance({
      action: 'archive',
      source: 'project',
      ownership: 'human',
      origin: 'background_learning',
    })).toMatchObject({ allowed: false });
  });

  it('only lets background learning mark skills as agent-created', () => {
    expect(canMarkCreatedByAgent('foreground_user')).toBe(false);
    expect(canMarkCreatedByAgent('assistant_tool')).toBe(false);
    expect(canMarkCreatedByAgent('background_learning')).toBe(true);
  });

  it('blocks pinned destructive curation even for background-created skills', () => {
    expect(decideSkillGovernance({
      action: 'quarantine',
      source: 'project',
      ownership: 'background_created',
      origin: 'background_learning',
      pinned: true,
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('pinned'),
    });
  });
});

describe('skill mutation proposal apply path', () => {
  it('dry-runs without mutating files and applies approved writes atomically', async () => {
    const skillRoot = await createTempDir('kodax-learning-skill-');
    const snapshotRoot = await createTempDir('kodax-learning-snapshot-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');

    const dryRun = await applySkillMutationProposal({
      proposalId: 'proposal-1',
      skillRoot,
      snapshotRoot,
      approved: false,
      dryRun: true,
      changes: [
        { kind: 'write', relativePath: 'SKILL.md', content: 'new skill' },
        { kind: 'write', relativePath: 'references/checklist.md', content: 'checklist' },
      ],
    });

    expect(dryRun.applied).toBe(false);
    expect(dryRun.validated).toBe(true);
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe('old skill');

    const applied = await applySkillMutationProposal({
      proposalId: 'proposal-1',
      skillRoot,
      snapshotRoot,
      approved: true,
      changes: [
        { kind: 'write', relativePath: 'SKILL.md', content: 'new skill' },
        { kind: 'write', relativePath: 'references/checklist.md', content: 'checklist' },
      ],
    });

    expect(applied.applied).toBe(true);
    expect(applied.snapshotPath).toBeTruthy();
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe('new skill');
    expect(await readFile(join(skillRoot, 'references', 'checklist.md'), 'utf8')).toBe('checklist');
  });

  it('snapshots single-file writes before applying approved changes', async () => {
    const skillRoot = await createTempDir('kodax-learning-single-snapshot-');
    const snapshotRoot = await createTempDir('kodax-learning-single-snapshot-root-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');

    const applied = await applySkillMutationProposal({
      proposalId: 'proposal-single-file',
      skillRoot,
      snapshotRoot,
      approved: true,
      changes: [
        { kind: 'write', relativePath: 'SKILL.md', content: 'new skill' },
      ],
    });

    expect(applied.snapshotPath).toBeTruthy();
    if (applied.snapshotPath === undefined) {
      throw new Error('test setup expected a snapshot path');
    }
    const location = await resolveSkillSnapshotLocation({
      proposalId: 'proposal-single-file',
      skillRoot,
      snapshotRoot,
    });
    expect(applied.snapshotPath.startsWith(join(location.snapshotBase, location.proposalPrefix))).toBe(true);
    expect(await readFile(join(applied.snapshotPath, 'SKILL.md'), 'utf8')).toBe('old skill');
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe('new skill');
  });

  it('rejects path traversal and unsupported support directories', async () => {
    const skillRoot = await createTempDir('kodax-learning-guard-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');

    await expect(applySkillMutationProposal({
      proposalId: 'proposal-traversal',
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: '../escape.md', content: 'nope' }],
    })).rejects.toThrow(/outside skill root/);

    await expect(applySkillMutationProposal({
      proposalId: 'proposal-resource',
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: 'resources/raw.md', content: 'nope' }],
    })).rejects.toThrow(/support directory/);
  });

  it('refuses delete proposals against directories', async () => {
    const skillRoot = await createTempDir('kodax-learning-delete-');
    await mkdir(join(skillRoot, 'references'), { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');

    await expect(applySkillMutationProposal({
      proposalId: 'proposal-delete-dir',
      skillRoot,
      approved: true,
      changes: [{ kind: 'delete', relativePath: 'references' }],
    })).rejects.toThrow(/delete is outside/);
  });

  it('rejects delete proposals against files because F224 is write-only', async () => {
    const skillRoot = await createTempDir('kodax-learning-delete-file-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');

    await expect(applySkillMutationProposal({
      proposalId: 'proposal-delete-file',
      skillRoot,
      approved: true,
      changes: [{ kind: 'delete', relativePath: 'SKILL.md' }],
    })).rejects.toThrow(/delete is outside/);
  });
});

describe('skill learning proposal apply plan', () => {
  it('applies approved project skill patches through governance and safe apply', async () => {
    const skillRoot = await createTempDir('kodax-learning-apply-patch-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');
    const proposal = triageProceduralLearning({
      proposalId: 'p-apply-skill',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:7'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'The same release note checklist was reused.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Patch the checklist.',
      },
    });
    if (proposal.destination !== 'skill_patch') {
      throw new Error('test setup expected a skill patch proposal');
    }

    const result = await applySkillLearningProposal({
      proposal,
      governance: {
        action: 'patch',
        source: 'project',
        ownership: 'human',
        origin: 'background_learning',
      },
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
    });

    expect(result.applied).toBe(true);
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe('new skill');
  });

  it('blocks readonly-source overlay proposals from mutating the source skill', async () => {
    const skillRoot = await createTempDir('kodax-learning-overlay-');
    await writeFile(join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');
    const proposal = triageProceduralLearning({
      proposalId: 'p-overlay',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:8'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'builtin-review',
        whyDurable: 'The checklist should be suggested as an overlay.',
        trigger: 'When reviewing code.',
        changeSummary: 'Patch readonly skill via overlay proposal.',
      },
    });
    if (proposal.destination !== 'skill_patch') {
      throw new Error('test setup expected a skill patch proposal');
    }

    await expect(applySkillLearningProposal({
      proposal,
      governance: {
        action: 'patch',
        source: 'builtin',
        ownership: 'system',
        origin: 'background_learning',
      },
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
    })).rejects.toThrow(/overlay proposal/);

    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe('old skill');
  });

  it('refuses to apply workflow handoffs in F224', async () => {
    const proposal = triageProceduralLearning({
      proposalId: 'p-workflow-apply',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['workflow:wf-apply'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-apply',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'This is a repeatable workflow.',
        requiredWorkflowEvidence: ['completed run'],
        risk: 'low',
        consumerImpact: noConsumerImpact,
      },
    });
    const skillRoot = await createTempDir('kodax-learning-wf-apply-');

    await expect(applySkillLearningProposal({
      proposal,
      governance: {
        action: 'patch',
        source: 'project',
        ownership: 'human',
        origin: 'background_learning',
      },
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'nope' }],
    })).rejects.toThrow(/only skill proposals/);
  });

  it('creates a new background skill root when a skill_create proposal includes SKILL.md', async () => {
    const parent = await createTempDir('kodax-learning-create-parent-');
    const skillRoot = join(parent, 'new-skill');
    const proposal = triageProceduralLearning({
      proposalId: 'p-create-skill',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:9'],
      candidate: {
        kind: 'skill_create',
        skillName: 'release-notes',
        whyDurable: 'No existing skill covers this reusable method.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Create a new skill.',
      },
    });
    if (proposal.destination !== 'skill_create') {
      throw new Error('test setup expected a skill create proposal');
    }

    const result = await applySkillLearningProposal({
      proposal,
      governance: {
        action: 'create',
        source: 'project',
        ownership: 'background_created',
        origin: 'background_learning',
      },
      skillRoot,
      approved: true,
      changes: [
        {
          kind: 'write',
          relativePath: 'SKILL.md',
          content: '---\nname: release-notes\ndescription: Use when drafting release notes.\n---\n\n# Release Notes\n',
        },
      ],
    });

    expect(result.applied).toBe(true);
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('release-notes');
  });

  it('dry-runs skill_create proposals without creating the skill root', async () => {
    const parent = await createTempDir('kodax-learning-create-dry-parent-');
    const skillRoot = join(parent, 'dry-new-skill');
    const proposal = triageProceduralLearning({
      proposalId: 'p-create-dry',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:9a'],
      candidate: {
        kind: 'skill_create',
        skillName: 'dry-release-notes',
        whyDurable: 'No existing skill covers this reusable method.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Create a new skill.',
      },
    });
    if (proposal.destination !== 'skill_create') {
      throw new Error('test setup expected a skill create proposal');
    }

    const result = await applySkillLearningProposal({
      proposal,
      governance: {
        action: 'create',
        source: 'project',
        ownership: 'background_created',
        origin: 'background_learning',
      },
      skillRoot,
      approved: false,
      dryRun: true,
      changes: [
        {
          kind: 'write',
          relativePath: 'SKILL.md',
          content: '---\nname: dry-release-notes\ndescription: Use when drafting release notes.\n---\n\n# Release Notes\n',
        },
      ],
    });

    expect(result.applied).toBe(false);
    await expect(stat(skillRoot)).rejects.toThrow();
  });

  it('rejects skill_create proposals without SKILL.md', async () => {
    const parent = await createTempDir('kodax-learning-create-missing-');
    const skillRoot = join(parent, 'missing-skill');
    const proposal = triageProceduralLearning({
      proposalId: 'p-create-missing',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:10'],
      candidate: {
        kind: 'skill_create',
        skillName: 'missing-skill',
        whyDurable: 'No existing skill covers this reusable method.',
        trigger: 'When doing the task.',
        changeSummary: 'Create a new skill.',
      },
    });
    if (proposal.destination !== 'skill_create') {
      throw new Error('test setup expected a skill create proposal');
    }

    await expect(applySkillLearningProposal({
      proposal,
      governance: {
        action: 'create',
        source: 'project',
        ownership: 'background_created',
        origin: 'background_learning',
      },
      skillRoot,
      approved: true,
      changes: [{ kind: 'write', relativePath: 'references/checklist.md', content: 'checklist' }],
    })).rejects.toThrow(/SKILL.md/);
  });
});

describe('learning proposal store', () => {
  it('serializes concurrent proposal upserts without losing entries', async () => {
    const dir = await createTempDir('kodax-learning-store-concurrent-');
    const storePath = join(dir, 'proposals.json');
    const proposals = ['p-concurrent-a', 'p-concurrent-b'].map((proposalId) =>
      triageProceduralLearning({
        proposalId,
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: [`turn:${proposalId}`],
        candidate: {
          kind: 'skill_patch' as const,
          skillName: `skill-${proposalId}`,
          whyDurable: 'The procedure recurred across completed sessions.',
          trigger: 'When the matching task recurs.',
          changeSummary: `Store ${proposalId}.`,
        },
      }));
    const reviewable = proposals.filter((proposal) =>
      proposal.destination !== 'discard' && proposal.destination !== 'trace_only');
    expect(reviewable).toHaveLength(2);

    await Promise.all(reviewable.map((proposal) => upsertLearningProposal(storePath, proposal)));

    expect((await readLearningProposalStore(storePath)).proposals.map((entry) => entry.proposalId).sort())
      .toEqual(['p-concurrent-a', 'p-concurrent-b']);
  });

  it('does not remove a successor lock when the current lock owner finishes', async () => {
    const dir = await createTempDir('kodax-learning-store-lock-owner-');
    const storePath = join(dir, 'proposals.json');
    const lockPath = `${storePath}.lock`;
    const successorLock = `${process.pid} 11111111-1111-4111-8111-111111111111\n`;
    const proposal = triageProceduralLearning({
      proposalId: 'p-lock-owner',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:lock-owner'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'lock-owner',
        whyDurable: 'Concurrent writers must preserve lock ownership.',
        trigger: 'When proposal writes overlap.',
        changeSummary: 'Preserve the successor lock.',
      },
    });
    if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
      throw new Error('test setup expected a reviewable proposal');
    }

    await upsertLearningProposal(storePath, proposal, {
      now: () => {
        writeFileSync(lockPath, successorLock, 'utf8');
        return '2026-07-12T00:00:00.000Z';
      },
    });

    await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorLock);
    await rm(lockPath, { force: true });
  });

  it('stores reviewable proposals and records rejection feedback', async () => {
    const dir = await createTempDir('kodax-learning-store-');
    const storePath = join(dir, 'proposals.json');
    const proposal = triageProceduralLearning({
      proposalId: 'p-store',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:4'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'The same checklist was reused across completed sessions.',
        trigger: 'When release notes are requested.',
        changeSummary: 'Add the checklist.',
      },
    });

    if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
      throw new Error('test setup expected a reviewable proposal');
    }

    const stored = await upsertLearningProposal(storePath, proposal, {
      now: () => '2026-06-21T00:00:00.000Z',
    });
    expect(stored.status).toBe('pending');

    const rejected = await updateLearningProposalStatus(storePath, 'p-store', 'rejected', {
      rejectedReason: 'too broad',
      now: () => '2026-06-21T00:01:00.000Z',
    });

    const read = await readLearningProposalStore(storePath);
    expect(rejected.rejectedReason).toBe('too broad');
    expect(read.warnings).toEqual([]);
    expect(read.proposals).toHaveLength(1);
    expect(read.proposals[0]).toMatchObject({
      proposalId: 'p-store',
      status: 'rejected',
      rejectedReason: 'too broad',
    });
  });

  it('clears rejected feedback when a proposal is later approved', async () => {
    const dir = await createTempDir('kodax-learning-store-clear-');
    const storePath = join(dir, 'proposals.json');
    const proposal = triageProceduralLearning({
      proposalId: 'p-clear',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:5'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'The same checklist was reused across completed sessions.',
        trigger: 'When release notes are requested.',
        changeSummary: 'Add the checklist.',
      },
    });
    if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
      throw new Error('test setup expected a reviewable proposal');
    }

    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, 'p-clear', 'rejected', {
      rejectedReason: 'too broad',
    });
    const approved = await updateLearningProposalStatus(storePath, 'p-clear', 'approved');

    expect(approved.status).toBe('approved');
    expect(approved.rejectedReason).toBeUndefined();
  });

  it('blocks consumer-impact workflow handoff approval until acknowledged', async () => {
    const dir = await createTempDir('kodax-learning-approval-');
    const storePath = join(dir, 'proposals.json');
    const blockingImpact: SkillConsumerImpact = {
      workflowCapsules: ['workflow:release'],
      savedWorkflows: [],
      constructedAgents: [],
      promptReferences: [],
      action: 'block_until_manual_review',
    };
    const proposal = triageProceduralLearning({
      proposalId: 'p-approval-impact',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:approval'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'workflow-run-approval',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The captured behavior is executable workflow state, not a method guide.',
        requiredWorkflowEvidence: ['workflow-run-approval'],
        risk: 'medium',
        consumerImpact: blockingImpact,
      },
    });
    if (proposal.destination !== 'workflow_handoff') {
      throw new Error('test setup expected a workflow handoff proposal');
    }

    const stored = await upsertLearningProposal(storePath, proposal, {
      now: () => '2026-06-21T00:03:00.000Z',
    });
    const blocked = await approveStoredLearningProposal(storePath, stored);
    expect(blocked.status).toBe('blocked_consumer_impact');
    if (blocked.status === 'blocked_consumer_impact') {
      expect(blocked.impact).toEqual(blockingImpact);
    }
    const stillPending = await readLearningProposalStore(storePath);
    expect(stillPending.proposals[0]?.status).toBe('pending');

    const approved = await approveStoredLearningProposal(storePath, stored, {
      acknowledgeImpact: true,
      now: () => '2026-06-21T00:04:00.000Z',
    });
    expect(approved.status).toBe('approved_handoff');
    if (approved.status === 'approved_handoff') {
      expect(approved.proposal).toMatchObject({
        proposalId: 'p-approval-impact',
        status: 'approved',
        updatedAt: '2026-06-21T00:04:00.000Z',
      });
      expect(approved.proposal.appliedAt).toBeUndefined();
    }
  });

  it('does not approve a stale pending entry after the current store entry changed status', async () => {
    const dir = await createTempDir('kodax-learning-approval-stale-');
    const storePath = join(dir, 'proposals.json');
    const proposal = triageProceduralLearning({
      proposalId: 'p-approval-stale',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:approval-stale'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'workflow-run-stale',
        workflowStatus: 'completed',
        suggestedAction: 'report_only',
        whyWorkflowNotSkill: 'The captured behavior is workflow-specific evidence.',
        requiredWorkflowEvidence: ['workflow-run-stale'],
        risk: 'low',
        consumerImpact: noConsumerImpact,
      },
    });
    if (proposal.destination !== 'workflow_handoff') {
      throw new Error('test setup expected a workflow handoff proposal');
    }

    const stalePending = await upsertLearningProposal(storePath, proposal, {
      now: () => '2026-06-21T00:05:00.000Z',
    });
    await updateLearningProposalStatus(storePath, 'p-approval-stale', 'rejected', {
      rejectedReason: 'user declined',
      now: () => '2026-06-21T00:06:00.000Z',
    });

    const result = await approveStoredLearningProposal(storePath, stalePending, {
      acknowledgeImpact: true,
      now: () => '2026-06-21T00:07:00.000Z',
    });

    expect(result).toEqual({ status: 'blocked_not_pending', reviewStatus: 'rejected' });
    const read = await readLearningProposalStore(storePath);
    expect(read.proposals[0]).toMatchObject({
      proposalId: 'p-approval-stale',
      status: 'rejected',
      rejectedReason: 'user declined',
      updatedAt: '2026-06-21T00:06:00.000Z',
    });
  });

  it('persists skill application metadata when a proposal is approved', async () => {
    const dir = await createTempDir('kodax-learning-store-applied-');
    const storePath = join(dir, 'proposals.json');
    const proposal = triageProceduralLearning({
      proposalId: 'p-applied',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:applied'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'The same checklist was reused across completed sessions.',
        trigger: 'When release notes are requested.',
        changeSummary: 'Add the checklist.',
      },
    });
    if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
      throw new Error('test setup expected a reviewable proposal');
    }

    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, 'p-applied', 'approved', {
      appliedAt: '2026-06-21T00:02:00.000Z',
      appliedChangedPaths: ['SKILL.md'],
      appliedSnapshotPath: join(dir, 'snapshot'),
      now: () => '2026-06-21T00:02:00.000Z',
    });

    const read = await readLearningProposalStore(storePath);
    expect(read.warnings).toEqual([]);
    expect(read.proposals[0]).toMatchObject({
      status: 'approved',
      appliedAt: '2026-06-21T00:02:00.000Z',
      appliedChangedPaths: ['SKILL.md'],
      appliedSnapshotPath: join(dir, 'snapshot'),
    });
  });

  it('degrades corrupt stores to warnings without returning proposals', async () => {
    const dir = await createTempDir('kodax-learning-corrupt-');
    const storePath = join(dir, 'proposals.json');
    await writeFile(storePath, '{not-json', 'utf8');

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings[0]).toContain('not valid JSON');
  });

  it.each([
    ['approvedAt', 123],
    ['approvalPolicyId', 123],
    ['approvalPolicyReason', 123],
    ['approvalExpectedFingerprints', []],
    ['approvalResultingFingerprints', []],
  ])('warns and refuses to overwrite an invalid %s field', async (field, invalidValue) => {
    const dir = await createTempDir(`kodax-learning-corrupt-${field}-`);
    const storePath = join(dir, 'proposals.json');
    const proposal = triageProceduralLearning({
      proposalId: `p-corrupt-${field}`,
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: [`turn:${field}`],
      candidate: {
        kind: 'skill_patch',
        skillName: `corrupt-${field}`,
        whyDurable: 'Approval metadata must fail loudly when corrupt.',
        trigger: 'When approval metadata is loaded.',
        changeSummary: 'Reject the corrupt store.',
      },
    });
    if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
      throw new Error('test setup expected a reviewable proposal');
    }
    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, proposal.proposalId, 'approved', {
      approvedBy: 'host',
      approvedAt: '2026-07-12T00:00:00.000Z',
      approvalPolicyId: 'policy-v1',
      approvalPolicyReason: 'verified',
      approvalExpectedFingerprints: { before: 'sha256:before' },
      approvalResultingFingerprints: { after: 'sha256:after' },
    });
    const document: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (!isMutableRecord(document) || !Array.isArray(document.proposals)
      || !isMutableRecord(document.proposals[0])) {
      throw new Error('test setup expected a stored proposal document');
    }
    document.proposals[0][field] = invalidValue;
    await writeFile(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const corruptBytes = await readFile(storePath, 'utf8');

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings).toContain(`proposal entry ${proposal.proposalId} has invalid ${field}`);
    await expect(upsertLearningProposal(storePath, proposal)).rejects.toThrow(/refusing to write corrupt/);
    await expect(readFile(storePath, 'utf8')).resolves.toBe(corruptBytes);
  });

  it('rejects trace-only and unknown destinations as reviewable proposals', async () => {
    const dir = await createTempDir('kodax-learning-invalid-store-');
    const storePath = join(dir, 'proposals.json');
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        proposals: [
          {
            proposalId: 'p-trace',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'trace_only',
              proposalId: 'p-trace',
              userLabel: 'trace_only',
              reason: 'low confidence',
              sourceTraceIds: ['turn:6'],
            },
          },
          {
            proposalId: 'p-unknown',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'unknown_carrier',
              proposalId: 'p-unknown',
            },
          },
          {
            proposalId: 'p-malformed-workflow',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'workflow_handoff',
              proposalId: 'p-malformed-workflow',
              origin: 'background_learning',
              userLabel: 'runnable_workflow',
            },
          },
          {
            proposalId: 'p-wrapper',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'skill_patch',
              proposalId: 'p-inner',
              origin: 'background_learning',
              userLabel: 'method_guide',
              skillName: 'release-notes',
              whyDurable: 'The same checklist was reused across completed sessions.',
              trigger: 'When release notes are requested.',
              changeSummary: 'Add the checklist.',
              sourceTraceIds: ['turn:mismatch'],
              confidence: 0.5,
            },
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings).toEqual([
      'proposal entry p-trace has invalid proposal payload',
      'proposal entry p-unknown has invalid proposal payload',
      'proposal entry p-malformed-workflow has invalid proposal payload',
      'proposal entry p-wrapper has mismatched proposal payload id',
    ]);
  });
});

describe('learning intake persistence', () => {
  it('stores completed reviewable skill learning into the inbox', async () => {
    const dir = await createTempDir('kodax-learning-intake-');
    const storePath = join(dir, 'proposals.json');

    const result = await recordProceduralLearning({
      storePath,
      now: () => '2026-06-21T00:00:00.000Z',
      learning: {
        proposalId: 'p-intake',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['turn:intake'],
        candidate: {
          kind: 'skill_patch',
          skillName: 'release-notes',
          whyDurable: 'Repeated completed sessions used the same checklist.',
          trigger: 'When drafting release notes.',
          changeSummary: 'Add checklist.',
        },
      },
    });

    expect(result.stored).toBe(true);
    const store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]).toMatchObject({
      proposalId: 'p-intake',
      status: 'pending',
    });
  });

  it('persists skill apply plans from intake', async () => {
    const dir = await createTempDir('kodax-learning-intake-plan-store-');
    const storePath = join(dir, 'proposals.json');

    await recordProceduralLearning({
      storePath,
      learning: {
        proposalId: 'p-intake-plan',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['turn:intake-plan'],
        candidate: {
          kind: 'skill_patch',
          skillName: 'release-notes',
          whyDurable: 'Repeated completed sessions used the same checklist.',
          trigger: 'When drafting release notes.',
          changeSummary: 'Add checklist.',
        },
      },
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot: join(dir, 'release-notes'),
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
      },
    });

    const store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]?.applyPlan).toMatchObject({
      kind: 'skill',
      skillRoot: join(dir, 'release-notes'),
    });
  });

  it('does not store interrupted or trace-only learning', async () => {
    const dir = await createTempDir('kodax-learning-intake-skip-');
    const storePath = join(dir, 'proposals.json');

    const interrupted = await recordProceduralLearning({
      storePath,
      learning: {
        proposalId: 'p-interrupted-intake',
        origin: 'background_learning',
        completedTurn: false,
        sourceRefs: ['turn:interrupted'],
        candidate: {
          kind: 'skill_patch',
          skillName: 'release-notes',
          whyDurable: 'Repeated completed sessions used the same checklist.',
          trigger: 'When drafting release notes.',
          changeSummary: 'Add checklist.',
        },
      },
    });
    const traceOnly = await recordProceduralLearning({
      storePath,
      learning: {
        proposalId: 'p-trace-intake',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['turn:trace'],
        candidate: {
          kind: 'trace_only',
          reason: 'evidence was not durable enough',
        },
      },
    });

    expect(interrupted.stored).toBe(false);
    expect(traceOnly.stored).toBe(false);
    const store = await readLearningProposalStore(storePath);
    expect(store.proposals).toEqual([]);
  });

  it('allows apply plans only on skill learning candidates', async () => {
    const dir = await createTempDir('kodax-learning-intake-plan-');
    const storePath = join(dir, 'proposals.json');

    await expect(recordProceduralLearning({
      storePath,
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot: join(dir, 'skill'),
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'content' }],
      },
      learning: {
        proposalId: 'p-invalid-plan',
        origin: 'background_learning',
        completedTurn: true,
        sourceRefs: ['workflow:wf-invalid-plan'],
        candidate: {
          kind: 'workflow_handoff',
          workflowRunId: 'wf-invalid-plan',
          workflowStatus: 'completed',
          suggestedAction: 'save_from_run',
          whyWorkflowNotSkill: 'The learning is a workflow.',
          requiredWorkflowEvidence: ['completed run'],
          risk: 'low',
          consumerImpact: noConsumerImpact,
        },
      },
    })).rejects.toThrow(/only be attached to skill/);
  });
});

describe('skill usage and trust ledgers', () => {
  it('records usage telemetry for readonly skills without requiring mutation authority', async () => {
    const root = await createTempDir('kodax-learning-ledger-');
    const usagePath = join(root, 'usage.json');

    const first = await recordSkillUsage(usagePath, {
      skillName: 'builtin-review',
      source: 'builtin',
      event: 'view',
      now: () => '2026-06-21T00:00:00.000Z',
    });
    const second = await recordSkillUsage(usagePath, {
      skillName: 'builtin-review',
      source: 'builtin',
      event: 'invoke',
      now: () => '2026-06-21T00:01:00.000Z',
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(true);
    const ledger = await readSkillUsageLedger(usagePath);
    expect(ledger.records).toEqual([
      expect.objectContaining({
        skillName: 'builtin-review',
        source: 'builtin',
        views: 1,
        invokes: 1,
        lastEventAt: '2026-06-21T00:01:00.000Z',
      }),
    ]);
  });

  it('keeps usage telemetry best-effort when the sidecar is corrupt', async () => {
    const root = await createTempDir('kodax-learning-ledger-corrupt-');
    const usagePath = join(root, 'usage.json');
    await writeFile(usagePath, '{not-json', 'utf8');

    const result = await recordSkillUsage(usagePath, {
      skillName: 'broken',
      source: 'project',
      event: 'view',
    });

    expect(result.recorded).toBe(false);
    expect(result.warnings.join('\n')).toContain('not valid JSON');
  });

  it('allows trust lifecycle only for background-created project or user skills', async () => {
    const root = await createTempDir('kodax-learning-trust-');
    const trustPath = join(root, 'trust.json');

    const blocked = await updateSkillTrustLedger(trustPath, {
      skillName: 'human-skill',
      source: 'project',
      ownership: 'human',
      origin: 'background_learning',
      state: 'trusted',
    });
    const allowed = await updateSkillTrustLedger(trustPath, {
      skillName: 'agent-skill',
      source: 'project',
      ownership: 'background_created',
      origin: 'background_learning',
      state: 'provisional',
      reason: 'created from completed learning proposal',
      now: () => '2026-06-21T00:02:00.000Z',
    });

    expect(blocked.updated).toBe(false);
    expect(blocked.reason).toContain('background-created');
    expect(allowed.updated).toBe(true);
    const ledger = await readSkillTrustLedger(trustPath);
    expect(ledger.records).toEqual([
      expect.objectContaining({
        skillName: 'agent-skill',
        state: 'provisional',
        createdByAgent: true,
      }),
    ]);
  });

  it('resolves project-specific ledger paths next to the proposal store', () => {
    const cwd = process.cwd();
    expect(resolveSkillUsageLedger(cwd)).toContain('learning');
    expect(resolveSkillTrustLedger(cwd)).toContain('learning');
    expect(resolveSkillUsageLedger(cwd)).not.toBe(resolveSkillTrustLedger(cwd));
  });
});

describe('skill consumer impact scanner', () => {
  it('finds workflow, agent, and prompt references and blocks manual-review mutations', async () => {
    const root = await createTempDir('kodax-learning-consumers-');
    const workflowDir = join(root, 'workflows');
    const agentDir = join(root, 'agents');
    const promptDir = join(root, 'prompts');
    await mkdir(workflowDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(workflowDir, 'capsule.json'), '{"requires":{"skills":["release-notes"]}}', 'utf8');
    await writeFile(join(agentDir, 'reviewer.md'), 'Use /skill:release-notes before final.', 'utf8');
    await writeFile(join(promptDir, 'prompt.md'), 'Relevant skill: release-notes', 'utf8');

    const impact = await computeSkillConsumerImpact({
      skillName: 'release-notes',
      workflowCapsuleDirs: [workflowDir],
      savedWorkflowDirs: [workflowDir],
      constructedAgentDirs: [agentDir],
      promptReferenceDirs: [promptDir],
    });

    expect(impact.workflowCapsules).toHaveLength(1);
    expect(impact.savedWorkflows).toHaveLength(1);
    expect(impact.constructedAgents).toHaveLength(1);
    expect(impact.promptReferences).toHaveLength(1);
    expect(impact.action).toBe('block_until_manual_review');
  });

  it('returns no impact when no references exist', async () => {
    const root = await createTempDir('kodax-learning-consumers-none-');
    await writeFile(join(root, 'note.md'), 'No skill reference here.', 'utf8');

    await expect(computeSkillConsumerImpact({
      skillName: 'release-notes',
      promptReferenceDirs: [root],
    })).resolves.toEqual(noConsumerImpact);
  });
});

describe('completed-turn learning bridge', () => {
  it('records explicit candidates only after a complete user and assistant turn', async () => {
    const root = await createTempDir('kodax-learning-turn-');
    const storePath = join(root, 'proposals.json');

    const result = await recordCompletedTurnLearning({
      storePath,
      sessionId: 'session-1',
      completedTurn: true,
      userMessage: 'Please draft release notes.',
      assistantMessage: 'Here are release notes.',
      sourceRefs: ['session:session-1'],
      candidates: [
        {
          candidate: {
            kind: 'skill_patch',
            skillName: 'release-notes',
            whyDurable: 'Two completed turns used the same release-note checklist.',
            trigger: 'When drafting release notes.',
            changeSummary: 'Add release-note review checklist.',
          },
        },
      ],
      now: () => '2026-06-21T00:03:00.000Z',
    });

    expect(result.stored).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    const store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]?.proposalId).toBe('session-1-0');
  });

  it('skips interrupted or empty turns before persistence', async () => {
    const root = await createTempDir('kodax-learning-turn-skip-');
    const storePath = join(root, 'proposals.json');

    const result = await recordCompletedTurnLearning({
      storePath,
      sessionId: 'session-2',
      completedTurn: false,
      userMessage: 'Please draft release notes.',
      assistantMessage: 'Here are release notes.',
      candidates: [
        {
          candidate: {
            kind: 'skill_patch',
            skillName: 'release-notes',
            whyDurable: 'Two completed turns used the same release-note checklist.',
            trigger: 'When drafting release notes.',
            changeSummary: 'Add release-note review checklist.',
          },
        },
      ],
    });

    expect(result.stored).toHaveLength(0);
    expect(result.skipped[0]?.result.destination).toBe('discard');
    await expect(readLearningProposalStore(storePath)).resolves.toEqual({ proposals: [], warnings: [] });
  });
});
