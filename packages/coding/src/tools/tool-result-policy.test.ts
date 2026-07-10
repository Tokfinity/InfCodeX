import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { applyToolResultGuardrail, getToolResultPolicy } from './tool-result-policy.js';
import { buildToolResultBudgetFromUsage } from './tool-result-budget.js';
import { TOOL_OUTPUT_DIR_ENV } from './truncate.js';

describe('tool result guardrail', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tool-guardrail-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('spills oversized generic output to a file', async () => {
    const content = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join('\n');
    const result = await applyToolResultGuardrail('write', content, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('Full output saved to:');
    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(1);
  });

  it('uses tail policy for bash output', async () => {
    const content = Array.from({ length: 1200 }, (_, index) => `line-${index + 1}`).join('\n');
    const result = await applyToolResultGuardrail('bash', content, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line-1200');
    expect(result.content).not.toContain('line-1\nline-2');
  });

  it('returns small output unchanged', async () => {
    const result = await applyToolResultGuardrail('read', 'small output', {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe('small output');
  });

  it('exposes tool-specific policy', () => {
    expect(getToolResultPolicy('bash').direction).toBe('tail');
    expect(getToolResultPolicy('read').direction).toBe('head');
    expect(getToolResultPolicy('web_fetch').maxBytes).toBe(24 * 1024);
    expect(getToolResultPolicy('semantic_lookup').spillToFile).toBe(true);
  });

  it('clamps inline preview size when a small-window budget is provided', async () => {
    const content = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join('\n');
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 16_000,
      currentTokens: 15_000,
    });

    const result = await applyToolResultGuardrail(
      'read',
      content,
      { backups: new Map(), executionCwd: process.cwd() },
      { toolResultBudget: budget },
    );

    expect(result.truncated).toBe(true);
    expect(result.policy.maxBytes).toBeLessThan(getToolResultPolicy('read').maxBytes);
    expect(result.content).toContain('Full output saved to:');
  });

  // FEATURE_121 v0.7.40 — spill-failure data-loss guard.
  // When `persistToolOutput` throws (disk full / EACCES / EROFS /
  // ENOSPC / etc.), the previous behaviour silently dropped the
  // truncation tail. These tests pin the fail-loud fallback: full
  // content is returned inlined so nothing is lost.

  it('inlines full content when persistToolOutput fails (data-loss guard)', async () => {
    // Trick `persistToolOutput` into failing by pointing the output
    // dir at an existing FILE instead of a directory. The internal
    // `fs.writeFile(path.join(file, fileName), ...)` then throws
    // ENOTDIR / ENOENT, which is structurally identical to a
    // disk-full / EACCES failure mode (the catch block treats every
    // thrown error the same).
    const blocker = path.join(tempDir, 'blocker');
    await fs.writeFile(blocker, 'not-a-dir');
    process.env[TOOL_OUTPUT_DIR_ENV] = blocker;

    const largeContent = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`).join('\n');

    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));

    let result: Awaited<ReturnType<typeof applyToolResultGuardrail>> | undefined;
    try {
      result = await applyToolResultGuardrail('child_task_summary', largeContent, {
        backups: new Map(),
        executionCwd: process.cwd(),
      });
    } finally {
      restoreDiagnostics();
    }

    // Full content preserved — no truncation, no spill path, no banner.
    expect(result).toBeDefined();
    const guarded = result!;
    expect(guarded.content).toBe(largeContent);
    expect(guarded.truncated).toBe(false);
    expect(guarded.outputPath).toBeUndefined();
    // Flag set so `dispatch-child-tasks` LLM-summary fallback can branch.
    expect(guarded.spillFailed).toBe(true);
    // The "truncated" banner text MUST NOT appear — its presence would
    // indicate silent data loss (the bug this guard was added for).
    expect(guarded.content).not.toContain('Tool output truncated');
    expect(guarded.content).not.toContain('Full output saved to');

    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'coding:tool-result-policy',
      level: 'error',
      message: expect.stringContaining('persistToolOutput failed for child_task_summary'),
    }));
  });

  it('inlines full content when forceSpill=true but persistToolOutput fails', async () => {
    // Same trick — point output dir at a file. forceSpill=true takes
    // even small content down the spill path (envelope-budget enforcer
    // calls applyToolResultGuardrail this way to reclaim envelope
    // space). The guard must still inline rather than truncate.
    const blocker = path.join(tempDir, 'blocker');
    await fs.writeFile(blocker, 'not-a-dir');
    process.env[TOOL_OUTPUT_DIR_ENV] = blocker;

    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));

    const content = 'short banner content that fits under the per-banner cap';
    let result: Awaited<ReturnType<typeof applyToolResultGuardrail>> | undefined;
    try {
      result = await applyToolResultGuardrail(
        'child_task_summary',
        content,
        { backups: new Map(), executionCwd: process.cwd() },
        { forceSpill: true },
      );
    } finally {
      restoreDiagnostics();
    }

    expect(result).toBeDefined();
    const guarded = result!;
    expect(guarded.content).toBe(content);
    expect(guarded.truncated).toBe(false);
    expect(guarded.outputPath).toBeUndefined();
    expect(guarded.spillFailed).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'coding:tool-result-policy',
      level: 'error',
    }));
  });
});
