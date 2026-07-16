import { emitKodaXDiagnostic } from '@kodax-ai/agent';

/**
 * Conservative tool-name repair.
 *
 * Weaker models (and some third-party providers) emit a tool name that differs
 * from the registered name only by case or separators — `Write` for `write`,
 * `TodoCreate` / `todo-create` for `todo_create`. Without repair the call
 * fails as "unknown/inactive tool" even though the intent is unambiguous.
 *
 * This repair is deliberately CONSERVATIVE: it matches ONLY when the candidate
 * names are equal after normalizing away case and separators (`_`, `-`,
 * whitespace). It does NOT do edit-distance/fuzzy matching — `red` must never
 * silently become `read`. A repair fires only when EXACTLY ONE candidate
 * normalizes to the same key; ties or no-match leave the name untouched so the
 * existing unknown-tool error path handles it.
 */

function normalizeToolNameKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Resolve a possibly-misspelled tool name against the candidate set.
 *
 * Returns the canonical candidate name when `name` is not already a candidate
 * but normalizes (case/separator-insensitively) to exactly one candidate.
 * Returns `null` when no repair is warranted (already valid, no match, or an
 * ambiguous tie).
 */
export function resolveToolNameAlias(name: string, candidates: readonly string[]): string | null {
  if (candidates.includes(name)) return null; // already valid — nothing to repair

  const key = normalizeToolNameKey(name);
  if (!key) return null;

  const matches = candidates.filter((candidate) => normalizeToolNameKey(candidate) === key);
  // Unique match only — never guess between two candidates.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Apply {@link resolveToolNameAlias} across a turn's tool_use blocks, returning
 * a new array (immutable) with each repairable name rewritten to its canonical
 * form. Done ONCE on the stream result before any consumer — history, dispatch
 * (bash sequential-vs-parallel routing keys on `name === 'bash'`), tool events,
 * and the incomplete-tool param scan — so the canonical name is used uniformly
 * and `tool:start`/`tool:result` never disagree. Preserves all other block
 * fields (e.g. `_truncated`).
 */
export function repairToolBlockNames<T extends { name: string }>(
  blocks: readonly T[],
  candidates: readonly string[],
): T[] {
  return blocks.map((block) => {
    const repaired = resolveToolNameAlias(block.name, candidates);
    if (!repaired) return block;
    if (process.env.KODAX_DEBUG_TOOL_STREAM) {
      emitKodaXDiagnostic({
        source: 'coding:tool-name-repair',
        level: 'debug',
        message: 'Tool name repaired.',
        detail: { from: block.name, to: repaired },
      });
    }
    return { ...block, name: repaired };
  });
}
