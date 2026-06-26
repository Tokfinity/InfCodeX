/**
 * FEATURE_124 (v0.7.43) Phase C — unit tests for `memory-rules` SP block.
 *
 * The block is hand-authored teaching text; these tests defend three
 * load-bearing properties that a careless edit (or a regression from a
 * future prompt-shrink pass) would silently break:
 *   1. memory directory path is interpolated correctly from
 *      `resolveMemoryRoot(cwd)` and shown with forward slashes
 *      (platform-stable prompt body — see capability-sections doc).
 *   2. all 4 memory types are present with their `<name>` tag (taxonomy
 *      coverage — claudecode TYPES_SECTION_INDIVIDUAL parity).
 *   3. the two-step save procedure AND the GC responsibilities section
 *      both appear in the body (these are KodaX-specific deltas vs
 *      claudecode and account for the absence of a `delete_memory` tool).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome, resolveMemoryRoot } from '@kodax-ai/agent';

import { buildMemoryRulesSection } from './memory-rules.js';

describe('FEATURE_124 Phase C — buildMemoryRulesSection', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-rules-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-rules-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('interpolates the memory directory path with forward slashes', () => {
    const block = buildMemoryRulesSection(cwd);
    const memoryDir = resolveMemoryRoot(cwd);
    const displayDir = memoryDir.split(path.sep).join('/');

    // Section header must lead.
    expect(block.startsWith('# Memory (per-project)')).toBe(true);
    // Memory dir is shown verbatim, slashes normalized so prompt body is
    // platform-stable (matters when the same MEMORY.md flows through
    // sessions launched on Windows vs *nix — prompt cache stability).
    expect(block).toContain(`\`${displayDir}\``);
    expect(block).not.toContain(`\`${memoryDir.replace(/\//g, path.sep)}\\`);
  });

  it('lists all 4 memory types with their <name> tags', () => {
    const block = buildMemoryRulesSection(cwd);

    expect(block).toContain('## Types of memory');
    expect(block).toContain('<name>user</name>');
    expect(block).toContain('<name>feedback</name>');
    expect(block).toContain('<name>project</name>');
    expect(block).toContain('<name>reference</name>');

    // Each type has its when_to_save tag so the LLM is told the trigger.
    expect(block).toMatch(/<when_to_save>[\s\S]+?<\/when_to_save>/g);
  });

  it('contains the two-step save procedure AND GC responsibilities (KodaX deltas)', () => {
    const block = buildMemoryRulesSection(cwd);

    // Two-step save with KodaX-specific PREPEND-to-top requirement.
    expect(block).toContain('## How to save memories');
    expect(block).toContain('**Step 1**');
    expect(block).toContain('**Step 2**');
    // PREPEND-to-top is the KodaX-specific natural-LRU requirement (see
    // memory-rules.ts header comment + docs/features/v0.7.43.md Step 3).
    expect(block).toMatch(/prepend/i);
    expect(block).toMatch(/AT THE TOP/);

    // GC section names `Bash rm` so LLM knows the no-custom-tool path.
    expect(block).toContain('## GC responsibilities');
    expect(block).toContain('`Bash rm <file>`');
    expect(block).toMatch(/Update or remove memories that turn out to be wrong or outdated/);

    // Recall etiquette — the "Before recommending from memory" wording is
    // eval-validated; renaming the header is a regression.
    expect(block).toContain('## Before recommending from memory');
  });

  it('points to AGENTS.md (KodaX file name), not CLAUDE.md alone', () => {
    const block = buildMemoryRulesSection(cwd);
    // `AGENTS.md` must appear at least once (the WHAT_NOT_TO_SAVE bullet
    // + memory-vs-other-persistence section both reference it).
    expect(block).toContain('AGENTS.md');
  });

  it('respects setAgentConfigHome override in displayed path', () => {
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-rules-alt-'));
    try {
      setAgentConfigHome(alt);
      const block = buildMemoryRulesSection(cwd);
      const expected = resolveMemoryRoot(cwd).split(path.sep).join('/');
      expect(block).toContain(`\`${expected}\``);
      expect(expected.startsWith(alt.split(path.sep).join('/'))).toBe(true);
    } finally {
      fs.rmSync(alt, { recursive: true, force: true });
    }
  });
});
