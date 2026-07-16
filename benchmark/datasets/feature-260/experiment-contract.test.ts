import { describe, expect, it } from 'vitest';

import {
  buildFeature260ExperimentManifest,
  hashFeature260SourceSnapshot,
} from './experiment-contract.js';

describe('FEATURE_260 experiment provenance', () => {
  it('binds untracked paths and bytes into the source snapshot', () => {
    const base = hashFeature260SourceSnapshot('tracked patch', [
      { path: 'new/a.ts', content: Buffer.from('alpha') },
      { path: 'new/b.ts', content: Buffer.from('beta') },
    ]);
    const reordered = hashFeature260SourceSnapshot('tracked patch', [
      { path: 'new/b.ts', content: Buffer.from('beta') },
      { path: 'new/a.ts', content: Buffer.from('alpha') },
    ]);
    const changed = hashFeature260SourceSnapshot('tracked patch', [
      { path: 'new/a.ts', content: Buffer.from('changed') },
      { path: 'new/b.ts', content: Buffer.from('beta') },
    ]);

    expect(reordered).toEqual(base);
    expect(changed.combinedSha256).not.toBe(base.combinedSha256);
    expect(base.untrackedFileCount).toBe(2);
  });

  it('writes the combined source snapshot into the manifest', () => {
    const manifest = buildFeature260ExperimentManifest() as {
      readonly schemaVersion: number;
      readonly sourceSnapshot: {
        readonly combinedSha256: string;
        readonly untrackedFileCount: number;
      };
    };

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.sourceSnapshot.combinedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sourceSnapshot.untrackedFileCount).toBeGreaterThanOrEqual(0);
  });
});
