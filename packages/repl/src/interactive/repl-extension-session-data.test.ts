import { describe, expect, it } from 'vitest';

import { createInteractiveContext } from './context.js';
import { contextExtensionSessionData } from './repl.js';

describe('contextExtensionSessionData', () => {
  it('omits clean extension session data from save payloads', async () => {
    const context = await createInteractiveContext({
      existingExtensionState: { 'ext:sample': { visits: 1 } },
      existingExtensionRecords: [{
        id: 'record-1',
        extensionId: 'ext:sample',
        type: 'note',
        ts: 1,
        data: { ok: true },
      }],
    });

    expect(contextExtensionSessionData(context)).toEqual({});
  });

  it('includes dirty extension session data, including explicit clears', async () => {
    const context = await createInteractiveContext({});
    context.extensionStateDirty = true;
    context.extensionRecordsDirty = true;

    expect(contextExtensionSessionData(context)).toEqual({
      extensionState: {},
      extensionRecords: [],
    });
  });
});
