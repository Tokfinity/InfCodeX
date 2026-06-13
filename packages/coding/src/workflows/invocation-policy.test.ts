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
        input: '用 workflow 分析这个 flaky test，提出三个独立假设并验证',
      }),
    ).toMatchObject({ action: 'none' });
  });

  it('suggests workflow for explicit natural-language requests in AMA mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'ama',
        source: 'natural-language',
        input: '用 workflow 分析这个 flaky test，提出三个独立假设并验证',
      }),
    ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
  });

  it('auto-starts restricted workflow candidates in AMAW mode', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'amaw',
        source: 'natural-language',
        input: '这个测试大约每 50 次会失败 1 次，请提出多个竞争假设并互相验证',
      }),
    ).toMatchObject({ action: 'auto-start', trigger: 'complexity' });
  });

  it('lets explicit negation override workflow triggers', () => {
    expect(
      decideWorkflowInvocation({
        agentMode: 'amaw',
        source: 'natural-language',
        input: '不要用 workflow，也不要多 agent，直接告诉我这个函数做什么',
      }),
    ).toMatchObject({ action: 'none', trigger: 'negated' });
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
