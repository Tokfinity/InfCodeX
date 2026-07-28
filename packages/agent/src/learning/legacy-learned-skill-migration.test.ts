import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LearnedCapabilityRecordV1 } from './center-types.js';
import { LearnedAreaStore } from './learned-area-store.js';
import { migrateLegacyLearnedSkillsForProject } from './legacy-learned-skill-migration.js';
import {
  createLearnedCapabilityScope,
  resolveProjectLearnedAreaRoot,
} from './learned-skill.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FEATURE_263 legacy loose learned Skill migration', () => {
  it('fails closed for v1 records without a trusted historical fingerprint', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-legacy-learned-'));
    roots.push(configHome);
    const legacyRoot = join(configHome, 'learned');
    const trustedDir = join(legacyRoot, 'skills', 'trusted-check');
    const looseDir = join(legacyRoot, 'skills', 'unregistered-check');
    await mkdir(trustedDir, { recursive: true });
    await mkdir(looseDir, { recursive: true });
    const trustedFile = join(trustedDir, 'SKILL.md');
    await writeFile(trustedFile, [
      '---',
      'name: trusted-check',
      'description: Check the release.',
      '---',
      'Run the exact release checks.',
    ].join('\n'), 'utf8');
    await writeFile(join(looseDir, 'SKILL.md'), [
      '---',
      'name: unregistered-check',
      'description: Unregistered check.',
      '---',
      'Do not activate without review.',
    ].join('\n'), 'utf8');
    const globalStore = new LearnedAreaStore(legacyRoot);
    await globalStore.initialize();
    const legacy: LearnedCapabilityRecordV1 = {
      schemaVersion: 1,
      capabilityId: 'lc_legacy_trusted',
      displayName: 'Trusted check',
      slug: 'trusted-check',
      carrier: 'skill',
      lifecycle: 'active_learned',
      revision: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      source: { kind: 'learning_controller' },
      artifactPath: trustedFile,
    };
    await globalStore.writeCapability(legacy);
    const scope = createLearnedCapabilityScope(configHome, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    });
    const projectStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    }));
    await projectStore.initialize();

    const first = await migrateLegacyLearnedSkillsForProject(configHome, projectStore, scope);
    const second = await migrateLegacyLearnedSkillsForProject(configHome, projectStore, scope);
    const records = await projectStore.listCapabilities();

    expect(first).toEqual({
      migratedActive: 0,
      recordedAttention: 2,
      alreadyComplete: false,
    });
    expect(second.alreadyComplete).toBe(true);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schemaVersion: 1,
        slug: 'trusted-check',
        lifecycle: 'ready',
        source: { kind: 'legacy_manual' },
      }),
      expect.objectContaining({
        schemaVersion: 1,
        slug: 'unregistered-check',
        lifecycle: 'ready',
        source: { kind: 'legacy_manual' },
      }),
    ]));
  });
});
