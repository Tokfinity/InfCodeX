# Issue 216 v0.7.77 Regression Guide

## Scope

Verify official Codex CLI and Gemini CLI cache usage survives the complete
CLI JSONL -> pseudo-ACP -> KodaX usage -> Runtime diagnostics chain without
estimation or double-counting.

## Codex CLI

1. Feed a `turn.completed` fixture containing `input_tokens`,
   `cached_input_tokens`, `cache_write_input_tokens`, and `output_tokens`.
2. Verify KodaX preserves input/output totals and maps the two cache counters
   to `cachedReadTokens` and `cachedWriteTokens`.
3. Verify cache counters are not added to `inputTokens`.
4. Repeat with explicit zero and verify both properties are present with `0`.
5. Repeat with absent, negative, null, and malformed counters and verify they
   are omitted.

## Gemini CLI

1. Feed a `result` fixture containing `stats.input_tokens`,
   `stats.output_tokens`, `stats.total_tokens`, and `stats.cached`.
2. Verify `stats.cached` maps to `cachedReadTokens`.
3. Verify `cachedWriteTokens` remains absent because Gemini does not report it.
4. Repeat with explicit zero and verify `cachedReadTokens: 0` is preserved.
5. Repeat with absent or invalid cache data and verify it remains omitted.

## ACP and Runtime

1. Pass both cache counters through the pseudo-ACP terminal response and verify
   the normalized KodaX Provider result retains them.
2. Verify missing required ACP input/output/total usage produces no usage
   object rather than a fabricated all-zero record.
3. Emit Runtime `provider.cache.diagnostics` responses for reported zero and
   unreported cache fields.
4. Verify realtime and latest-value consumers can distinguish a present `0`
   from an absent property after JSON/daemon transport.

## Commands

```bash
npx vitest run \
  packages/llm/src/cli-events/codex-parser.test.ts \
  packages/llm/src/cli-events/gemini-parser.test.ts \
  packages/llm/src/cli-events/pseudo-acp-server.test.ts \
  packages/llm/src/providers/acp-base.test.ts \
  packages/coding/src/agent-runtime/prompt-cache-diagnostics.test.ts \
  src/sdk-runtime.test.ts \
  src/runtime-daemon/server.test.ts \
  src/runtime-daemon/client.test.ts
```
