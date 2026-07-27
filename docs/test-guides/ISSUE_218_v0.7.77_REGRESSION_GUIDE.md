# Issue 218 v0.7.77 Regression Guide

## Scope

Verify that a missing local file referenced by historical image content no longer prevents
later Provider requests, while non-missing filesystem failures remain visible.

## Missing User Image

1. Build an OpenAI-compatible user message containing text and an image path that does not
   exist.
2. Verify serialization keeps the text and replaces the image with
   `[Historical image unavailable: the local attachment file is missing.]`.
3. Verify the serialized request does not expose the local path.
4. Repeat through an Anthropic-compatible Provider and verify the same path-free marker.

## Missing Tool-Result Image

1. Build a matched Anthropic `tool_use` / `tool_result` pair whose result contains a missing
   image.
2. Verify the `tool_result` envelope remains valid and contains the text marker.
3. Verify a later top-level image in the same user turn is independently degraded.
4. Repeat with an OpenAI-compatible Provider and multiple missing tool-result images.
5. Verify every item gets the missing marker and no structured image item serializes its local
   path. For an existing tool-result image, verify the path-free provider-unsupported marker.

## Error Boundary

1. Read an existing directory through the image serializer.
2. Verify the platform `EISDIR` error is propagated.
3. Repeat with another non-`ENOENT` / non-`ENOTDIR` failure where supported.

## Commands

```bash
npx vitest run \
  packages/llm/src/providers/image-serialization.test.ts \
  packages/llm/src/providers/openai-message-serialization.test.ts \
  packages/llm/src/providers/anthropic-message-serialization.test.ts

npm run build
```
