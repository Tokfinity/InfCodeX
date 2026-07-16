import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
} from '../construction/agent-resolver.js';
import {
  listCodingDispatchableAgents,
  resolveCodingDispatchableAgent,
} from './local-catalog.js';

afterEach(() => {
  _resetAgentResolverForTesting();
});

describe('FEATURE_258 local dispatchable projection', () => {
  it('projects native and constructed agents with opaque stable scoped IDs', () => {
    registerConstructedAgent({
      kind: 'agent',
      name: 'db-reviewer',
      version: '1.0.0',
      createdAt: '2026-07-10T00:00:00.000Z',
      content: {
        instructions: 'Review database changes.',
        description: 'Database reviewer',
      },
      testedAt: '2026-07-10T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    }, { source: 'markdown:project' });

    const descriptors = listCodingDispatchableAgents({
      actorId: 'actor:one',
      projectId: 'project:alpha',
    });
    expect(descriptors.map((entry) => entry.agentId)).toEqual([
      'native:kodax-child',
      'constructed:project:project%3Aalpha:db-reviewer',
    ]);
    const constructed = descriptors[1]!;
    expect(constructed.origin).toBe('constructed');
    expect(constructed.configurationRevision).toMatch(/^sha256:/);

    const route = resolveCodingDispatchableAgent(constructed.agentId, {
      actorId: 'actor:one',
      projectId: 'project:alpha',
    });
    expect(route).toMatchObject({ kind: 'constructed', subagentType: 'db-reviewer' });
    expect(resolveCodingDispatchableAgent('native:kodax-child', { actorId: 'actor:one' }))
      .toMatchObject({ kind: 'native' });
  });

  it('does not leak project-scoped constructed agents without a project scope', () => {
    registerConstructedAgent({
      kind: 'agent',
      name: 'project-only',
      version: '1.0.0',
      createdAt: '2026-07-10T00:00:00.000Z',
      content: { instructions: 'Project only.' },
      testedAt: '2026-07-10T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    }, { source: 'markdown:project' });

    expect(listCodingDispatchableAgents({ actorId: 'actor-1' }).map((entry) => entry.agentId))
      .toEqual(['native:kodax-child']);
  });
});
