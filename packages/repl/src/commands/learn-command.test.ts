import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readLearningProposalStore,
  resolveLearningProposalStore,
  setAgentConfigHome,
  triageProceduralLearning,
  updateLearningProposalStatus,
  upsertLearningProposal,
  type ReviewableLearningProposal,
} from '@kodax-ai/agent';

import { learnCommand } from './learn-command.js';
import { memoryCommand } from './memory-command.js';
import { workflowCommand } from './workflow-command.js';
import { BUILTIN_COMMANDS } from '../interactive/commands.js';

interface CapturedLog {
  readonly lines: readonly string[];
  contains: (needle: string) => boolean;
}

function captureOutput(): { readonly log: CapturedLog; readonly restore: () => void } {
  const lines: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((entry) => String(entry)).join(' '));
  });
  return {
    log: {
      lines,
      contains: (needle: string) => lines.some((line) => line.includes(needle)),
    },
    restore: () => {
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
    },
  };
}

function buildContext(cwd: string) {
  return {
    messages: [],
    runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
  };
}

function getSkillCommand() {
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === 'skill');
  if (!command) {
    throw new Error('test setup expected /skill command');
  }
  return command;
}

async function invoke(args: readonly string[], cwd: string): Promise<void> {
  await learnCommand.handler(
    [...args],
    buildContext(cwd) as never,
    {} as never,
    {} as never,
  );
}

function requireReviewable(proposal: ReturnType<typeof triageProceduralLearning>): ReviewableLearningProposal {
  if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
    throw new Error('test setup expected a reviewable proposal');
  }
  return proposal;
}

describe('FEATURE_224 /learn command', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-learn-cmd-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-learn-cmd-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('lists pending learning suggestions', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-list',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:list'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await invoke(['pending'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('pending learning suggestions')).toBe(true);
    expect(log.contains('p-list')).toBe(true);
    expect(log.contains('release-notes')).toBe(true);
  });

  it('approves and applies skill plans', async () => {
    const skillRoot = path.join(cwd, '.kodax', 'skills', 'release-notes');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-approve',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:approve'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal, {
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot,
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
      },
    });

    const { log, restore } = captureOutput();
    try {
      await invoke(['approve', 'p-approve'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('approved and applied p-approve')).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('new skill');
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('approved');
    expect(store.proposals[0]?.appliedAt).toBeTruthy();
    expect(store.proposals[0]?.appliedChangedPaths).toEqual(['SKILL.md']);
    expect(store.proposals[0]?.appliedSnapshotPath).toBeTruthy();
  });

  it('approves crash-recovered skill plans when files already match', async () => {
    const skillRoot = path.join(cwd, '.kodax', 'skills', 'release-notes-recovered');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'new skill', 'utf8');
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-recovered',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:recovered'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes-recovered',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal, {
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot,
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
      },
    });

    const { log, restore } = captureOutput();
    try {
      await invoke(['approve', 'p-recovered'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('files already match the apply plan')).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('new skill');
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('approved');
    expect(store.proposals[0]?.appliedChangedPaths).toEqual(['SKILL.md']);
  });

  it('refuses to reapply pending skill plans over edits made after a snapshot', async () => {
    const skillRoot = path.join(cwd, '.kodax', 'skills', 'release-notes-conflict');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');
    const storePath = resolveLearningProposalStore(cwd);
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-conflict',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:conflict'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes-conflict',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(storePath, proposal, {
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot,
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
      },
    });

    const first = captureOutput();
    try {
      await invoke(['approve', 'p-conflict'], cwd);
    } finally {
      first.restore();
    }
    await updateLearningProposalStatus(storePath, 'p-conflict', 'pending');
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'manual edit', 'utf8');

    const { log, restore } = captureOutput();
    try {
      await invoke(['approve', 'p-conflict'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('refusing to reapply p-conflict')).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('manual edit');
    const store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('does not apply a proposal twice after approval', async () => {
    const skillRoot = path.join(cwd, '.kodax', 'skills', 'release-notes-once');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'old skill', 'utf8');
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-once',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:once'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes-once',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal, {
      applyPlan: {
        kind: 'skill',
        governance: {
          action: 'patch',
          source: 'project',
          ownership: 'human',
          origin: 'background_learning',
        },
        skillRoot,
        changes: [{ kind: 'write', relativePath: 'SKILL.md', content: 'new skill' }],
      },
    });

    const first = captureOutput();
    try {
      await invoke(['approve', 'p-once'], cwd);
    } finally {
      first.restore();
    }
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), 'manual edit', 'utf8');
    const { log, restore } = captureOutput();
    try {
      await invoke(['approve', 'p-once'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('is already approved')).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('manual edit');
  });

  it('does not approve skill proposals without an apply plan', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-no-plan',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:no-plan'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await invoke(['approve', 'p-no-plan'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('has no skill apply plan')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('rejects proposals with feedback', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-reject',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:reject'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-reject',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The learning is a repeatable phase graph.',
        requiredWorkflowEvidence: ['completed run'],
        risk: 'low',
        consumerImpact: {
          workflowCapsules: [],
          savedWorkflows: [],
          constructedAgents: [],
          promptReferences: [],
          action: 'none',
        },
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { restore } = captureOutput();
    try {
      await invoke(['reject', 'p-reject', 'too', 'broad'], cwd);
    } finally {
      restore();
    }

    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]).toMatchObject({
      status: 'rejected',
      rejectedReason: 'too broad',
    });
  });

  it('requires explicit impact acknowledgement before approving impacted workflow handoffs', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-impact',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:impact'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-impact',
        workflowStatus: 'completed',
        suggestedAction: 'revise_capsule',
        whyWorkflowNotSkill: 'The learning is a repeatable phase graph.',
        requiredWorkflowEvidence: ['completed run'],
        risk: 'medium',
        consumerImpact: {
          workflowCapsules: ['workflows/release.json'],
          savedWorkflows: [],
          constructedAgents: [],
          promptReferences: ['prompts/release.md'],
          action: 'block_until_manual_review',
        },
      },
    }));
    const storePath = resolveLearningProposalStore(cwd);
    await upsertLearningProposal(storePath, proposal);

    const blocked = captureOutput();
    try {
      await invoke(['approve', 'p-impact'], cwd);
    } finally {
      blocked.restore();
    }

    expect(blocked.log.contains('requires manual consumer-impact review')).toBe(true);
    let store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]?.status).toBe('pending');

    const acknowledged = captureOutput();
    try {
      await invoke(['approve', 'p-impact', '--ack-impact'], cwd);
    } finally {
      acknowledged.restore();
    }

    expect(acknowledged.log.contains('approved p-impact as a downstream handoff')).toBe(true);
    store = await readLearningProposalStore(storePath);
    expect(store.proposals[0]?.status).toBe('approved');
    expect(store.proposals[0]?.appliedAt).toBeUndefined();
  });

  it('keeps pending read-only when store entries contain warnings', async () => {
    const storePath = resolveLearningProposalStore(cwd);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({
        version: 1,
        proposals: [
          {
            proposalId: 'p-bad',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'unknown_carrier',
              proposalId: 'p-bad',
            },
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );

    const { log, restore } = captureOutput();
    try {
      await invoke(['pending'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('invalid proposal payload')).toBe(true);
    expect(log.contains('pending learning suggestions')).toBe(true);
    expect(log.contains('refusing to mutate')).toBe(false);
  });

  it('shows skill suggestions through /skill pending', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-skill-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:skill-filter'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await getSkillCommand().handler(['pending'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('pending method guides')).toBe(true);
    expect(log.contains('p-skill-filter')).toBe(true);
  });

  it('shows workflow suggestions through /workflow pending', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-workflow-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:workflow-filter'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-filter',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The learning is a repeatable phase graph.',
        requiredWorkflowEvidence: ['completed run'],
        risk: 'low',
        consumerImpact: {
          workflowCapsules: [],
          savedWorkflows: [],
          constructedAgents: [],
          promptReferences: [],
          action: 'none',
        },
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await workflowCommand.handler(['pending'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('pending runnable workflows')).toBe(true);
    expect(log.contains('p-workflow-filter')).toBe(true);
  });

  it('shows memory suggestions through /memory pending', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-memory-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:memory-filter'],
      candidate: {
        kind: 'memdir_handoff',
        memoryKind: 'project',
        body: 'This project tracks feature designs in docs/features.',
        metadata: {
          writeOrigin: 'background_learning',
          executionContext: 'primary',
          sessionId: 's-memory',
          sourceRefs: ['turn:memory-filter'],
          completedTurn: true,
        },
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await memoryCommand.handler(['pending'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('pending memory proposals')).toBe(true);
    expect(log.contains('p-memory-filter')).toBe(true);
  });
});
