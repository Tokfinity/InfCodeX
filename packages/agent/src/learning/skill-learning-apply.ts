import {
  applySkillMutationProposal,
} from './skill-safe-apply.js';
import {
  decideSkillGovernance,
} from './skill-governance.js';
import type {
  SkillLearningApplyInput,
  SkillMutationApplyResult,
} from './types.js';

function ensureSkillProposal(input: SkillLearningApplyInput): 'skill_patch' | 'skill_create' {
  const destination = input.proposal.destination;
  if (destination !== 'skill_patch' && destination !== 'skill_create') {
    throw new Error('F224 apply path supports only skill proposals');
  }
  return destination;
}

function ensureGovernanceMatchesProposal(
  input: SkillLearningApplyInput,
  destination: 'skill_patch' | 'skill_create',
): void {
  const expectedAction = destination === 'skill_create' ? 'create' : 'patch';
  if (input.governance.action !== expectedAction) {
    throw new Error(`skill ${destination} requires governance action ${expectedAction}`);
  }
}

function ensureCreatePlanIncludesSkillFile(input: SkillLearningApplyInput): void {
  if (input.proposal.destination !== 'skill_create') return;
  const hasSkillFile = input.changes.some(
    (change) => change.kind === 'write' && change.relativePath.replace(/\\/g, '/') === 'SKILL.md',
  );
  if (!hasSkillFile) {
    throw new Error('skill_create proposals must include SKILL.md');
  }
}

export async function applySkillLearningProposal(
  input: SkillLearningApplyInput,
): Promise<SkillMutationApplyResult> {
  const destination = ensureSkillProposal(input);
  ensureGovernanceMatchesProposal(input, destination);
  ensureCreatePlanIncludesSkillFile(input);

  const governance = decideSkillGovernance(input.governance);
  if (!governance.allowed) {
    throw new Error(`skill proposal blocked by governance: ${governance.reason}`);
  }
  if (governance.mode === 'overlay_proposal') {
    throw new Error('readonly skill sources require an overlay proposal; F224 will not mutate the source skill');
  }
  if (governance.mode !== 'proposal') {
    throw new Error(`skill proposal requires a mutable proposal path; got ${governance.mode}`);
  }

  return applySkillMutationProposal({
    proposalId: input.proposal.proposalId,
    skillRoot: input.skillRoot,
    approved: input.approved,
    changes: input.changes,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.snapshotRoot !== undefined ? { snapshotRoot: input.snapshotRoot } : {}),
    createSkillRoot: destination === 'skill_create',
  });
}
