/**
 * FEATURE_219 (v0.7.46) — Per-project session storage key derivation.
 *
 * Maps a session's canonical project identity to a stable, human-readable
 * directory name under `~/.kodax/sessions/<projectKey>/`. See ADR-038.
 *
 * Key shape: `<slug>-<hash>` where
 *   - `slug`   = sanitized canonical root path (readable; helps eyeballing)
 *   - `hash`   = short hex of the case-folded canonical root (collision-proof;
 *                two different roots that sanitize to the same slug still get
 *                distinct keys — `C:/a-b` vs `C:/a/b`)
 *
 * Identity precedence (mirrors ADR-038 §3): canonical git root
 * (`--git-common-dir` derived, already computed in workspace-runtime) →
 * raw cwd (non-git) → `_unknown` (no path at all).
 */

import path from 'path';
import { createHash } from 'crypto';
import type { KodaXSessionRuntimeInfo } from '@kodax-ai/agent';
import { resolveSessionRuntimeInfo } from './workspace-runtime.js';

/** Shared bucket for sessions with no resolvable path (no gitRoot AND no cwd). */
export const UNKNOWN_PROJECT_KEY = '_unknown';

/** Max slug length before the hash suffix — keeps folder names bounded. */
const MAX_SLUG_LENGTH = 80;

/**
 * Windows (NTFS/ReFS) and macOS (APFS default) fold case on lookup, so two
 * paths differing only in case are the SAME directory and MUST map to one
 * key. Lowercase the whole path on those platforms so the folder name is
 * deterministic per logical project. POSIX keeps case (case-sensitive FS).
 */
function caseFold(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

/** Resolve + forward-slash + case-fold a root path into its canonical form. */
function normalizeRoot(root: string): string {
  return caseFold(path.resolve(root).replace(/\\/g, '/'));
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/**
 * Sanitize to a readable slug. Keeps the TAIL of the path (the project name
 * end is more identifying than the `c-users-...` prefix) when over the cap.
 */
function slugify(folded: string): string {
  const sanitized = folded.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > MAX_SLUG_LENGTH
    ? sanitized.slice(sanitized.length - MAX_SLUG_LENGTH)
    : sanitized;
}

export interface ProjectIdentity {
  /** Directory name under the sessions root. */
  readonly key: string;
  /** Case-folded canonical root used as the hash input (null for `_unknown`). */
  readonly canonicalRoot: string | null;
  /** Human-friendly label (basename of the original-case root). */
  readonly displayName: string;
}

/** Derive a project identity directly from a (canonical / cwd) root path. */
export function deriveProjectKeyFromRoot(root: string | null | undefined): ProjectIdentity {
  if (!root || !root.trim()) {
    return { key: UNKNOWN_PROJECT_KEY, canonicalRoot: null, displayName: UNKNOWN_PROJECT_KEY };
  }
  const folded = normalizeRoot(root);
  const slug = slugify(folded);
  const key = slug ? `${slug}-${shortHash(folded)}` : shortHash(folded);
  const displayName = path.basename(path.resolve(root).replace(/\\/g, '/')) || root;
  return { key, canonicalRoot: folded, displayName };
}

/**
 * Derive a project identity from a session's persisted data. Reuses the same
 * canonical-repo resolution the session-list filter already relies on, so a
 * session and its `list()` query converge on one key.
 */
export function deriveProjectKeyFromData(
  data: { gitRoot?: string; runtimeInfo?: KodaXSessionRuntimeInfo },
): ProjectIdentity {
  // `resolveSessionRuntimeInfo` types `gitRoot` as required; coerce a missing
  // value to '' (it normalizes empties back to undefined internally).
  const runtime = resolveSessionRuntimeInfo({
    gitRoot: data.gitRoot ?? '',
    runtimeInfo: data.runtimeInfo,
  });
  const root =
    runtime?.canonicalRepoRoot
    ?? runtime?.executionCwd
    ?? (data.gitRoot && data.gitRoot.trim() ? data.gitRoot : undefined);
  return deriveProjectKeyFromRoot(root);
}

/** Match a persisted Session using the same authoritative identity precedence as bucket routing. */
export function sessionProjectMatchesAnyRoot(
  data: { gitRoot?: string; runtimeInfo?: KodaXSessionRuntimeInfo },
  roots: readonly string[],
): boolean {
  const persistedRoot = deriveProjectKeyFromData(data).canonicalRoot;
  return persistedRoot !== null && roots.some(
    (root) => deriveProjectKeyFromRoot(root).canonicalRoot === persistedRoot,
  );
}
