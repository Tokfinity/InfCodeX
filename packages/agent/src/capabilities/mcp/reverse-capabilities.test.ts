import { describe, expect, it } from 'vitest';
import {
  buildInitializeCapabilities,
  type McpReverseCapabilities,
} from './reverse-capabilities.js';

describe('buildInitializeCapabilities', () => {
  it('advertises nothing when no reverse capabilities are injected', () => {
    expect(buildInitializeCapabilities(undefined)).toEqual({});
    expect(buildInitializeCapabilities({})).toEqual({});
  });

  it('advertises roots (listChanged false by default) when listRoots is present', () => {
    const reverse: McpReverseCapabilities = { listRoots: () => [] };
    expect(buildInitializeCapabilities(reverse)).toEqual({ roots: { listChanged: false } });
  });

  it('honors rootsListChanged', () => {
    const reverse: McpReverseCapabilities = { listRoots: () => [], rootsListChanged: true };
    expect(buildInitializeCapabilities(reverse)).toEqual({ roots: { listChanged: true } });
  });

  it('advertises form-only elicitation by default when elicit is present', () => {
    const reverse: McpReverseCapabilities = { elicit: async () => ({ action: 'decline' }) };
    expect(buildInitializeCapabilities(reverse)).toEqual({ elicitation: { form: {} } });
  });

  it('advertises url elicitation only when the host opts in', () => {
    const reverse: McpReverseCapabilities = {
      elicit: async () => ({ action: 'decline' }),
      elicitationModes: { form: true, url: true },
    };
    expect(buildInitializeCapabilities(reverse)).toEqual({ elicitation: { form: {}, url: {} } });
  });

  it('advertises sampling only when sample is present', () => {
    const reverse: McpReverseCapabilities = {
      sample: async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }),
    };
    expect(buildInitializeCapabilities(reverse)).toEqual({ sampling: {} });
  });

  it('composes multiple capabilities', () => {
    const reverse: McpReverseCapabilities = {
      listRoots: () => [],
      elicit: async () => ({ action: 'decline' }),
      sample: async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }),
    };
    expect(buildInitializeCapabilities(reverse)).toEqual({
      roots: { listChanged: false },
      elicitation: { form: {} },
      sampling: {},
    });
  });
});
