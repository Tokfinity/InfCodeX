# FEATURE_284 v0.7.79 Test Guide

## Scope

Verify that Qwen Token Plan defaults to `qwen3.8-max`, retains
`qwen3.8-max-preview`, and preserves reasoning and image-input behavior.

## Prerequisites

- Node.js 20 or later and workspace dependencies installed.
- Optional live smoke: a valid `QWEN_TOKEN_API_KEY`.

## Automated Verification

```bash
npx vitest run packages/llm/src/providers/registry.test.ts packages/llm/src/providers/provider-capabilities.test.ts packages/llm/src/cost-rates.test.ts packages/agent/src/media/capabilities.test.ts packages/coding/src/self-knowledge/registry.test.ts
npm run build:packages
```

Expected: all commands exit successfully. Registry assertions show
`qwen3.8-max` first and `qwen3.8-max-preview` second.

## Manual Verification

1. Set `QWEN_TOKEN_API_KEY` without writing it into project files.
2. Start `kodax --provider qwen-token-plan` and run `/model`.
3. Confirm the selected default is `qwen3.8-max` and Preview remains available.
4. Send a short text prompt and confirm a normal response.
5. Attach a small PNG or JPEG and confirm the model analyzes it.
6. Select `qwen3.8-max-preview`, repeat a short prompt, and confirm compatibility.
7. Attempt effort `none` for either Qwen 3.8 ID and confirm KodaX rejects the
   request locally because thinking is always enabled.

## Pass Criteria

- Default, compatibility selection, text response, and image input all work.
- No credential is logged or stored by the test.
- Older Token Plan models remain selectable with unchanged behavior.
