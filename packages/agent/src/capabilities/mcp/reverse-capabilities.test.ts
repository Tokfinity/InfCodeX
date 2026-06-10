import { describe, expect, it } from 'vitest';
import {
  buildInitializeCapabilities,
  normalizeElicitResult,
  parseElicitRequest,
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

describe('parseElicitRequest', () => {
  it('parses a form request (default mode)', () => {
    expect(parseElicitRequest({ message: 'hi', requestedSchema: { type: 'object' } })).toEqual({
      mode: 'form',
      message: 'hi',
      requestedSchema: { type: 'object' },
    });
  });

  it('parses a url request', () => {
    expect(parseElicitRequest({ mode: 'url', message: 'auth', url: 'https://x.test/a', elicitationId: 'e1' })).toEqual({
      mode: 'url',
      message: 'auth',
      url: 'https://x.test/a',
      elicitationId: 'e1',
    });
  });

  it('tolerates missing/garbage params', () => {
    expect(parseElicitRequest(undefined)).toEqual({ mode: 'form', message: undefined, requestedSchema: undefined });
    expect(parseElicitRequest({ requestedSchema: 'nope' })).toEqual({ mode: 'form', message: undefined, requestedSchema: undefined });
  });
});

describe('normalizeElicitResult', () => {
  it('passes through accept + content object', () => {
    expect(normalizeElicitResult({ action: 'accept', content: { a: 1 } })).toEqual({ action: 'accept', content: { a: 1 } });
  });

  it('coerces accept with non-object content to {}', () => {
    expect(normalizeElicitResult({ action: 'accept', content: undefined as never })).toEqual({ action: 'accept', content: {} });
  });

  it('passes decline / cancel', () => {
    expect(normalizeElicitResult({ action: 'decline' })).toEqual({ action: 'decline' });
    expect(normalizeElicitResult({ action: 'cancel' })).toEqual({ action: 'cancel' });
  });

  it('degrades a malformed result to cancel', () => {
    expect(normalizeElicitResult({ action: 'weird' } as never)).toEqual({ action: 'cancel' });
  });
});
