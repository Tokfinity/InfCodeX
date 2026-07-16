/**
 * FEATURE_134 (v0.7.40) — REPL image / screenshot paste building blocks.
 *
 * **Status**: foundation modules shipped + tested. REPL UI integration
 * (keybinding registration, pill insertion in `prompt-input-controller`,
 * pending-images state in `repl.ts`, message injection on submit)
 * lands in a follow-up commit — design doc
 * [`docs/features/v0.7.40.md`](../../../../docs/features/v0.7.40.md)
 * §FEATURE_134 lists the wiring points.
 *
 * Public surface:
 *   - `extractBracketedPaste` / `parseKeypress.isPaste` — terminal
 *     bracketed-paste detection (Source 1+2+3 path)
 *   - `handleBracketedPaste(content)` — orchestrator: routes to image
 *     paths / clipboard read / plain text
 *   - `triggerExplicitClipboardImage()` — Alt+V / Ctrl+V keybind path
 *     (Source 4+5)
 *   - `enableBracketedPasteMode` / `disableBracketedPasteMode` /
 *     `installBracketedPasteShutdownGuard` — DEC 2004 lifecycle
 *
 * Internal modules (not re-exported, used by orchestrator):
 *   - `image-normalize.ts` — jimp decode + resize + JPEG fallback
 *   - `clipboard-image.ts` — platform clipboard reader
 *   - `persist-image.ts` — write to `$TMPDIR/kodax-paste/` and build
 *     `KodaXImageBlock`
 */

export {
  enableBracketedPasteMode,
  disableBracketedPasteMode,
  installBracketedPasteShutdownGuard,
  isBracketedPasteModeEnabled,
} from './bracketed-paste-mode.js';

export {
  type PasteHandlerOutcome,
  extractImagePaths,
  handleBracketedPaste,
  triggerExplicitClipboardImage,
} from './paste-handler.js';

export {
  ImageResizeError,
  MAX_DIMENSION,
  TARGET_RAW_SIZE_BYTES,
  type NormalizedImage,
  normalizePastedImage,
} from './image-normalize.js';

export { readClipboardImage } from './clipboard-image.js';

export {
  PASTE_TMP_DIR_ENV,
  PASTE_TMP_TTL_MS,
  persistImageAsBlock,
  prunePasteTmpDir,
} from './persist-image.js';
