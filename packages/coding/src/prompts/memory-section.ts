/**
 * FEATURE_124 (v0.7.43) Phase B — `project-memory` SP section builder.
 *
 * Reads MEMORY.md from the resolved per-project memory directory,
 * applies claudecode-shape line/byte truncation, and emits the SP
 * section content. Designed for SYNC fs reads (mirrors
 * `loadAgentsFiles` / `formatAgentsForPrompt` pattern in
 * `context/agents-loader.ts` — SP build is synchronous).
 *
 * Section position in `capability-sections.ts`:
 *   project-agents (AGENTS.md, user-managed)
 *     ↓
 *   memory-rules (Phase C — LLM teaching text)
 *     ↓
 *   project-memory (this section — MEMORY.md index)
 *     ↓
 *   skills-addendum
 *
 * Why index only, no topic-file pre-injection:
 *   - MEMORY.md is capped at 25KB / 200 lines (claudecode-aligned, see
 *     `@kodax-ai/agent` `memory/truncate.ts`). Index provides
 *     deterministic SP overhead budget.
 *   - Topic files (`feedback_*.md`, `user_*.md`, etc.) are unbounded —
 *     pre-injecting all of them would make context occupancy unpredictable.
 *   - The LLM reads topic files on demand via the existing `read` tool
 *     when an index entry looks relevant.
 *
 * Fallback when MEMORY.md is missing:
 *   - Returns a "your MEMORY.md is currently empty" stub so the LLM
 *     still sees the memory subsystem is active and knows where to
 *     write its first entry. Matches claudecode `buildMemoryPrompt`
 *     L307-313 fallback text.
 *
 * The directory is NOT created here — that happens lazily on the first
 * LLM Write tool call. Section building must remain side-effect-free so
 * tests can run hermetically and `setAgentConfigHome()` overrides apply
 * uniformly across read/write paths.
 */

import * as fs from 'node:fs';

import {
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  truncateEntrypointContent,
} from '@kodax-ai/agent';

export interface MemorySectionResult {
  /** SP section content. Always non-empty (fallback when MEMORY.md missing). */
  readonly content: string;
  /** Resolved memory directory absolute path. */
  readonly memoryDir: string;
  /** True when the MEMORY.md file exists and was read. */
  readonly entrypointExists: boolean;
}

/**
 * mtime-keyed read cache for MEMORY.md — mirrors the FEATURE_149 pattern in
 * `context/agents-loader.ts` (`readFileWithMtimeCache`). `buildMemorySection`
 * runs on EVERY SP rebuild (once per SA/AMA turn); MEMORY.md is up to 25KB, so
 * re-reading it every turn is wasted sync IO. Keyed by absolute entrypoint path;
 * a `todo_save` write bumps the file mtime and invalidates the entry automatically.
 */
const entrypointCache = new Map<string, { mtimeMs: number; content: string }>();

/** Test-only — reset the MEMORY.md read cache between unit tests. */
export function clearMemorySectionCacheForTesting(): void {
  entrypointCache.clear();
}

/**
 * Read MEMORY.md via the mtime cache. Returns the raw content when the file
 * exists and is readable, or `undefined` for any stat/read failure (missing
 * file, EISDIR, permission denied) — the caller degrades to the empty fallback.
 * Never throws.
 */
function readEntrypointWithCache(entrypoint: string): string | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(entrypoint).mtimeMs;
  } catch {
    entrypointCache.delete(entrypoint);
    return undefined;
  }
  const cached = entrypointCache.get(entrypoint);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  try {
    const content = fs.readFileSync(entrypoint, 'utf-8');
    entrypointCache.set(entrypoint, { mtimeMs, content });
    return content;
  } catch {
    entrypointCache.delete(entrypoint);
    return undefined;
  }
}

/**
 * Build the `project-memory` SP section content for the given cwd.
 *
 * Synchronous + side-effect-free + NEVER throws — any fs read failure
 * (permission denied, transient EBUSY) silently degrades to the empty-
 * memory fallback. A missing memory subsystem must not break session
 * startup.
 */
export function buildMemorySection(cwd: string): MemorySectionResult {
  const memoryDir = resolveMemoryRoot(cwd);
  const entrypoint = resolveMemoryEntrypoint(cwd);

  const raw = readEntrypointWithCache(entrypoint);
  const entrypointExists = raw !== undefined;

  const content = entrypointExists
    ? buildBodyWithEntrypoint(memoryDir, raw)
    : buildEmptyFallback(memoryDir);

  return { content, memoryDir, entrypointExists };
}

/**
 * Compose the section body when MEMORY.md exists. Trims, truncates,
 * then wraps with the section header + footer hint about topic files.
 */
function buildBodyWithEntrypoint(memoryDir: string, raw: string): string {
  const truncated = truncateEntrypointContent(raw);
  return [
    '=== Persistent memory (cross-session) ===',
    `Memory directory: ${memoryDir}`,
    '',
    truncated.content,
    '',
    '[Index only — read individual files via the read tool when you need details. See memory rules section above.]',
  ].join('\n');
}

/**
 * Fallback section body when MEMORY.md is missing. Tells the LLM the
 * subsystem is active and gives the directory path it should write to.
 */
function buildEmptyFallback(memoryDir: string): string {
  return [
    '=== Persistent memory (cross-session) ===',
    `Memory directory: ${memoryDir}`,
    '',
    'Your MEMORY.md is currently empty. When you save new memories, they will appear here.',
  ].join('\n');
}
