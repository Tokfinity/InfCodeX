# GLM-5.3 Coding Plan v0.7.87 Regression Guide

## Purpose

Verify the v0.7.87 Zhipu Coding Plan model catalog, exact wire IDs, reasoning
normalization, documentation, and account-entitlement behavior. Do not run
`npm publish`; publication remains a manual maintainer step.

## Prerequisites

- Node.js 20 or 22 and dependencies installed with `npm ci`.
- `ZHIPU_CODING_API_KEY` for China Coding Plan checks.
- `ZAI_CODING_API_KEY` for overseas Coding Plan checks.
- Use a disposable session and prompts that request only `OK` to minimize cost.

## Automated regression

1. Run the provider and manual suites:

   ```bash
   npx vitest run packages/llm/src/providers/registry.test.ts packages/llm/src/providers/provider-capabilities.test.ts packages/llm/src/providers/anthropic-reasoning-capability.test.ts packages/llm/src/providers/openai-reasoning-capability.test.ts packages/llm/src/wire-effort.test.ts packages/repl/src/interactive/completers/argument-completer.test.ts packages/coding/src/self-knowledge/registry.test.ts
   ```

2. Confirm all tests pass and the assertions cover:

   - `zhipu-coding` default `glm-5.3`, with `glm-5.2` selectable;
   - `zai-coding` default `glm-5.2`, with `glm-5.3` retained;
   - wire IDs exactly `glm-5.3` / `glm-5.2`, with no `[1m]` suffix;
   - GLM-5.3 `off` / `none` lowering to enabled low-effort thinking.

## CLI model catalog

1. Start KodaX with each configured alias.
2. Run `/model` and inspect completion choices.
3. Confirm the defaults and both GLM routes match the automated assertions.
4. Switch away from and back to each model; confirm the saved model is shown in
   the header and status bar.

## Live request matrix

For each cell, send `Reply only OK` with a maximum output of 32 tokens:

| Provider/model | Expected result |
|---|---|
| `zhipu-coding/glm-5.3` | Success; exact raw model ID; no disabled-thinking rejection. |
| `zhipu-coding/glm-5.2` | Success; usable rollback route. |
| `zai-coding/glm-5.2` | Success; overseas default route. |
| `zai-coding/glm-5.3` | Success when entitled, otherwise upstream 1220 permission error. It must not be reported as 1214 model-not-found. |

Repeat the `glm-5.3` request with an explicit `off` / `none` intent. The request
must succeed for an entitled key because KodaX emits low effort rather than
disabled thinking.

As a negative control, a direct diagnostic request using `glm-5.3[1m]` or
`glm-5.2[1m]` should return upstream 1214 model-not-found. Never place those
invalid names in KodaX configuration.

## Documentation and package checks

1. Search current README, public provider docs, LLM package guide,
   `kodax_manual`, changelog, release checklist, and v0.7.87 feature record.
2. Confirm all describe the same defaults, raw IDs, effort mapping, and overseas
   entitlement boundary.
3. Confirm every root/workspace package and lockfile entry is `0.7.87`.
4. Run `node scripts/release.mjs --pack-only`, install the exact tarball into an
   empty consumer, and import the root plus all 12 SDK subpaths.
5. Leave npm publication to the maintainer.
