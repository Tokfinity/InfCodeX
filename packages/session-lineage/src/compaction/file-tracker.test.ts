import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import { extractArtifactLedger, mergeArtifactLedger } from './file-tracker.js';

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
});

describe('FEATURE_185 (v0.7.42): result-side enrichment', () => {
  function buildToolPair(opts: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    resultContent: string;
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
