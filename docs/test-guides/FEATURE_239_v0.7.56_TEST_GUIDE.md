# FEATURE_239 v0.7.56 Human Test Guide

## Overview

**Feature**: SDK Multimodal Input + Clipboard Image Public API
**Version**: v0.7.56
**Test Date**: 2026-06-24
**Tester**: TBD

This guide focuses on host-visible behavior: SDK import shape, clipboard image
flow, file/video/GIF capability preflight, queued follow-ups with artifacts,
REPL compatibility, model capability copy, and fail-closed artifact validation.
Low-level mapping and TypeScript contracts are covered by automated tests.

## Environment

- Build from the current workspace.
- Use a temporary KodaX home when testing REPL behavior:
  `set KODAX_HOME=%TEMP%\kodax-f239-manual`
- Configure at least one image-capable provider route, such as `openai` or
  `kimi` with `model=k2.6`, if you want to send a real prompt.
- Prepare one small PNG/JPEG/WebP image, one animated GIF, one small PDF or text
  file, one small MP4/WebM video, and one unsupported image extension such as
  `.bmp`.

## Manual Test Cases

### TC-001: SDK media subpath is usable from a host app

**Priority**: High
**Type**: Positive / SDK

1. Build KodaX with `npm run build`.
2. In a small ESM script or host app, import from `@kodax-ai/kodax/media`.
3. Call `createImageArtifactFromPath('/tmp/demo.png', { source: 'clipboard' })`.
4. Call `createFileArtifactFromPath('/tmp/report.pdf', { mediaType: 'application/pdf' })`.
5. Call `createVideoArtifactFromPath('/tmp/demo.mp4')`.
6. Call `getModelInputCapabilities({ provider: 'minimax-coding', model: 'MiniMax-M3' })`.

**Expected**

- [ ] The import succeeds without reaching into `packages/repl/src`.
- [ ] The created artifact has `kind: 'image'`, `mediaType: 'image/png'`, and
      `source: 'clipboard'`.
- [ ] The MiniMax M3 route reports image `supported`.
- [ ] The same route reports video `provider-native-unwired`, not send-enabled.
- [ ] The file artifact has `kind: 'file'`; the video artifact has
      `kind: 'video'` and `mediaType: 'video/mp4'`.

### TC-002: Clipboard image fallback produces a host-storable image

**Priority**: High
**Type**: Positive / UX

1. Copy a screenshot or image to the OS clipboard.
2. Call `readAndNormalizeClipboardImage()` from a host script.
3. Store the returned bytes in a host-controlled temporary directory.
4. Construct an artifact with `createImageArtifactFromPath(storedPath)`.

**Expected**

- [ ] A clipboard image returns normalized PNG or JPEG bytes with width/height.
- [ ] Clipboard text or empty clipboard returns `null` without crashing.
- [ ] The host can choose its own storage directory.
- [ ] The constructed artifact can be passed in `context.inputArtifacts`.

### TC-003: Unsupported provider/model routes fail before send

**Priority**: High
**Type**: Negative / Safety

1. Create an image artifact for a valid `.png` path.
2. Call `validateInputArtifactsForModel([artifact], { provider: 'codex-cli' })`.
3. Repeat with `{ provider: 'ark-coding', model: 'kimi-k2.6' }`.

**Expected**

- [ ] Both validations throw `KodaXMediaError`.
- [ ] The error code is `MODEL_INPUT_UNSUPPORTED`.
- [ ] The gateway route does not inherit Kimi image support by model name alone.

### TC-004: Unsupported media type is explicit

**Priority**: Medium
**Type**: Negative / Boundary

1. Create or simulate an image artifact with `mediaType: 'image/bmp'`.
2. Validate it against `{ provider: 'kimi', model: 'k2.6' }`.

**Expected**

- [ ] Validation throws `KodaXMediaError`.
- [ ] The error code is `UNSUPPORTED_MEDIA_TYPE`.
- [ ] No provider request is made.

### TC-005: Existing REPL paste behavior still feels unchanged

**Priority**: High
**Type**: Regression / UX

1. Start the REPL.
2. Paste ordinary text.
3. Paste or drag a local PNG/JPEG image path into the terminal.
4. Trigger the explicit clipboard-image keybinding with no image on clipboard.

**Expected**

- [ ] Text paste still inserts text.
- [ ] Image path paste still attaches an image block.
- [ ] No-image clipboard fallback remains a quiet no-op.
- [ ] Any image processing failure is shown as an inline error, not a crash.

### TC-006: File and video artifacts fail at validation with stable reasons

**Priority**: High
**Type**: Negative / SDK

1. Construct a file artifact with `createFileArtifactFromPath()`.
2. Construct a video artifact with `createVideoArtifactFromPath()`.
3. Validate each against `{ provider: 'kimi', model: 'k2.6' }`.
4. Repeat the video validation against `{ provider: 'minimax-coding', model: 'MiniMax-M3' }`.

**Expected**

- [ ] File validation throws `KodaXMediaError` with code
      `MODEL_INPUT_UNSUPPORTED`.
- [ ] Video validation throws `KodaXMediaError` with code
      `MODEL_INPUT_UNSUPPORTED`.
- [ ] The native-video route error detail includes `provider-native-unwired`.
- [ ] No provider request is made.

### TC-007: Direct GIF path remains an image artifact

**Priority**: Medium
**Type**: Boundary / SDK

1. Construct an artifact for an animated GIF path with
   `createImageArtifactFromPath('/tmp/animated.gif')`.
2. Validate it against an image-capable route such as
   `{ provider: 'mimo-coding', model: 'mimo-v2.5' }`.
3. Send a small prompt with `context.inputArtifacts: [artifact]` if the route is
   configured.

**Expected**

- [ ] The artifact media type is `image/gif`.
- [ ] Validation passes for image-capable routes.
- [ ] KodaX preserves the direct-path `image/gif` media type.
- [ ] Clipboard fallback GIF normalization is documented as static PNG/JPEG, not
      animation-preserving.

### TC-008: Streaming follow-up queue preserves image artifacts

**Priority**: High
**Type**: Positive / SDK

1. Start a run that remains active long enough to accept a follow-up.
2. Call `enqueueWithArtifacts({ provider, model, sessionId, content, inputArtifacts })`
   with an image artifact.
3. Drain or observe the next runner turn.
4. Repeat with a file artifact.

**Expected**

- [ ] The image follow-up is accepted into the queue.
- [ ] The queued message retains `inputArtifacts`.
- [ ] The next runner turn receives a multimodal user message with text + image.
- [ ] The file follow-up is rejected before enqueueing with
      `MODEL_INPUT_UNSUPPORTED`.

## Test Summary

| Cases | Pass | Fail | Blocked |
|---:|---:|---:|---:|
| 8 | - | - | - |

**Conclusion**: TBD
**Issues Found**: TBD

Feature/Issue ID: FEATURE_239
