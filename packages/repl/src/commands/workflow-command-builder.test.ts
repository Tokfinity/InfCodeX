import { describe, expect, it } from 'vitest';

import { buildWorkflowProcessMetadata } from './workflow-command-builder.js';

describe('buildWorkflowProcessMetadata', () => {
  it('passes hostMetadata through as defensive copy', () => {
    const hostMetadata = { sessionId: 'session-1', tag: 'coder' };

    const metadata = buildWorkflowProcessMetadata({
      source: 'sdk',
      displayName: 'Generated workflow',
      hostMetadata,
    });

    expect(metadata.hostMetadata).toEqual({ sessionId: 'session-1', tag: 'coder' });
    expect(metadata.hostMetadata).not.toBe(hostMetadata);
  });
});
