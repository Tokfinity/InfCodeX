import { Stream } from "node:stream";
import { openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import InkBox from "./primitives/Box.js";
import InkText from "./primitives/Text.js";
import InkStatic from "./primitives/Static.js";
import KodaXRenderer, {
  type RendererInstanceHandle,
} from "./renderer.js";

// FEATURE_172 / ADR-028 — opt-in render-pipeline tracing.
//
// Enable with `KODAX_RENDER_TRACE=1 kodax -c` (default file
// `<tmpdir>/kodax-render-trace-<pid>.log` — `/tmp/...` on Linux/macOS,
// `%TEMP%\...` on Windows) or `KODAX_RENDER_TRACE=/path/to/file kodax -c`
// for a custom path.
//
// Writes one line per render frame with:
//   - renderTime: engine internal cost (Yoga + renderNodeToOutput + outputToScreen)
//   - interval: wall-time since the prior frame's onRender callback (full frame
//     wall-time when streaming is continuous; includes throttle idle when sparse)
//   - writes: stdout.write() call count for the prior frame (typically 1 for
//     the cell-renderer path, more if hasStaticOutput branch fired)
//   - bytes: ANSI bytes written to stdout for the prior frame
//   - screenH / viewport: prevFrame dimensions
//
// Writes to a FILE (not stderr) because fullscreen alt-screen mode hides
// stderr output. `fs.writeSync` is intentional — async writes risk being
// dropped on process exit / panic when the perf data is most needed.
let traceFd: number | -1 | null = null;
function resolveTraceFd(): number | null {
  if (traceFd === -1) return null;
  if (traceFd !== null) return traceFd;
  const flag = process.env.KODAX_RENDER_TRACE;
  if (!flag || flag === "0" || flag === "false") {
    traceFd = -1;
    return null;
  }
  const path =
    flag === "1" || flag === "true"
      ? join(tmpdir(), `kodax-render-trace-${process.pid}.log`)
      : flag;
  try {
    traceFd = openSync(path, "a");
    writeSync(
      traceFd,
      `=== KODAX render trace pid=${process.pid} ${new Date().toISOString()} platform=${process.platform} node=${process.version} ===\n`,
    );
    return traceFd;
  } catch {
    traceFd = -1;
    return null;
  }
}
function traceLine(line: string): void {
  const fd = resolveTraceFd();
  if (fd === null) return;
  try {
    writeSync(fd, line);
  } catch {
    // swallow — tracing must never crash the renderer
  }
}

const localInstances = new WeakMap<NodeJS.WriteStream, RendererInstanceHandle>();

const fallbackStdout = {
  isTTY: false,
  columns: 80,
  rows: 24,
  write: () => true,
  on: () => undefined,
  off: () => undefined,
} as unknown as NodeJS.WriteStream;

const fallbackStderr = {
  isTTY: false,
  write: () => true,
  on: () => undefined,
  off: () => undefined,
} as unknown as NodeJS.WriteStream;

const fallbackStdin = {
  isTTY: false,
  isRaw: false,
  on: () => undefined,
  off: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  setRawMode: () => undefined,
} as unknown as NodeJS.ReadStream;

export interface TuiRendererInstance {
  setAltScreenActive?: (active: boolean, mouseTracking?: boolean) => void;
  setShellMode?: (
    mode: "virtual" | "main-screen",
    mouseTracking?: boolean,
  ) => void;
  beginShellTransition?: (
    phase: "enter-alt-screen" | "exit-alt-screen",
  ) => void;
  clearTextSelection?: () => void;
}

export interface RenderOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  debug?: boolean;
  exitOnCtrlC?: boolean;
  patchConsole?: boolean;
  onRender?: (metrics: { renderTime: number }) => void;
  isScreenReaderEnabled?: boolean;
  maxFps?: number;
  concurrent?: boolean;
  shellMode?: "virtual" | "main-screen";
  kittyKeyboard?: {
    mode?: "auto" | "enabled" | "disabled";
    flags?: string[];
  };
}

export interface RenderInstance {
  rerender: (node: ReactNode) => void;
  unmount: (error?: unknown) => void;
  waitUntilExit: () => Promise<unknown>;
  cleanup: () => void;
  clear: () => void;
}

export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
  capsLock: boolean;
  numLock: boolean;
  eventType?: "press" | "repeat" | "release";
}

export interface TextProps extends PropsWithChildren {
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
}

export type BoxProps = PropsWithChildren<Record<string, unknown>>;

export interface StaticProps<Item> {
  items: readonly Item[];
  children: (item: Item, index: number) => ReactNode;
  style?: Record<string, unknown>;
}

export interface TuiRoot {
  render: (node: ReactNode) => void;
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
}

function getOptions(
  stdout: NodeJS.WriteStream | RenderOptions | undefined = {},
): RenderOptions {
  if (stdout instanceof Stream) {
    return {
      stdout,
    };
  }

  return stdout;
}

function getInstance(
  stdout: NodeJS.WriteStream,
  createInstance: () => RendererInstanceHandle,
  concurrent: boolean,
): RendererInstanceHandle {
  let instance = localInstances.get(stdout);

  if (!instance) {
    instance = createInstance();
    localInstances.set(stdout, instance);
  } else if (instance.isConcurrent !== concurrent) {
    console.warn(
      `Warning: render() was called with concurrent: ${concurrent}, but the existing renderer for this stdout uses concurrent: ${instance.isConcurrent}. `
      + "The concurrent option only takes effect on the first render. Call unmount() first if you need to change the rendering mode.",
    );
  }

  return instance;
}

export function getRendererInstance(
  stdout: NodeJS.WriteStream,
): TuiRendererInstance | undefined {
  return localInstances.get(stdout) as TuiRendererInstance | undefined;
}

export function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): RenderInstance {
  const inkOptions = {
    stdout: fallbackStdout,
    stdin: fallbackStdin,
    stderr: fallbackStderr,
    debug: false,
    exitOnCtrlC: true,
      patchConsole: false,
      maxFps: 30,
      concurrent: false,
      ...getOptions(options),
  };

  // FEATURE_172 / ADR-028 — install per-frame render trace if enabled.
  // Wraps stdout.write to count writes/bytes accumulated since the last
  // onRender callback fired (i.e. the prior frame's applyCellFrame work).
  // Wraps inkOptions.onRender to emit a trace line each frame.
  const traceFdProbe = resolveTraceFd();
  if (traceFdProbe !== null) {
    const stdout = inkOptions.stdout as NodeJS.WriteStream;
    const origWrite = stdout.write.bind(stdout) as NodeJS.WriteStream["write"];
    let frameWrites = 0;
    let frameBytes = 0;
    (stdout as { write: NodeJS.WriteStream["write"] }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      frameWrites += 1;
      frameBytes +=
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, "utf8")
          : (chunk?.length ?? 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    }) as NodeJS.WriteStream["write"];

    let lastOnRenderTs = 0;
    let frameSeq = 0;
    const userOnRender = inkOptions.onRender;
    inkOptions.onRender = (metrics: { renderTime: number }) => {
      const now = performance.now();
      const interval = lastOnRenderTs === 0 ? 0 : now - lastOnRenderTs;
      const stdoutAny = stdout as unknown as { rows?: number; columns?: number };
      const viewportW = stdoutAny.columns ?? 0;
      const viewportH = stdoutAny.rows ?? 0;
      traceLine(
        `frame=${frameSeq} renderTime=${metrics.renderTime.toFixed(2)}ms ` +
          `interval=${interval.toFixed(2)}ms ` +
          `writes=${frameWrites} bytes=${frameBytes} ` +
          `viewport=${viewportW}x${viewportH}\n`,
      );
      frameWrites = 0;
      frameBytes = 0;
      lastOnRenderTs = now;
      frameSeq += 1;
      return userOnRender?.(metrics);
    };
  }

  const instance = getInstance(
    inkOptions.stdout,
    () => new KodaXRenderer(inkOptions),
    inkOptions.concurrent ?? false,
  );

  instance.render(node);

  return {
    rerender: instance.render,
    unmount() {
      instance.unmount();
    },
    waitUntilExit: instance.waitUntilExit,
    cleanup: () => {
      localInstances.delete(inkOptions.stdout);
    },
    clear: instance.clear,
  };
}

export function createRoot(options: RenderOptions = {}): TuiRoot {
  const inkOptions = {
    stdout: fallbackStdout,
    stdin: fallbackStdin,
    stderr: fallbackStderr,
    debug: false,
    exitOnCtrlC: true,
      patchConsole: false,
      maxFps: 30,
      concurrent: false,
      ...options,
  };

  const instance = new KodaXRenderer(inkOptions);
  localInstances.set(inkOptions.stdout, instance);

  return {
    render(node) {
      instance.render(node);
    },
    unmount() {
      instance.unmount();
      localInstances.delete(inkOptions.stdout);
    },
    waitUntilExit() {
      return instance.waitUntilExit();
    },
    clear() {
      instance.clear();
    },
  };
}

export const Box = InkBox as unknown as ComponentType<BoxProps>;
export const Text = InkText as unknown as ComponentType<TextProps>;
export const Static = InkStatic as unknown as (<Item>(
  props: StaticProps<Item>,
) => ReactNode);
