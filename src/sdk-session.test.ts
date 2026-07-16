import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compactSession,
  createSessionManager,
  listSessions,
} from '@kodax-ai/kodax/session';

describe('@kodax-ai/kodax/session SDK subpath', () => {
  it('exports the session facade including imperative compactSession', async () => {
    expect(typeof listSessions).toBe('function');
    expect(typeof createSessionManager).toBe('function');
    expect(typeof compactSession).toBe('function');

    const result = await compactSession('missing-session', {
      sessionsDir: path.join(os.tmpdir(), `kodax-sdk-session-${process.pid}-${Date.now()}`),
    });

    expect(result.compacted).toBe(false);
    expect(result.reason).toContain('not found');
  });
});
