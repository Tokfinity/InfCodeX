/**
 * FEATURE_124 (v0.7.43) — Memory System Alignment substrate.
 *
 * Per-project isolated memory directory + frontmatter-typed taxonomy
 * (user / feedback / project / reference) + claudecode-shape truncation
 * for SP injection. Mirrors claudecode `src/memdir/` semantically;
 * implementation is independent and zero-yaml-dep.
 *
 * Consumers (in dependency order):
 *   - `@kodax-ai/coding` `prompts/memory-section.ts` (Phase B) — reads
 *     MEMORY.md, calls `truncateEntrypointContent`, builds SP block.
 *   - `@kodax-ai/coding` `prompts/memory-rules.ts` (Phase C) — emits the
 *     LLM teaching text using the resolved memory directory path.
 *   - `@kodax-ai/repl` `interactive/memory-command.ts` (Phase D) —
 *     `/memory list/edit/rebuild` slash commands.
 *   - `@kodax-ai/repl` `ui/InkREPL.tsx` (Phase D) — uses
 *     `isAutoManagedMemoryFile` for transcript badge rendering.
 */

export {
  hashCwd,
  isAutoManagedMemoryFile,
  parseMemoryTypeFromFilename,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  sanitizeProjectKey,
  tryGitRemote,
} from './paths.js';

export type { MemoryFrontmatter, MemoryType, ParsedMemoryFile } from './frontmatter.js';
export {
  parseMemoryFile,
  parseMemoryType,
  parseScalarFields,
} from './frontmatter.js';

export {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from './truncate.js';
export type { EntrypointTruncation } from './truncate.js';
