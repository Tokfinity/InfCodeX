/**
 * KodaX Cache Control — FEATURE_116 (v0.7.37)
 *
 * Helpers for inserting and lowering `KodaXCacheBoundary` markers across
 * the prompt assembly path. The two halves of the contract:
 *
 *   producer side  — `insertCacheBoundary(blocks, hint)` appends a
 *                    boundary to the end of any stable prefix (system
 *                    prompt blocks, role prompt blocks, …).
 *   consumer side  — `lowerCacheBoundaries(blocks, mode)` is called by
 *                    a provider base class right before serialisation:
 *                      - `attach`: write `cache_control` onto the block
 *                        immediately before each boundary, then drop the
 *                        boundaries (Anthropic-compat path).
 *                      - `strip`:  drop the boundaries with no further
 *                        action (OpenAI-compat / ACP CLI bridge path).
 *
 * The boundary marker is purely client-side and MUST be removed before
 * a request is sent over the wire. Provider subclasses do nothing —
 * lowering happens once per base class in `KodaXAnthropicCompatProvider`,
 * `KodaXOpenAICompatProvider`, and `KodaXAcpProvider`.
 */

import type { KodaXCacheBoundary, KodaXContentBlock } from './types.js';

/**
 * Block shape Anthropic accepts where a `cache_control` field can be
 * legally attached. Used in `lowerCacheBoundaries` mode `'attach'` to
 * mark the preceding block as a cache prefix.
 */
export interface KodaXAnthropicCacheableBlock {
  type: string;
  cache_control?: { type: 'ephemeral' };
  // Pass-through of any other fields the wire payload carries.
  [key: string]: unknown;
}

export type KodaXCacheLowerMode = 'attach' | 'strip';

/**
 * Append a cache-boundary marker to a block array. Idempotent: if the
 * last block is already a boundary with the same hint, the array is
 * returned unchanged (avoids accidental double-marking when the same
 * stable prefix is composed twice).
 */
export function insertCacheBoundary<T extends KodaXContentBlock>(
  blocks: readonly T[],
  hint?: KodaXCacheBoundary['hint'],
): readonly (T | KodaXCacheBoundary)[] {
  const last = blocks[blocks.length - 1];
  if (last && isCacheBoundary(last) && last.hint === hint) {
    return blocks;
  }
  const marker: KodaXCacheBoundary = hint ? { type: 'cache-boundary', hint } : { type: 'cache-boundary' };
  return [...blocks, marker];
}

/**
 * Type-guard. Cheap to call repeatedly during lowering.
 *
 * Structural narrowing rather than just `type === 'cache-boundary'`:
 * the block must carry no fields beyond `type` and the optional `hint`.
 * This prevents an external wire payload that happens to carry
 * `type: 'cache-boundary'` plus other fields (a coincidental name
 * collision) from being silently stripped during lowering.
 */
export function isCacheBoundary(block: unknown): block is KodaXCacheBoundary {
  if (typeof block !== 'object' || block === null) return false;
  if ((block as { type?: unknown }).type !== 'cache-boundary') return false;
  const keys = Object.keys(block as object);
  // Allowed shape: { type } or { type, hint }. Anything else means a
  // foreign object that merely shares the discriminant string.
  return keys.length <= 2 && keys.every((k) => k === 'type' || k === 'hint');
}

/**
 * Provider-base-class entry point. Walks the block array once.
 *
 * - `mode === 'attach'`:  for each boundary, set
 *   `cache_control: { type: 'ephemeral' }` on the immediately preceding
 *   non-boundary block, then drop the boundary itself. If a boundary is
 *   the first block (no predecessor) it is silently dropped — there is
 *   nothing to attach to. If multiple boundaries land back-to-back, only
 *   the predecessor of the *first* one in the run is marked (the others
 *   collapse, since they would all attach to the same predecessor).
 *
 * - `mode === 'strip'`:  drop every boundary. No `cache_control` is
 *   added. Used by adapters whose wire format does not expose a
 *   client-side cache marker (OpenAI-compat, ACP CLI bridge).
 *
 * Always returns a NEW array (never mutates input — the caller may hold
 * references to the original payload for diagnostics).
 */
export function lowerCacheBoundaries<T extends KodaXAnthropicCacheableBlock>(
  blocks: readonly (T | KodaXCacheBoundary)[],
  mode: KodaXCacheLowerMode,
): T[] {
  const out: T[] = [];

  for (const block of blocks) {
    if (isCacheBoundary(block)) {
      // Boundary semantics: "everything BEFORE the marker is the cache
      // prefix". When we encounter a boundary in `attach` mode, mark the
      // most recently emitted block (i.e. its predecessor) and drop the
      // boundary. If there is no predecessor (leading boundary, or two
      // boundaries back-to-back where the first already consumed it),
      // there is nothing to attach to — silently drop. Strip mode skips
      // the attach step entirely.
      if (mode === 'attach' && out.length > 0) {
        const prev = out[out.length - 1]!;
        out[out.length - 1] = { ...prev, cache_control: { type: 'ephemeral' } } as T;
      }
      continue;
    }
    out.push(block);
  }

  return out;
}

/**
 * Drop every cache boundary from a block array without attaching any
 * cache marker. Convenience wrapper for `lowerCacheBoundaries(blocks, 'strip')`
 * for callers that only need the strip behaviour.
 *
 * Generic bound is intentionally loose (`{ type: string }`) so the helper
 * is callable both at the KodaX-internal level (KodaXContentBlock arrays)
 * and at the provider-wire level (Anthropic-compat / OpenAI-compat block
 * shapes that include extra wire fields).
 */
export function stripCacheBoundaries<T extends { type: string }>(
  blocks: readonly (T | KodaXCacheBoundary)[],
): T[] {
  return blocks.filter((b): b is T => !isCacheBoundary(b));
}
