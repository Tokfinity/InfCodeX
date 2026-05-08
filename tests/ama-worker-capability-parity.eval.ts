/**
 * Eval: AMA Worker Capability Context Parity — FEATURE_144 (v0.7.35.1).
 *
 * ## Why this exists
 *
 * v0.7.26 FEATURE_084 migrated the AMA worker pipeline from the SA path
 * (`buildSystemPrompt`) to a Runner-driven assembly in
 * `task-engine/runner-driven.ts`. That migration silently dropped 6 of
 * the 13 capability-context sections the SA path emits:
 *
 *   1. `mcp-capability-context`  — active MCP server visibility
 *   2. `skills-addendum`         — skill-specific guidance
 *   3. `project-agents`          — AGENTS.md / CLAUDE.md project rules
 *   4. `tool-construction`       — tool self-construction guidance
 *   5. `git-context`             — branch / status snapshot
 *   6. `project-snapshot`        — lightweight repo tree
 *
 * Three of these dropouts produced confirmed user-facing bugs (MCP
 * servers invisible to Scout, skills invisible to workers, project
 * CLAUDE.md rules ignored by Generator). FEATURE_144 plumbs the
 * `buildCapabilityContextSections()` helper into the AMA worker chain
 * so all 6 reach Scout / Planner / Generator / Evaluator.
 *
 * ## What this eval guards
 *
 * **Structural ship gate** (deterministic — runs without API keys):
 *   For every role (scout / planner / generator / evaluator), prove
 *   that the runner's filtered capability block carries marker text
 *   from each of the 6 sections AND lands in the rendered role prompt.
 *   Failure = at least one section was dropped on the way through.
 *
 * **Negative parity** (deterministic):
 *   The 7 sections AMA-owned by other paths
 *   (base-system / base-system-suffix / environment-context /
 *   working-directory / runtime-fact / repo-intelligence-context /
 *   prompt-overlay) MUST NOT appear in the capability block — they
 *   would otherwise duplicate against `workspaceSection`,
 *   `prebuiltRepoIntelligenceContext`, and the Shard 6d-L overlay
 *   stitching that already inject those sections through different
 *   Runner channels.
 *
 * ## Behavioral dimensions (v0.7.36 follow-up)
 *
 * The 4-dimension behavioral eval (instruction-following parity /
 * mcp_search call rate / CLAUDE.md compliance / dirty-repo git
 * declaration) requires a multi-provider judge harness build that
 * exceeds v0.7.35.1 patch-release scope. Tracked as a v0.7.36
 * follow-up in `docs/features/v0.7.36.md`. The structural ship gate
 * here is the load-bearing guarantee that the prompt content reaches
 * the worker; behavioral validation can iterate without re-shipping
 * the wiring.
 *
 * ## Run
 *
 *   npm run test:eval -- ama-worker-capability-parity
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCapabilityContextSections } from '@kodax-ai/coding';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { KodaXOptions, KodaXTaskRole } from '@kodax-ai/coding';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';

const execAsync = promisify(exec);

// Same filter set as `runner-driven.ts:rolePromptContextFactory`. The
// filter is the load-bearing piece — if a section ID is added here
// that the runner doesn't filter (or removed here that it does), the
// eval drifts from production wiring.
const AMA_OWNED_SECTION_IDS = new Set<string>([
  'base-system',
  'base-system-suffix',
  'environment-context',
  'runtime-fact',
  'working-directory',
  'repo-intelligence-context',
  'prompt-overlay',
]);

const ALL_ROLES: ReadonlyArray<Exclude<KodaXTaskRole, 'direct'>> = [
  'scout',
  'planner',
  'generator',
  'evaluator',
];

const MARKERS = {
  mcp: 'FROZEN_MCP_SERVER_MARKER',
  skills: 'FROZEN_SKILLS_MARKER',
  agents: 'FROZEN_PROJECT_AGENTS_MARKER',
  toolConstruction: '[Tool Construction Mode]',
  gitContext: 'Git Branch:',
  projectSnapshot: 'Project:',
} as const;

interface FixtureFiles {
  cwd: string;
  cleanup: () => Promise<void>;
}

async function buildPopulatedRepo(): Promise<FixtureFiles> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-fea144-'));
  // Real git repo so getGitContext picks up branch + status.
  await execAsync('git init --initial-branch=main', { cwd });
  await execAsync('git config user.email "test@test"', { cwd });
  await execAsync('git config user.name "test"', { cwd });
  await fs.writeFile(path.join(cwd, 'README.md'), '# fixture', 'utf-8');
  await execAsync('git add .', { cwd });
  await execAsync('git commit -m "init"', { cwd });
  // Leave a dirty file so `git status --short` has output (one of the
  // 4 behavioral dimensions: dirty-repo git awareness).
  await fs.writeFile(path.join(cwd, 'dirty.txt'), 'unstaged', 'utf-8');

  // AGENTS.md so the project-agents section emits.
  await fs.mkdir(path.join(cwd, '.kodax'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.kodax', 'AGENTS.md'),
    `# Project Rules\n${MARKERS.agents}: prefer immutability.\n`,
    'utf-8',
  );

  return {
    cwd,
    cleanup: async () => {
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

function fakeMcpExtensionRuntime(
  mcpContext: string,
): KodaXOptions['extensionRuntime'] {
  return {
    getCapabilityPromptContext: async (kind: string) =>
      kind === 'mcp' ? mcpContext : undefined,
  } as unknown as KodaXOptions['extensionRuntime'];
}

function makeOptions(
  fixture: FixtureFiles,
): KodaXOptions {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    extensionRuntime: fakeMcpExtensionRuntime(
      `## MCP Capability Provider\n${MARKERS.mcp}: search before call.`,
    ),
    context: {
      executionCwd: fixture.cwd,
      gitRoot: fixture.cwd,
      skillsPrompt: `## Skills\n${MARKERS.skills}: scoped guidance.`,
      toolConstructionMode: true,
    },
  } as unknown as KodaXOptions;
}

function buildContextWithCapabilityBlock(
  block: string,
  fixture: FixtureFiles,
): ManagedRolePromptContext {
  return {
    originalTask: 'fea144 parity probe',
    workspace: {
      executionCwd: fixture.cwd,
      gitRoot: fixture.cwd,
      platform: process.platform,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    capabilityContextBlock: block,
  };
}

describe('FEATURE_144 — AMA worker capability parity (structural ship gate)', () => {
  const fixtures: FixtureFiles[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
  });

  it('runner-side filter retains all 6 missing sections + drops 7 AMA-owned ones', async () => {
    const fixture = await buildPopulatedRepo();
    fixtures.push(fixture);

    // Use isNewSession=true so git-context + project-snapshot emit.
    const sections = await buildCapabilityContextSections(
      makeOptions(fixture),
      true,
      fixture.cwd,
    );
    const allIds = sections.map((s) => s.id);

    // Sanity: SA path must emit every section that AMA needs to see.
    expect(allIds).toContain('mcp-capability-context');
    expect(allIds).toContain('skills-addendum');
    expect(allIds).toContain('project-agents');
    expect(allIds).toContain('tool-construction');
    expect(allIds).toContain('git-context');
    expect(allIds).toContain('project-snapshot');

    const filtered = sections.filter((s) => !AMA_OWNED_SECTION_IDS.has(s.id));
    const filteredIds = filtered.map((s) => s.id);

    // The 6 sections AMA needs survive the filter…
    expect(filteredIds).toContain('mcp-capability-context');
    expect(filteredIds).toContain('skills-addendum');
    expect(filteredIds).toContain('project-agents');
    expect(filteredIds).toContain('tool-construction');
    expect(filteredIds).toContain('git-context');
    expect(filteredIds).toContain('project-snapshot');

    // …and the 7 sections AMA-owned by other paths are dropped, so the
    // capability block doesn't duplicate against workspaceSection /
    // prebuiltRepoIntelligenceContext / Shard 6d-L overlay stitching.
    expect(filteredIds).not.toContain('base-system');
    expect(filteredIds).not.toContain('base-system-suffix');
    expect(filteredIds).not.toContain('environment-context');
    expect(filteredIds).not.toContain('working-directory');
    expect(filteredIds).not.toContain('runtime-fact');
    expect(filteredIds).not.toContain('repo-intelligence-context');
    expect(filteredIds).not.toContain('prompt-overlay');
  });

  it('all 4 AMA roles render the capability block end-to-end (markers reach the prompt)', async () => {
    const fixture = await buildPopulatedRepo();
    fixtures.push(fixture);

    const sections = await buildCapabilityContextSections(
      makeOptions(fixture),
      true,
      fixture.cwd,
    );
    const filtered = sections.filter((s) => !AMA_OWNED_SECTION_IDS.has(s.id));
    const block = filtered.map((s) => s.content).join('\n\n');

    // The block itself must carry every marker before role rendering.
    expect(block).toContain(MARKERS.mcp);
    expect(block).toContain(MARKERS.skills);
    expect(block).toContain(MARKERS.agents);
    expect(block).toContain(MARKERS.toolConstruction);
    expect(block).toContain(MARKERS.gitContext);
    expect(block).toContain(MARKERS.projectSnapshot);

    const decision = buildFallbackRoutingDecision('fea144 parity probe');
    const rolePromptContext = buildContextWithCapabilityBlock(block, fixture);

    for (const role of ALL_ROLES) {
      const rendered = createRolePrompt(
        role,
        'fea144 parity probe',
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        rolePromptContext,
        undefined,
        false,
      );

      // Each marker must reach the rendered role prompt — these are
      // the ship-gate assertions; failure = at least one section was
      // dropped between runner-driven.ts and createRolePrompt.
      expect(rendered, `role=${role}: missing MCP marker`).toContain(MARKERS.mcp);
      expect(rendered, `role=${role}: missing Skills marker`).toContain(MARKERS.skills);
      expect(rendered, `role=${role}: missing AGENTS marker`).toContain(MARKERS.agents);
      expect(rendered, `role=${role}: missing tool-construction marker`).toContain(MARKERS.toolConstruction);
      expect(rendered, `role=${role}: missing git-context marker`).toContain(MARKERS.gitContext);
      expect(rendered, `role=${role}: missing project-snapshot marker`).toContain(MARKERS.projectSnapshot);

      // Capability block must come AFTER the workspace section's
      // `## Environment` header so capability truth sits next to
      // runtime truth (matches builder.ts SA-path ordering).
      const envIdx = rendered.indexOf('## Environment');
      const mcpIdx = rendered.indexOf(MARKERS.mcp);
      expect(envIdx, `role=${role}: workspaceSection present`).toBeGreaterThanOrEqual(0);
      expect(mcpIdx, `role=${role}: capability block ordered after workspace`).toBeGreaterThan(envIdx);
    }
  });

  it('legacy callers (no capabilityContextBlock) keep pre-FEATURE_144 prompt shape', async () => {
    const fixture = await buildPopulatedRepo();
    fixtures.push(fixture);

    const decision = buildFallbackRoutingDecision('legacy probe');
    const ctx: ManagedRolePromptContext = {
      originalTask: 'legacy probe',
      workspace: {
        executionCwd: fixture.cwd,
        gitRoot: fixture.cwd,
        platform: process.platform,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
      // capabilityContextBlock intentionally omitted — pre-FEATURE_144
      // call sites must keep working with no structural change.
    };

    for (const role of ALL_ROLES) {
      const rendered = createRolePrompt(
        role,
        'legacy probe',
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        ctx,
        undefined,
        false,
      );
      // Sanity: workspace + decision summary still present (workspace
      // was the only capability-adjacent block pre-FEATURE_144).
      expect(rendered, `role=${role}`).toContain('## Environment');
      expect(rendered, `role=${role}`).toContain('Primary task:');
      // No leak from the new-section text when the parent didn't compute one.
      expect(rendered, `role=${role}`).not.toContain('## MCP Capability Provider');
    }
  });
});
