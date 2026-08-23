import type { ReactNode } from "react";
import Engine from "./engine.js";

interface EngineInstance extends InstanceType<typeof Engine> {
  setAltScreenActive?: (active: boolean, mouseTracking?: boolean) => void;
  setShellMode?: (
    mode: "virtual" | "main-screen",
    mouseTracking?: boolean,
  ) => void;
  beginShellTransition?: (
    phase: "enter-alt-screen" | "exit-alt-screen",
  ) => void;
  clearTextSelection?: () => void;
  registerTerminalExitGuard?: (guard: () => void) => () => void;
  commitInlineScrollback?: (options: {
    mode: "append" | "rebuild";
    text: string;
  }) => void;
}

export type RendererOptions = ConstructorParameters<typeof Engine>[0];

export interface RendererInstanceHandle {
  readonly isConcurrent: boolean;
  render: (node: ReactNode) => void;
  unmount: (error?: unknown) => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
  setAltScreenActive?: (active: boolean, mouseTracking?: boolean) => void;
  setShellMode?: (mode: "virtual" | "main-screen", mouseTracking?: boolean) => void;
  beginShellTransition?: (phase: "enter-alt-screen" | "exit-alt-screen") => void;
  clearTextSelection?: () => void;
  registerTerminalExitGuard?: (guard: () => void) => () => void;
  commitInlineScrollback?: (options: {
    mode: "append" | "rebuild";
    text: string;
  }) => void;
}

export default class KodaXRenderer implements RendererInstanceHandle {
  private readonly engineInstance: EngineInstance;

  readonly isConcurrent: boolean;

  constructor(options: RendererOptions) {
    this.engineInstance = new Engine(options) as EngineInstance;
    this.isConcurrent = this.engineInstance.isConcurrent;
  }

  render = (node: ReactNode) => {
    this.engineInstance.render(node);
  };

  unmount = (error?: unknown) => {
    this.engineInstance.unmount(error);
  };

  waitUntilExit = () => this.engineInstance.waitUntilExit();

  clear = () => {
    this.engineInstance.clear();
  };

  setAltScreenActive = (active: boolean, mouseTracking?: boolean) => {
    this.engineInstance.setAltScreenActive?.(active, mouseTracking);
  };

  setShellMode = (mode: "virtual" | "main-screen", mouseTracking?: boolean) => {
    this.engineInstance.setShellMode?.(mode, mouseTracking);
  };

  beginShellTransition = (phase: "enter-alt-screen" | "exit-alt-screen") => {
    this.engineInstance.beginShellTransition?.(phase);
  };

  clearTextSelection = () => {
    this.engineInstance.clearTextSelection?.();
  };

  registerTerminalExitGuard = (guard: () => void) =>
    this.engineInstance.registerTerminalExitGuard?.(guard) ?? (() => undefined);

  commitInlineScrollback = (options: {
    mode: "append" | "rebuild";
    text: string;
  }) => {
    this.engineInstance.commitInlineScrollback?.(options);
  };
}
