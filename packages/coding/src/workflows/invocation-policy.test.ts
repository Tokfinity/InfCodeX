import { describe, expect, it } from 'vitest';

import type { KodaXAgentMode } from '../types.js';
import { decideWorkflowInvocation } from './invocation-policy.js';

describe('decideWorkflowInvocation', () => {
  it('treats AMAW as a first-class agent mode', () => {
    const modes: readonly KodaXAgentMode[] = ['sa', 'ama', 'amaw'];
    expect(modes).toContain('amaw');
  });

  it('does not route natural-language workflow requests in SA mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'sa',
        source: 'natural-language',
        input: 'please create a workflow to analyze this flaky test',
      }),
    ).toMatchObject({ action: 'none' });
  });

  it('suggests workflow for explicit natural-language requests in AMA mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'ama',
        source: 'natural-language',
        input: 'please create a workflow to analyze this flaky test',
      }),
    ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
  });

  it('auto-starts restricted workflow candidates in AMAW mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'amaw',
        source: 'natural-language',
        input: 'Please compare three independent competing hypotheses and verify each one.',
      }),
    ).toMatchObject({ action: 'auto-start', trigger: 'complexity' });
  });

  it('does not auto-start AMAW for routine single-signal verbs', () => {
    for (const input of [
      'please verify this one file',
      'sort this short list alphabetically',
      'what does the workflow option do?',
    ]) {
      expect(
        decideWorkflowInvocation({
          agentMode: 'amaw',
          source: 'natural-language',
          input,
        }),
      ).toMatchObject({ action: 'none' });
    }
  });

  it('treats workflow mentions as explicit only when they request workflow execution', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'ama',
        source: 'natural-language',
        input: 'what does the workflow option do?',
      }),
    ).toMatchObject({ action: 'none', trigger: 'none' });

    expect(
      decideWorkflowInvocation({
        agentMode: 'ama',
        source: 'natural-language',
        input: 'why did the workflow that failed yesterday stop?',
      }),
    ).toMatchObject({ action: 'none', trigger: 'none' });

    expect(
      decideWorkflowInvocation({
        agentMode: 'ama',
        source: 'natural-language',
        input: 'please create a workflow for this UI regression audit',
      }),
    ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
  });

  it('lets explicit negation override workflow triggers', () => {
    for (const input of [
      'do not use a workflow; just answer directly',
      'without using a workflow, verify these ideas',
      'avoid workflows and skip multi-agent routing',
    ]) {
      expect(
        decideWorkflowInvocation({
          agentMode: 'amaw',
          source: 'natural-language',
          input,
        }),
      ).toMatchObject({ action: 'none', trigger: 'negated' });
    }
  });

  it('treats command-level workflow requests as explicit in every mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'sa',
        source: 'command',
        input: '/review --workflow',
      }),
    ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
  });
});
