import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type {
  LearnedCapabilityCanary,
  LearnedCapabilityRecord,
  LearnedCapabilityRecordV2,
  LearningAction,
  LearningActionDriver,
} from './center-types.js';
import {
  LearningCapabilityError,
  assertLearnedCapabilityTransition,
} from './center-types.js';
import { isLearnedCapabilityRecordV2 } from './learned-skill.js';

export interface CreateLearnedSkillActionDriverOptions {
  readonly learnedAreaRoot: string;
  readonly learnedAreaKind?: 'global' | 'project';
  readonly userSkillsRoot: string;
  readonly now?: () => string;
}

const DRIVER_ACTIONS = ['review', 'trust', 'rollback', 'promote'] as const;

/**
 * Explicit-user actions for one project Learned Area.
 *
 * The Learning Center invokes this driver while holding the carrier owner
 * lock, then commits the returned next record with the usual revision CAS.
 */
export function createLearnedSkillActionDriver(
  options: CreateLearnedSkillActionDriverOptions,
): LearningActionDriver {
  return {
    carrier: 'skill',
    actions: DRIVER_ACTIONS,
    execute: async (action, capability) => {
      const current = requireLearnedSkill(capability);
      const now = options.now?.() ?? new Date().toISOString();
      if (action === 'rollback') return rollbackRecord(current, now);
      if (action === 'review') {
        return transitionRecord(current, 'testing', now, {
          canary: resetCanary(),
          lastAction: action,
        });
      }
      if (action === 'trust') {
        return transitionRecord(current, 'active_learned', now, {
          previousGoodRevision: current.previousGoodRevision
            ?? current.artifact.contentRevision,
          previousGoodArtifact: current.previousGoodArtifact
            ?? current.artifact,
          lastAction: action,
        });
      }
      if (action === 'promote') {
        await promoteExactArtifact(options, current);
        return transitionRecord(current, 'promoted_user', now, { lastAction: action });
      }
      throw new LearningCapabilityError(
        'unsupported_action',
        `unsupported learned Skill action: ${String(action)}`,
      );
    },
  };
}

function requireLearnedSkill(
  capability: LearnedCapabilityRecord,
): LearnedCapabilityRecordV2 {
  if (!isLearnedCapabilityRecordV2(capability)
    || capability.source.kind !== 'skill_learning_loop') {
    throw new LearningCapabilityError(
      'unsupported_action',
      'the capability is not an F263 learned Skill',
    );
  }
  return capability;
}

function transitionRecord(
  current: LearnedCapabilityRecordV2,
  lifecycle: LearnedCapabilityRecordV2['lifecycle'],
  now: string,
  patch: Partial<LearnedCapabilityRecordV2>,
): LearnedCapabilityRecordV2 {
  if (current.lifecycle !== lifecycle) {
    assertLearnedCapabilityTransition(current.lifecycle, lifecycle);
  }
  return {
    ...current,
    ...patch,
    lifecycle,
    revision: current.revision + 1,
    updatedAt: now,
  };
}

function rollbackRecord(
  current: LearnedCapabilityRecordV2,
  now: string,
): LearnedCapabilityRecordV2 {
  if (current.previousGoodArtifact === undefined
    || current.previousGoodRevision === undefined) {
    throw new LearningCapabilityError(
      'invalid_transition',
      'learned Skill has no immutable previous good revision',
    );
  }
  const restoredArtifact = current.previousGoodArtifact;
  return {
    ...current,
    lifecycle: 'active_learned',
    revision: current.revision + 1,
    updatedAt: now,
    lastAction: 'rollback',
    artifactPath: restoredArtifact.relativePath,
    artifact: restoredArtifact,
    previousGoodRevision: restoredArtifact.contentRevision,
    previousGoodArtifact: restoredArtifact,
    previousLifecycle: current.lifecycle,
    canary: resetCanary(),
  };
}

function resetCanary(): LearnedCapabilityCanary {
  return {
    maxInvocations: 3,
    invocationCount: 0,
    verifiedSuccesses: 0,
    credibleNegatives: 0,
    invocations: [],
  };
}

async function promoteExactArtifact(
  options: CreateLearnedSkillActionDriverOptions,
  current: LearnedCapabilityRecordV2,
): Promise<void> {
  const learnedAreaRoot = capabilityAreaRoot(options, current);
  const source = resolve(
    learnedAreaRoot,
    ...current.artifact.relativePath.split('/'),
  );
  assertInside(source, learnedAreaRoot);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'learned Skill promotion source is not a regular file',
    );
  }
  const content = await readFile(source, 'utf8');
  if (sha256(content) !== current.artifact.fingerprint) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'learned Skill promotion source fingerprint changed',
    );
  }
  const destination = resolve(options.userSkillsRoot, current.slug, 'SKILL.md');
  assertInside(destination, options.userSkillsRoot);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const handle = await open(destination, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileError(error, 'EEXIST')) throw error;
    if (await readFile(destination, 'utf8') !== content) {
      throw new LearningCapabilityError(
        'action_failed',
        `formal user Skill already exists with different content: ${current.slug}`,
      );
    }
  }
}

function capabilityAreaRoot(
  options: CreateLearnedSkillActionDriverOptions,
  current: LearnedCapabilityRecordV2,
): string {
  const normalized = resolve(options.learnedAreaRoot);
  if (options.learnedAreaKind === 'project'
    || (options.learnedAreaKind === undefined && normalized.endsWith(join(
      'projects',
      current.scope.tenantHash,
      current.scope.projectHash,
    )))) {
    return normalized;
  }
  return join(
    normalized,
    'projects',
    current.scope.tenantHash,
    current.scope.projectHash,
  );
}

function assertInside(target: string, rootDir: string): void {
  const root = comparable(rootDir);
  const candidate = comparable(target);
  if (candidate !== root
    && !candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'learned Skill path escaped its configured owner root',
    );
  }
}

function comparable(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
