import React, { useContext } from "react";
import chalk from "chalk";
import colorize from "../colorize.js";
import { accessibilityContext } from "../contexts/AccessibilityContext.js";
import { backgroundContext } from "../contexts/BackgroundContext.js";

export interface TextProps extends React.PropsWithChildren {
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-middle";
  "aria-label"?: string;
  "aria-hidden"?: boolean;
  /**
   * FEATURE_214: marks this text node as the input cursor cell so the renderer
   * captures its absolute position for IME / typing (render-node-to-output →
   * frame.cursor → engine shows + positions the OS cursor there).
   */
  internal_cursorAnchor?: boolean;
}

export default function Text({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = "wrap",
  children,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden = false,
  internal_cursorAnchor = false,
}: TextProps) {
  const { isScreenReaderEnabled } = useContext(accessibilityContext);
  const inheritedBackgroundColor = useContext(backgroundContext);
  const childrenOrAriaLabel = isScreenReaderEnabled && ariaLabel ? ariaLabel : children;

  if (childrenOrAriaLabel === undefined || childrenOrAriaLabel === null) {
    return null;
  }

  const transform = (content: string) => {
    let transformed = content;

    if (dimColor) {
      transformed = chalk.dim(transformed);
    }
    if (color) {
      transformed = colorize(transformed, color, "foreground");
    }

    const effectiveBackgroundColor = backgroundColor ?? inheritedBackgroundColor;
    if (effectiveBackgroundColor) {
      transformed = colorize(transformed, effectiveBackgroundColor, "background");
    }
    if (bold) {
      transformed = chalk.bold(transformed);
    }
    if (italic) {
      transformed = chalk.italic(transformed);
    }
    if (underline) {
      transformed = chalk.underline(transformed);
    }
    if (strikethrough) {
      transformed = chalk.strikethrough(transformed);
    }
    if (inverse) {
      transformed = chalk.inverse(transformed);
    }

    return transformed;
  };

  if (isScreenReaderEnabled && ariaHidden) {
    return null;
  }

  return React.createElement(
    "ink-text",
    {
      style: { flexGrow: 0, flexShrink: 1, flexDirection: "row", textWrap: wrap },
      internal_transform: transform,
      ...(internal_cursorAnchor ? { internal_cursorAnchor: true } : {}),
    },
    isScreenReaderEnabled && ariaLabel ? ariaLabel : children,
  );
}
