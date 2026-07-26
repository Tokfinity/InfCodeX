# Prompt Cache Cross-Run Regression Guide

## Automated regression

Run the cache-prefix, serialization, AMA continuity, diagnostics, idle-yield,
compaction, and Runtime tests:

```powershell
npm exec vitest -- run packages/llm/src/providers/anthropic-cache-control.test.ts packages/llm/src/providers/anthropic-message-serialization.test.ts packages/llm/src/providers/anthropic-reasoning-capability.test.ts packages/agent/src/orchestration/idle-yield.test.ts packages/agent/src/session-lineage/compaction/post-compact.test.ts packages/coding/src/task-engine/_internal/managed-task/role-prompt.test.ts packages/coding/src/task-engine/runner-driven.test.ts packages/coding/src/agent-runtime/durable-compaction.test.ts src/sdk-runtime.test.ts
```

Confirm that consecutive AMA runs keep the same `systemPromptHash`,
`toolSchemaHash`, `messagePrefixHash`, `reasoningHash`, `wireModel`, endpoint,
output limit, and cache setting before interpreting a cache-hit change.

## Opt-in real-provider lifetime probe

This probe sends five paid requests and takes about 16 minutes. It uses the
same system, tools, messages, provider endpoint, and wire model for every call.
It logs hashes and official provider usage but never logs prompt text.

```powershell
npm run build:packages
node scripts/probe-prompt-cache.mjs zai-coding glm-5.2 --confirm-cost
```

The calls occur at seed, 10 seconds, 1 minute, 5 minutes, and 10 minutes.
Missing `cachedReadTokens` or `cachedWriteTokens` remains absent in the JSON;
the probe never estimates either value.

Interpret low cache reads as TTL/routing/provider behavior only when all logged
identity and request hashes remain equal. Repeat the probe before drawing a
conclusion about load balancing or cache shards.
