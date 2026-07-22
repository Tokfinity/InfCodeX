import { describe, expect, it } from 'vitest';
import { COMPACTION_SUMMARY_PREFIX } from '@kodax-ai/agent';
import type {
  KodaXManagedTask,
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  KodaXTaskStatus,
} from '../../types.js';
import {
  buildUserFacingMessages,
  extractFinalAssistantText,
  isUnconvergedVerdict,
  normalizeLoadedSessionMessages,
  reshapeToUserConversation,
} from './round-boundary.js';

function makeResult(overrides: Partial<KodaXResult> = {}): KodaXResult {
  return {
    success: true,
    lastText: 'the final answer',
    messages: [
      { role: 'user', content: 'You are the Evaluator role...' },
      { role: 'assistant', content: '<verdict>accept</verdict>' },
    ],
    sessionId: 'sess-test',
    ...overrides,
  } as KodaXResult;
}

function makeManagedTask(status: KodaXTaskStatus, summary = 'stub summary'): KodaXManagedTask {
  return {
    contract: {} as KodaXManagedTask['contract'],
    roleAssignments: [],
    workItems: [],
    evidence: {} as KodaXManagedTask['evidence'],
    verdict: {
      status,
      decidedByAssignmentId: 'test',
      summary,
    },
  };
}

function makeOptions(initial: KodaXMessage[] = []): KodaXOptions {
  return {
    session: { initialMessages: initial },
  } as unknown as KodaXOptions;
}

describe('round-boundary/isUnconvergedVerdict', () => {
  it('treats running as unconverged (placeholder path)', () => {
    expect(isUnconvergedVerdict('running')).toBe(true);
  });

  it('treats planned as unconverged (defensive; should not reach round exit)', () => {
    expect(isUnconvergedVerdict('planned')).toBe(true);
  });

  it('treats completed as converged (has a real user-facing answer)', () => {
    expect(isUnconvergedVerdict('completed')).toBe(false);
  });

  it('treats blocked as converged (blocked reason is a valid user answer)', () => {
    expect(isUnconvergedVerdict('blocked')).toBe(false);
  });

  it('treats failed as converged (error message is a valid user answer)', () => {
    expect(isUnconvergedVerdict('failed')).toBe(false);
  });

  it('treats undefined as converged (SA paths have no managedTask)', () => {
    expect(isUnconvergedVerdict(undefined)).toBe(false);
  });
});

describe('round-boundary/extractFinalAssistantText', () => {
  it('prefers non-empty result.lastText', () => {
    const result = {
      lastText: 'the answer',
      messages: [{ role: 'assistant', content: 'ignored' }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('the answer');
  });

  it('falls back to last message content when lastText is empty', () => {
    const result = {
      lastText: '',
      messages: [{ role: 'assistant', content: 'from message' }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('from message');
  });

  it('returns empty string when result is undefined', () => {
    expect(extractFinalAssistantText(undefined)).toBe('');
  });

  it('concatenates text blocks from multi-modal content', () => {
    const result = {
      lastText: '',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('part one part two');
  });

  it('treats a legacy bare placeholder fallback as no final answer', () => {
    const result = {
      lastText: '',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: '...' }],
      }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('returns "" when the trailing message is a user turn (no assistant answer this run)', () => {
    // Interrupted / error before the assistant: the fallback must NOT surface
    // the user's own prompt text as the final assistant answer.
    const result = {
      lastText: '',
      messages: [
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'a different new question' },
      ],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('');
  });
});

describe('round-boundary/buildUserFacingMessages', () => {
  it('appends {user, assistant} when initial is empty', () => {
    const out = buildUserFacingMessages([], 'hi there', 'hello back');
    expect(out).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('appends only assistant when initial already ends with matching user prompt (CLI REPL pre-push path)', () => {
    const initial: KodaXMessage[] = [
      { role: 'user', content: 'hi there' },
    ];
    const out = buildUserFacingMessages(initial, 'hi there', 'hello back');
    expect(out).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('appends both when last initial user does not match prompt', () => {
    const initial: KodaXMessage[] = [
      { role: 'user', content: 'an earlier question' },
      { role: 'assistant', content: 'an earlier answer' },
    ];
    const out = buildUserFacingMessages(initial, 'a new question', 'a new answer');
    expect(out).toEqual([
      { role: 'user', content: 'an earlier question' },
      { role: 'assistant', content: 'an earlier answer' },
      { role: 'user', content: 'a new question' },
      { role: 'assistant', content: 'a new answer' },
    ]);
  });

  it('does not mutate the initial array', () => {
    const initial: KodaXMessage[] = [{ role: 'user', content: 'existing' }];
    const initialLen = initial.length;
    buildUserFacingMessages(initial, 'different prompt', 'answer');
    expect(initial.length).toBe(initialLen);
  });

  it('dedup works against multi-modal user message (text + image blocks)', () => {
    const initial: KodaXMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this screenshot' },
        { type: 'image', path: '/tmp/a.png', mediaType: 'image/png' },
      ],
    }];
    const out = buildUserFacingMessages(initial, 'describe this screenshot', 'it shows X');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: 'it shows X' });
  });

  it('attaches inputArtifacts as image blocks when prompt is new', () => {
    const out = buildUserFacingMessages(
      [],
      'describe this',
      'it shows X',
      [{ kind: 'image', path: '/tmp/pic.png', mediaType: 'image/png', source: 'user-inline' }],
    );
    const userMsg = out[0];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
  });
});

describe('round-boundary/reshapeToUserConversation', () => {
  it('passes through when result.messages is undefined', () => {
    const result = makeResult({ messages: undefined as unknown as KodaXMessage[] });
    const out = reshapeToUserConversation(result, makeOptions(), 'user prompt');
    expect(out).toBe(result);
  });

  it('reshapes on completed verdict to clean {user, assistant} dialog', () => {
    const result = makeResult({
      managedTask: makeManagedTask('completed', 'done'),
      lastText: 'the answer to your question',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'what is X?');
    expect(out.messages).toEqual([
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'the answer to your question' },
    ]);
  });

  it('does not write a legacy bare placeholder into the clean completed dialog', () => {
    const result = makeResult({
      managedTask: makeManagedTask('completed', 'done'),
      lastText: '',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: '...' }] },
      ],
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'q');
    expect(out.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('reshapes on blocked verdict (blocked reason IS a valid user answer) — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('blocked', 'need OAuth token'),
      lastText: 'Blocked: please authorize via browser',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'connect the MCP');
    expect(out.messages).toEqual([
      { role: 'user', content: 'connect the MCP' },
      { role: 'assistant', content: 'Blocked: please authorize via browser' },
    ]);
  });

  it('reshapes on failed verdict (error message IS a valid user answer) — Q1', () => {
    const result = makeResult({
      success: false,
      managedTask: makeManagedTask('failed', 'parser failure'),
      lastText: 'Evaluator protocol parse failed after 3 retries',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'refactor X');
    expect(out.messages?.[1].content).toBe(
      'Evaluator protocol parse failed after 3 retries',
    );
  });

  it('falls back on running verdict (unconverged, placeholder) — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('running', 'Task is running...'),
      lastText: 'Task is running...',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'the prompt');
    expect(out).toBe(result);
  });

  it('falls back on planned verdict — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('planned', 'scheduled'),
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'the prompt');
    expect(out).toBe(result);
  });

  it('reshapes when result has no managedTask (SA fast-path) — Q1', () => {
    const result = makeResult({
      lastText: 'direct SA answer',
      managedTask: undefined,
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'direct question');
    expect(out.messages).toEqual([
      { role: 'user', content: 'direct question' },
      { role: 'assistant', content: 'direct SA answer' },
    ]);
  });

  it('falls back when interrupted with no finalText', () => {
    const result = makeResult({
      interrupted: true,
      lastText: '',
      messages: [{ role: 'assistant', content: '' }],
      managedTask: makeManagedTask('completed'),
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out).toBe(result);
  });

  it('preserves prior user conversation when present in result.messages (V2 shape)', () => {
    // v0.7.40 Option A: the prior round dialog is observable in
    // `result.messages` (Runner.run emits `runnerInput` which prepends
    // initialMessages). Reshape preserves it verbatim instead of
    // re-deriving from `options.session.initialMessages`. This mirrors
    // production V2 AMA shape: `[system, ...prior, user_q, ...tools..., final_asst]`.
    const priorMessages: KodaXMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const v2ShapedMessages: KodaXMessage[] = [
      { role: 'system', content: 'You are the Worker. Role prompt body.' },
      ...priorMessages,
      { role: 'user', content: 'round 2 Q' },
      { role: 'assistant', content: 'round 2 answer' },
    ];
    const result = makeResult({
      messages: v2ShapedMessages,
      managedTask: makeManagedTask('completed'),
      lastText: 'round 2 answer',
    });
    const out = reshapeToUserConversation(result, makeOptions(priorMessages), 'round 2 Q');
    expect(out.messages).toEqual([
      ...priorMessages,
      { role: 'user', content: 'round 2 Q' },
      { role: 'assistant', content: 'round 2 answer' },
    ]);
  });

  it('preserves tool_use / tool_result chains across rounds (v0.7.40 Option A)', () => {
    // v0.7.40 Option A: the central cache/re-read fix — round-boundary
    // reshape MUST keep `tool_use` and `tool_result` blocks so the next
    // round's worker (a) doesn't re-read files it already read and (b)
    // hits the provider's prompt cache on the existing prefix.
    const v2WorkerShapedMessages: KodaXMessage[] = [
      { role: 'system', content: 'You are the Worker. Investigate.' },
      { role: 'user', content: 'review packages/llm/src/index.ts' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'packages/llm/src/index.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'export const FOO = 1;\nexport const BAR = 2;' },
        ],
      },
      { role: 'assistant', content: 'The file exports FOO and BAR.' },
    ];
    const result = makeResult({
      messages: v2WorkerShapedMessages,
      managedTask: makeManagedTask('completed'),
      lastText: 'The file exports FOO and BAR.',
    });
    const out = reshapeToUserConversation(
      result,
      makeOptions(),
      'review packages/llm/src/index.ts',
    );
    // System message stripped, tool chain preserved, final answer at end.
    expect(out.messages).toEqual([
      { role: 'user', content: 'review packages/llm/src/index.ts' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'packages/llm/src/index.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'export const FOO = 1;\nexport const BAR = 2;' },
        ],
      },
      { role: 'assistant', content: 'The file exports FOO and BAR.' },
    ]);
  });

  it('replaces (not appends) terminal tool_use assistant with synthetic final-text — verdict-only path', () => {
    // V2 AMA Evaluator commonly ends the chain with an `emit_verdict`
    // tool_use call — no plain-text content. The user-facing answer
    // lives in `result.lastText` (sanitised from the verdict's
    // `user_answer` field). Reshape MUST REPLACE the terminal
    // tool_use-only assistant (not append after it) — appending would
    // create two consecutive `role: 'assistant'` messages which
    // Anthropic's API rejects on the next request.
    const verdictOnlyMessages: KodaXMessage[] = [
      { role: 'system', content: 'You are the Evaluator.' },
      { role: 'user', content: 'review the code' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_v',
            name: 'emit_verdict',
            input: { status: 'accept', user_answer: 'looks good' },
          },
        ],
      },
    ];
    const result = makeResult({
      messages: verdictOnlyMessages,
      managedTask: makeManagedTask('completed'),
      lastText: 'looks good',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'review the code');
    // System stripped, user retained, tool_use-only assistant REPLACED
    // (not appended) with the synthetic final-text assistant.
    expect(out.messages).toEqual([
      { role: 'user', content: 'review the code' },
      { role: 'assistant', content: 'looks good' },
    ]);
    // No two consecutive `role: 'assistant'` messages anywhere.
    for (let i = 1; i < out.messages!.length; i++) {
      expect(out.messages![i].role === 'assistant' && out.messages![i - 1].role === 'assistant').toBe(false);
    }
  });

  it('preserves CompactionSummary system messages (does not strip them)', () => {
    // Step 1 strips the leading role-prompt system but only when it
    // is NOT a CompactionSummary. The discriminator is the
    // `[对话历史摘要]\n\n` prefix that `@kodax-ai/agent` writes.
    const compactionPrefix = '[对话历史摘要]\n\n';
    const messagesWithCompactionSystem: KodaXMessage[] = [
      { role: 'system', content: `${compactionPrefix}Summary of prior rounds: …` },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'reply' },
    ];
    const result = makeResult({
      messages: messagesWithCompactionSystem,
      managedTask: makeManagedTask('completed'),
      lastText: 'reply',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'follow-up');
    // CompactionSummary survives at position 0 — round 2 needs it.
    expect(out.messages![0].role).toBe('system');
    expect(out.messages![0].content as string).toContain(compactionPrefix);
  });

  it('does not duplicate the final-text assistant when transcript already ends with it', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'role prompt body' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the answer' },
    ];
    const result = makeResult({
      messages,
      managedTask: makeManagedTask('completed'),
      lastText: 'the answer',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'q');
    // System stripped, no synthetic append (last asst already has final text).
    expect(out.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the answer' },
    ]);
  });

  it('handles empty result.messages array — produces [user, assistant] from prompt + finalText', () => {
    // Edge case: `result.messages = []`. The `!result.messages` guard
    // at the top of `reshapeToUserConversation` only catches undefined;
    // an empty array passes through to `preserveTranscriptForRoundExit`.
    const result = makeResult({
      messages: [],
      managedTask: makeManagedTask('completed'),
      lastText: 'the answer',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'q');
    expect(out.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the answer' },
    ]);
  });

  it('handles transcript with only a CompactionSummary system message', () => {
    // Step 1 must NOT strip the CompactionSummary; step 3 appends user
    // prompt; step 4 appends synthetic assistant. Output preserves the
    // condensed history at position 0 so the next round still sees it.
    const compactionPrefix = '[对话历史摘要]\n\n';
    const messages: KodaXMessage[] = [
      { role: 'system', content: `${compactionPrefix}Prior summary…` },
    ];
    const result = makeResult({
      messages,
      managedTask: makeManagedTask('completed'),
      lastText: 'reply',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'q');
    expect(out.messages).toEqual([
      { role: 'system', content: `${compactionPrefix}Prior summary…` },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('does NOT re-append user prompt when CompactionSummary head is present (long-session edge case)', () => {
    // After compaction the original user prompt may have been folded
    // into the summary (compaction's protection window is anchored at
    // the tail, so older messages including the prompt get
    // summarised). Re-appending the prompt at the transcript tail
    // would produce `[summary, …work…, user_prompt, asst]` — reads as
    // if the user spoke mid-task. Trust the summary instead.
    const compactionPrefix = '[对话历史摘要]\n\n';
    const messages: KodaXMessage[] = [
      { role: 'system', content: `${compactionPrefix}User asked: review packages/llm. Worker completed.` },
      // Note: original `{user: 'review packages/llm'}` was summarised away.
      { role: 'assistant', content: 'Continuing from summary…' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'read',
            input: { path: 'packages/llm/src/foo.ts' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'export const X = 1;' }] },
      { role: 'assistant', content: 'Reviewed.' },
    ];
    const result = makeResult({
      messages,
      managedTask: makeManagedTask('completed'),
      lastText: 'Reviewed.',
    });
    const out = reshapeToUserConversation(
      result,
      makeOptions(),
      'review packages/llm', // original prompt, no longer in transcript
    );
    // Output should NOT have the original prompt re-appended at tail.
    // Output structure: CompactionSummary at head, work preserved, ends with asst.
    const userMessagesInOutput = (out.messages ?? []).filter((m) => m.role === 'user');
    // The only user messages should be tool_result-bearing user messages from the chain;
    // the original prompt should NOT appear as a separate text user message at the tail.
    const tailUser = userMessagesInOutput[userMessagesInOutput.length - 1];
    if (tailUser) {
      // If a user message exists, it must be tool_result-bearing, not a re-appended prompt.
      expect(typeof tailUser.content === 'string' && tailUser.content === 'review packages/llm').toBe(false);
    }
    // Transcript ends on assistant (carrying final answer).
    const lastMsg = out.messages![out.messages!.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect((lastMsg.content as string) === 'Reviewed.' || (lastMsg.content as string) === 'Reviewed.').toBe(true);
    // CompactionSummary preserved at head.
    expect((out.messages![0].content as string).startsWith(compactionPrefix)).toBe(true);
  });

  it('recognizes the runtime user-shaped compaction checkpoint after repo context', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'Repository intelligence for the active worker.' },
      {
        role: 'user',
        content: `${COMPACTION_SUMMARY_PREFIX}User asked: inspect the reliability fix. Work completed.`,
        _synthetic: true,
        _source: 'compaction-checkpoint',
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_after_compact', name: 'read', input: { path: 'CHANGELOG.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_after_compact', content: 'release notes' }],
      },
      { role: 'assistant', content: 'The fix is verified.' },
    ];
    const result = makeResult({
      messages,
      managedTask: makeManagedTask('completed'),
      lastText: 'The fix is verified.',
    });

    const out = reshapeToUserConversation(
      result,
      makeOptions(),
      'inspect the reliability fix',
    );

    expect(out.messages?.[0]).toMatchObject({
      role: 'user',
      _source: 'compaction-checkpoint',
    });
    expect(out.messages?.filter((message) => (
      message.role === 'user' && message.content === 'inspect the reliability fix'
    ))).toHaveLength(0);
    expect(out.messages?.filter((message) => (
      message.role === 'assistant' && message.content === 'The fix is verified.'
    ))).toHaveLength(1);
  });

  it('replaces last assistant containing only thinking blocks with synthetic final-text', () => {
    // Edge case: assistant content is an array of `thinking` blocks
    // only (no text, no tool_use). Step 4 case (b) fires because
    // content is not a string === finalText → replace. This avoids
    // emitting two consecutive assistants on the next round.
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'role prompt' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think…' },
        ],
      },
    ];
    const result = makeResult({
      messages,
      managedTask: makeManagedTask('completed'),
      lastText: 'final',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'q');
    expect(out.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'final' },
    ]);
  });

  it('pre-extracts artifactLedger onto the reshaped result', () => {
    const messagesWithTool: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: 'foo.ts' },
        }],
      },
    ];
    const result = makeResult({
      messages: messagesWithTool,
      managedTask: makeManagedTask('completed'),
      lastText: 'summary',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out.artifactLedger).toBeDefined();
  });

  it('recomputes contextTokenSnapshot based on the clean messages (Q2)', () => {
    const result = makeResult({
      managedTask: makeManagedTask('completed'),
      lastText: 'hi',
      contextTokenSnapshot: {
        currentTokens: 9999,
        baselineEstimatedTokens: 9999,
        source: 'api',
        usage: { inputTokens: 9999, outputTokens: 1, totalTokens: 10000 },
      },
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'hi');
    expect(out.contextTokenSnapshot).toBeDefined();
    expect(out.contextTokenSnapshot!.currentTokens).toBeLessThan(100);
    expect(out.contextTokenSnapshot!.usage).toBeUndefined();
  });

  it('preserves result.sessionId / signal / success / lastText after reshape', () => {
    const result = makeResult({
      success: false,
      signal: 'BLOCKED',
      managedTask: makeManagedTask('blocked', 'blocked summary'),
      lastText: 'blocked answer',
      sessionId: 'unique-sess',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out.success).toBe(false);
    expect(out.signal).toBe('BLOCKED');
    expect(out.sessionId).toBe('unique-sess');
    expect(out.lastText).toBe('blocked answer');
  });
});

describe('round-boundary/normalizeLoadedSessionMessages (Q4)', () => {
  it('passes clean {user, assistant} dialog through unchanged', () => {
    const clean: KodaXMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'sure' },
    ];
    expect(normalizeLoadedSessionMessages(clean)).toEqual(clean);
  });

  it('drops Evaluator role-prompt worker trace at the tail', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'round 1 answer' },
      {
        role: 'user',
        content: 'You are the Evaluator role. Review the Generator output...',
      },
      { role: 'assistant', content: '<kodax-task-verdict>accept</kodax-task-verdict>' },
    ];
    const normalized = normalizeLoadedSessionMessages(polluted);
    expect(normalized).toEqual([
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'round 1 answer' },
    ]);
  });

  it('drops Scout role-prompt worker trace at the tail', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'prior Q' },
      { role: 'assistant', content: 'prior A' },
      {
        role: 'user',
        content: 'You are the Scout role. <original user question wrapped>',
      },
      { role: 'assistant', content: 'summary' },
    ];
    const normalized = normalizeLoadedSessionMessages(polluted);
    expect(normalized).toEqual([
      { role: 'user', content: 'prior Q' },
      { role: 'assistant', content: 'prior A' },
    ]);
  });

  it('drops Planner and Generator role-prompt wrappers too', () => {
    expect(
      normalizeLoadedSessionMessages([
        {
          role: 'user',
          content: 'You are the Planner role. Break down the task.',
        },
        { role: 'assistant', content: '<kodax-task-contract>...' },
      ]),
    ).toEqual([]);

    expect(
      normalizeLoadedSessionMessages([
        {
          role: 'user',
          content: 'You are the Generator role. Execute the plan.',
        },
        { role: 'assistant', content: 'generator output' },
      ]),
    ).toEqual([]);
  });

  it('returns fully polluted sessions as empty (pure worker trace)', () => {
    const fullyPolluted: KodaXMessage[] = [
      {
        role: 'user',
        content: 'You are the Evaluator role. Review the Generator...',
      },
      { role: 'assistant', content: '<verdict>accept</verdict>' },
    ];
    expect(normalizeLoadedSessionMessages(fullyPolluted)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(normalizeLoadedSessionMessages([])).toEqual([]);
  });

  it('does not over-match: "You are..." in normal content is not truncated', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Please explain what "You are amazing" means' },
      { role: 'assistant', content: 'It is a compliment.' },
    ];
    expect(normalizeLoadedSessionMessages(messages)).toEqual(messages);
  });

  it('does not mutate input array', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'valid' },
      { role: 'assistant', content: 'valid' },
      { role: 'user', content: 'You are the Evaluator role...' },
      { role: 'assistant', content: 'verdict' },
    ];
    const originalLen = polluted.length;
    normalizeLoadedSessionMessages(polluted);
    expect(polluted.length).toBe(originalLen);
  });
});
