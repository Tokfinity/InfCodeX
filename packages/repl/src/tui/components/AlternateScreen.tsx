import { writeSync } from "node:fs";
import React, { useInsertionEffect, useMemo } from "react";
import { onExit as onProcessExit } from "signal-exit";
// FEATURE_093 (v0.7.24): import Box + terminal hooks directly from
// renderer-runtime to avoid the `tui/index.ts ↔
// components/AlternateScreen.tsx` barrel cycle.
import {
  Box,
  useTerminalOutput,
  useTerminalSize,
  useTerminalWrite,
} from "../renderer-runtime.js";
import { getRendererInstance } from "../core/root.js";
import {
  buildAlternateScreenEnterSequence,
  buildAlternateScreenExitSequence,
} from "../core/termio.js";

export interface AlternateScreenProps {
  children: React.ReactNode;
  mouseTracking?: boolean;
  enabled?: boolean;
  clearOnEnter?: boolean;
}

function writeExitSequence(
  output: NodeJS.WriteStream,
  writeRaw: (chunk: string) => boolean,
  sequence: string,
): void {
  if (!("fd" in output) || typeof output.fd !== "number") {
    writeRaw(sequence);
    return;
  }
  try {
    writeSync(output.fd, sequence);
  } catch {
    writeRaw(sequence);
  }
}

export const AlternateScreen: React.FC<AlternateScreenProps> = ({
  children,
  mouseTracking = true,
  enabled = true,
  clearOnEnter = false,
}) => {
  const output = useTerminalOutput();
  const { rows } = useTerminalSize();
  const writeRaw = useTerminalWrite();
  const isInteractiveStdout = useMemo(
    () => enabled && output.isTTY === true,
    [enabled, output],
  );

  useInsertionEffect(() => {
    if (!isInteractiveStdout) {
      return;
    }

    const rendererInstance = getRendererInstance(output);
    rendererInstance?.setShellMode?.("virtual", mouseTracking);
    let restored = false;
    const restoreTerminal = () => {
      if (restored) return;
      restored = true;
      rendererInstance?.beginShellTransition?.("exit-alt-screen");
      rendererInstance?.clearTextSelection?.();
      writeExitSequence(
        output,
        writeRaw,
        buildAlternateScreenExitSequence({ mouseTracking }),
      );
      rendererInstance?.setAltScreenActive?.(false);
    };
    const removeRendererExitGuard =
      rendererInstance?.registerTerminalExitGuard?.(restoreTerminal)
      ?? (() => undefined);
    const removeExitGuard = onProcessExit(restoreTerminal, { alwaysLast: true });

    rendererInstance?.beginShellTransition?.("enter-alt-screen");
    writeRaw(
      buildAlternateScreenEnterSequence({
        mouseTracking,
        clearOnEnter,
      }),
    );
    rendererInstance?.setAltScreenActive?.(true, mouseTracking);

    return () => {
      removeExitGuard();
      try {
        restoreTerminal();
      } finally {
        removeRendererExitGuard();
      }
    };
  }, [clearOnEnter, isInteractiveStdout, mouseTracking, output, writeRaw]);

  return (
    <Box
      flexDirection="column"
      height={rows}
      width="100%"
      flexGrow={1}
      flexShrink={0}
    >
      {children}
    </Box>
  );
};
