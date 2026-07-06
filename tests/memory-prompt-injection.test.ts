/**
 * FEATURE_124 (v0.7.43) Phase B — integration test: SP injection.
 *
 * Verifies that `buildSystemPromptSnapshot` from `@kodax-ai/coding`
 * correctly injects the `project-memory` section in the right position
 * relative to other capability-context sections, and that the rendered
 * system prompt contains MEMORY.md content (or fallback) per cwd.
 *
 * These tests exercise the FULL SP build pipeline, not just
 * `buildMemorySection` alone — they catch regressions where future
 * `capability-sections.ts` reordering accidentally drops or misplaces
 * the memory section.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome, resolveMemoryRoot } from '@kodax-ai/agent';
import { buildSystemPromptSnapshot } from '@kodax-ai/coding';

describe('FEATURE_124 Phase B — system prompt memory injection', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-prompt-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-prompt-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('emits a project-memory section when MEMORY.md is missing (fallback text)', async () => {
    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: { executionCwd: cwd, gitRoot: cwd },
      },
      false,
    );

    const memorySection = snapshot.sections.find((s) => s.id === 'project-memory');
    expect(memorySection).toBeDefined();
    expect(memorySection?.feature).toBe('FEATURE_124');
    expect(memorySection?.content).toContain('Your MEMORY.md is currently empty');
    expect(memorySection?.content).toContain('=== Persistent memory (cross-session) ===');

    // Rendered SP must contain the fallback text.
    expect(snapshot.rendered).toContain('Your MEMORY.md is currently empty');
  });

  it('emits MEMORY.md content when the file exists', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryMd = [
      '- [User role](user_role.md) — Senior backend engineer',
      '- [No mock DB](feedback_no_mock.md) — Q1 incident',
    ].join('\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), memoryMd, 'utf-8');

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: { executionCwd: cwd, gitRoot: cwd },
      },
      false,
    );

    expect(snapshot.rendered).toContain('Senior backend engineer');
    expect(snapshot.rendered).toContain('Q1 incident');
    expect(snapshot.rendered).not.toContain('currently empty');
  });

  it('emits bounded-index NOTE text when MEMORY.md exceeds the prompt line budget', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`- [Entry ${i}](e${i}.md) — hook`);
    }
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), lines.join('\n'), 'utf-8');

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: { executionCwd: cwd, gitRoot: cwd },
      },
      false,
    );

    expect(snapshot.rendered).toContain('NOTE');
    expect(snapshot.rendered).toContain('250 lines');
    expect(snapshot.rendered).toContain('bounded 60-line');
    expect(snapshot.rendered).toContain('Read relevant topic files on demand');
  });

  it('orders project-agents → memory-rules → project-memory → skills-addendum', async () => {
    // Plant both AGENTS.md and MEMORY.md so all four sections fire.
    fs.mkdirSync(path.join(cwd, '.kodax'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.kodax', 'AGENTS.md'),
      'PROJECT RULE: prefer project-scoped constraints.',
      'utf-8',
    );

    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'MEMORY.md'),
      '- [User role](user_role.md) — Memory-Entry-Marker-XYZ',
      'utf-8',
    );

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: {
          executionCwd: cwd,
          gitRoot: cwd,
          skillsPrompt: '## Skills\nSkills-Marker-ABC',
        },
      },
      false,
    );

    const ids = snapshot.sections.map((s) => s.id);
    const agentsIdx = ids.indexOf('project-agents');
    const rulesIdx = ids.indexOf('memory-rules');
    const memoryIdx = ids.indexOf('project-memory');
    const skillsIdx = ids.indexOf('skills-addendum');

    expect(agentsIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBe(agentsIdx + 1);
    expect(memoryIdx).toBe(rulesIdx + 1);
    expect(skillsIdx).toBe(memoryIdx + 1);

    // Rendered SP preserves the same order.
    const renderedAgentsIdx = snapshot.rendered.indexOf(
      'PROJECT RULE: prefer project-scoped constraints.',
    );
    const renderedRulesIdx = snapshot.rendered.indexOf('# Memory (per-project)');
    const renderedMemoryIdx = snapshot.rendered.indexOf('Memory-Entry-Marker-XYZ');
    const renderedSkillsIdx = snapshot.rendered.indexOf('Skills-Marker-ABC');
    expect(renderedAgentsIdx).toBeGreaterThan(-1);
    expect(renderedRulesIdx).toBeGreaterThan(renderedAgentsIdx);
    expect(renderedMemoryIdx).toBeGreaterThan(renderedRulesIdx);
    expect(renderedSkillsIdx).toBeGreaterThan(renderedMemoryIdx);
  });

  it('isolates memory across different cwds (per-project boundary)', async () => {
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cwdA-'));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cwdB-'));
    try {
      const memoryDirA = resolveMemoryRoot(cwdA);
      const memoryDirB = resolveMemoryRoot(cwdB);
      // Different cwds → different fallback hash → different memory dirs.
      expect(memoryDirA).not.toBe(memoryDirB);

      fs.mkdirSync(memoryDirA, { recursive: true });
      fs.writeFileSync(
        path.join(memoryDirA, 'MEMORY.md'),
        '- [Project A only](e.md) — A-MARKER',
        'utf-8',
      );

      const snapshotA = await buildSystemPromptSnapshot(
        { provider: 'openai', context: { executionCwd: cwdA, gitRoot: cwdA } },
        false,
      );
      const snapshotB = await buildSystemPromptSnapshot(
        { provider: 'openai', context: { executionCwd: cwdB, gitRoot: cwdB } },
        false,
      );

      expect(snapshotA.rendered).toContain('A-MARKER');
      expect(snapshotB.rendered).not.toContain('A-MARKER');
      expect(snapshotB.rendered).toContain('currently empty');
    } finally {
      fs.rmSync(cwdA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      fs.rmSync(cwdB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('keeps SP memory overhead under 28 KB hard budget (memory section only)', async () => {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    // Pathological 50KB MEMORY.md — truncation must cap us.
    const longLine = '- [E](e.md) — ' + 'X'.repeat(490);
    const lines = Array.from({ length: 100 }, () => longLine);
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), lines.join('\n'), 'utf-8');

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: { executionCwd: cwd, gitRoot: cwd },
      },
      false,
    );

    const memorySection = snapshot.sections.find((s) => s.id === 'project-memory');
    expect(memorySection).toBeDefined();
    // memory section content ≤ 26 KB (25KB cap + section header ~500B + WARNING line ~200B)
    const bytes = Buffer.byteLength(memorySection!.content, 'utf-8');
    expect(bytes).toBeLessThan(26_500);
  });
});
