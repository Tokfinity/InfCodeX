import { readdir, readFile, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import { join } from 'path';

import type { SkillConsumerImpact } from './types.js';

const MAX_SCAN_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo']);
const TEXT_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
]);

export interface SkillConsumerImpactScanInput {
  readonly skillName: string;
  readonly workflowCapsuleDirs?: readonly string[];
  readonly savedWorkflowDirs?: readonly string[];
  readonly constructedAgentDirs?: readonly string[];
  readonly promptReferenceDirs?: readonly string[];
}

function extensionOf(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  return index >= 0 ? filePath.slice(index).toLowerCase() : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasSkillReference(body: string, skillName: string): boolean {
  const escaped = escapeRegExp(skillName);
  const pattern = new RegExp(
    `(^|[^a-zA-Z0-9_-])(?:/skill:|skill:|skills?["'\\s:\\[]+)?${escaped}([^a-zA-Z0-9_-]|$)`,
    'i',
  );
  return pattern.test(body);
}

async function scanFile(filePath: string, skillName: string): Promise<boolean> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_SCAN_FILE_BYTES || !TEXT_EXTENSIONS.has(extensionOf(filePath))) {
    return false;
  }
  const body = await readFile(filePath, 'utf8');
  return hasSkillReference(body, skillName);
}

async function scanDir(dir: string, skillName: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        matches.push(...await scanDir(entryPath, skillName));
      }
      continue;
    }
    if (entry.isFile() && await scanFile(entryPath, skillName)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function scanDirs(dirs: readonly string[] | undefined, skillName: string): Promise<readonly string[]> {
  if (!dirs || dirs.length === 0) {
    return [];
  }
  const all: string[] = [];
  for (const dir of dirs) {
    all.push(...await scanDir(dir, skillName));
  }
  return Array.from(new Set(all)).sort();
}

export async function computeSkillConsumerImpact(
  input: SkillConsumerImpactScanInput,
): Promise<SkillConsumerImpact> {
  const workflowCapsules = await scanDirs(input.workflowCapsuleDirs, input.skillName);
  const savedWorkflows = await scanDirs(input.savedWorkflowDirs, input.skillName);
  const constructedAgents = await scanDirs(input.constructedAgentDirs, input.skillName);
  const promptReferences = await scanDirs(input.promptReferenceDirs, input.skillName);
  const hasReferences =
    workflowCapsules.length > 0
    || savedWorkflows.length > 0
    || constructedAgents.length > 0
    || promptReferences.length > 0;

  return {
    workflowCapsules,
    savedWorkflows,
    constructedAgents,
    promptReferences,
    action: hasReferences ? 'block_until_manual_review' : 'none',
  };
}
