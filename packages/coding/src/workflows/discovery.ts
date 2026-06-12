/**
 * FEATURE_217 (v0.7.49) Phase E — Saved workflow discovery + loading.
 *
 * Discovers user-authored workflows from `.kodax/workflows/` (project)
 * and `~/.kodax/workflows/` (personal), project winning on name
 * conflict. Loading reuses the proven Self-Construction pattern
 * (`await import(pathToFileURL(...))`, FEATURE_088 load-handler) — no
 * transpiler dependency: `.ts` resolves under a tsx runtime (dev), `.js`
 * / `.mjs` resolve in compiled binaries.
 *
 * SECURITY: loading a saved workflow EXECUTES local code. The REPL gates
 * the first run of any discovered file behind a trusted-local
 * confirmation (Phase D.2 command) — discovery itself only reads paths.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WorkflowModule } from '@kodax-ai/agent';

/** Extensions recognised as workflow modules, in resolution priority. */
const WORKFLOW_EXTENSIONS: readonly string[] = ['.ts', '.mjs', '.js'];

export type SavedWorkflowSource = 'project' | 'personal';

export interface SavedWorkflowRef {
  /** Workflow name = filename without extension. */
  readonly name: string;
  readonly path: string;
  readonly source: SavedWorkflowSource;
}

export interface SavedWorkflowDirs {
  /** `.kodax/workflows` relative to the project root. */
  readonly project?: string;
  /** `~/.kodax/workflows`. */
  readonly personal?: string;
}

async function scanDir(
  dir: string | undefined,
  source: SavedWorkflowSource,
): Promise<SavedWorkflowRef[]> {
  if (!dir) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // missing dir → no saved workflows
  }
  const byName = new Map<string, SavedWorkflowRef>();
  for (const ext of WORKFLOW_EXTENSIONS) {
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      const name = entry.slice(0, -ext.length);
      if (name.length === 0 || byName.has(name)) continue; // higher-priority ext wins
      byName.set(name, { name, path: join(dir, entry), source });
    }
  }
  return [...byName.values()];
}

/**
 * Discover saved workflows across the project + personal dirs. On a name
 * conflict the project copy wins. Result is sorted by name.
 */
export async function discoverSavedWorkflows(
  dirs: SavedWorkflowDirs,
): Promise<SavedWorkflowRef[]> {
  const personal = await scanDir(dirs.personal, 'personal');
  const project = await scanDir(dirs.project, 'project');
  const byName = new Map<string, SavedWorkflowRef>();
  for (const ref of personal) byName.set(ref.name, ref);
  for (const ref of project) byName.set(ref.name, ref); // project overrides personal
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isWorkflowModule(value: unknown): value is WorkflowModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'meta' in value &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  );
}

/**
 * Normalize a loaded module into a `WorkflowModule`. Accepts:
 *   - `export default { meta, run }`
 *   - `export const workflow = {...}` (meta) + `export default <run fn>`
 *   - `export const meta` + `export const run`
 */
export function normalizeWorkflowModule(mod: Record<string, unknown>): WorkflowModule {
  const def = mod.default;
  if (isWorkflowModule(def)) return def;

  const run = typeof def === 'function' ? def : mod.run;
  const meta = mod.workflow ?? mod.meta;
  if (
    typeof run === 'function' &&
    typeof meta === 'object' &&
    meta !== null &&
    'name' in meta
  ) {
    return { meta: meta as WorkflowModule['meta'], run: run as WorkflowModule['run'] };
  }
  throw new Error(
    'invalid workflow module: expected a `{ meta, run }` default export, ' +
      'or `export const workflow = {...}` + a default run function',
  );
}

/** Dynamically import + normalize a saved workflow file. Executes local code. */
export async function loadSavedWorkflow(filePath: string): Promise<WorkflowModule> {
  const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return normalizeWorkflowModule(mod);
}
