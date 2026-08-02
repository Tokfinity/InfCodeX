import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import {
  buildPermissionIntentEvidence,
  MAX_CURRENT_USER_INTENT_BYTES,
} from './permission-intent.js';

describe('buildPermissionIntentEvidence', () => {
  it('marks absent user authority explicitly', () => {
    expect(buildPermissionIntentEvidence([], 'delete build')).toMatchObject({
      status: 'missing', sourceBytes: 0, includedBytes: 0, omittedBytes: 0,
    });
  });

  it('keeps only genuine user text when the evidence fits', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Move the report to D:/archive.' },
      { role: 'assistant', content: 'PRIVATE ASSISTANT NARRATION' },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'PRIVATE TOOL OUTPUT',
        }],
      },
    ];

    const evidence = buildPermissionIntentEvidence(messages, 'move D:/archive');

    expect(evidence.status).toBe('complete');
    expect(evidence.content).toContain('Move the report');
    expect(evidence.currentUserContent).toBe('Move the report to D:/archive.');
    expect(evidence.content).not.toContain('PRIVATE ASSISTANT');
    expect(evidence.content).not.toContain('PRIVATE TOOL OUTPUT');
    expect(evidence.omittedBytes).toBe(0);
  });

  it('isolates the latest real user request and excludes synthetic reminder turns', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Older unrelated task.' },
      {
        role: 'user',
        content: '<system-reminder>Never mention this synthetic instruction.</system-reminder>',
        _synthetic: true,
      },
      {
        role: 'user',
        content: 'Move the travel documents into the project folder.',
      },
      {
        role: 'user',
        content: '<system-reminder>Tool call bookkeeping.</system-reminder>',
      },
    ];

    const evidence = buildPermissionIntentEvidence(messages, 'move project folder');

    expect(evidence.currentUserContent)
      .toBe('Move the travel documents into the project folder.');
    expect(evidence.content).not.toContain('system-reminder');
    expect(evidence.content).not.toContain('bookkeeping');
  });

  it('selects explicit relevant slices and reports omitted bytes for oversized intent', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: `Background ${'x'.repeat(12_000)}` },
      {
        role: 'user',
        content: 'For the release artifact, Move-Item may write to D:/archive/output.zip.',
      },
    ];

    const evidence = buildPermissionIntentEvidence(
      messages,
      'Move-Item D:/archive/output.zip',
      1_000,
    );

    expect(evidence.status).toBe('targeted');
    expect(evidence.content).toContain('Move-Item may write to D:/archive/output.zip');
    expect(evidence.sourceBytes).toBeGreaterThan(evidence.includedBytes);
    expect(evidence.omittedBytes).toBe(evidence.sourceBytes - evidence.includedBytes);
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(evidence.content, 'utf8')).toBeLessThanOrEqual(1_000);
  });

  it('caps a large current request while retaining action-relevant intent', () => {
    const target = 'Move report.json into project/archive.';
    const messages: KodaXMessage[] = [{
      role: 'user',
      content: `${'background '.repeat(2_000)}\n${target}\n${'appendix '.repeat(2_000)}`,
    }];

    const evidence = buildPermissionIntentEvidence(messages, 'move report.json project/archive');

    expect(Buffer.byteLength(evidence.currentUserContent ?? '', 'utf8'))
      .toBeLessThanOrEqual(MAX_CURRENT_USER_INTENT_BYTES);
    expect(evidence.currentUserContent).toContain(target);
    expect(evidence.currentUserContentTruncated).toBe(true);
    expect(evidence.status).toBe('targeted');
  });

  it.each([
    'Do not use shell commands; use file tools only.',
    'Review all files except README.md.',
    'Stay within src/.',
    'README.md is out of scope.',
    'Use file APIs and nothing else.',
    'Keep files unchanged.',
    '\u4e0d\u8981\u4f7f\u7528 shell \u547d\u4ee4\uff0c\u53ea\u4f7f\u7528\u6587\u4ef6\u5de5\u5177\u3002',
  ])('retains an authority constraint from the middle of a long current request: %s', (constraint) => {
    const messages: KodaXMessage[] = [{
      role: 'user',
      content: [
        'Background material. '.repeat(800),
        constraint,
        'Appendix material. '.repeat(800),
      ].join('\n'),
    }];

    const evidence = buildPermissionIntentEvidence(messages, 'git show --stat HEAD');

    expect(evidence.currentUserContentTruncated).toBe(true);
    expect(evidence.currentUserContent).toContain(constraint);
  });

  it('keeps runtime-authenticated root intent separate from a child briefing', () => {
    const evidence = buildPermissionIntentEvidence(
      [{ role: 'user', content: `# Child Agent Task\n${'briefing '.repeat(2_000)}` }],
      'findstr transcriptSearch %TEMP%\\sdk-runtime-v0.7.78.ts',
      undefined,
      {
        rootUserIntent: '请 review 当前版本的所有改动和提交。',
        delegatedObjective: '只读复审会话历史实现，并核对临时对照文件。',
        bindingConstraints: ['只读审查，禁止修改或创建文件'],
        scopeHint: 'packages/repl/src src',
        readOnly: true,
      },
    );

    expect(evidence.currentUserContent).toBe('请 review 当前版本的所有改动和提交。');
    expect(evidence.currentUserContentTruncated).toBe(false);
    expect(evidence.delegatedObjective).toBe('只读复审会话历史实现，并核对临时对照文件。');
    expect(evidence.bindingConstraints).toEqual(['只读审查，禁止修改或创建文件']);
    expect(evidence.scopeHint).toBe('packages/repl/src src');
    expect(evidence.readOnly).toBe(true);
    expect(evidence.content).not.toContain('# Child Agent Task');
  });

  it('retains prior genuine user context for a short root follow-up', () => {
    const evidence = buildPermissionIntentEvidence(
      [
        { role: 'user', content: 'Move report.json into the project output folder.' },
        { role: 'assistant', content: 'I found the target.' },
        { role: 'user', content: 'Do it.' },
      ],
      'move report.json output/report.json',
      undefined,
      { rootUserIntent: 'Do it.' },
    );

    expect(evidence.currentUserContent).toBe('Do it.');
    expect(evidence.content).toContain(
      '[prior-user-intent] Move report.json into the project output folder.',
    );
    expect(evidence.content).not.toContain('[prior-user-intent] Do it.');
  });

  it('treats a later genuine root message as the current authority', () => {
    const evidence = buildPermissionIntentEvidence(
      [
        { role: 'user', content: 'Implement the requested changes.' },
        { role: 'assistant', content: 'I started editing the workspace.' },
        { role: 'user', content: 'Stop. Do not modify any more files.' },
      ],
      'write packages/coding/src/index.ts',
      undefined,
      { rootUserIntent: 'Implement the requested changes.' },
    );

    expect(evidence.currentUserContent).toBe('Stop. Do not modify any more files.');
    expect(evidence.currentUserContentTruncated).toBe(false);
    expect(evidence.content).toContain(
      '[prior-user-intent] Implement the requested changes.',
    );
  });
});
