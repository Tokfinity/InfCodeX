/**
 * v0.7.35.1 FEATURE_142 (B-R1) — coding-caller routing regression test.
 *
 * The byte-equivalence contract requires that ALL coding-layer callers
 * of `compact` from `@kodax-ai/agent` explicitly pass
 * `CODING_SUMMARY_PROMPT` / `CODING_UPDATE_SUMMARY_PROMPT` as the 8th
 * and 9th positional arguments — otherwise the call falls through to
 * `DEFAULT_*_PROMPT` (the neutral default) and the coding path's prompt
 * silently drifts to non-coding wording.
 *
 * The original B-R1 commit (106c63c) updated two of three coding callers
 * but missed `task-engine/_internal/managed-task/compaction.ts` (the
 * Runner-driven AMA compaction hook). The hotfix (this commit) adds the
 * missing routing AND this test, which pins all three known callers so
 * a future similar omission is a test failure instead of a silent
 * regression.
 *
 * Strategy:
 *   1. The CAP-060 caller (`tryIntelligentCompact`) is verified
 *      runtime-style with a `vi.mock('@kodax-ai/agent')` — easy
 *      because the function takes its config as input.
 *   2. The Runner-driven caller (`buildManagedTaskCompactionHook`) is
 *      verified at the source level — its config loads from disk via
 *      `loadCompactionConfig`, so a runtime test would be brittle to
 *      env / cwd. A source assertion is enough to catch the regression
 *      class and stays robust to environmental drift.
 *   3. The REPL caller (`commands.ts`) is verified at the source level
 *      for the same reason (it requires a fully bootstrapped REPL
 *      `InteractiveContext`).
 *
 * If a new coding caller is added, it must be enumerated here AND in
 * the source-level audit. The grep pattern below is the actual gate.
 */

import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import type {
  CompactionConfig,
  CompactionResult,
} from '@kodax-ai/agent';

import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from './coding-compaction-prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname → packages/coding/src/agent-runtime/ → up 4 = repo root.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Runtime test for the CAP-060 caller (mockable input config).
// ---------------------------------------------------------------------------

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    compact: vi.fn(),
  };
});

import { compact as mockedCompact } from '@kodax-ai/agent';
import { tryIntelligentCompact } from './middleware/compaction-orchestration.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  compactMock.mockReset();
});

function compactionConfig(): CompactionConfig {
  return {
    enabled: true,
    triggerPercent: 1,
    keepRecentTurns: 3,
  } as CompactionConfig;
}

class StubProvider extends KodaXBaseProvider {
  readonly name = 'stub';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'STUB_KEY',
    model: 'stub-model',
    supportsThinking: false,
    contextWindow: 200_000,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _thinking?: boolean,
    _streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    return { textBlocks: [], toolBlocks: [], thinkingBlocks: [] };
  }

  override getContextWindow(): number {
    return 200_000;
  }
}

describe('B-R1 byte-equivalence — runtime routing', () => {
  it('CAP-060 (compaction-orchestration.ts) routes CODING_*_PROMPT as positional args 8 + 9', async () => {
    const successfulResult: CompactionResult = {
      compacted: true,
      messages: [],
      tokensBefore: 1000,
      tokensAfter: 100,
      entriesRemoved: 5,
      summary: '## Goal\nstub',
      details: { readFiles: [], modifiedFiles: [] },
      artifactLedger: [],
      memorySeed: {
        objective: undefined,
        constraints: [],
        progress: { completed: [], inProgress: [], blockers: [] },
        keyDecisions: [],
        nextSteps: [],
        keyContext: [],
        importantTargets: [],
        tombstones: [],
      },
    };
    compactMock.mockResolvedValue(successfulResult);

    await tryIntelligentCompact({
      messages: [{ role: 'user', content: 'hello' }],
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: compactionConfig(),
      provider: new StubProvider(),
      model: 'active-model',
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events: {},
    });

    expect(compactMock).toHaveBeenCalledTimes(1);
    const args = compactMock.mock.calls[0];
    // compact(messages, config, provider, contextWindow, customInstructions,
    //         systemPrompt, tokenCountOverride, summaryPrompt,
    //         updateSummaryPrompt, modelOverride)
    expect(args[7]).toBe(CODING_SUMMARY_PROMPT);
    expect(args[8]).toBe(CODING_UPDATE_SUMMARY_PROMPT);
    expect(args[9]).toBe('active-model');
  });
});

// ---------------------------------------------------------------------------
// TUI-safety: the compaction stderr trace must be debug-gated.
//
// Regression guard for the v0.7.57 report where `[Compaction] triggered {...}`
// leaked below the live region of the Ink TUI (renderer runs with
// `patchConsole: false`, so a bare `console.*` write bypasses the engine and
// desyncs the cell frame). User-facing observability is delivered via the
// `onCompactStats` / `onCompact` lifecycle events instead; the raw stderr
// trace is only for `KODAX_DEBUG_COMPACTION` debugging.
// ---------------------------------------------------------------------------

describe('compaction stderr trace is debug-gated (TUI safety)', () => {
  const successfulResult: CompactionResult = {
    compacted: true,
    messages: [],
    tokensBefore: 1000,
    tokensAfter: 100,
    entriesRemoved: 5,
  };

  const priorEnv = process.env.KODAX_DEBUG_COMPACTION;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    compactMock.mockResolvedValue(successfulResult);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    if (priorEnv === undefined) {
      delete process.env.KODAX_DEBUG_COMPACTION;
    } else {
      process.env.KODAX_DEBUG_COMPACTION = priorEnv;
    }
  });

  it('does not write to console by default, but still emits lifecycle events', async () => {
    delete process.env.KODAX_DEBUG_COMPACTION;
    const onCompactStats = vi.fn();
    const onCompact = vi.fn();

    await tryIntelligentCompact({
      messages: [{ role: 'user', content: 'hello' }],
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: compactionConfig(),
      provider: new StubProvider(),
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events: { onCompactStats, onCompact },
    });

    // No raw stderr write — the screen stays uncorrupted in the TUI.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    // Observability is still delivered through the event channel.
    expect(onCompactStats).toHaveBeenCalledWith(
      expect.objectContaining({ tokensBefore: 1000 }),
    );
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('writes the [Compaction] stderr trace only when KODAX_DEBUG_COMPACTION is set', async () => {
    process.env.KODAX_DEBUG_COMPACTION = '1';

    await tryIntelligentCompact({
      messages: [{ role: 'user', content: 'hello' }],
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: compactionConfig(),
      provider: new StubProvider(),
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events: {},
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('[Compaction] triggered');
  });
});

// ---------------------------------------------------------------------------
// Source-level audit for environment-bound callers.
// ---------------------------------------------------------------------------

interface CodingCallerCheck {
  readonly description: string;
  readonly file: string;
}

/**
 * Add an entry here for every coding-layer call site that invokes
 * `compact` (or `intelligentCompact`) from `@kodax-ai/agent`.
 * The audit asserts that both `CODING_SUMMARY_PROMPT` and
 * `CODING_UPDATE_SUMMARY_PROMPT` appear adjacent (separated only by
 * whitespace / commas / line breaks) — catches the regression class
 * where one is imported but the call site is missed.
 */
const CODING_CALLERS: readonly CodingCallerCheck[] = [
  {
    description: 'managed-task/compaction.ts (Runner-driven AMA path)',
    file: 'packages/coding/src/task-engine/_internal/managed-task/compaction.ts',
  },
  {
    description: 'middleware/compaction-orchestration.ts (CAP-060 LLM path)',
    file: 'packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts',
  },
  {
    description: 'repl/interactive/commands.ts (manual /compact command)',
    file: 'packages/repl/src/interactive/commands.ts',
  },
];

// Adjacent-positional-args pattern: CODING_SUMMARY_PROMPT, then optional
// trailing comma + whitespace + CRLF / LF, then CODING_UPDATE_SUMMARY_PROMPT.
// Tolerates Windows CRLF and any indentation.
const ADJACENT_ROUTING_PATTERN =
  /CODING_SUMMARY_PROMPT,\s*CODING_UPDATE_SUMMARY_PROMPT/;

describe('B-R1 byte-equivalence — source-level audit', () => {
  for (const caller of CODING_CALLERS) {
    it(`${caller.description} routes both CODING_*_PROMPT as adjacent positional args`, () => {
      const path = join(REPO_ROOT, caller.file);
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('CODING_SUMMARY_PROMPT');
      expect(source).toContain('CODING_UPDATE_SUMMARY_PROMPT');
      // Both must appear adjacent in the source — a stronger signal
      // than just both being present, because mere presence allows the
      // case where they're imported but not actually passed to compact.
      expect(source).toMatch(ADJACENT_ROUTING_PATTERN);
    });
  }
});
