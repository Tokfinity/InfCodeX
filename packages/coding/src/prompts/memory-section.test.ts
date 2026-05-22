/**
 * FEATURE_124 (v0.7.43) Phase B — memory-section.ts unit tests.
 *
 * Verifies buildMemorySection across the 6 input shapes:
 *   1. MEMORY.md missing → fallback "currently empty" text
 *   2. MEMORY.md present + small → content passed through unchanged
 *   3. MEMORY.md > 200 lines → truncated + WARNING text
 *   4. MEMORY.md > 25KB → truncated + WARNING text (byte cap)
 *   5. Multibyte (Chinese) content counted via Buffer.byteLength
 *   6. fs read error → graceful fallback (never throws)
 *
 * Hermetic via setAgentConfigHome temp dir override.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome, resolveMemoryRoot } from '@kodax-ai/agent';

import { buildMemorySection } from './memory-section.js';

describe('buildMemorySection', () => {
  let tempHome: string;
  let cwd: string;
  let memoryDir: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-section-'));
    setAgentConfigHome(tempHome);
    // Use a no-remote cwd so resolveMemoryRoot falls back to local-<hash>.
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-cwd-'));
    memoryDir = resolveMemoryRoot(cwd);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ── Case 1: missing MEMORY.md ──────────────────────────────────────────────
  it('returns fallback text when MEMORY.md does not exist', () => {
    const result = buildMemorySection(cwd);

    expect(result.entrypointExists).toBe(false);
    expect(result.memoryDir).toBe(memoryDir);
    expect(result.content).toContain(
      'Your MEMORY.md is currently empty. When you save new memories, they will appear here.',
    );
    expect(result.content).toContain(memoryDir);
  });

  // ── Case 2: small MEMORY.md ────────────────────────────────────────────────
  it('passes through small MEMORY.md content unchanged', () => {
    const memoryMd = [
      '- [User role](user_role.md) — Backend engineer',
      '- [No mock DB](feedback_no_mock.md) — Q1 incident',
    ].join('\n');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), memoryMd, 'utf-8');

    const result = buildMemorySection(cwd);

    expect(result.entrypointExists).toBe(true);
    expect(result.content).toContain('User role');
    expect(result.content).toContain('No mock DB');
    expect(result.content).not.toContain('WARNING');
    expect(result.content).toContain(
      '[Index only — read individual files via the read tool when you need details.',
    );
  });

  // ── Case 3: line-cap truncation ────────────────────────────────────────────
  it('truncates + appends WARNING when MEMORY.md exceeds 200 lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`- [Entry ${i}](e${i}.md) — hook`);
    }
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), lines.join('\n'), 'utf-8');

    const result = buildMemorySection(cwd);

    expect(result.entrypointExists).toBe(true);
    expect(result.content).toContain('WARNING');
    expect(result.content).toContain('250 lines');
    // First entry present, line-201+ entries dropped.
    expect(result.content).toContain('- [Entry 0](e0.md)');
    expect(result.content).not.toContain('- [Entry 249](e249.md)');
  });

  // ── Case 4: byte-cap truncation ────────────────────────────────────────────
  it('truncates + appends WARNING when MEMORY.md exceeds 25KB', () => {
    // 30 lines × ~1000 bytes/line = 30KB → byte-cap, line-cap not triggered.
    const longLine = '- [E](e.md) — ' + 'X'.repeat(980);
    const memoryMd = Array.from({ length: 30 }, () => longLine).join('\n');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), memoryMd, 'utf-8');

    const result = buildMemorySection(cwd);

    expect(result.content).toContain('WARNING');
    expect(result.content).toContain('index entries are too long');
  });

  // ── Case 5: multibyte content ──────────────────────────────────────────────
  it('handles UTF-8 multibyte content without phantom truncation', () => {
    const cnLine = '- [' + '记忆条目'.repeat(20) + '](e.md)';
    // ~80 Chinese chars × ~3 bytes ≈ 250 bytes per line × 10 lines = 2.5KB
    // Should NOT trigger any cap.
    const memoryMd = Array.from({ length: 10 }, () => cnLine).join('\n');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), memoryMd, 'utf-8');

    const result = buildMemorySection(cwd);

    expect(result.content).not.toContain('WARNING');
    expect(result.content).toContain('记忆条目');
  });

  // ── Case 6: fs read error → graceful fallback ──────────────────────────────
  it('NEVER throws when MEMORY.md exists but cannot be read', () => {
    // Simulate by creating a directory at the MEMORY.md path. readFileSync
    // on a directory throws EISDIR — our catch must swallow.
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'MEMORY.md'));

    expect(() => buildMemorySection(cwd)).not.toThrow();
    const result = buildMemorySection(cwd);
    expect(result.entrypointExists).toBe(false);
    expect(result.content).toContain('currently empty');
  });

  // ── Bonus: memoryDir is reported verbatim ─────────────────────────────────
  it('reports memoryDir absolute path in the section content', () => {
    const result = buildMemorySection(cwd);
    expect(result.memoryDir).toBe(memoryDir);
    expect(result.content).toContain(memoryDir);
  });
});
