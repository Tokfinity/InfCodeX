import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { MemoryItemRef } from './types.js';

/** Unambiguous user/SDK handle for a mutable Memory item. */
export function memoryMutationHandle(ref: MemoryItemRef): string {
  if (ref.kind !== 'memdir' || ref.storageUri === undefined) return ref.id;
  const windows = process.platform === 'win32';
  const storageKey = windows ? ref.storageUri.toLowerCase() : ref.storageUri;
  const filename = windows ? basename(ref.storageUri).toLowerCase() : basename(ref.storageUri);
  const scopeKey = createHash('sha256').update(storageKey).digest('hex').slice(0, 12);
  return `memdir:${ref.scope}:${scopeKey}:${filename}`;
}

export function matchesMemoryMutationHandle(ref: MemoryItemRef, handle: string): boolean {
  return ref.id === handle || memoryMutationHandle(ref) === handle;
}
