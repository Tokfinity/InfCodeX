/**
 * Wire-compat smoke eval — empty-content / orphan-repair root-cause fix.
 *
 * SKIPPED by default (CI has no keys). Run against real provider HTTP with:
 *
 *   KODAX_INTEGRATION_TEST=1 npm run test:integration -- \
 *     packages/llm/src/providers/empty-content-wire-compat.integration.test.ts
 *
 * Purpose (NOT a prompt-behavior eval — see benchmark/EVAL_GUIDELINES.md):
 * verify that the special history shapes produced by the empty-content fix
 * are ACCEPTED by every real gateway (no 4xx/5xx) and the stream COMPLETES
 * (no interruption). Primary assertion is mechanical — `provider.stream(...)`
 * resolves without throwing. Per EVAL_GUIDELINES §Raw output preservation,
 * EVERY run's raw response (text + stopReason + toolCalls) is dumped to
 *   os.tmpdir()/kodax-eval-dumps/empty-content-wire-compat/<provider>.json
 * so the orchestrating session can LLM-judge it afterwards for false
 * positives (stream completed but the model was derailed into a degenerate
 * reply by the empty marker / wire '...') and false negatives (a transient
 * 429/timeout misread as a shape rejection).
 *
 * Per EVAL_GUIDELINES anti-pattern 3 (shared coding-plan quota): all cases
 * live in ONE file → vitest runs them sequentially → concurrency = 1.
 *
 * Cases (provider-wire level):
 *   C1 empty-text marker mid-history     → P1: serializer synthesizes wire '...'
 *   C2 empty tool_result (content: '')   → P1④: faithful '', not rewritten
 *   C3 thinking-only turn (gated)        → reasoning_content replay
 *   C4 orphan tool_use (no tool_result)  → P2 / repairToolCallHistory drops it
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveProvider } from './resolver.js';
import type { KodaXMessage, KodaXToolDefinition } from '../types.js';

const RUN_INTEGRATION = process.env.KODAX_INTEGRATION_TEST === '1';

const PROVIDER_NAMES = [
  'kimi-code',
  'zhipu-coding',
  'minimax-coding',
  'mimo-coding',
  'mimo',
  'ark-coding',
  'deepseek',
] as const;

const SYSTEM_PROMPT = 'You are a terse test assistant. Reply with a single short word.';

const NOOP_TOOL: KodaXToolDefinition = {
  name: 'noop',
  description: 'A no-op tool, used only to make a replayed tool_use well-formed.',
  input_schema: { type: 'object', properties: {} },
};

interface WireCase {
  readonly id: string;
  readonly description: string;
  readonly tools: KodaXToolDefinition[];
  readonly messages: KodaXMessage[];
  /** The single word the final user turn asks for — judge anchor. */
  readonly expectWord: string;
  readonly requiresThinking?: boolean;
}

const CASES: WireCase[] = [
  {
    id: 'C1-empty-text-marker',
    description: 'empty-text marker mid-history serializes (wire "...") and is accepted',
    expectWord: 'ok',
    tools: [],
    messages: [
      { role: 'user', content: 'Say hello.' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'Now reply with exactly the word: ok' },
    ],
  },
  {
    id: 'C2-empty-tool-result',
    description: 'empty tool_result (content: "") passes through faithfully, not 400',
    expectWord: 'done',
    tools: [NOOP_TOOL],
    messages: [
      { role: 'user', content: 'Run the noop tool.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '' },
          { type: 'text', text: 'Reply with exactly the word: done' },
        ],
      },
    ],
  },
  {
    id: 'C3-thinking-only',
    description: 'thinking-only replayed turn is accepted (reasoning_content replay)',
    expectWord: 'yes',
    requiresThinking: true,
    tools: [],
    messages: [
      { role: 'user', content: 'Think, then answer.' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user wants a short reply.' }] },
      { role: 'user', content: 'Reply with exactly the word: yes' },
    ],
  },
  {
    id: 'C4-orphan-tool-use',
    description: 'orphan tool_use (no tool_result) is repaired by the serializer, not 400',
    expectWord: 'recovered',
    tools: [NOOP_TOOL],
    messages: [
      { role: 'user', content: 'Run noop.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_orphan', name: 'noop', input: {} }] },
      { role: 'user', content: 'Reply with exactly the word: recovered' },
    ],
  },
];

const DUMP_DIR = path.join(tmpdir(), 'kodax-eval-dumps', 'empty-content-wire-compat');
const accumulated: Record<string, unknown[]> = {};

function recordAndDump(provider: string, record: Record<string, unknown>): void {
  (accumulated[provider] ??= []).push(record);
  // Re-mkdir before every write — Windows tmp cleanup can vanish the dir
  // mid-run (see feedback_audit_dump_dir_vanishes).
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(
    path.join(DUMP_DIR, `${provider}.json`),
    JSON.stringify({ provider, runs: accumulated[provider] }, null, 2),
  );
}

describe.skipIf(!RUN_INTEGRATION)('empty-content wire-compat — real provider HTTP', () => {
  for (const name of PROVIDER_NAMES) {
    const provider = resolveProvider(name);
    const configured = provider.isConfigured();

    describe.skipIf(!configured)(`${name}`, () => {
      for (const c of CASES) {
        const skip = c.requiresThinking && !provider.supportsThinking;
        it.skipIf(skip)(`${c.id}: ${c.description}`, async () => {
          const started = Date.now();
          try {
            const result = await provider.stream(c.messages, c.tools, SYSTEM_PROMPT);
            const text = result.textBlocks.map((b) => b.text).join('');
            recordAndDump(name, {
              case: c.id,
              ok: true,
              expectWord: c.expectWord,
              stopReason: result.stopReason ?? null,
              text,
              toolCalls: result.toolBlocks.map((b) => b.name),
              usage: result.usage ?? null,
              durationMs: Date.now() - started,
            });
            // Primary mechanical assertion: gateway accepted the shape and the
            // stream completed without throwing. Coherence of `text` is judged
            // separately by the orchestrating session from the dump.
            expect(result).toBeDefined();
          } catch (error) {
            recordAndDump(name, {
              case: c.id,
              ok: false,
              expectWord: c.expectWord,
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
              durationMs: Date.now() - started,
            });
            // eslint-disable-next-line no-console
            console.error(`[wire-compat] ${name} ${c.id} FAILED:`, error);
            throw error;
          }
        }, 90_000);
      }
    });
  }
});
