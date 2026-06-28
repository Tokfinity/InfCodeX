/**
 * FEATURE_196 (v0.7.43) — Sidecar Verifier content-aware gate unit tests.
 *
 * Verifies the 2-layer fire/skip gate primitives in isolation. Layer 2
 * panel eval (`tests/feature-196-sidecar-content-gate.eval.ts`) covers
 * end-to-end behavior across the canonical 5-alias panel.
 */
import { describe, expect, it } from 'vitest';
import type { StopHookContext } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  composeGateDecision,
  detectActionSurface,
  detectConversationalIntent,
  detectWorkScale,
  type VerifierGateMetrics,
} from './gate.js';

/** Baseline = Worker did nothing measurable (no writes / plan / risky shell, 1 round). */
const NO_WORK: VerifierGateMetrics = {
  riskyShellOps: 0,
  writeOps: 0,
  filesChanged: 0,
  estimatedChangedLines: 0,
  hasPlan: false,
  rounds: 1,
};
function metrics(over: Partial<VerifierGateMetrics>): VerifierGateMetrics {
  return { ...NO_WORK, ...over };
}

/**
 * Test helper — builds a minimal StopHookContext from a transcript.
 * The non-transcript fields (`signal`, `reanimateCount`, etc.) aren't
 * consulted by the gate helpers but are required by the type.
 */
function makeCtx(transcript: readonly KodaXMessage[]): StopHookContext {
  const lastAssistant = [...transcript]
    .reverse()
    .find((m) => m.role === 'assistant');
  const lastAssistantText = lastAssistant
    ? typeof lastAssistant.content === 'string'
      ? lastAssistant.content
      : lastAssistant.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
    : '';
  return {
    transcript,
    lastAssistantText,
    signal: 'natural-end',
    reanimateCount: 0,
    reanimateBudget: 2,
  };
}

describe('FEATURE_196 — gate.detectActionSurface (Layer 1)', () => {
  it('fires when last assistant turn invokes a mutation tool (write)', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'add a hello function to foo.ts' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will add the function.' },
          {
            type: 'tool_use',
            id: 't-1',
            name: 'write',
            input: { path: 'foo.ts', content: 'function hello() {}' },
          },
        ],
      },
    ]);
    const decision = detectActionSurface(ctx);
    expect(decision).toBeDefined();
    expect(decision?.fire).toBe(true);
    expect(decision?.reason).toMatch(/action-surface/);
  });

  it('fires when last assistant turn invokes a read-only tool (grep)', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'search README for setup instructions' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't-1',
            name: 'grep',
            input: { pattern: 'setup', path: 'README.md' },
          },
        ],
      },
    ]);
    const decision = detectActionSurface(ctx);
    expect(decision?.fire).toBe(true);
  });

  it('fires when last assistant turn invokes dispatch_child_task', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'investigate the auth bug' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't-1',
            name: 'dispatch_child_task',
            input: { id: 'p-1', objective: 'investigate auth' },
          },
        ],
      },
    ]);
    const decision = detectActionSurface(ctx);
    expect(decision?.fire).toBe(true);
  });

  it('returns undefined when last assistant turn has no tool_use (text-only)', () => {
    const ctx = makeCtx([
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '你好! 我是 KodaX 的开发助手。' }],
      },
    ]);
    const decision = detectActionSurface(ctx);
    expect(decision).toBeUndefined();
  });

  it('returns undefined when last assistant turn has string content (text-only)', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ]);
    const decision = detectActionSurface(ctx);
    expect(decision).toBeUndefined();
  });

  it('returns undefined when transcript has no assistant message', () => {
    const ctx = makeCtx([{ role: 'user', content: 'hi' }]);
    const decision = detectActionSurface(ctx);
    expect(decision).toBeUndefined();
  });
});

describe('FEATURE_196 — gate.detectConversationalIntent (Layer 2)', () => {
  it('skips for Chinese greeting "你好"', () => {
    const ctx = makeCtx([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好! 我是 KodaX。' },
    ]);
    const decision = detectConversationalIntent(ctx);
    expect(decision?.fire).toBe(false);
    expect(decision?.reason).toMatch(/conversational-intent/);
  });

  it('skips for English greeting "hi"', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
    expect(detectConversationalIntent(ctx)?.fire).toBe(false);
  });

  it('skips for "thanks"', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'You are welcome.' },
    ]);
    expect(detectConversationalIntent(ctx)?.fire).toBe(false);
  });

  it('skips for "好的"', () => {
    const ctx = makeCtx([
      { role: 'user', content: '好的' },
      { role: 'assistant', content: 'OK!' },
    ]);
    expect(detectConversationalIntent(ctx)?.fire).toBe(false);
  });

  it('does NOT skip when user message contains imperative verb (Chinese)', () => {
    const ctx = makeCtx([
      { role: 'user', content: '查一下 README' },
      { role: 'assistant', content: '好的，正在查找。' },
    ]);
    expect(detectConversationalIntent(ctx)).toBeUndefined();
  });

  it('does NOT skip when user message contains imperative verb (English)', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'OK, looking into it.' },
    ]);
    expect(detectConversationalIntent(ctx)).toBeUndefined();
  });

  it('does NOT skip when message exceeds length cap (long)', () => {
    const ctx = makeCtx([
      {
        role: 'user',
        content:
          '你好啊，我想问一下今天天气怎么样，对了顺便看看 README 文件',
      },
      { role: 'assistant', content: 'OK.' },
    ]);
    expect(detectConversationalIntent(ctx)).toBeUndefined();
  });

  it('does NOT skip when message starts without a greeting prefix', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'show me the file' },
      { role: 'assistant', content: 'OK.' },
    ]);
    expect(detectConversationalIntent(ctx)).toBeUndefined();
  });

  it('skips imperative-shaped greeting case "你好谢谢" (no actionable verb)', () => {
    const ctx = makeCtx([
      { role: 'user', content: '你好谢谢' },
      { role: 'assistant', content: '不客气!' },
    ]);
    expect(detectConversationalIntent(ctx)?.fire).toBe(false);
  });

  it('returns undefined when transcript has no user message', () => {
    const ctx = makeCtx([
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(detectConversationalIntent(ctx)).toBeUndefined();
  });

  it('skips _synthetic user messages and uses the prior real user message', () => {
    // Harness-injected auto-continue prompts should NOT change the
    // gate decision — defer to the original user intent.
    const ctx = makeCtx([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好!' },
      { role: 'user', content: '[auto-continue]', _synthetic: true },
      { role: 'assistant', content: 'Continuing.' },
    ]);
    expect(detectConversationalIntent(ctx)?.fire).toBe(false);
  });
});

describe('H2 — gate.detectWorkScale (metric refinement)', () => {
  // Contexts whose tool-surface is irrelevant (metrics drive the decision);
  // a text-only final turn is the realistic natural-end shape.
  const editCtx = makeCtx([
    { role: 'user', content: 'tweak foo.ts' },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  const readOnlyCtx = makeCtx([
    { role: 'user', content: '这个函数在哪定义?' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't-1', name: 'grep', input: { pattern: 'foo' } }],
    },
    { role: 'assistant', content: [{ type: 'text', text: '定义在 foo.ts:10。' }] },
  ]);
  const noToolCtx = makeCtx([
    { role: 'user', content: '查一下 README' },
    { role: 'assistant', content: [{ type: 'text', text: '我查过了，没有相关内容。' }] },
  ]);

  it('skips a trivial single-file small edit', () => {
    const d = detectWorkScale(editCtx, metrics({ writeOps: 1, filesChanged: 1, estimatedChangedLines: 5 }));
    expect(d?.fire).toBe(false);
    expect(d?.reason).toMatch(/trivial observed work/);
  });

  it('fires a large single-file edit (> TRIVIAL_LINES)', () => {
    const d = detectWorkScale(editCtx, metrics({ writeOps: 1, filesChanged: 1, estimatedChangedLines: 50 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/large single-file/);
  });

  it('fires a multi-file change (filesChanged ≥ 2)', () => {
    const d = detectWorkScale(editCtx, metrics({ writeOps: 3, filesChanged: 3, estimatedChangedLines: 18 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/multi-file/);
  });

  it('fires when the Worker committed a Todolist (hasPlan)', () => {
    const d = detectWorkScale(editCtx, metrics({ hasPlan: true, writeOps: 1, filesChanged: 1, estimatedChangedLines: 3 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/Todolist/);
  });

  it('fires when rounds exceed the threshold (long task)', () => {
    const d = detectWorkScale(editCtx, metrics({ rounds: 11, writeOps: 1, filesChanged: 1, estimatedChangedLines: 4 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/rounds/);
  });

  it('fires on a high-risk shell op even with no tracked file change', () => {
    const d = detectWorkScale(editCtx, metrics({ riskyShellOps: 1 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/shell op/);
  });

  it('fires on an unattributable write op (undo / worktree / scaffold: writeOps>0 but filesChanged=0)', () => {
    // recordMutationForTool counts these as a write op but cannot resolve the
    // file (the path is computed inside the handler), so filesChanged/lines stay
    // 0. Without the blind-spot branch this would fall to the trivial skip.
    const d = detectWorkScale(editCtx, metrics({ writeOps: 1, filesChanged: 0, estimatedChangedLines: 0 }));
    expect(d?.fire).toBe(true);
    expect(d?.reason).toMatch(/no attributable file/);
  });

  it('skips a short grounded read-only lookup (tool evidence, no writes)', () => {
    // taskHasAnyToolUse sees the grep → observable work → trivial → skip.
    const d = detectWorkScale(readOnlyCtx, metrics({}));
    expect(d?.fire).toBe(false);
    expect(d?.reason).toMatch(/trivial observed work/);
  });

  it('returns undefined when there is NO observable work (defers to floor)', () => {
    // No writes, no plan, no tool_use anywhere → not decided here → F184 floor.
    expect(detectWorkScale(noToolCtx, metrics({}))).toBeUndefined();
  });
});

describe('H2 — gate.composeGateDecision', () => {
  const greetingCtx = makeCtx([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好! 我是 KodaX。' },
  ]);
  const imperativeNoToolCtx = makeCtx([
    { role: 'user', content: '查一下 README 文件' },
    {
      role: 'assistant',
      // Intent-vs-action: claims to search but no grep tool fired
      // (the zhipu floor case F184 must catch).
      content: [{ type: 'text', text: '明白，我用 grep 搜索 README...' }],
    },
  ]);
  const trivialEditCtx = makeCtx([
    { role: 'user', content: 'add hello to foo.ts' },
    { role: 'assistant', content: [{ type: 'text', text: 'Added.' }] },
  ]);

  it('fires when KODAX_VERIFIER_ALWAYS=1 even for trivial chat', () => {
    const decision = composeGateDecision(greetingCtx, NO_WORK, {
      KODAX_VERIFIER_ALWAYS: '1',
    });
    expect(decision.fire).toBe(true);
    expect(decision.reason).toMatch(/escape-hatch/);
  });

  it('skips a trivial single-file edit (metric refinement)', () => {
    const decision = composeGateDecision(
      trivialEditCtx,
      metrics({ writeOps: 1, filesChanged: 1, estimatedChangedLines: 6 }),
      {},
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/metric-gate/);
  });

  it('fires a substantial multi-file change (metric refinement)', () => {
    const decision = composeGateDecision(
      trivialEditCtx,
      metrics({ writeOps: 4, filesChanged: 3, estimatedChangedLines: 120 }),
      {},
    );
    expect(decision.fire).toBe(true);
    expect(decision.reason).toMatch(/metric-gate/);
  });

  it('skips when conversational-intent matches (trivial chat, no work)', () => {
    const decision = composeGateDecision(greetingCtx, NO_WORK, {});
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/conversational-intent/);
  });

  it('fires (safe default) when imperative + zero tool action — zhipu floor catch', () => {
    // F184 CORE CONTRACT: imperative user + zero observable action = zhipu
    // intent-vs-action floor case. The metric layer defers (no work), so the
    // default-fire path MUST still catch it.
    const decision = composeGateDecision(imperativeNoToolCtx, NO_WORK, {});
    expect(decision.fire).toBe(true);
    expect(decision.reason).toMatch(/default/);
  });

  it('escape hatch is OFF when env var unset or any value other than "1"', () => {
    const variants: Array<Record<string, string | undefined>> = [
      {},
      { KODAX_VERIFIER_ALWAYS: '' },
      { KODAX_VERIFIER_ALWAYS: '0' },
      { KODAX_VERIFIER_ALWAYS: 'true' },
      { KODAX_VERIFIER_ALWAYS: undefined },
    ];
    for (const env of variants) {
      const decision = composeGateDecision(greetingCtx, NO_WORK, env);
      expect(decision.fire, JSON.stringify(env)).toBe(false);
    }
  });
});
