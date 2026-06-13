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

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createRestrictedWorkflowModule,
  validateWorkflowScriptManifest,
  type WorkflowModule,
  type WorkflowScriptManifest,
} from '@kodax-ai/agent';

/** Extensions recognised as workflow modules, in resolution priority. */
const WORKFLOW_SUFFIXES: readonly string[] = ['.workflow.json', '.ts', '.mjs', '.js'];

export type SavedWorkflowSource = 'project' | 'personal';
export type SavedWorkflowExecution = 'trusted-local' | 'capability-generated';

export interface SavedWorkflowRef {
  /** Workflow name = filename without extension. */
  readonly name: string;
  readonly path: string;
  readonly source: SavedWorkflowSource;
  readonly execution: SavedWorkflowExecution;
}

export interface SavedWorkflowDirs {
  /** `.kodax/workflows` relative to the project root. */
  readonly project?: string;
  /** `~/.kodax/workflows`. */
  readonly personal?: string;
}

export interface SavedGeneratedWorkflowFile {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
}

export interface SaveGeneratedWorkflowInput {
  readonly dir: string;
  readonly name: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
}

export interface SaveGeneratedWorkflowFromRunInput {
  readonly runDir: string;
  readonly targetDir: string;
  readonly name: string;
}

function executionForPath(path: string): SavedWorkflowExecution {
  return path.endsWith('.workflow.json') ? 'capability-generated' : 'trusted-local';
}

function stripWorkflowSuffix(entry: string): string | undefined {
  const suffix = WORKFLOW_SUFFIXES.find((candidate) => entry.endsWith(candidate));
  return suffix ? entry.slice(0, -suffix.length) : undefined;
}

function safeWorkflowName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('workflow name must contain at least one safe filename character');
  }
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`workflow run.json missing ${key}`);
  }
  return value;
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
  for (const suffix of WORKFLOW_SUFFIXES) {
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const name = stripWorkflowSuffix(entry);
      if (!name) continue;
      if (name.length === 0 || byName.has(name)) continue; // higher-priority ext wins
      const path = join(dir, entry);
      byName.set(name, { name, path, source, execution: executionForPath(path) });
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

function parseGeneratedWorkflowFile(raw: string): SavedGeneratedWorkflowFile {
  const data = JSON.parse(raw) as unknown;
  if (!isRecord(data)) {
    throw new Error('generated workflow file must be an object');
  }
  const source = data.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('generated workflow file source must be a non-empty string');
  }
  return {
    manifest: validateWorkflowScriptManifest(data.manifest),
    source,
  };
}

/** Dynamically import + normalize a saved workflow file. Executes local code. */
export async function loadSavedWorkflow(filePath: string): Promise<WorkflowModule> {
  if (filePath.endsWith('.workflow.json')) {
    const generated = parseGeneratedWorkflowFile(await readFile(filePath, 'utf8'));
    return createRestrictedWorkflowModule({
      manifest: generated.manifest,
      source: generated.source,
    });
  }
  const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return normalizeWorkflowModule(mod);
}

export async function saveGeneratedWorkflow(
  input: SaveGeneratedWorkflowInput,
): Promise<SavedWorkflowRef> {
  const safeName = safeWorkflowName(input.name);
  const manifest = validateWorkflowScriptManifest(input.manifest);
  await mkdir(input.dir, { recursive: true });
  const path = join(input.dir, `${safeName}.workflow.json`);
  await writeFile(
    path,
    `${JSON.stringify({ manifest, source: input.source }, null, 2)}\n`,
    'utf8',
  );
  return {
    name: safeName,
    path,
    source: 'project',
    execution: 'capability-generated',
  };
}

export async function saveGeneratedWorkflowFromRun(
  input: SaveGeneratedWorkflowFromRunInput,
): Promise<SavedWorkflowRef> {
  const runRaw = JSON.parse(await readFile(join(input.runDir, 'run.json'), 'utf8')) as unknown;
  if (!isRecord(runRaw)) {
    throw new Error('workflow run.json must be an object');
  }
  const scriptPath = readRequiredString(runRaw, 'scriptSnapshotPath');
  const manifestPath = readRequiredString(runRaw, 'manifestSnapshotPath');
  const source = await readFile(scriptPath, 'utf8');
  const manifest = validateWorkflowScriptManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
  return saveGeneratedWorkflow({
    dir: input.targetDir,
    name: input.name,
    manifest,
    source,
  });
}
