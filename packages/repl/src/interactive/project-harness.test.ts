import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectHarnessAttempt } from './project-harness.js';
import { ProjectStorage } from './project-storage.js';

describe('project harness', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-project-harness-'));
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'Add verifier-gated project execution',
        },
      ],
    });
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks direct writes to feature_list.json during harnessed execution', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'write',
      { path: storage.getPaths().features, content: '{}' },
    );

    expect(typeof allowed).toBe('string');
    expect(String(allowed)).toContain('Blocked by Project Harness');
  });

  it('verifies a completed attempt when progress is updated and a completion report is present', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 1\n\nCompleted verifier wiring.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"tests":["manual check"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');
    expect(result.runRecord.changedFiles[0]).toContain('src');
    expect(result.evidenceRecord.completionSource).toBe('auto_verified');
  });
});
