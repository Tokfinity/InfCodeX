import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeReviewPackets } from './review-packet.js';

describe('writeReviewPackets', () => {
  it('partitions captured files deterministically with one-primary ownership', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-packets-'));
    const diff = [
      'diff --git a/packages/agent/src/a.ts b/packages/agent/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/docs/README.md b/docs/README.md',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n');
    try {
      const first = await writeReviewPackets({ cwd, sessionId: 's/259', label: 'captured', diff });
      const second = await writeReviewPackets({ cwd, sessionId: 's/259', label: 'captured', diff });

      expect(first.map((packet) => packet.partitionKey)).toEqual([
        'docs/docs',
        'packages/agent/source',
      ]);
      expect(first.map((packet) => packet.contentHash)).toEqual(second.map((packet) => packet.contentHash));
      expect(first.flatMap((packet) => packet.scopePaths).sort()).toEqual([
        'docs/README.md',
        'packages/agent/src/a.ts',
      ]);
      expect(new Set(first.flatMap((packet) => packet.scopePaths)).size).toBe(2);
      expect(await readFile(first[0]!.packetPath, 'utf8')).toContain('Scoped diff');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('chunks oversized evidence without truncating characters and maps only authoritative risk', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-large-'));
    const longLine = `+${'x'.repeat(6_500)}`;
    const diff = `diff --git a/packages/a/large.ts b/packages/a/large.ts\n@@ -1 +1 @@\n${longLine}\n`;
    try {
      const [packet] = await writeReviewPackets({
        cwd,
        sessionId: 's',
        label: 'large',
        diff,
        routingRisk: 'high',
        budget: { maxBytes: 1_200, maxLines: 12, maxLineChars: 300 },
      });

      expect(packet?.riskFlags).toEqual(['routing-high']);
      expect(packet?.evidenceChunks.length).toBeGreaterThan(1);
      const chunks = await Promise.all(packet!.evidenceChunks.map((chunk) => readFile(chunk.path, 'utf8')));
      expect(chunks.join('').match(/x/g)?.length).toBe(6_500);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1_200);
        expect(chunk.split(/\r?\n/).length).toBeLessThanOrEqual(12);
        expect(chunk.split(/\r?\n/).every((line) => line.length <= 300)).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('changes range identity when refs, scope, or captured bytes change', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-range-'));
    const base = {
      cwd,
      sessionId: 's',
      label: 'range',
      diff: 'diff --git a/a.ts b/a.ts\n+one\n',
      baseRef: 'a'.repeat(40),
      headRef: 'b'.repeat(40),
      scope: 'compare' as const,
    };
    try {
      const [first] = await writeReviewPackets(base);
      const [changedRef] = await writeReviewPackets({ ...base, headRef: 'c'.repeat(40) });
      const [changedBytes] = await writeReviewPackets({ ...base, diff: `${base.diff}+two\n` });
      expect(new Set([first?.rangeId, changedRef?.rangeId, changedBytes?.rangeId]).size).toBe(3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not lose payload when the configured line cap is smaller than a continuation marker', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-tiny-lines-'));
    const payload = 'x'.repeat(160);
    const diff = `diff --git a/a.ts b/a.ts\n+${payload}\n`;
    try {
      const [packet] = await writeReviewPackets({
        cwd,
        sessionId: 's',
        label: 'tiny line cap',
        diff,
        budget: { maxBytes: 96, maxLines: 8, maxLineChars: 16 },
      });
      const chunks = await Promise.all(packet!.evidenceChunks.map((chunk) => readFile(chunk.path, 'utf8')));
      expect(chunks.join('').match(/x/g)?.length).toBe(payload.length);
      expect(chunks.every((chunk) => chunk.split(/\r?\n/).every((line) => line.length <= 16))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
