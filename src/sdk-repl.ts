/**
 * SDK subpath entry — `@kodax-ai/kodax/repl`
 *
 * Re-exports the entire `@kodax-ai/repl` public API — full interactive
 * terminal experience built on Ink: `runInkInteractiveMode`, configuration
 * loaders (`loadConfig` / `saveConfig`), session storage primitives,
 * provider resolution, etc.
 *
 * Note: this subpath pulls Ink + React as transitive deps via the
 * `@kodax-ai/repl` package. SDK consumers who only need configuration
 * helpers (no UI) get fine-grained named imports — ESM tree-shaking
 * is friendly to the side-effect-free helper exports.
 *
 * Usage:
 * ```ts
 * import { loadConfig, FileSessionStorage } from '@kodax-ai/kodax/repl';
 * ```
 *
 * See docs/ADR.md ADR-024 for the SDK formalization decision.
 */

export * from '@kodax-ai/repl';
