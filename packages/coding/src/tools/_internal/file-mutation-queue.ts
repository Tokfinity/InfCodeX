/**
 * file-mutation-queue — FEATURE_131 v0.7.36 Part A.
 *
 * Path-keyed serial mutation queue. Same path → mutations run in
 * arrival order; different paths → mutations still run concurrently.
 *
 * Why this exists: FEATURE_119 Pattern B lets the Worker fan out to
 * multiple async children that can each call `write` / `edit` /
 * `multi_edit` / `insert_after_anchor`. Without serialization at the
 * tool layer, two concurrent edits to the same file race the
 * read-modify-write cycle and silently lose one side's changes (last
 * writer wins).
 *
 * Implementation: a single process-global Map keyed by a normalized
 * path. Each `withFileMutation` call chains its work onto the tail of
 * that path's queue, sets the new tail, and clears the entry when its
 * own work is the current tail (so completed paths don't leak).
 *
 * Process-scope only — does not coordinate across multiple KodaX
 * processes (a separate FEATURE_125 content-hash safety net is the
 * cross-process story).
 *
 * Path normalization rules (Windows/POSIX parity):
 *   - lowercase the drive letter on Windows-style paths so `C:\foo`
 *     and `c:/foo` queue together
 *   - normalize backslashes to forward slashes
 *   - collapse repeated separators
 * The intent is "would this path read and write the same file at the
 * OS level"; we keep the ruleset minimal — three fixups handle
 * 99%+ of the realistic collision space without the surface area of
 * full `path.resolve()` (which would couple us to cwd at queue time
 * and miss the symlink case anyway).
 */

const fileMutationQueue = new Map<string, Promise<unknown>>();

/**
 * Normalize a path so equivalent variants collide on the same queue
 * key. Cross-platform parity per design §FEATURE_131 acceptance #9.
 *
 * On Windows the filesystem is case-insensitive across the entire
 * path, so we lowercase everything once we know we're on win32.
 * POSIX paths are case-sensitive and stay as-is. Detection is via
 * `process.platform`, with `KODAX_PATH_KEY_PLATFORM` as a test-only
 * override so unit tests can exercise both branches regardless of
 * the host OS.
 */
function isWindowsPathPlatform(): boolean {
  const override = process.env.KODAX_PATH_KEY_PLATFORM;
  if (override === 'win32') return true;
  if (override === 'posix') return false;
  return process.platform === 'win32';
}

export function normalizePathForKey(absolutePath: string): string {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return '';
  }
  let normalized = absolutePath.replace(/\\/g, '/');
  // Collapse repeated separators ("a//b" → "a/b") but not the leading
  // double-slash on UNC paths.
  if (normalized.startsWith('//')) {
    normalized = '//' + normalized.slice(2).replace(/\/+/g, '/');
  } else {
    normalized = normalized.replace(/\/+/g, '/');
  }
  if (isWindowsPathPlatform()) {
    // Windows filesystem is case-insensitive end-to-end — lowercase
    // the entire path so any spelling collides on the same key.
    normalized = normalized.toLowerCase();
  } else if (normalized.length >= 2 && /^[A-Za-z]:/.test(normalized)) {
    // POSIX host but a Windows-style path snuck in (cross-platform
    // tests, mock data) — at minimum align the drive letter so the
    // common case of `C:` vs `c:` doesn't split the queue.
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  // Trim trailing slash unless it's the root marker.
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
  }
  return normalized;
}

/**
 * Run `fn` serialized against any other in-flight mutations targeting
 * the same `absolutePath`. Returns whatever `fn` returns. The queue
 * tail entry is cleared when this call's work is the current tail —
 * so steady-state behavior is "queue size === count of paths with
 * mutations actively in flight", never growing unboundedly.
 *
 * Errors propagate: if `fn` throws/rejects, the queue still moves on
 * to the next caller (it chains off `previous` not off the failure),
 * but the rejected promise is what `withFileMutation` returns to the
 * caller. Subsequent enqueues see a settled prior tail and proceed.
 */
export async function withFileMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizePathForKey(absolutePath);
  const previous = fileMutationQueue.get(key) ?? Promise.resolve();
  // Wrap `fn` so a failure on the prior tail does not poison this
  // call's chain. We always advance the queue regardless of whether
  // the prior caller succeeded.
  const next: Promise<T> = previous
    .catch(() => undefined)
    .then(() => fn());
  // Track a sibling promise for tail-eviction so `next`'s consumer
  // sees its real result (success or rejection) without our cleanup
  // accidentally swallowing it.
  const trackable: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (fileMutationQueue.get(key) === trackable) {
      fileMutationQueue.delete(key);
    }
  });
  fileMutationQueue.set(key, trackable);
  return next;
}

/**
 * Test-only helper: snapshot the live queue size. Used by the unit
 * tests to assert "no leak after settle". Production code should not
 * read this — it only exists for verification.
 */
export function _peekFileMutationQueueSizeForTests(): number {
  return fileMutationQueue.size;
}

/**
 * Test-only helper: clear the queue between tests. Production code
 * should never call this — it would orphan in-flight mutations.
 */
export function _resetFileMutationQueueForTests(): void {
  fileMutationQueue.clear();
}
