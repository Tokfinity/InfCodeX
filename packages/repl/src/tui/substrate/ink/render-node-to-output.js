import widestLine from 'widest-line';
import indentString from 'indent-string';
import Yoga from 'yoga-layout';
import wrapText from './wrap-text.js';
import getMaxWidth from './get-max-width.js';
import squashTextNodes from './squash-text-nodes.js';
import renderBorder from './render-border.js';
import renderBackground from './render-background.js';
import { computeScrollState } from './scroll-state.js';
// If parent container is `<Box>`, text nodes will be treated as separate nodes in
// the tree and will have their own coordinates in the layout.
// To ensure text nodes are aligned correctly, take X and Y of the first text node
// and use it as offset for the rest of the nodes
// Only first node is taken into account, because other text nodes can't have margin or padding,
// so their coordinates will be relative to the first node anyway
const applyPaddingToText = (node, text) => {
    const yogaNode = node.childNodes[0]?.yogaNode;
    if (yogaNode) {
        const offsetX = yogaNode.getComputedLeft();
        const offsetY = yogaNode.getComputedTop();
        text = '\n'.repeat(offsetY) + indentString(text, offsetX);
    }
    return text;
};
export const renderNodeToScreenReaderOutput = (node, options = {}) => {
    if (options.skipStaticElements && node.internal_static) {
        return '';
    }
    if (node.yogaNode?.getDisplay() === Yoga.DISPLAY_NONE) {
        return '';
    }
    let output = '';
    if (node.nodeName === 'ink-text') {
        output = squashTextNodes(node);
    }
    else if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
        const separator = node.style.flexDirection === 'row' ||
            node.style.flexDirection === 'row-reverse'
            ? ' '
            : '\n';
        const childNodes = node.style.flexDirection === 'row-reverse' ||
            node.style.flexDirection === 'column-reverse'
            ? [...node.childNodes].reverse()
            : [...node.childNodes];
        output = childNodes
            .map(childNode => {
            const screenReaderOutput = renderNodeToScreenReaderOutput(childNode, {
                parentRole: node.internal_accessibility?.role,
                skipStaticElements: options.skipStaticElements,
            });
            return screenReaderOutput;
        })
            .filter(Boolean)
            .join(separator);
    }
    if (node.internal_accessibility) {
        const { role, state } = node.internal_accessibility;
        if (state) {
            const stateKeys = Object.keys(state);
            const stateDescription = stateKeys.filter(key => state[key]).join(', ');
            if (stateDescription) {
                output = `(${stateDescription}) ${output}`;
            }
        }
        if (role && role !== options.parentRole) {
            output = `${role}: ${output}`;
        }
    }
    return output;
};
// FEATURE_212 (v0.7.45) — scroll-hint capture for the DECSTBM optimization.
// READ-ONLY side-channel: the `overflowY:'scroll'` block below stamps the
// active scroll region's screen rows + the delta the content moved since the
// previous render. This does NOT change `output`/the rendered screen — the
// `renderer` resets it before the walk and reads it after, attaching it to the
// Frame. `cell-renderer`'s `render()` consumes it to emit a hardware scroll
// instead of repainting every shifted row. Mirrors CC's render-node-to-output
// module-level `scrollHint`.
let _scrollHint = null;
export function resetScrollHint() {
    _scrollHint = null;
}
export function getScrollHint() {
    return _scrollHint;
}
// After nodes are laid out, render each to output object, which later gets rendered to terminal
const renderNodeToOutput = (node, output, options) => {
    const { offsetX = 0, offsetY = 0, transformers = [], skipStaticElements, } = options;
    if (skipStaticElements && node.internal_static) {
        return;
    }
    const { yogaNode } = node;
    if (yogaNode) {
        if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
            return;
        }
        // Left and top positions in Yoga are relative to their parent node
        const x = offsetX + yogaNode.getComputedLeft();
        const y = offsetY + yogaNode.getComputedTop();
        // Transformers are functions that transform final text output of each component
        // See Output class for logic that applies transformers
        let newTransformers = transformers;
        if (typeof node.internal_transform === 'function') {
            newTransformers = [node.internal_transform, ...transformers];
        }
        if (node.nodeName === 'ink-text') {
            let text = squashTextNodes(node);
            if (text.length > 0) {
                const currentWidth = widestLine(text);
                const maxWidth = getMaxWidth(yogaNode);
                if (currentWidth > maxWidth) {
                    const textWrap = node.style.textWrap ?? 'wrap';
                    text = wrapText(text, maxWidth, textWrap);
                }
                text = applyPaddingToText(node, text);
                output.write(x, y, text, { transformers: newTransformers });
            }
            return;
        }
        let clipped = false;
        let scrollOffsetY = 0;
        if (node.nodeName === 'ink-box') {
            renderBackground(x, y, node, output);
            renderBorder(x, y, node, output);
            const overflowX = node.style.overflowX ?? node.style.overflow;
            const overflowY = node.style.overflowY ?? node.style.overflow;
            const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll';
            const clipVertically = overflowY === 'hidden' || overflowY === 'scroll';
            if (overflowY === 'scroll') {
                const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
                const borderBottom = yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
                const viewportHeight = Math.max(0, yogaNode.getComputedHeight() - borderTop - borderBottom);
                const virtualScrollWindowed = node.attributes?.virtualScrollWindowed === true;
                const contentNode = node.childNodes[0];
                const contentHeight = Math.max(0, Math.floor(virtualScrollWindowed
                    ? node.attributes?.scrollHeight ?? 0
                    : contentNode?.yogaNode?.getComputedHeight() ?? node.attributes?.scrollHeight ?? 0));
                const previousScrollHeight = typeof node.scrollHeight === 'number'
                    ? node.scrollHeight
                    : contentHeight;
                // FEATURE_214 (v0.7.46) — scroll math extracted to the pure
                // `computeScrollState` (unit-gated). It computes the clamped/
                // sticky-followed applied scroll position, the child translation
                // (`scrollOffsetY`, 0 when windowed), and the DECSTBM hint
                // (FEATURE_212) when the applied position moved. The node-mutation
                // glue below is the only side-effecting part.
                const scrollState = computeScrollState({
                    rawScrollTop: node.scrollTop ?? node.attributes?.scrollTop ?? 0,
                    contentHeight,
                    viewportHeight,
                    previousScrollHeight,
                    stickyScroll: node.stickyScroll ?? Boolean(node.attributes?.stickyScroll),
                    clampMin: node.attributes?.scrollClampMin,
                    clampMax: node.attributes?.scrollClampMax,
                    virtualScrollWindowed,
                    previousAppliedScrollTop: node.appliedScrollTop,
                    regionTop: y + borderTop,
                });
                node.scrollHeight = scrollState.scrollHeight;
                node.scrollViewportHeight = viewportHeight;
                node.scrollViewportTop = scrollState.viewportTop;
                node.appliedScrollTop = scrollState.appliedScrollTop;
                if (scrollState.scrollHint) {
                    _scrollHint = scrollState.scrollHint;
                }
                node.scrollTop = scrollState.scrollTop;
                scrollOffsetY = scrollState.scrollOffsetY;
            }
            if (clipHorizontally || clipVertically) {
                const x1 = clipHorizontally
                    ? x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT)
                    : undefined;
                const x2 = clipHorizontally
                    ? x +
                        yogaNode.getComputedWidth() -
                        yogaNode.getComputedBorder(Yoga.EDGE_RIGHT)
                    : undefined;
                const y1 = clipVertically
                    ? y + yogaNode.getComputedBorder(Yoga.EDGE_TOP)
                    : undefined;
                const y2 = clipVertically
                    ? y +
                        yogaNode.getComputedHeight() -
                        yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM)
                    : undefined;
                output.clip({ x1, x2, y1, y2 });
                clipped = true;
            }
        }
        if (node.nodeName === 'ink-root' || node.nodeName === 'ink-box') {
            for (const childNode of node.childNodes) {
                renderNodeToOutput(childNode, output, {
                    offsetX: x,
                    offsetY: y - scrollOffsetY,
                    transformers: newTransformers,
                    skipStaticElements,
                });
            }
            if (clipped) {
                output.unclip();
            }
        }
    }
};
export default renderNodeToOutput;
