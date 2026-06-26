import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
  resolveConstructedAgent,
  resolveConstructedAgentSource,
} from './agent-resolver.js';
import {
  REPO_EXPLORER_AGENT_NAME,
  REPO_EXPLORER_TOOL_NAMES,
  ensureBuiltinRepoExplorerAgent,
} from './builtin-agents.js';
import type { AgentArtifact } from './types.js';

afterEach(() => {
  _resetAgentResolverForTesting();
});

function names(agentTools: readonly { readonly name: string }[]): string[] {
  return agentTools.map((tool) => tool.name).sort();
}

function artifact(name: string): AgentArtifact {
  return {
    kind: 'agent',
    name,
    version: '1.0.0',
    content: {
      instructions: 'PROJECT REPO EXPLORER',
      description: 'project override',
      tools: [{ ref: 'builtin:read' }],
    },
    status: 'active',
    createdAt: Date.now(),
    testedAt: Date.now(),
    activatedAt: Date.now(),
  };
}

describe('built-in repo-explorer specialist', () => {
  it('registers a read-only repository exploration specialist through admission', async () => {
    await expect(ensureBuiltinRepoExplorerAgent()).resolves.toBe(true);
    const agent = resolveConstructedAgent(REPO_EXPLORER_AGENT_NAME);

    expect(agent?.description).toContain('Read-only repository exploration specialist');
    expect(agent?.instructions).toContain('relationship_scan');
    expect(resolveConstructedAgentSource(REPO_EXPLORER_AGENT_NAME)).toBe('built-in');
    expect(names(agent?.tools ?? [])).toEqual([...REPO_EXPLORER_TOOL_NAMES].sort());
    expect(agent?.tools?.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['write', 'edit', 'multi_edit', 'bash', 'dispatch_child_task']),
    );
  });

  it('is idempotent and never overrides a more specific registered agent', async () => {
    registerConstructedAgent(artifact(REPO_EXPLORER_AGENT_NAME), { source: 'markdown:project' });

    await expect(ensureBuiltinRepoExplorerAgent()).resolves.toBe(false);
    const agent = resolveConstructedAgent(REPO_EXPLORER_AGENT_NAME);

    expect(resolveConstructedAgentSource(REPO_EXPLORER_AGENT_NAME)).toBe('markdown:project');
    expect(agent?.instructions).toBe('PROJECT REPO EXPLORER');
    expect(agent?.tools?.map((tool) => tool.name)).toEqual(['read']);
  });
});
