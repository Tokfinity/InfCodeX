# Issue 212 v0.7.77 Regression Guide

## Scope

Validate the cross-review hardening that aligns child evidence, interrupt
admission, governed-memory safety, terminal events, and structured-output
Schemas with their production contracts.

## Automated gate

```bash
npx vitest run \
  packages/coding/src/child-executor.test.ts \
  packages/coding/src/agent-runtime/run-substrate.terminal-interrupt.test.ts \
  packages/coding/src/agent-runtime/__contract-tests__/cap-005-events-complete.contract.test.ts \
  packages/agent/src/memory-control/prompt-safety.test.ts \
  packages/coding/src/memory/policy-artifact.test.ts \
  packages/coding/src/orchestration/pattern-result.test.ts \
  packages/coding/src/workflows/structured-output.test.ts
```

Expected: every file passes with no snapshot or evidence-fingerprint update
outside the reviewed v0.7.77 values.

## Child evidence

1. Return a child `agent-turn:` result containing a fenced Markdown code block.
2. Read it through `agent_output` or the evidence resolver.
3. Verify the outer evidence fence remains valid.
4. Verify nested fences use invisible zero-width separators and no visible
   mojibake appears.

## Runtime interrupt batch

1. Queue two active-Run prompt inputs before the terminal boundary.
2. Make the second input contain an artifact unsupported by the active
   provider/model.
3. Verify the Run fails visibly.
4. Verify neither queued prompt was consumed and no partial user-message batch
   was appended.

## Memory evidence

1. Offer a qualified credential sentence such as
   `The db password used by staging is ...`.
2. Verify prompt-safe memory sanitization rejects it.
3. Verify the frozen evidence-template SHA-256 includes the policy identity,
   claim/reference limits, reference count, token reserve, and prompt-safety
   marker.

## Terminal and Schema alignment

1. Exhaust an ordinary coding Run's iteration limit with a tool call and verify
   `onComplete` fires exactly once.
2. Make a completion observer throw `AbortError`; verify the result and live
   turn both report `interrupted`.
3. Validate a pattern-disposition target containing both actor/turn fields and
   `evidenceRef`; verify first-pass `oneOf` validation rejects it.
4. Verify the same `oneOf` Schema remains accepted as a Workflow
   `outputSchema`.
