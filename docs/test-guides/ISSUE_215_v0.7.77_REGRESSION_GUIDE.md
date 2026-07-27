# Issue 215 v0.7.77 Regression Guide

## Scope

Validate stable, opaque Provider prompt-cache affinity without changing prompt
bytes, cache usage accounting, ACP conversation identity, or strict compatible
Provider requests.

## AMA root continuity

1. Run two physical Provider requests in one logical Runtime Session.
2. Resume that Session and issue another Run.
3. Verify every request carries the same 64-character hexadecimal affinity key.
4. Verify the raw Session ID does not appear in the key.
5. Repeat with `disablePromptCache: true` and verify no affinity field is sent.
6. With context diagnostics enabled, verify supported requests expose only a
   stable `promptCacheAffinityHash`; the raw key and logical identity must not
   appear in the event.

## SA and recursive child isolation

1. Run a root Agent that spawns a child and nested grandchild.
2. Let the parent make another request after the descendants complete.
3. Verify all parent requests reuse one key.
4. Verify each canonical child Agent path receives its own stable key even when
   its physical transcript Session changes.
5. Verify root, child, grandchild, and sibling keys are distinct.

## Retry, fallback, and compaction

1. Force one streaming retry and verify the retried request retains the key.
2. Force the non-streaming fallback and verify `complete()` retains the key.
3. Trigger max-token continuation and verify it retains the key.
4. Trigger automatic compaction and verify the summary request and the first
   post-compaction request retain the logical context key.
5. Verify Provider-supplied cache usage remains the only source of
   `cachedTokens` and cache-write counts.

## Provider lowering and compatibility

1. For built-in `kimi-code`, inspect the Anthropic-compatible request and
   verify the opaque key is `metadata.user_id`.
2. For built-in `kimi` and official `openai`, verify it is
   `prompt_cache_key`.
3. Verify official Anthropic and unconfigured OpenAI/Anthropic-compatible
   custom Providers do not receive either field.
4. Configure a compatible custom Provider with `promptCacheAffinity: true` and
   verify its protocol-specific field is emitted.
5. Set `promptCacheAffinity` to a non-boolean value and verify configuration
   validation rejects it.

## Interpretation

A stable affinity key improves Provider routing but does not guarantee a cache
hit. Compare Provider/model/endpoint, request-envelope hashes, call time, and
Provider-returned cache usage before attributing a miss to KodaX. Compare
`promptCacheAffinityHash` separately: it is deliberately excluded from
`requestEnvelopeHash` because routing metadata does not change prompt bytes.
An absent affinity hash means the configured endpoint did not apply affinity,
the cache was disabled, or no stable logical identity was available.
This release deliberately isolates canonical Agent paths. It does not claim
root-to-child or sibling-to-sibling first-call reuse; evaluate any future
session-wide or prefix-family policy with controlled hash/RPM measurements.
