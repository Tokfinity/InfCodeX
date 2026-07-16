import { describe, expect, it } from 'vitest';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';
import { extractArtifactLedger, mergeArtifactLedger } from './file-tracker.js';
import { microcompact, DEFAULT_MICROCOMPACTION_CONFIG } from './microcompaction.js';

describe('extractArtifactLedger', () => {
  it('records user-attached image inputs in the artifact ledger', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please review this screenshot.' },
          {
            type: 'image',
            path: 'C:/repo/screenshots/bug.png',
            mediaType: 'image/png',
          },
        ],
      },
    ]);

    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'image_input',
          sourceTool: 'user-input',
          action: 'attach',
          target: 'C:/repo/screenshots/bug.png',
          metadata: { mediaType: 'image/png' },
        }),
      ]),
    );
  });

  it('records only successfully promoted Skill script outputs as created files', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'skill-script-1',
          name: 'run_skill_script',
          input: {
            skill: 'office-reports',
            script: 'scripts/render.py',
            outputs: [
              { path: 'deck.pptx', target: 'deliverables/deck.pptx' },
              { path: 'data.csv', target: 'reports/data.csv' },
            ],
          },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'skill-script-1',
          content: JSON.stringify({
            stdout: 'rendered',
            outputs: ['deliverables/deck.pptx', 'reports/data.csv', 'undeclared/private.txt'],
          }),
        }],
      },
    ]);

    expect(ledger).toHaveLength(2);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file_created',
        sourceTool: 'run_skill_script',
        action: 'promote_output',
        target: 'deliverables/deck.pptx',
      }),
      expect.objectContaining({
        kind: 'file_created',
        sourceTool: 'run_skill_script',
        action: 'promote_output',
        target: 'reports/data.csv',
      }),
    ]));
  });

  it('does not record declared Skill script outputs when execution fails', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'skill-script-2', name: 'run_skill_script',
          input: {
            skill: 'office-reports', script: 'scripts/render.py',
            outputs: [{ path: 'deck.pptx', target: 'deliverables/deck.pptx' }],
          },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'skill-script-2',
          content: '[Tool Error] run_skill_script: render failed', is_error: true,
        }],
      },
    ]);

    expect(ledger).toEqual([]);
  });
});

describe('FEATURE_185 (v0.7.42): result-side enrichment', () => {
  const recoverableOutputPath = 'C:\\Users\\test\\.kodax\\tool-results\\full-result.txt';
  const recoverableMarker = `[KODAX_RESULT_INCOMPLETE. Tool output truncated. Showing 1 of 200 lines. Full output saved to: ${recoverableOutputPath}. Use read on the saved output path.]`;

  function buildToolPair(opts: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    resultContent: string;
    resultMetadata?: Record<string, unknown>;
  }): KodaXMessage[] {
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: opts.toolUseId,
            name: opts.toolName,
            input: opts.input,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: opts.toolUseId,
            content: opts.resultContent,
            ...(opts.resultMetadata ? { metadata: opts.resultMetadata } : {}),
          },
        ],
      },
    ];
  }

  it('grep ledger entry includes parsed hits in metadata when raw result is present', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_1',
      toolName: 'grep',
      input: { pattern: 'authenticate', path: 'src/' },
      resultContent: [
        'src/auth.ts:42: function authenticate(user) {',
        'src/auth.ts:78:   await authenticate(req.user);',
        'src/login.ts:13: import { authenticate } from "../auth";',
      ].join('\n'),
    }));

    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.kind).toBe('search_scope');
    expect(entry.target).toBe('authenticate');
    expect(entry.metadata?.hits).toBeDefined();
    const hits = entry.metadata!.hits as Array<{ path: string; line: number; preview: string }>;
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      path: 'src/auth.ts',
      line: 42,
      preview: 'function authenticate(user) {',
    });
    expect(entry.metadata?.resultMode).toBe('content');
  });

  it('grep ledger entry keeps a recoverable output pointer from the capacity marker', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_recoverable_grep',
      toolName: 'grep',
      input: { pattern: 'authenticate', path: 'src/' },
      resultContent: `src/auth.ts:42: function authenticate(user) {\n\n${recoverableMarker}`,
    }));

    expect(ledger[0]?.metadata).toEqual(expect.objectContaining({
      outputPath: recoverableOutputPath,
      truncated: true,
      capturedCount: 1,
    }));
  });

  it('grep ledger entry has no `hits` metadata when result is a placeholder', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_2',
      toolName: 'grep',
      input: { pattern: 'authenticate', path: 'src/' },
      resultContent: '[Cleared: grep src/ "authenticate"]',
    }));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe('search_scope');
    expect(ledger[0]!.metadata?.hits).toBeUndefined();
  });

  it('grep ledger entry survives without a tool_result block (input-only)', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_use_3',
            name: 'grep',
            input: { pattern: 'token', path: 'src/' },
          },
        ],
      },
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe('search_scope');
    expect(ledger[0]!.metadata?.hits).toBeUndefined();
    // Path scope still preserved from input.
    expect(ledger[0]!.metadata?.path).toBe('src/');
  });

  it('glob ledger entry includes matched paths in metadata', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_4',
      toolName: 'glob',
      input: { pattern: '**/*.ts', path: 'packages/' },
      resultContent: [
        'packages/coding/src/auth.ts',
        'packages/coding/src/login.ts',
        'packages/session-lineage/src/session.ts',
      ].join('\n'),
    }));

    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.kind).toBe('path_scope');
    expect(entry.sourceTool).toBe('glob');
    const matched = entry.metadata?.matchedPaths as string[] | undefined;
    expect(matched).toEqual([
      'packages/coding/src/auth.ts',
      'packages/coding/src/login.ts',
      'packages/session-lineage/src/session.ts',
    ]);
  });

  it('glob ledger entry keeps a recoverable output pointer from the capacity marker', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_recoverable_glob',
      toolName: 'glob',
      input: { pattern: '**/*.ts', path: 'packages/' },
      resultContent: `packages/coding/src/auth.ts\n\n${recoverableMarker}`,
    }));

    expect(ledger[0]?.metadata).toEqual(expect.objectContaining({
      outputPath: recoverableOutputPath,
      truncated: true,
      capturedCount: 1,
    }));
  });

  it('creates a recoverable ledger entry for a generic tool result with no path input', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_recoverable_generic',
      toolName: 'custom_report',
      input: { topic: 'audit' },
      resultContent: `short preview\n\n${recoverableMarker}`,
    }));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual(expect.objectContaining({
      kind: 'path_scope',
      sourceTool: 'custom_report',
      action: 'recover_output',
      target: recoverableOutputPath,
      metadata: expect.objectContaining({
        outputPath: recoverableOutputPath,
        truncated: true,
      }),
    }));
  });

  it('prefers structured tool-result recovery metadata when no text marker exists', () => {
    const structuredPath = 'C:\\Users\\test\\.kodax\\tool-results\\structured.txt';
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_structured_recovery',
      toolName: 'custom_report',
      input: { topic: 'audit' },
      resultContent: 'short preview',
      resultMetadata: {
        outputPath: structuredPath,
        truncated: true,
        capacityFallback: true,
      },
    }));

    expect(ledger[0]).toEqual(expect.objectContaining({
      target: structuredPath,
      metadata: expect.objectContaining({
        outputPath: structuredPath,
        truncated: true,
        capacityFallback: true,
      }),
    }));
  });

  it('count-mode grep records matchCount instead of hits', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_5',
      toolName: 'grep',
      input: { pattern: 'TODO', path: '.' },
      resultContent: '42 matches',
    }));

    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.metadata?.matchCount).toBe(42);
    expect(entry.metadata?.hits).toBeUndefined();
    expect(entry.metadata?.resultMode).toBe('count');
  });

  it('bash ledger entry captures exit code 0 and tail', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_6',
      toolName: 'bash',
      input: { command: 'npm test' },
      resultContent: 'Command: npm test\nExit: 0\n123 passed (123)',
    }));

    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.kind).toBe('command_scope');
    expect(entry.metadata?.exitCode).toBe(0);
    expect(entry.metadata?.tail).toContain('123 passed');
    expect(entry.metadata?.cancelled).toBeUndefined();
    expect(entry.metadata?.timeout).toBeUndefined();
  });

  it('bash ledger entry captures non-zero exit code (failure)', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_7',
      toolName: 'bash',
      input: { command: 'npm run lint' },
      resultContent: 'Command: npm run lint\nExit: 1\nESLint found 3 problems\nsrc/foo.ts:42:5 error',
    }));

    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.metadata?.exitCode).toBe(1);
    expect(entry.metadata?.tail).toContain('ESLint found 3 problems');
  });

  it('bash ledger entry flags cancelled commands', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_8',
      toolName: 'bash',
      input: { command: 'long-running' },
      resultContent: '[Cancelled] Operation cancelled by user',
    }));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.metadata?.cancelled).toBe(true);
    expect(ledger[0]!.metadata?.exitCode).toBeUndefined();
  });

  it('bash ledger entry flags timeout commands with tail', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_9',
      toolName: 'bash',
      input: { command: 'sleep 100' },
      resultContent: [
        'Command: sleep 100',
        '[Timeout] Command interrupted after 30s',
        'Partial output (tail):',
        'still processing',
      ].join('\n'),
    }));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.metadata?.timedOut).toBe(true);
    expect(ledger[0]!.metadata?.tail).toContain('Partial output');
  });

  it('bash result-side `timedOut` flag does not collide with input.timeout numeric', () => {
    const ledger = extractArtifactLedger(buildToolPair({
      toolUseId: 'tool_use_9b',
      toolName: 'bash',
      input: { command: 'sleep 100', timeout: 30 }, // input has timeout=30 (configured limit)
      resultContent: [
        'Command: sleep 100',
        '[Timeout] Command interrupted after 30s',
        'Partial output (tail):',
        'still processing',
      ].join('\n'),
    }));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.metadata?.timeout).toBe(30);     // input config preserved
    expect(ledger[0]!.metadata?.timedOut).toBe(true);  // extracted flag separate
  });

  it('bash ledger entry without result content keeps prior input-only fields', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_use_10',
            name: 'bash',
            input: { command: 'npm test', timeout: 60 },
          },
        ],
      },
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.metadata?.timeout).toBe(60); // input.timeout — not the bool flag
    expect(ledger[0]!.metadata?.exitCode).toBeUndefined();
    expect(ledger[0]!.metadata?.tail).toBeUndefined();
  });
});

describe('FEATURE_185 (v0.7.42): mergeArtifactLedger preserves rich metadata', () => {
  const baseEntry = {
    id: 'e_1',
    kind: 'search_scope' as const,
    sourceTool: 'grep',
    action: 'grep',
    target: 'authenticate',
    displayTarget: 'authenticate',
    summary: 'grep authenticate (src/)',
    timestamp: '2026-05-20T10:00:00.000Z',
  };

  it('keeps prior hits when the new entry lacks them (placeholder re-extraction)', () => {
    const prior = [
      {
        ...baseEntry,
        metadata: {
          path: 'src/',
          hits: [
            { path: 'src/auth.ts', line: 42, preview: 'function authenticate(...)' },
          ],
        },
      },
    ];
    const next = [
      {
        ...baseEntry,
        id: 'e_1_re',
        metadata: { path: 'src/' }, // re-extracted from a [Cleared:] placeholder
      },
    ];

    const merged = mergeArtifactLedger(prior, next);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.metadata?.hits).toEqual([
      { path: 'src/auth.ts', line: 42, preview: 'function authenticate(...)' },
    ]);
    // Non-empty new fields still override.
    expect(merged[0]!.metadata?.path).toBe('src/');
  });

  it('new non-empty metadata overrides prior', () => {
    const prior = [{ ...baseEntry, metadata: { hits: [], path: 'old/' } }];
    const next = [{
      ...baseEntry,
      id: 'e_1_b',
      metadata: {
        path: 'new/',
        hits: [{ path: 'a.ts', line: 1, preview: 'a' }],
      },
    }];

    const merged = mergeArtifactLedger(prior, next);
    expect(merged[0]!.metadata?.path).toBe('new/');
    expect((merged[0]!.metadata?.hits as unknown[])).toHaveLength(1);
  });

  it('preserves empty new value when prior had no value either (no information leak)', () => {
    const prior = [{ ...baseEntry, metadata: { path: 'src/' } }];
    const next = [{ ...baseEntry, id: 'e_1_c', metadata: { path: 'src/', hits: [] } }];

    const merged = mergeArtifactLedger(prior, next);
    expect(merged[0]!.metadata?.hits).toEqual([]);
  });
});

describe('FEATURE_185 (v0.7.42): end-to-end enrichment survives microcompact', () => {
  // Pipeline this test models:
  //   1. Tool runs, raw tool_result in messages (iter N).
  //   2. Round-end: extractArtifactLedger captures hits into ledger metadata.
  //   3. Many later turns age out iter N.
  //   4. Top-of-loop microcompact (run-substrate.ts:621) clears the
  //      tool_result content to `[Cleared: ...]`.
  //   5. Compaction time: extractArtifactLedger re-runs on microcompacted
  //      messages — parser correctly rejects placeholder, new entry has no
  //      hits.
  //   6. mergeArtifactLedger(roundEndLedger, compactionLedger) MUST preserve
  //      the iter-N enrichment (this is the F185.1 keystone fix).
  //
  // Without this guarantee, every compaction would silently lose enrichment
  // and re-grep would still be the model's only way to recall hits.
  it('grep hits captured at round-end survive microcompact + re-extract + merge', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'grep_iter_n',
          name: 'grep',
          input: { pattern: 'authenticate', path: 'src/' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'grep_iter_n',
          content: [
            'src/auth.ts:42: function authenticate(user) {',
            'src/auth.ts:78:   await authenticate(req.user);',
            'src/login.ts:13: import { authenticate } from "../auth";',
          ].join('\n'),
        }],
      },
    ];

    // Step 2 — round-end extract (raw result intact)
    const ledgerAtRoundEnd = extractArtifactLedger(messages);
    expect(ledgerAtRoundEnd).toHaveLength(1);
    const roundEndHits = ledgerAtRoundEnd[0]!.metadata?.hits as unknown[] | undefined;
    expect(roundEndHits).toBeDefined();
    expect(roundEndHits!.length).toBe(3);

    // Step 3 — age the tool_result past microcompact's maxAge (default 20).
    // Each user-after-assistant counts as one turn.
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `assistant turn ${i}` }] });
      messages.push({ role: 'user', content: [{ type: 'text', text: `user prompt ${i}` }] });
    }

    // Step 4 — top-of-loop microcompact
    const microcompacted = microcompact(messages, {
      ...DEFAULT_MICROCOMPACTION_CONFIG,
      enabled: true,
    }) as KodaXMessage[];
    const earlyToolResultBlock = (microcompacted[1]!.content as KodaXToolResultBlock[])[0]!;
    expect(typeof earlyToolResultBlock.content).toBe('string');
    expect(earlyToolResultBlock.content).toMatch(/^\[Cleared:/);

    // Step 5 — compaction-time re-extract on microcompacted messages
    const ledgerAtCompaction = extractArtifactLedger(microcompacted);
    expect(ledgerAtCompaction).toHaveLength(1);
    // Re-extracted entry MUST NOT carry stale hits — parser refuses
    // placeholder content. If this fails, the parser is mis-detecting
    // `[Cleared: ...]` as legitimate grep output.
    expect(ledgerAtCompaction[0]!.metadata?.hits).toBeUndefined();

    // Step 6 — merge: enrichment MUST survive
    const merged = mergeArtifactLedger(ledgerAtRoundEnd, ledgerAtCompaction);
    expect(merged).toHaveLength(1);
    const mergedHits = merged[0]!.metadata?.hits as Array<{ path: string; line: number; preview: string }> | undefined;
    expect(mergedHits).toBeDefined();
    expect(mergedHits!.length).toBe(3);
    expect(mergedHits![0]!.path).toBe('src/auth.ts');
    expect(mergedHits![0]!.line).toBe(42);
  });

  it('bash exit_code + tail captured at round-end survive microcompact + merge', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'bash_iter_n',
          name: 'bash',
          input: { command: 'npm run lint' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'bash_iter_n',
          content: 'Command: npm run lint\nExit: 1\nESLint found 3 problems\nsrc/foo.ts:42:5 error',
        }],
      },
    ];

    const ledgerAtRoundEnd = extractArtifactLedger(messages);
    expect(ledgerAtRoundEnd[0]!.metadata?.exitCode).toBe(1);
    expect(ledgerAtRoundEnd[0]!.metadata?.tail).toContain('ESLint found 3 problems');

    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }] });
    }

    const microcompacted = microcompact(messages, {
      ...DEFAULT_MICROCOMPACTION_CONFIG,
      enabled: true,
    }) as KodaXMessage[];
    const ledgerAtCompaction = extractArtifactLedger(microcompacted);
    // After clearance the re-extract sees a placeholder, so no fresh enrichment.
    expect(ledgerAtCompaction[0]!.metadata?.exitCode).toBeUndefined();
    expect(ledgerAtCompaction[0]!.metadata?.tail).toBeUndefined();

    const merged = mergeArtifactLedger(ledgerAtRoundEnd, ledgerAtCompaction);
    expect(merged[0]!.metadata?.exitCode).toBe(1);
    expect(merged[0]!.metadata?.tail).toContain('ESLint found 3 problems');
  });
});
