import { describe, expect, it } from 'vitest';

import {
  createSessionSourceRevision,
  createSessionSourceRevisionState,
  extendSessionMainSourceRevisionState,
} from './source-revision.js';

describe('Session source revision state', () => {
  it.each([
    ['file ending in LF', Buffer.from('meta\nentry\n'), Buffer.from('\nnext\nmeta-update')],
    ['file without trailing LF', Buffer.from('meta\nentry'), Buffer.from('\nnext\nmeta-update')],
    ['empty lines and CRLF', Buffer.from('meta\r\n\r\nentry'), Buffer.from('\n\r\nnext')],
    ['append crossing a source chunk', Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from('\nbc')],
    ['append after an exact source chunk', Buffer.alloc(64 * 1024, 0x62), Buffer.from('\nnext')],
  ])('extends %s to the same exact revision as a full recompute', (
    _name,
    before,
    appended,
  ) => {
    const files = [
      { kind: 'main' as const, relativePath: 'project/session.jsonl', bytes: before },
      {
        kind: 'islands' as const,
        relativePath: 'project/session.islands.jsonl',
        bytes: Buffer.from('island\n'),
      },
    ];
    const initial = createSessionSourceRevisionState(files);
    const extended = extendSessionMainSourceRevisionState(
      initial,
      'project/session.jsonl',
      appended,
    );
    const recomputed = createSessionSourceRevisionState([
      { ...files[0]!, bytes: Buffer.concat([before, appended]) },
      files[1]!,
    ]);

    expect(extended).toEqual(recomputed);
    expect(createSessionSourceRevision(extended!)).toBe(
      createSessionSourceRevision(recomputed),
    );
  });

  it('rejects an extension that is not separated from the persisted JSONL prefix', () => {
    const state = createSessionSourceRevisionState([{
      kind: 'main',
      relativePath: 'project/session.jsonl',
      bytes: Buffer.from('meta'),
    }]);

    expect(extendSessionMainSourceRevisionState(
      state,
      'project/session.jsonl',
      Buffer.from('not-an-append-boundary'),
    )).toBeUndefined();
  });
});
