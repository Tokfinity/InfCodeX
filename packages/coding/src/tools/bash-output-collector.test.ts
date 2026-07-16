import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASH_CAPTURE_COMPLETE_MARKER,
  BASH_CAPTURE_INCOMPLETE_MARKER,
  appendBashOutputChunk,
  createBashOutputCollector,
  disposeBashOutputCollector,
  finishBashOutputCollector,
  finishBashOutputRecovery,
  startBashOutputRecovery,
} from './bash-output-collector.js';

describe('Bash output collector', () => {
  it('returns an explicit recoverable marker instead of throwing when a spool cannot be read', () => {
    const collector = createBashOutputCollector();
    const missingSpool = join(process.cwd(), `missing-bash-spool-${Date.now()}.output`);
    collector.spoolPath = missingSpool;
    collector.chunks = [Buffer.from('captured-suffix', 'utf-8')];
    collector.memoryBytes = collector.chunks[0]?.length ?? 0;

    const output = finishBashOutputCollector(collector).toString('utf-8');

    expect(output).toContain(BASH_CAPTURE_INCOMPLETE_MARKER);
    expect(output).toContain(missingSpool);
    expect(output).toContain('captured-suffix');
    expect(() => disposeBashOutputCollector(collector)).not.toThrow();
  });

  it('keeps accepting chunks after capture is promoted to a recovery artifact', () => {
    const collector = createBashOutputCollector();
    appendBashOutputChunk(collector, Buffer.from('before-deadline\n'));
    const recoveryPath = startBashOutputRecovery(collector);

    appendBashOutputChunk(collector, Buffer.from('after-deadline\n'));
    expect(finishBashOutputRecovery(collector)).toBe(true);

    const recovered = readFileSync(recoveryPath, 'utf-8');
    expect(recovered).toContain('before-deadline');
    expect(recovered).toContain('after-deadline');
    expect(recovered).toContain(BASH_CAPTURE_COMPLETE_MARKER);
    disposeBashOutputCollector(collector);
    unlinkSync(recoveryPath);
  });
});
