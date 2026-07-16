// @ts-nocheck
import process from 'node:process';
import React from 'react';
import { throttle } from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import { onExit as signalExit } from 'signal-exit';
import patchConsole from 'patch-console';
import { LegacyRoot, ConcurrentRoot } from 'react-reconciler/constants.js';
import Yoga from 'yoga-layout';
import wrapAnsi from 'wrap-ansi';
import terminalSize from 'terminal-size';
import { isDev } from './utils.js';
// FEATURE_214 — claudecode ink.tsx displayCursor model. All input-cursor moves are
// RELATIVE between actually-tracked positions (resting cursor, displayCursor,
// input target); never recomputed from raw screen.height. `cursorMoveSeq` is the
// relative move; `toVisibleCursor` (below) maps a frame-coordinate point to the
// VISIBLE terminal row the cell renderer actually leaves the cursor on. Computing
// relative to the VISIBLE row, not raw screen.height, is what stays correct once
// scrollback history makes the content taller than the viewport.
const cursorMoveSeq = (dx, dy) =>
    (dy < 0 ? ansiEscapes.cursorUp(-dy) : dy > 0 ? ansiEscapes.cursorDown(dy) : '') +
    (dx < 0 ? ansiEscapes.cursorBackward(-dx) : dx > 0 ? ansiEscapes.cursorForward(dx) : '');
// Translate a FRAME-coordinate point (where renderer.js / render-node-to-output
// placed it, measured from the top of the full content) into the VISIBLE terminal
// row the cell renderer actually paints it on. When the content is taller than the
// viewport, the top `viewportY` rows are in scrollback; the visible row is
// `y - viewportY`, clamped to the viewport. WITHOUT this, the input target's large
// frame-Y produces a huge cursorDown to content-bottom instead of a small move to
// the input bar — the "input lands below the status bar with scrollback" bug.
// FEATURE_214: on the inline main-screen path (`inlineBottomAnchored`) the clamp
// ceiling is `min(viewport.height - 1, screen.height - 1)`, so the resting cursor
// (renderer.js parks it at `screen.height`, one past the last row) maps to the
// frame's OWN last row — matching where `clampRestingCursor` + the suppressed
// last-row `\n` physically leave it, so the suffix's relative move to the input
// anchor and `returnCursorToRest` stay byte-accurate. The input anchor itself
// (y ≤ screen.height - 1) is never clipped, so the cursor still lands in the input
// bar exactly as before. WITHOUT the flag (alt-screen / fullscreen) the ceiling is
// the original `viewport.height - 1`, so a non-filling fullscreen frame whose
// resting cursor is genuinely one past its last row is mapped without an off-by-one.
const toVisibleCursor = (frame, inlineBottomAnchored = false) => {
    const viewportY = Math.max(0, frame.screen.height - frame.viewport.height);
    const maxY = inlineBottomAnchored
        ? Math.max(0, Math.min(frame.viewport.height - 1, frame.screen.height - 1))
        : Math.max(0, frame.viewport.height - 1);
    return (point) => ({
        x: point.x,
        y: Math.min(Math.max(point.y - viewportY, 0), maxY),
    });
};
import reconciler from './internals/reconciler.js';
import render from './internals/renderer.js';
import * as dom from './internals/dom.js';
import { LogUpdate as CellLogUpdate } from '../substrate/ink/cell-renderer.js';
import { applyCellFrame as applyCellFrameHelper } from '../substrate/ink/apply-cell-frame.js';
import { applyDiff } from '../substrate/ink/apply-diff.js';
import { emptyFrame } from '../substrate/ink/frame.js';
import { bsu, esu, shouldSynchronize } from './write-synchronized.js';
import instances from './instances.js';
import App from './components/App.js';
import { accessibilityContext as AccessibilityContext } from './contexts/AccessibilityContext.js';
import { resolveFlags } from './kitty-keyboard.js';

const noop = () => { };
const kittyQueryEscapeByte = 0x1b;
const kittyQueryOpenBracketByte = 0x5b;
const kittyQueryQuestionMarkByte = 0x3f;
const kittyQueryLetterByte = 0x75;
const zeroByte = 0x30;
const nineByte = 0x39;
const isDigitByte = (byte) => byte >= zeroByte && byte <= nineByte;

const matchKittyQueryResponse = (buffer, startIndex) => {
    if (buffer[startIndex] !== kittyQueryEscapeByte ||
        buffer[startIndex + 1] !== kittyQueryOpenBracketByte ||
        buffer[startIndex + 2] !== kittyQueryQuestionMarkByte) {
        return undefined;
    }
    let index = startIndex + 3;
    const digitsStartIndex = index;
    while (index < buffer.length && isDigitByte(buffer[index])) {
        index++;
    }
    if (index === digitsStartIndex) {
        return undefined;
    }
    if (index === buffer.length) {
        return { state: 'partial' };
    }
    if (buffer[index] === kittyQueryLetterByte) {
        return { state: 'complete', endIndex: index };
    }
    return undefined;
};

const hasCompleteKittyQueryResponse = (buffer) => {
    for (let index = 0; index < buffer.length; index++) {
        const match = matchKittyQueryResponse(buffer, index);
        if (match?.state === 'complete') {
            return true;
        }
    }
    return false;
};

const stripKittyQueryResponsesAndTrailingPartial = (buffer) => {
    const keptBytes = [];
    let index = 0;
    while (index < buffer.length) {
        const match = matchKittyQueryResponse(buffer, index);
        if (match?.state === 'complete') {
            index = match.endIndex + 1;
            continue;
        }
        if (match?.state === 'partial') {
            break;
        }
        keptBytes.push(buffer[index]);
        index++;
    }
    return keptBytes;
};

const isErrorInput = (value) => {
    return (value instanceof Error ||
        Object.prototype.toString.call(value) === '[object Error]');
};

/**
 * @typedef {{
 *   isConcurrent: boolean;
 *   render: (node: import('react').ReactNode) => void;
 *   unmount: (error?: unknown) => void;
 *   waitUntilExit: () => Promise<unknown>;
 *   clear: () => void;
 * }} InkPublicInstance
 */
/** @type {new (options: any) => InkPublicInstance} */
const Ink = class Ink {
    isConcurrent;
    options;
    cursorPosition;
    isScreenReaderEnabled;
    isUnmounted;
    isUnmounting;
    lastOutput;
    lastOutputToRender;
    lastOutputHeight;
    lastTerminalWidth;
    container;
    rootNode;
    fullStaticOutput;
    exitPromise;
    exitResult;
    beforeExitHandler;
    restoreConsole;
    restoreStreamWriteGuard;
    rawStdoutWrite;
    rawStderrWrite;
    internalStreamWriteDepth = 0;
    unsubscribeResize;
    throttledOnRender;
    hasPendingThrottledRender = false;
    kittyProtocolEnabled = false;
    cancelKittyDetection;
    altScreenActive = false;
    shellMode;
    mouseTrackingActive = false;
    shellTransitionPhase = undefined;
    cursorHidden = false;
    constructor(options) {
        autoBind(this);
        this.options = options;
        this.rawStdoutWrite = options.stdout.write.bind(options.stdout);
        this.rawStderrWrite = options.stderr.write.bind(options.stderr);
        this.rootNode = dom.createNode('ink-root');
        this.rootNode.onComputeLayout = this.calculateLayout;
        this.isScreenReaderEnabled =
            options.isScreenReaderEnabled ??
                process.env['INK_SCREEN_READER'] === 'true';
        const unthrottled = options.debug || this.isScreenReaderEnabled;
        const maxFps = options.maxFps ?? 30;
        const renderThrottleMs = maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
        if (unthrottled) {
            this.rootNode.onRender = this.onRender;
            this.throttledOnRender = undefined;
        }
        else {
            const throttled = throttle(this.onRender, renderThrottleMs, {
                leading: true,
                trailing: true,
            });
            this.rootNode.onRender = () => {
                this.hasPendingThrottledRender = true;
                throttled();
            };
            this.throttledOnRender = throttled;
        }
        this.rootNode.onImmediateRender = this.onRender;
        // FEATURE_057 Track F Phase 6 (v0.7.30): cell-level renderer is the
        // sole render path. `applyCellFrame(frame)` owns every dispatch in
        // `onRender()` (debug / CI / screen-reader branches still bypass
        // cell renderer for compatibility — those have specialized output
        // pipelines that don't benefit from cell-level diffing).
        this.cellLogUpdate = new CellLogUpdate({
            isTTY: Boolean(options.stdout.isTTY),
        });
        this.prevFrame = emptyFrame(
            options.stdout.rows ?? 24,
            options.stdout.columns ?? 80,
        );
        this.cursorPosition = undefined;
        this.isUnmounted = false;
        this.isUnmounting = false;
        this.installExternalStreamWriteGuard();
        this.isConcurrent = options.concurrent ?? false;
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.lastTerminalWidth = this.getTerminalWidth();
        this.fullStaticOutput = '';
        this.shellMode = options.shellMode ?? 'virtual';
        const rootTag = options.concurrent ? ConcurrentRoot : LegacyRoot;
        this.container = reconciler.createContainer(this.rootNode, rootTag, null, false, null, 'id', () => { }, () => { }, () => { }, () => { });
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (isDev()) {
            reconciler.injectIntoDevTools();
        }
        if (options.patchConsole) {
            this.patchConsole();
        }
        if (!isInCi) {
            options.stdout.on('resize', this.resized);
            this.unsubscribeResize = () => {
                options.stdout.off('resize', this.resized);
            };
        }
        this.initKittyKeyboard();
    }
    getTerminalWidth = () => {
        if (this.options.stdout.columns) {
            return this.options.stdout.columns;
        }
        const size = terminalSize();
        return size?.columns ?? 80;
    };
    resized = () => {
        const currentWidth = this.getTerminalWidth();
        if (currentWidth < this.lastTerminalWidth) {
            // Phase 6: width shrink — clear visible render area + reseed cell
            // renderer's prevFrame so the next applyCellFrame paints from
            // scratch. `shouldFullReset` Case 1 also catches viewport-shrink /
            // width-change on the next render's own merits, but the explicit
            // erase-on-shrink keeps the screen clean across the resize.
            // FEATURE_214: return the cursor to content-bottom before the erase
            // (and before prevFrame is reseeded below, which returnCursorToRest reads).
            // Both paths now rest on the last content row and erase lastOutputHeight
            // rows (row 0 included): inline via eraseInlineLiveBlock, fullscreen/
            // alt-screen via the clamped-cursor eraseLines(lastOutputHeight).
            this.returnCursorToRest();
            const eraseSeq = this.altScreenActive
                ? (this.lastOutputHeight > 0 ? ansiEscapes.eraseLines(this.lastOutputHeight) : '')
                : this.eraseInlineLiveBlock();
            if (eraseSeq.length > 0) {
                this.writeStdout(eraseSeq);
            }
            this.lastOutput = '';
            this.lastOutputToRender = '';
            this.cellLogUpdate.reset();
            this.prevFrame = emptyFrame(this.options.stdout.rows ?? 24, currentWidth);
        }
        this.calculateLayout();
        this.onRender();
        this.lastTerminalWidth = currentWidth;
    };
    resolveExitPromise = () => { };
    rejectExitPromise = () => { };
    unsubscribeExit = () => { };
    handleAppExit = (errorOrResult) => {
        if (this.isUnmounted || this.isUnmounting) {
            return;
        }
        if (isErrorInput(errorOrResult)) {
            this.unmount(errorOrResult);
            return;
        }
        this.exitResult = errorOrResult;
        this.unmount();
    };
    setCursorPosition = (position) => {
        // Phase 6 (v0.7.30): cell renderer derives terminal cursor placement
        // from `frame.cursor` (set by renderer.js to (0, screen.height)) on
        // every dispatch; today the legacy log-update IME-positioning path is
        // not re-applied (custom `TextInput` owns its own visible cursor via
        // inverse-color cell). The state is preserved here for any future
        // renderer-level IME wiring.
        //
        // Defensive clamp: if a future call site reapplies `cursorPosition`
        // through `cellLogUpdate.render` or `applyDiff`, an out-of-bounds
        // (x, y) would hit `setCellAt`'s RangeError and crash the process.
        // Clamp into [0, width-1] × [0, height-1] at the storage boundary so
        // the stored value can always be safely consumed downstream.
        if (position === undefined) {
            this.cursorPosition = undefined;
            return;
        }
        const cols = this.getTerminalWidth();
        const rows = this.options.stdout.rows ?? 24;
        // width / height of zero (very edge cases — TTY just resized away)
        // would make any non-undefined position out-of-bounds; drop to
        // undefined rather than store a guaranteed-broken coordinate.
        if (cols <= 0 || rows <= 0) {
            this.cursorPosition = undefined;
            return;
        }
        const x = Math.max(0, Math.min(position.x | 0, cols - 1));
        const y = Math.max(0, Math.min(position.y | 0, rows - 1));
        this.cursorPosition = { x, y };
    };
    resetOutputTracking = () => {
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.cursorPosition = undefined;
        // Phase 6: callers (`setShellMode` / `setAltScreenActive`) invoke this
        // when the substrate cursor pipeline has just emitted alt-screen
        // toggles or mouse-tracking flips outside the cell-renderer pipeline.
        // The actual screen state is now decoupled from `prevFrame`, so the
        // next `applyCellFrame` must paint from scratch — otherwise its diff
        // computes against a stale `prevFrame` and leaves rows un-repainted.
        this.invalidateCellFrame();
    };
    usesVirtualShellOwnership = (options = {}) => {
        const altScreenActive = options.altScreenActive ?? this.altScreenActive;
        return altScreenActive;
    };
    beginShellTransition(phase) {
        this.shellTransitionPhase = phase;
    }
    setShellMode(mode, mouseTracking) {
        const previousMode = this.shellMode;
        const previousMouseTracking = this.mouseTrackingActive;
        const previousVirtualOwnership = this.usesVirtualShellOwnership();
        const nextMouseTracking = mouseTracking ?? false;
        this.shellMode = mode;
        this.mouseTrackingActive = nextMouseTracking;
        const nextVirtualOwnership = this.usesVirtualShellOwnership();
        const shellOwnershipChanged = previousMode !== mode
            && (previousVirtualOwnership || nextVirtualOwnership);
        const managedMouseTrackingChanged = previousMouseTracking !== nextMouseTracking
            && nextVirtualOwnership;
        if (shellOwnershipChanged || managedMouseTrackingChanged) {
            this.resetOutputTracking();
        }
    }
    setAltScreenActive(active, mouseTracking) {
        const previousAltScreenActive = this.altScreenActive;
        const previousMouseTracking = this.mouseTrackingActive;
        const previousVirtualOwnership = this.usesVirtualShellOwnership();
        const nextMouseTracking = mouseTracking ?? false;
        this.altScreenActive = active;
        this.mouseTrackingActive = nextMouseTracking;
        this.shellTransitionPhase = undefined;
        const nextVirtualOwnership = this.usesVirtualShellOwnership();
        const altScreenChanged = previousAltScreenActive !== active;
        const managedMouseTrackingChanged = previousMouseTracking !== nextMouseTracking
            && (previousVirtualOwnership || nextVirtualOwnership);
        if (altScreenChanged || managedMouseTrackingChanged) {
            this.resetOutputTracking();
        }
    }
    clearTextSelection() {
    }
    installExternalStreamWriteGuard() {
        if (this.options.debug || isInCi) {
            return;
        }
        const stdout = this.options.stdout;
        const stderr = this.options.stderr;
        const originalStdoutWrite = stdout.write;
        const originalStderrWrite = stderr.write;
        const guardedStdoutWrite = (...args) => {
            const result = this.rawStdoutWrite(...args);
            if (this.internalStreamWriteDepth === 0) {
                this.handleExternalStreamWrite();
            }
            return result;
        };
        const guardedStderrWrite = (...args) => {
            const result = this.rawStderrWrite(...args);
            if (this.internalStreamWriteDepth === 0) {
                this.handleExternalStreamWrite();
            }
            return result;
        };
        stdout.write = guardedStdoutWrite;
        stderr.write = guardedStderrWrite;
        this.restoreStreamWriteGuard = () => {
            if (stdout.write === guardedStdoutWrite) {
                stdout.write = originalStdoutWrite;
            }
            if (stderr.write === guardedStderrWrite) {
                stderr.write = originalStderrWrite;
            }
        };
    }
    handleExternalStreamWrite() {
        if (this.isUnmounted) {
            return;
        }
        this.invalidateCellFrame();
    }
    withInternalStreamWrite(write) {
        this.internalStreamWriteDepth += 1;
        try {
            return write();
        }
        finally {
            this.internalStreamWriteDepth -= 1;
        }
    }
    writeStdout(data, ...args) {
        return this.withInternalStreamWrite(() => this.rawStdoutWrite(data, ...args));
    }
    writeStderr(data, ...args) {
        return this.withInternalStreamWrite(() => this.rawStderrWrite(data, ...args));
    }
    restoreLastOutput = () => {
        // Phase 6: replay the last cell-level frame at the current cursor
        // position. Used after `writeToStdout` / `writeToStderr` injects
        // external bytes above the rendered UI — we erase the rendered
        // area, write the external data, then paint the prev frame back
        // below it via a cell-renderer diff against an empty seed. The
        // diff's first-render-via-incremental path paints all rows with
        // row-final `\r\n`, landing the cursor at (0, prevFrame.screen.height).
        if (this.prevFrame.screen.height === 0) return;
        const empty = emptyFrame(
            this.options.stdout.rows ?? 24,
            this.getTerminalWidth(),
        );
        const diff = this.cellLogUpdate.render(empty, this.prevFrame);
        this.withInternalStreamWrite(() => applyDiff(this.options.stdout, diff));
    };
    shouldRestoreManagedShellAfterExternalWrite = () => this.altScreenActive;
    calculateLayout = () => {
        const terminalWidth = this.getTerminalWidth();
        this.rootNode.yogaNode.setWidth(terminalWidth);
        this.rootNode.yogaNode.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    };
    onRender = () => {
        this.hasPendingThrottledRender = false;
        if (this.isUnmounted) {
            return;
        }
        const startTime = performance.now();
        // Phase 6: pass terminalSize so renderer.js can build `frame.viewport`
        // from the real TTY dimensions (Phase 3b's scrollback decisions need
        // the visible viewport, not the rendered content size).
        const cellTerminalSize = {
            rows: this.options.stdout.rows ?? 24,
            columns: this.getTerminalWidth(),
        };
        const { output, outputHeight, staticOutput, frame } = render(this.rootNode, this.isScreenReaderEnabled, cellTerminalSize);
        this.options.onRender?.({ renderTime: performance.now() - startTime });
        // FEATURE_214: hide the OS terminal cursor ONCE at first render and keep it
        // hidden for the session. The app draws the visible cursor block in the input
        // bar; the engine only POSITIONS the hidden OS cursor at the input anchor (the
        // displayCursor SUFFIX after render) so IME composition lands there. The input
        // anchor travels via `frame.inputCursor`, NOT `frame.cursor.visible` (always
        // false now), so there is no per-render show/hide toggling.
        if (!isInCi && !this.options.debug && !this.isScreenReaderEnabled && !this.cursorHidden) {
            this.writeStdout(ansiEscapes.cursorHide);
            this.cursorHidden = true;
        }
        const hasStaticOutput = staticOutput && staticOutput !== '\n';
        if (this.options.debug) {
            if (hasStaticOutput) {
                this.fullStaticOutput += staticOutput;
            }
            this.writeStdout(this.fullStaticOutput + output);
            return;
        }
        if (isInCi) {
            if (hasStaticOutput) {
                this.writeStdout(staticOutput);
            }
            this.lastOutput = output;
            this.lastOutputToRender = output + '\n';
            this.lastOutputHeight = outputHeight;
            return;
        }
        if (this.isScreenReaderEnabled) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.writeStdout(bsu);
            }
            if (hasStaticOutput) {
                const erase = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.writeStdout(erase + staticOutput);
                this.lastOutputHeight = 0;
            }
            if (output === this.lastOutput && !hasStaticOutput) {
                if (sync) {
                    this.writeStdout(esu);
                }
                return;
            }
            const terminalWidth = this.getTerminalWidth();
            const wrappedOutput = wrapAnsi(output, terminalWidth, {
                trim: false,
                hard: true,
            });
            if (hasStaticOutput) {
                this.writeStdout(wrappedOutput);
            }
            else {
                const erase = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.writeStdout(erase + wrappedOutput);
            }
            this.lastOutput = output;
            this.lastOutputToRender = wrappedOutput;
            this.lastOutputHeight =
                wrappedOutput === '' ? 0 : wrappedOutput.split('\n').length;
            if (sync) {
                this.writeStdout(esu);
            }
            return;
        }
        if (hasStaticOutput) {
            this.fullStaticOutput += staticOutput;
        }
        // FEATURE_214 — inline cursor TRANSACTION. The inline main-screen frame
        // (prefix return-to-rest + erase/static + cell diff + suffix move-to-input)
        // must reach the terminal as ONE atomic write. Three separate writes let
        // Windows Terminal / ConPTY / IME sample the cursor at the resting row
        // mid-frame, so the CJK preedit / candidate box flickers between the input
        // bar and the status line at the spinner frame rate. When inline AND an input
        // anchor exists, buffer every byte into `txn` and flush once below (BSU/ESU
        // when the terminal supports synchronized output); otherwise `emit` writes
        // straight through (fullscreen / no-anchor paths, byte-identical to before).
        // `sink` routes applyCellFrame's diff into the same buffer.
        const inlineCursorTxn = !this.altScreenActive && !!(frame && frame.inputCursor);
        const txn = inlineCursorTxn ? [] : null;
        const emit = (seq) => {
            if (!seq) return;
            if (txn) txn.push(seq);
            else this.writeStdout(seq);
        };
        const sink = txn ? { write: emit } : null;
        // PREFIX: every render path past this point (eraseLines, cell growth, cell
        // diff) assumes the terminal cursor rests at content-bottom. If the previous
        // render parked it at the input anchor (the suffix), return it there first —
        // buffered into the txn for the inline path so it is never a standalone write.
        emit(this.computeReturnToRestSeq());
        const usesManagedVirtualFullscreenShell = this.altScreenActive;
        const shouldUseFullscreenFrameOwnership = this.options.stdout.isTTY
            && outputHeight >= this.options.stdout.rows
            && usesManagedVirtualFullscreenShell;
        const outputToRender = shouldUseFullscreenFrameOwnership ? output : output + '\n';
        if (this.lastOutputHeight >= this.options.stdout.rows && usesManagedVirtualFullscreenShell) {
            // FEATURE_212 (v0.7.45) gated fast path — minimal cell-diff under
            // synchronized output instead of a full ~screen-sized atomic
            // repaint. The full-frame repaint below writes the whole viewport
            // (~6KB ANSI) on EVERY render, so a ticking spinner-stats tail
            // (FEATURE_058682 elapsed+tokens) or a single typed character
            // triggers a full repaint every frame — on Win10/ConPTY each such
            // synchronous write costs tens of ms and blocks the event loop
            // (typing lag + spinner drift + global slowdown). In fullscreen the
            // transcript does NOT use Ink `<Static>` (MessageList gates Static
            // on `!windowed`), so `fullStaticOutput` is empty and the cell
            // `frame` already represents the entire viewport — a cell-diff
            // paints only the changed cells. Wrapped in BSU/ESU so the
            // incremental writes are atomic to the terminal (the flicker that
            // FEATURE_096 originally worked around). DEFAULT ON (validated:
            // typing smooth, no ConPTY flicker on Win10); escape hatch
            // `KODAX_FULLSCREEN_CELLDIFF=0` restores the legacy full-frame
            // repaint. Scroll-heavy frames (streaming) take the DECSTBM
            // hardware-scroll fast path (FEATURE_212): `applyCellFrame` threads
            // `{altScreen, decstbmSafe}` into `render()`, which on a scrolled
            // frame emits a region-scroll + paints only the rows that scrolled
            // in (escape hatch `KODAX_SCROLL_DECSTBM=0`).
            if (process.env.KODAX_FULLSCREEN_CELLDIFF !== '0'
                && this.altScreenActive
                && this.fullStaticOutput === '') {
                const cellSync = shouldSynchronize(this.options.stdout);
                if (cellSync) {
                    this.writeStdout(bsu);
                }
                this.applyCellFrame(frame);
                if (cellSync) {
                    this.writeStdout(esu);
                }
                this.lastOutput = output;
                this.lastOutputToRender = outputToRender;
                this.lastOutputHeight = outputHeight;
                return;
            }
            // Phase 6 fullscreen branch: previous render filled or exceeded
            // the viewport. We need to clear the visible area + repaint with
            // the new full-frame content. Cell renderer's `shouldFullReset`
            // Case 3 covers the "scrollback cell change" subset; the
            // explicit branch here also handles the "viewport-filling
            // re-render with no scrollback cell change" case (e.g.,
            // toggling between two same-shape full screens — the diff would
            // be incremental but we still want clearAndRender atomicity for
            // Win10 OpenSSH/ConPTY where two-write erase+paint flickers).
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.writeStdout(bsu);
            }
            const fullFrameOutput = this.fullStaticOutput + outputToRender;
            if (this.altScreenActive) {
                // Single atomic stream.write to avoid the FEATURE_096
                // Win10/ConPTY two-write blank intermediate frame.
                const eraseSeq = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.writeStdout(eraseSeq + fullFrameOutput);
            }
            else {
                this.writeStdout(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            }
            this.lastOutput = output;
            this.lastOutputToRender = this.altScreenActive
                ? fullFrameOutput
                : outputToRender;
            this.lastOutputHeight = outputHeight;
            // Reseed the cell renderer's prevFrame so the next applyCellFrame
            // goes through the full-frame paint path — we just wrote string
            // content to stdout outside the cell-renderer pipeline.
            this.invalidateCellFrame();
            if (sync) {
                this.writeStdout(esu);
            }
            return;
        }
        // Per-branch BSU/ESU only when NOT buffering the inline txn (the txn flush
        // below owns the brackets for the inline path; the alt-screen non-filling
        // path that also reaches here keeps its per-branch sync, byte-identical).
        const branchSync = !txn && shouldSynchronize(this.options.stdout);
        // try/finally: the buffered txn MUST be flushed even if applyCellFrame throws,
        // so the prefix return-to-rest still reaches the terminal and the physical
        // cursor stays consistent with the displayCursor that computeReturnToRestSeq
        // already cleared (parity with the old immediate-write returnCursorToRest —
        // without this, a render exception would strand the cursor at the input anchor
        // while displayCursor reads null, corrupting every later erase).
        try {
            if (hasStaticOutput) {
                if (branchSync) emit(bsu);
                // Phase 6: erase main render area, write the new <Static> block
                // (which scrolls up into terminal scrollback), then paint the
                // main render via the cell renderer. invalidateCellFrame()
                // before applyCellFrame so the cell path treats this as a
                // first-render at the current cursor position (post-static).
                // The entry-level cursor prefix (FEATURE_214) already dropped the
                // terminal cursor to content-bottom (the last content row); the
                // inline-live-block erase covers row 0 too so no live row leaks above
                // the freshly committed <Static> block.
                emit(this.eraseInlineLiveBlock() + staticOutput);
                this.invalidateCellFrame();
                this.applyCellFrame(frame, sink);
                if (branchSync) emit(esu);
            }
            else if (!this.altScreenActive
                && this.prevFrame
                && this.prevFrame.screen.height !== frame.screen.height
                && this.lastOutputHeight > 0
                // FEATURE_214 step 5 — the erase+repaint only manages the VISIBLE live
                // block; eraseLines cannot reach rows already in native scrollback. So it
                // is valid ONLY when both the old and new live blocks fit the viewport. A
                // taller-than-viewport frame means the upstream live frame was NOT bounded
                // (a bug to fix there, not here) — fall through to the plain cell diff,
                // which scrolls naturally (each row once) instead of duplicating.
                && outputHeight <= this.options.stdout.rows
                && this.lastOutputHeight < this.options.stdout.rows) {
                // FEATURE_214 (codex diagnosis): the inline footer/prompt is a LIVE
                // BLOCK. When its height changes (completion list opens, status line
                // reflows, footer grows after a response ends), the cell renderer's
                // incremental grow/shrink appends new rows DOWNWARD via
                // `renderFrameSlice` (\r\n) — leaving the OLD block in place and shoving
                // the cursor + input below the status bar (the "input lands at terminal
                // bottom" bug). A live block must ERASE the old block and repaint clean,
                // exactly like the static-commit branch above. The cursor PREFIX
                // (computeReturnToRestSeq, buffered above) already dropped the physical
                // cursor to the old block's resting row, so eraseLines clears the whole
                // block; invalidateCellFrame makes applyCellFrame a clean first-render;
                // the suffix below then re-parks the cursor at the input target.
                // eraseInlineLiveBlock erases lastOutputHeight rows so row 0 (the live
                // block's top, e.g. the `You` header) is cleared too — the inline resting
                // cursor sits ON the last content row, so no +1 is needed.
                if (branchSync) emit(bsu);
                emit(this.eraseInlineLiveBlock());
                this.invalidateCellFrame();
                this.applyCellFrame(frame, sink);
                if (branchSync) emit(esu);
            }
            else {
                // Phase 6: cell renderer is the sole render path. No inline height
                // change here, so the incremental diff is correct (and cheap).
                this.applyCellFrame(frame, sink);
            }
            // FEATURE_214 cursor SUFFIX: the cell renderer left the (hidden) terminal
            // cursor at content-bottom (frame.cursor). Park it at the input anchor so
            // IME composition / typing lands in the input bar. Relative (cursorUp) so
            // it tracks the just-rendered frame; the next render's prefix returns it to
            // content-bottom. inputCursor.y < screen.height for the small interactive
            // frame (history lives in scrollback), so no viewport clamp interaction.
            if (frame?.inputCursor) {
                // Suffix (claudecode ink.tsx 696-713): park the physical cursor at the
                // input target via a RELATIVE move from where the diff left it (the
                // resting cursor). Both translated to VISIBLE rows so the move stays
                // correct under scrollback. Record displayCursor (visible) so the next
                // render's preamble knows where the cursor actually is. Buffered into the
                // txn so it lands in the SAME write as the prefix + diff (no exposed
                // intermediate the IME could anchor the preedit to).
                const toVisible = toVisibleCursor(frame, !this.altScreenActive);
                const rest = toVisible(frame.cursor);
                const target = toVisible(frame.inputCursor);
                const seq = cursorMoveSeq(target.x - rest.x, target.y - rest.y);
                emit(seq);
                this.displayCursor = target;
            }
        }
        finally {
            // Flush the inline cursor transaction as ONE write (BSU/ESU when the
            // terminal supports synchronized output) — prefix → erase/static → diff →
            // suffix are atomic, so ConPTY/IME never samples the resting-cursor
            // mid-frame. In `finally` so a throw above still lands the prefix.
            if (txn) {
                this.flushCursorTxn(txn);
            }
        }
        this.lastOutput = output;
        this.lastOutputToRender = outputToRender;
        this.lastOutputHeight = outputHeight;
    };
    /**
     * Apply a cell-level Frame to the terminal. Returns `true` when the
     * cell path consumed the frame, `false` when it didn't (frame was
     * undefined — only happens on the screen-reader path).
     */
    applyCellFrame = (frame, sink = null) => {
        const state = {
            cellLogUpdate: this.cellLogUpdate,
            prevFrame: this.prevFrame,
            // FEATURE_214: when an inline cursor transaction is buffering, the diff
            // bytes go into the txn `sink` (flushed as ONE write so the IME never
            // samples a mid-frame cursor) instead of straight to stdout.
            stdout: sink ?? this.options.stdout,
        };
        // FEATURE_212 — enable the DECSTBM scroll fast path only in synchronized
        // alt-screen (where a scroll otherwise costs a full ~6KB frame write).
        // The fast path additionally requires `frame.scrollHint`, so on non-scroll
        // frames these opts are inert. `synchronized` (same gate) brackets a
        // clearTerminal reset in BSU/ESU so its erase+repaint never flashes black.
        const sync = shouldSynchronize(this.options.stdout);
        const opts = {
            altScreen: this.altScreenActive,
            decstbmSafe: sync,
            // When buffering into the txn sink, the OUTER transaction owns BSU/ESU,
            // so don't let applyDiff add inner brackets around a clearTerminal.
            synchronized: sink ? false : sync,
            // FEATURE_214: inline main-screen frames are physically anchored to the
            // terminal bottom (the live frame is always the last content), so the
            // cell renderer rests the cursor on the frame's own last row instead of
            // one past it — no scrolled-in blank line under the status bar. Never on
            // the alt-screen (fullscreen) path, which owns the whole viewport.
            inlineBottomAnchored: !this.altScreenActive,
        };
        const applied = this.withInternalStreamWrite(() => applyCellFrameHelper(state, frame, opts));
        this.prevFrame = state.prevFrame;
        return applied;
    };
    /**
     * Invalidate the cell renderer's `prevFrame`. Called whenever a write
     * to stdout outside the cell-renderer pipeline (writeToStdout /
     * writeToStderr / clear() / fullscreen branch's raw write) leaves
     * `prevFrame` out of sync with the actual screen state. Reseeding
     * with `emptyFrame` forces the next `applyCellFrame` through the
     * first-render-via-incremental path, painting from scratch.
     */
    invalidateCellFrame = () => {
        this.cellLogUpdate.reset();
        this.prevFrame = emptyFrame(
            this.options.stdout.rows ?? 24,
            this.getTerminalWidth(),
        );
    };
    /**
     * FEATURE_214 — erase the current main-screen INLINE live block so the next
     * paint repaints it CLEAN, row 0 included.
     *
     * The inline resting cursor now sits on the live block's LAST content row
     * (row `lastOutputHeight - 1`): `clampRestingCursor` caps it at
     * `screen.height - 1` and `renderFrameSlice` suppresses the last row's scroll
     * `\n` (so no blank row is pushed under the status bar when the frame is
     * anchored to the terminal bottom). From there `eraseLines(lastOutputHeight)`
     * clears rows `lastOutputHeight-1 .. 0` — EVERY content row, row 0 (the live
     * block's top, e.g. the `You [HH:MM]` header) included — and leaves the cursor
     * on the block's top row, so the repaint re-aligns exactly where the old block
     * began (no downward drift, committed scrollback above untouched). This is the
     * fix for the "You repeats once per streaming/thinking/tool update" leak. A
     * `+ 1` here would now reach ONE row INTO the committed scrollback above and
     * eat it (the resting cursor is no longer one past the last row).
     *
     * INLINE ONLY. The fullscreen / alt-screen path clamps the resting cursor to
     * the last VISIBLE row the same way and repaints the whole managed viewport;
     * callers on that path must NOT use this helper.
     */
    eraseInlineLiveBlock = () => {
        return this.lastOutputHeight > 0
            ? ansiEscapes.eraseLines(this.lastOutputHeight)
            : '';
    };
    /**
     * FEATURE_214 — commit finalized inline history to native scrollback through a
     * single narrow primitive, then repaint the live frame. The inline scrollback
     * ledger calls THIS — never raw stdout writes, which leave prevFrame /
     * lastOutputHeight stale and corrupt the next live diff.
     *
     *   - append:  erase the old live block (eraseInlineLiveBlock — lastOutputHeight
     *              rows from the last-content-row resting cursor, so the block's row 0
     *              is cleared too), write `text` (the new finalized rows scroll up
     *              into native scrollback).
     *   - rebuild: clearTerminal (ESC[2J + ESC[3J scrollback purge + home), write `text`
     *              (all retained finalized rows, re-rendered from source at the current
     *              width). Does NOT read lastOutputHeight — that block is being discarded.
     *
     * Then: reset output tracking, clear fullStaticOutput (ledger owns history now),
     * reseed prevFrame, recompute layout, repaint the live frame, re-park the cursor.
     * alt-screen / transcript use the windowed owned viewport and MUST NOT route here.
     */
    commitInlineScrollback = ({ mode, text }) => {
        if (this.altScreenActive || this.isUnmounted) {
            return;
        }
        // FEATURE_214 — commit + repaint as ONE atomic write, the same IME-safe
        // transaction as onRender. With the ledger default-ON this is a core inline
        // repaint path, and it ALSO re-parks the cursor (prefix return-to-rest →
        // scrollback commit → live diff → suffix). Three+ separate writes let Windows
        // Terminal / ConPTY / IME sample the cursor at the resting row mid-commit, so a
        // CJK composition active during a ledger append/rebuild flickers the preedit —
        // the same root cause. Buffer every byte into `txn`, flush once below.
        const txn = [];
        const emit = (seq) => { if (seq) txn.push(seq); };
        const sink = { write: emit };
        // PREFIX: drop the (possibly input-parked) cursor to its resting row so the
        // erase/clear and the history text land at content-bottom, not the input anchor.
        emit(this.computeReturnToRestSeq());
        // NOTE: ansiEscapes.clearTerminal OMITS ESC[3J (scrollback purge) on Windows
        // (it emits ESC[0f instead), so we build the clear explicitly — ESC[2J (erase
        // screen) + ESC[3J (purge scrollback) + ESC[H (home) — to guarantee the stale
        // old-width finalized rows are gone from scrollback on EVERY platform.
        const prefix = mode === 'rebuild'
            ? '[2J[3J[H'
            : this.eraseInlineLiveBlock();
        emit(prefix + (text ?? ''));
        // The live block we just erased/cleared is gone; reset output tracking.
        // fullStaticOutput is owned by the ledger now (the <Static> path is retiring).
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.fullStaticOutput = '';
        // Reseed prevFrame so the next paint is a clean first-render against the
        // erased/cleared screen — never a diff against a stale prevFrame.
        this.invalidateCellFrame();
        // Recompute + repaint the current live frame below the committed history.
        // try/finally so the txn (prefix + committed history + diff + suffix) is
        // flushed even if render()/applyCellFrame throws — keeping the physical cursor
        // consistent with the displayCursor computeReturnToRestSeq already cleared.
        try {
            this.calculateLayout();
            const cellTerminalSize = {
                rows: this.options.stdout.rows ?? 24,
                columns: this.getTerminalWidth(),
            };
            const { output, outputHeight, frame } = render(this.rootNode, this.isScreenReaderEnabled, cellTerminalSize);
            // Diff into the txn buffer (synchronized:false there — the flush owns BSU/ESU).
            this.applyCellFrame(frame, sink);
            // SUFFIX: park the hidden cursor at the input anchor (same as onRender),
            // buffered so it lands in the SAME write as the commit + diff.
            if (frame?.inputCursor) {
                const toVisible = toVisibleCursor(frame, !this.altScreenActive);
                const rest = toVisible(frame.cursor);
                const target = toVisible(frame.inputCursor);
                const seq = cursorMoveSeq(target.x - rest.x, target.y - rest.y);
                emit(seq);
                this.displayCursor = target;
            }
            this.lastOutput = output;
            this.lastOutputToRender = output;
            this.lastOutputHeight = outputHeight;
        }
        finally {
            // Flush the whole commit as ONE write (BSU/ESU when synchronized).
            this.flushCursorTxn(txn);
        }
    };
    /**
     * Flush a buffered inline cursor TRANSACTION (prefix return-to-rest + erase/static
     * + cell diff + suffix move-to-input) as ONE stdout.write — BSU/ESU-bracketed when
     * the terminal supports synchronized output. Single source of truth for the two
     * inline repaint paths that re-park the cursor (onRender + commitInlineScrollback),
     * so neither can leave a mid-transaction cursor for ConPTY/IME to sample. No-op on
     * an empty buffer (idle frame) so the stream's drain queue doesn't churn.
     */
    flushCursorTxn(txn) {
        const out = txn.join('');
        if (!out) {
            return;
        }
        const sync = shouldSynchronize(this.options.stdout);
        this.writeStdout(sync ? bsu + out + esu : out);
    }
    render(node) {
        const tree = (React.createElement(AccessibilityContext.Provider, { value: { isScreenReaderEnabled: this.isScreenReaderEnabled } },
            React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, exitOnCtrlC: this.options.exitOnCtrlC, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, setCursorPosition: this.setCursorPosition, onExit: this.handleAppExit }, node)));
        if (this.options.concurrent) {
            reconciler.updateContainer(tree, this.container, null, noop);
        }
        else {
            reconciler.updateContainerSync(tree, this.container, null, noop);
            reconciler.flushSyncWork();
        }
    }
    // FEATURE_214: the cursor SUFFIX (end of render) parks the hidden terminal
    // cursor at the input anchor for IME. Any path that erases/repaints from the
    // cursor (render, writeToStdout, writeToStderr) must first return it to
    // content-bottom — the resting position every such path assumes. Relative
    // (cursorDown) so it composes with the terminal's current scroll state; a no-op
    // when the cursor is already at rest (visibleInputCursor undefined).
    /**
     * Compute the return-to-rest PREFIX sequence (and clear `displayCursor`) WITHOUT
     * writing. Preamble (claudecode ink.tsx 676-685): if the previous render parked
     * the physical cursor at the input, this is the relative move back to that frame's
     * RESTING cursor — the spot the next diff / eraseLines assumes. Relative from the
     * ACTUAL tracked position (displayCursor), never a recomputed cursorDown from raw
     * screen.height. Returning the bytes (instead of writing) lets onRender fold the
     * prefix into the inline cursor transaction so it is never a standalone write the
     * IME can sample mid-frame. Empty string when the cursor is already at rest.
     */
    computeReturnToRestSeq() {
        if (this.displayCursor && this.prevFrame) {
            const rest = toVisibleCursor(this.prevFrame, !this.altScreenActive)(this.prevFrame.cursor);
            const seq = cursorMoveSeq(rest.x - this.displayCursor.x, rest.y - this.displayCursor.y);
            this.displayCursor = null;
            return seq;
        }
        return '';
    }
    returnCursorToRest() {
        // Non-transaction callers (writeToStdout / writeToStderr / resize) write the
        // prefix directly; onRender's inline path uses computeReturnToRestSeq + the txn.
        const seq = this.computeReturnToRestSeq();
        if (seq) this.writeStdout(seq);
    }
    writeToStdout(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.writeStdout(data + this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.writeStdout(data);
            return;
        }
        if (!this.shouldRestoreManagedShellAfterExternalWrite()) {
            // FEATURE_214: the cursor may be parked at the input anchor (displayCursor).
            // Return it to the resting row before injecting external data so the data
            // lands at content-bottom, not the input bar, and the next render is not
            // computed from a stale parked position. No-op when displayCursor is null.
            this.returnCursorToRest();
            this.writeStdout(data);
            // Raw stdout write bypasses the cell-renderer pipeline; the
            // next applyCellFrame must repaint from a clean slate.
            this.invalidateCellFrame();
            return;
        }
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.writeStdout(bsu);
        }
        // Phase 6: erase the rendered UI area, write the external `data`
        // (which lands above the UI in scrollback / scroll history), then
        // replay the last cell frame at the new cursor position via
        // `restoreLastOutput`. The raw external write bypasses the cell
        // renderer, so make the next render repaint from a clean slate.
        // FEATURE_214: return the cursor from the input anchor to content-bottom
        // before the erase, which erases upward assuming that resting position.
        this.returnCursorToRest();
        const eraseSeq = this.lastOutputHeight > 0
            ? ansiEscapes.eraseLines(this.lastOutputHeight)
            : '';
        this.writeStdout(eraseSeq + data);
        this.restoreLastOutput();
        this.invalidateCellFrame();
        if (sync) {
            this.writeStdout(esu);
        }
    }
    writeToStderr(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.writeStderr(data);
            this.writeStdout(this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.writeStderr(data);
            return;
        }
        if (!this.shouldRestoreManagedShellAfterExternalWrite()) {
            // FEATURE_214: return the cursor from the input anchor to the resting row
            // before injecting external data (see writeToStdout). No-op when unparked.
            this.returnCursorToRest();
            this.writeStderr(data);
            // Raw stderr write bypasses the cell-renderer pipeline.
            this.invalidateCellFrame();
            return;
        }
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.writeStdout(bsu);
        }
        // Phase 6: erase rendered UI on stdout, write `data` to stderr,
        // replay last cell frame on stdout. The erase + write needs two
        // separate streams (stdout for erase, stderr for data), so it's
        // inherently a two-write sequence. The stderr write still bypasses
        // the cell renderer, so make the next render repaint from scratch.
        // FEATURE_214: return the cursor from the input anchor to content-bottom
        // before the erase, which erases upward assuming that resting position.
        this.returnCursorToRest();
        const eraseSeq = this.lastOutputHeight > 0
            ? ansiEscapes.eraseLines(this.lastOutputHeight)
            : '';
        if (eraseSeq.length > 0) {
            this.writeStdout(eraseSeq);
        }
        this.writeStderr(data);
        this.restoreLastOutput();
        this.invalidateCellFrame();
        if (sync) {
            this.writeStdout(esu);
        }
    }
    unmount(error) {
        if (this.isUnmounted || this.isUnmounting) {
            return;
        }
        this.isUnmounting = true;
        if (this.beforeExitHandler) {
            process.off('beforeExit', this.beforeExitHandler);
            this.beforeExitHandler = undefined;
        }
        const stdout = this.options.stdout;
        const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
        const settleThrottle = (throttled) => {
            if (typeof throttled.flush !== 'function') {
                return;
            }
            if (canWriteToStdout) {
                throttled.flush();
            }
            else if (typeof throttled.cancel === 'function') {
                throttled.cancel();
            }
        };
        settleThrottle(this.throttledOnRender ?? {});
        if (canWriteToStdout) {
            const shouldRenderFinalFrame = !this.throttledOnRender ||
                (!this.hasPendingThrottledRender && this.fullStaticOutput === '');
            if (shouldRenderFinalFrame) {
                this.calculateLayout();
                this.onRender();
            }
        }
        this.isUnmounted = true;
        this.unsubscribeExit();
        if (typeof this.restoreConsole === 'function') {
            this.restoreConsole();
        }
        if (typeof this.restoreStreamWriteGuard === 'function') {
            this.restoreStreamWriteGuard();
            this.restoreStreamWriteGuard = undefined;
        }
        if (typeof this.unsubscribeResize === 'function') {
            this.unsubscribeResize();
        }
        if (this.cancelKittyDetection) {
            this.cancelKittyDetection();
        }
        if (canWriteToStdout) {
            if (this.kittyProtocolEnabled) {
                try {
                    this.writeStdout('\u001B[<u');
                }
                catch {
                }
            }
            if (isInCi) {
                this.writeStdout(this.lastOutput + '\n');
            }
            // Phase 6: no `this.log.done()` cleanup needed — cell renderer
            // is stateless at the stream level. The cursor visibility
            // restore that legacy `done()` performed via cliCursor.show
            // is handled by the substrate cursor pipeline + alt-screen
            // cleanup at the higher renderer-runtime / runtime layers.
        }
        this.kittyProtocolEnabled = false;
        this.shellTransitionPhase = undefined;
        if (this.options.concurrent) {
            reconciler.updateContainer(null, this.container, null, noop);
        }
        else {
            reconciler.updateContainerSync(null, this.container, null, noop);
            reconciler.flushSyncWork();
        }
        instances.delete(this.options.stdout);
        const { exitResult } = this;
        const resolveOrReject = () => {
            if (isErrorInput(error)) {
                this.rejectExitPromise(error);
            }
            else {
                this.resolveExitPromise(exitResult);
            }
        };
        const isProcessExiting = error !== undefined && !isErrorInput(error);
        const hasWritableState = stdout._writableState !== undefined ||
            stdout.writableLength !== undefined;
        if (isProcessExiting) {
            resolveOrReject();
        }
        else if (canWriteToStdout && hasWritableState) {
            this.writeStdout('', resolveOrReject);
        }
        else {
            setImmediate(resolveOrReject);
        }
    }
    async waitUntilExit() {
        this.exitPromise ||= new Promise((resolve, reject) => {
            this.resolveExitPromise = resolve;
            this.rejectExitPromise = reject;
        });
        if (!this.beforeExitHandler) {
            this.beforeExitHandler = () => {
                this.unmount();
            };
            process.once('beforeExit', this.beforeExitHandler);
        }
        return this.exitPromise;
    }
    clear() {
        if (!isInCi && !this.options.debug) {
            // Phase 6: erase the visible render area; reseed cell renderer's
            // prevFrame so the next applyCellFrame paints from scratch.
            // FEATURE_214: return the cursor to content-bottom before the erase.
            // Both paths rest on the last content row and erase lastOutputHeight rows
            // (row 0 included): inline via eraseInlineLiveBlock, fullscreen/alt-screen
            // via the clamped-cursor eraseLines(lastOutputHeight).
            this.returnCursorToRest();
            const eraseSeq = this.altScreenActive
                ? (this.lastOutputHeight > 0 ? ansiEscapes.eraseLines(this.lastOutputHeight) : '')
                : this.eraseInlineLiveBlock();
            if (eraseSeq.length > 0) {
                this.writeStdout(eraseSeq);
            }
            this.lastOutput = '';
            this.lastOutputToRender = '';
            this.lastOutputHeight = 0;
            this.invalidateCellFrame();
        }
    }
    patchConsole() {
        if (this.options.debug) {
            return;
        }
        this.restoreConsole = patchConsole((stream, data) => {
            if (stream === 'stdout') {
                this.writeToStdout(data);
            }
            if (stream === 'stderr') {
                const isReactMessage = data.startsWith('The above error occurred');
                if (!isReactMessage) {
                    this.writeToStderr(data);
                }
            }
        });
    }
    initKittyKeyboard() {
        if (!this.options.kittyKeyboard) {
            return;
        }
        const opts = this.options.kittyKeyboard;
        const mode = opts.mode ?? 'auto';
        if (mode === 'disabled' ||
            !this.options.stdin.isTTY ||
            !this.options.stdout.isTTY) {
            return;
        }
        const flags = opts.flags ?? ['disambiguateEscapeCodes'];
        if (mode === 'enabled') {
            this.enableKittyProtocol(flags);
            return;
        }
        const term = process.env['TERM'] ?? '';
        const termProgram = process.env['TERM_PROGRAM'] ?? '';
        const isKnownSupportingTerminal = 'KITTY_WINDOW_ID' in process.env ||
            term === 'xterm-kitty' ||
            termProgram === 'WezTerm' ||
            termProgram === 'ghostty';
        if (!isInCi && isKnownSupportingTerminal) {
            this.confirmKittySupport(flags);
        }
    }
    confirmKittySupport(flags) {
        const { stdin } = this.options;
        let responseBuffer = [];
        const cleanup = () => {
            this.cancelKittyDetection = undefined;
            clearTimeout(timer);
            stdin.removeListener('data', onData);
            const remaining = stripKittyQueryResponsesAndTrailingPartial(responseBuffer);
            responseBuffer = [];
            if (remaining.length > 0) {
                stdin.unshift(Buffer.from(remaining));
            }
        };
        const onData = (data) => {
            const chunk = typeof data === 'string' ? Buffer.from(data) : data;
            for (const byte of chunk) {
                responseBuffer.push(byte);
            }
            if (hasCompleteKittyQueryResponse(responseBuffer)) {
                cleanup();
                if (!this.isUnmounted) {
                    this.enableKittyProtocol(flags);
                }
            }
        };
        stdin.on('data', onData);
        const timer = setTimeout(cleanup, 200);
        this.cancelKittyDetection = cleanup;
        this.writeStdout('\u001B[?u');
    }
    enableKittyProtocol(flags) {
        this.writeStdout(`\u001B[>${resolveFlags(flags)}u`);
        this.kittyProtocolEnabled = true;
    }
};

export default Ink;
