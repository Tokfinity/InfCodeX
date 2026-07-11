import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeReviewPacket } from './review-packet.js';

describe('writeReviewPacket', () => {
  it('captures one immutable, content-addressed manifest and bounded evidence chunks', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-packet-'));
    try {
      const packet = await writeReviewPacket({
        cwd,
        sessionId: 'session/259',
        label: 'uncommitted changes',
        diff: 'diff --git a/packages/a.ts b/packages/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        customPrompt: 'preserve API',
      });

      expect(packet.packetPath).toContain('review-packets');
      expect(packet.contentHash).toHaveLength(64);
      expect(packet.rangeId).toHaveLength(64);
      expect(packet.scopePaths).toEqual(['packages/a.ts']);
      expect(packet.requirementsPresent).toBe(true);
      expect(packet.evidenceChunks).toHaveLength(1);
      expect(await readFile(packet.packetPath, 'utf8')).toContain(packet.evidenceChunks[0]!.path);
      const files = await readdir(path.dirname(packet.packetPath));
      expect(files).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps oversized lines within the captured read line limit', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-packet-large-'));
    try {
      const diff = `diff --git a/large.txt b/large.txt\n${'+' + 'x'.repeat(2100)}\n`;
      const packet = await writeReviewPacket({ cwd, sessionId: 's', label: 'large', diff });
      expect(packet.evidenceChunks.length).toBeGreaterThan(0);
      for (const chunk of packet.evidenceChunks) {
        const content = await readFile(chunk.path, 'utf8');
        expect(content.split(/\r?\n/).every((line) => line.length <= 2_000)).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
