import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { hashProviderVisibleMessages } from './llm-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

describe('AMA prompt-cache message fingerprint', () => {
  it('ignores local-only tool-result metadata', () => {
    const message = (metadata: Record<string, unknown>): KodaXMessage => ({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'same wire result',
        metadata,
      }],
    });

    expect(hashProviderVisibleMessages([message({ outputPath: 'a.txt' })]))
      .toBe(hashProviderVisibleMessages([message({ outputPath: 'b.txt' })]));
  });

  it('fingerprints image bytes instead of only the local path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-cache-hash-'));
    tempDirs.push(dir);
    const imagePath = path.join(dir, 'image.png');
    const messages: KodaXMessage[] = [{
      role: 'user',
      content: [{ type: 'image', path: imagePath, mediaType: 'image/png' }],
    }];

    await writeFile(imagePath, 'first-image-bytes');
    const first = hashProviderVisibleMessages(messages);
    await writeFile(imagePath, 'second-image-bytes');
    const second = hashProviderVisibleMessages(messages);

    expect(second).not.toBe(first);
  });
});
