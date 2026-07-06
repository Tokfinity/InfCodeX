import { describe, expect, it } from 'vitest';
import { applyDeclarativeOutputFilters } from './declarative.js';

describe('declarative output filters', () => {
  it('compresses package-manager progress while preserving final summaries', () => {
    const progress = Array.from({ length: 180 }, (_, index) => `Progress: resolved ${index}, reused ${index}`).join('\n');
    const result = applyDeclarativeOutputFilters({
      command: 'pnpm install',
      stdout: `${progress}\nPackages: +12\nDone in 3.1s`,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('Packages: +12');
    expect(result.stdout).toContain('Done in 3.1s');
    expect(result.stdout).not.toContain('resolved 179');
    expect(result.note).toContain('package-manager-progress');
  });

  it('does not truncate docker commands unless progress content is present', () => {
    const logs = Array.from({ length: 130 }, (_, index) => `app log line ${index}`).join('\n');
    const result = applyDeclarativeOutputFilters({
      command: 'docker compose logs api',
      stdout: logs,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.stdout).toBe(logs);
    expect(result.lossiness).toBe('none');
    expect(result.note).toBeUndefined();
  });

  it('applies stderr-aware rules for docker progress streams', () => {
    const stderr = Array.from(
      { length: 120 },
      (_, index) => index % 2 === 0 ? `#${index + 1} [stage 1/2] CACHED` : `#${index + 1} [stage 1/2] DONE 0.${index % 10}s`,
    ).join('\n');
    const result = applyDeclarativeOutputFilters({
      command: 'docker build .',
      stdout: 'final image sha256:abc',
      stderr,
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toBe('final image sha256:abc');
    expect(result.stderr).not.toContain('[stage 1/2] CACHED');
    expect(result.stderr).not.toContain('DONE 0.');
    expect(result.note).toContain('docker-progress');
  });

  it('strips braille spinner frames using ASCII source escapes', () => {
    const result = applyDeclarativeOutputFilters({
      command: 'pnpm install',
      stdout: '\u2801 resolving packages\nDone in 1s',
      stderr: '',
      lossiness: 'none',
    });

    expect(result.stdout).toBe('Done in 1s');
    expect(result.lossiness).toBe('tail');
  });
});
