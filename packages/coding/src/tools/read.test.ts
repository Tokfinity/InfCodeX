import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToolResultGuardrail } from './tool-result-policy.js';
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES } from './truncate.js';
import { toolRead } from './read.js';

describe('toolRead', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-read-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('streams a bounded first chunk for large files and hints continuation', async () => {
    const filePath = path.join(tempDir, 'large.txt');
    const content = Array.from({ length: 4000 }, (_, index) => `line-${index + 1}-${'x'.repeat(90)}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-1');
    expect(result).toContain('Use offset=');
    expect(result).toContain('Large file:');
  });

  it('keeps the exact continuation hint after the global read guardrail runs', async () => {
    const filePath = path.join(tempDir, 'guarded-large.txt');
    const content = Array.from(
      { length: 2200 },
      (_, index) => `line-${index + 1}-${'x'.repeat(120)}`,
    ).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const guarded = await applyToolResultGuardrail('read', result, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_BYTES);
    expect(result).toContain('Use offset=');
    expect(guarded.truncated).toBe(false);
    expect(guarded.content).toContain('Use offset=');
  });

  it('supports offset-based continuation', async () => {
    const filePath = path.join(tempDir, 'offset.txt');
    const content = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath, offset: 10, limit: 3 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-10');
    expect(result).toContain('line-12');
    expect(result).not.toContain('line-9');
  });

  it('rejects binary files', async () => {
    const filePath = path.join(tempDir, 'binary.bin');
    await fs.writeFile(filePath, Buffer.from([0, 159, 146, 150]));

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Binary file not supported');
  });
});
