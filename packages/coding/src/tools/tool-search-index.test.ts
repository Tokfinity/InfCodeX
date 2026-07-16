import { describe, expect, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { buildToolSearchIndex, searchToolIndex } from './tool-search-index.js';

const tools: KodaXToolDefinition[] = [
  {
    name: 'module_context',
    description: 'Build a module capsule with dependencies, exported symbols, and related tests.',
    input_schema: {
      type: 'object',
      properties: {
        modulePath: {
          type: 'string',
          description: 'Module path to inspect.',
        },
      },
      required: ['modulePath'],
    },
  },
  {
    name: 'impact_estimate',
    description: 'Estimate refactor blast radius before a rename or API change.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Symbol or file path target.',
        },
      },
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a remote URL and convert HTML into markdown.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Remote URL to fetch.',
        },
      },
      required: ['url'],
    },
  },
];

describe('tool search index', () => {
  it('boosts exact and split-name matches', () => {
    const index = buildToolSearchIndex(tools);
    const results = searchToolIndex(index, 'module context', 3);

    expect(results[0]?.name).toBe('module_context');
    expect(results[0]?.matchedTerms).toEqual(expect.arrayContaining(['module', 'context']));
  });

  it('uses schema keys and descriptions as searchable metadata', () => {
    const index = buildToolSearchIndex(tools);
    const results = searchToolIndex(index, 'modulePath', 3);

    expect(results[0]?.name).toBe('module_context');
  });

  it('honors required terms and max result limits', () => {
    const index = buildToolSearchIndex(tools);
    const results = searchToolIndex(index, { required: ['refactor'], loose: ['module', 'impact'] }, 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('impact_estimate');
  });

  it('returns an empty list when no indexed metadata matches', () => {
    const index = buildToolSearchIndex(tools);

    expect(searchToolIndex(index, 'zzzz-not-present', 5)).toEqual([]);
  });
});
