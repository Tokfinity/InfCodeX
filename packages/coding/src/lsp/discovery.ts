/**
 * FEATURE_132 — server-binary discovery utilities (no auto-download here).
 *
 * Two discovery surfaces, matching opencode's cascade step ①:
 *   - `whichGlobal`  → walk `PATH` (PATHEXT-aware on Windows) for a binary.
 *   - `resolveNodePackageBin` → resolve a node CLI's entry script from a
 *     project's `node_modules`, returned as `node <entry>` so we never have
 *     to spawn a `.cmd`/`.ps1` shim (avoids Windows shell-escaping traps).
 *
 * `findNearestRoot` walks up for a project marker, bounded by a stop dir, so
 * a server is rooted at the real project and not the edited file's folder.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { normalizeFsPath } from './paths.js';

const IS_WINDOWS = process.platform === 'win32';

const PATH_EXTENSIONS = IS_WINDOWS
  ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  : [''];

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Find an executable on `PATH`. Returns the absolute path, or undefined. */
export function whichGlobal(command: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of PATH_EXTENSIONS) {
      const alreadyHasExt = ext && command.toLowerCase().endsWith(ext.toLowerCase());
      const candidate = path.join(dir, alreadyHasExt ? command : command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A resolved launch command: program + args (program is usually `node`). */
export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly kind: 'javascript';
}

function requireFrom(root: string): NodeRequire {
  // Seed the require with a path inside the root so resolution searches the
  // project's node_modules first, then walks up — same as a script in root.
  return createRequire(path.join(root, '__kodax_lsp_resolve__.js'));
}

/**
 * Resolve a node-based language-server CLI installed under `root`'s
 * `node_modules`, returned as a `node <entry-script>` launch command.
 * Reads the package's `bin` field to find the real entry; never spawns a
 * platform shim. Returns undefined when the package is not installed.
 */
export function resolveNodePackageBin(
  pkg: string,
  root: string,
  preferredBin?: string,
): LaunchCommand | undefined {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = requireFrom(root).resolve(`${pkg}/package.json`);
  } catch {
    return undefined;
  }
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: unknown }).bin;
  } catch {
    return undefined;
  }
  let entryRel: string | undefined;
  if (typeof bin === 'string') {
    entryRel = bin;
  } else if (bin && typeof bin === 'object') {
    const table = bin as Record<string, string>;
    entryRel = (preferredBin && table[preferredBin]) || table[pkg] || Object.values(table)[0];
  }
  if (!entryRel) return undefined;
  const entry = path.join(path.dirname(pkgJsonPath), entryRel);
  if (!isFile(entry)) return undefined;
  return { command: process.execPath, args: [entry], kind: 'javascript' };
}

/**
 * Resolve the `typescript/lib/tsserver.js` the language server should drive.
 * Prefers the project's own TypeScript (correct version for its diagnostics),
 * falling back to the TypeScript bundled with `@kodax-ai/coding` so the
 * feature still works in projects without a local typescript install.
 */
export function resolveTsserver(root: string, fallbackFromUrl?: string): string | undefined {
  try {
    return requireFrom(root).resolve('typescript/lib/tsserver.js');
  } catch {
    // fall through to bundled
  }
  if (fallbackFromUrl) {
    try {
      return createRequire(fallbackFromUrl).resolve('typescript/lib/tsserver.js');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Walk up from `fromFile`'s directory looking for any of `markers`, stopping
 * at (and including) `stopDir`. Returns the directory containing the nearest
 * marker, or `stopDir` when none is found (a sane project-root default).
 */
export function findNearestRoot(
  fromFile: string,
  markers: readonly string[],
  stopDir: string,
): string {
  const stop = path.resolve(stopDir);
  const stopKey = normalizeFsPath(stop);
  let dir = path.dirname(path.resolve(fromFile));
  // Compare via normalized keys (Windows drive/casing differences between
  // resolved paths would otherwise break the prefix/equality checks); return
  // the original-case directory.
  if (!normalizeFsPath(dir).startsWith(stopKey)) return stop;
  for (;;) {
    for (const marker of markers) {
      if (existsSync(path.join(dir, marker))) return dir;
    }
    if (normalizeFsPath(dir) === stopKey) return stop;
    const parent = path.dirname(dir);
    if (parent === dir) return stop;
    dir = parent;
  }
}
