import renderNodeToOutput, { renderNodeToScreenReaderOutput, resetScrollHint, getScrollHint, } from './render-node-to-output.js';
import Output from './output.js';
import { outputToScreen } from '../../substrate/ink/output-to-screen.js';
/**
 * Engine-side renderer (KodaX-local mirror of `substrate/ink/renderer.js`).
 *
 * Phase 6 (v0.7.30): cell renderer is the sole render path. `frame` is
 * populated for every render except the screen-reader path. Legacy fields
 * remain populated for engine.js's `lastOutput*` bookkeeping.
 *
 * @param {object} node - the rendered ink DOM node
 * @param {boolean} isScreenReaderEnabled - whether the screen-reader pipeline is active
 * @param {{rows: number, columns: number}} [terminalSize] - actual TTY
 *   dimensions used for `frame.viewport`. Falls back to the yoga-computed content
 *   size when undefined; passing the real terminal size lets `LogUpdate`'s
 *   scrollback decisions (Phase 3b `shouldFullReset`) reason against the visible
 *   viewport rather than the rendered content height.
 * @returns {{ output: string, outputHeight: number, staticOutput: string, frame: import('../../substrate/ink/frame.js').Frame | undefined }}
 */
const renderer = (node, isScreenReaderEnabled, terminalSize) => {
    if (node.yogaNode) {
        if (isScreenReaderEnabled) {
            const output = renderNodeToScreenReaderOutput(node, {
                skipStaticElements: true,
            });
            const outputHeight = output === '' ? 0 : output.split('\n').length;
            let staticOutput = '';
            if (node.staticNode) {
                staticOutput = renderNodeToScreenReaderOutput(node.staticNode, {
                    skipStaticElements: false,
                });
            }
            return {
                output,
                outputHeight,
                staticOutput: staticOutput ? `${staticOutput}\n` : '',
                frame: undefined,
            };
        }
        const output = new Output({
            width: node.yogaNode.getComputedWidth(),
            height: node.yogaNode.getComputedHeight(),
        });
        resetScrollHint();
        renderNodeToOutput(node, output, {
            skipStaticElements: true,
        });
        let staticOutput;
        if (node.staticNode?.yogaNode) {
            staticOutput = new Output({
                width: node.staticNode.yogaNode.getComputedWidth(),
                height: node.staticNode.yogaNode.getComputedHeight(),
            });
            renderNodeToOutput(node.staticNode, staticOutput, {
                skipStaticElements: false,
            });
        }
        const { output: generatedOutput, height: outputHeight } = output.get();
        // Phase 6: build a Frame from the same Output. `outputToScreen` is
        // duck-typed compatible with both `core/internals/output.js` and
        // `substrate/ink/output.js` — both expose `.width`, `.height`, and
        // `.getGrid()` returning the same StyledChar grid shape from the
        // same vendored tokenize package.
        const screen = outputToScreen(output);
        const viewportWidth = terminalSize?.columns ?? node.yogaNode.getComputedWidth();
        const viewportHeight = terminalSize?.rows ?? node.yogaNode.getComputedHeight();
        // FEATURE_214: when the interactive tree marked a cursor anchor (the
        // input's cursor cell), position the real terminal cursor there + show it
        // (visible) so IME composition / typing lands in the input. Otherwise the
        // resting cursor parks at content-bottom and stays hidden (visible:false).
        const anchored = output.cursorPosition;
        const frame = {
            screen,
            viewport: { width: viewportWidth, height: viewportHeight },
            // FEATURE_214: the render cursor RESTS at content-bottom — the engine's
            // eraseLines and the cell renderer's growth (renderFrameSlice) + diff all
            // assume that. The input's cursor anchor travels SEPARATELY as
            // `inputCursor`; engine.js parks the (hidden) terminal cursor there as the
            // final step each render (so IME composition lands in the input) and
            // returns it to content-bottom before the next render. Keeping the render
            // cursor at content-bottom is what stops the input/text from drifting
            // below the status bar once there is scrollback history.
            cursor: { x: 0, y: screen.height, visible: false },
            scrollHint: getScrollHint(),
            ...(anchored ? { inputCursor: { x: anchored.x, y: anchored.y } } : {}),
        };
        return {
            output: generatedOutput,
            outputHeight,
            // Newline at the end is needed, because static output doesn't have one, so
            // interactive output will override last line of static output
            staticOutput: staticOutput ? `${staticOutput.get().output}\n` : '',
            frame,
        };
    }
    return {
        output: '',
        outputHeight: 0,
        staticOutput: '',
        frame: undefined,
    };
};
export default renderer;
