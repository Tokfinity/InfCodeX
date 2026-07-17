import type {
  GovernedSkillSource,
  SkillGovernanceDecision,
  SkillGovernanceInput,
  SkillWriteOrigin,
} from './types.js';

const READONLY_SOURCES: ReadonlySet<GovernedSkillSource> = new Set([
  'builtin',
  'plugin',
  'learned',
  'external',
]);

const DESTRUCTIVE_ACTIONS = new Set([
  'archive',
  'quarantine',
  'delete',
  'consolidate',
]);

export function canMarkCreatedByAgent(origin: SkillWriteOrigin): boolean {
  return origin === 'background_learning';
}

export function decideSkillGovernance(
  input: SkillGovernanceInput,
): SkillGovernanceDecision {
  if (input.action === 'record_usage') {
    return {
      allowed: true,
      mode: 'telemetry',
      reason: 'usage telemetry is best-effort and source-independent',
    };
  }

  if (input.pinned && DESTRUCTIVE_ACTIONS.has(input.action)) {
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'pinned skills cannot be archived, quarantined, deleted, or consolidated',
    };
  }

  if (input.action === 'direct_mutation') {
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'F224 only applies explicit approved proposals, not direct skill mutation',
    };
  }

  if (input.action === 'delete') {
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'delete is outside the F224 learning loop',
    };
  }

  if (READONLY_SOURCES.has(input.source)) {
    if (input.action === 'patch') {
      return {
        allowed: true,
        mode: 'overlay_proposal',
        reason: 'readonly skill sources can receive overlay proposals only',
      };
    }
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'readonly skill sources cannot be curated by F224',
    };
  }

  if (input.action === 'create') {
    if (input.origin !== 'background_learning') {
      return {
        allowed: false,
        mode: 'blocked',
        reason: 'learning-created skills require background_learning origin',
      };
    }
    if (input.ownership !== 'background_created') {
      return {
        allowed: false,
        mode: 'blocked',
        reason: 'learning-created skills must be marked as background-created',
      };
    }
    return {
      allowed: true,
      mode: 'proposal',
      reason: 'background learning can create reviewable project or user skill proposals',
    };
  }

  if (input.action === 'patch') {
    return {
      allowed: true,
      mode: 'proposal',
      reason: 'project and user skills can receive reviewable patch proposals',
    };
  }

  if (input.ownership !== 'background_created') {
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'only background-created skills are eligible for automatic curation proposals',
    };
  }

  if (!canMarkCreatedByAgent(input.origin)) {
    return {
      allowed: false,
      mode: 'blocked',
      reason: 'automatic curation requires background_learning origin',
    };
  }

  return {
    allowed: true,
    mode: 'proposal',
    reason: 'background-created project or user skill is eligible for reviewable curation',
  };
}
