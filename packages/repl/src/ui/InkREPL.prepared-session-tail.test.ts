import { createSessionLineage } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { createPreparedSessionTail } from './InkREPL.js';
import type { PreparedSessionAppendBaseline } from '../interactive/storage.js';
import type { SessionData } from './utils/session-storage.js';

function fixture(): {
  baseline: PreparedSessionAppendBaseline;
  data: SessionData;
} {
  const messages = [{ role: 'user' as const, content: 'prepared helper base' }];
  const lineage = createSessionLineage(messages);
  return {
    baseline: {
      sessionId: 'prepared-helper-session',
      revision: 'prepared-helper-revision',
      lineageCount: lineage.entries.length,
      artifactCount: 1,
      extensionCount: 0,
      activeEntryId: lineage.activeEntryId,
    },
    data: {
      messages,
      title: 'Prepared helper',
      gitRoot: '/repo',
      lineage,
      artifactLedger: [{
        id: 'artifact-replacement',
        kind: 'file_read',
        target: 'same.ts',
        timestamp: '2026-08-02T00:00:01.000Z',
      }],
    },
  };
}

describe('createPreparedSessionTail', () => {
  it('forces the exact path for an in-place artifact replacement', () => {
    const { baseline, data } = fixture();

    expect(createPreparedSessionTail(data, baseline, true)).toBeUndefined();
  });

  it('forces the exact path for a fixed-cap artifact rollover', () => {
    const { baseline, data } = fixture();
    const artifactLedger = Array.from({ length: 256 }, (_, index) => ({
      id: `rollover-${index}`,
      kind: 'file_read',
      target: `rollover-${index}.ts`,
      timestamp: '2026-08-02T00:00:01.000Z',
    }));
    data.artifactLedger = artifactLedger;

    expect(createPreparedSessionTail(
      data,
      { ...baseline, artifactCount: artifactLedger.length },
      true,
    )).toBeUndefined();
  });

  it('forces the exact path when runtime migration changed non-tail metadata', () => {
    const { baseline, data } = fixture();
    data.runtimeInfo = {
      workspaceRoot: '/replacement-workspace',
      executionCwd: '/replacement-workspace',
    };

    expect(createPreparedSessionTail(data, baseline, true)).toBeUndefined();
  });
});
