import path from 'path';
import { access, readdir, stat } from 'fs/promises';
import { constants } from 'fs';
import { getAgentConfigHome } from '@kodax-ai/agent';

const EXTENSION_MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

interface ExtensionDirectoryEntry {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
}

const EXTENSION_ENTRY_FILENAMES = [
  'extension.mjs',
  'extension.js',
  'extension.cjs',
  'extension.mts',
  'extension.ts',
  'extension.cts',
  'index.mjs',
  'index.js',
  'index.cjs',
  'index.mts',
  'index.ts',
  'index.cts',
] as const;

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return false;
    }
    await access(filePath, constants.R_OK);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

export function isSupportedExtensionModulePath(filePath: string): boolean {
  return EXTENSION_MODULE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getDefaultExtensionDirectory(configHome = getAgentConfigHome()): string {
  return path.join(configHome, 'extensions');
}

export async function resolveExtensionEntrypoint(extensionPath: string): Promise<string> {
  const resolvedPath = path.resolve(extensionPath);
  const entryStat = await stat(resolvedPath);

  if (entryStat.isFile()) {
    if (!isSupportedExtensionModulePath(resolvedPath)) {
      throw new Error(
        `Unsupported extension module "${resolvedPath}". Expected one of: ${[...EXTENSION_MODULE_EXTENSIONS].join(', ')}.`,
      );
    }
    return resolvedPath;
  }

  if (!entryStat.isDirectory()) {
    throw new Error(`Extension path "${resolvedPath}" must be a file or directory.`);
  }

  for (const filename of EXTENSION_ENTRY_FILENAMES) {
    const candidate = path.join(resolvedPath, filename);
    if (await isReadableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Extension directory "${resolvedPath}" must contain one of: ${EXTENSION_ENTRY_FILENAMES.join(', ')}.`,
  );
}

async function tryResolveDirectoryEntrypoint(directoryPath: string): Promise<string | undefined> {
  for (const filename of EXTENSION_ENTRY_FILENAMES) {
    const candidate = path.join(directoryPath, filename);
    if (await isReadableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function discoverExtensionsInDirectory(directory: string): Promise<string[]> {
  const resolvedDirectory = path.resolve(directory);
  let entries: ExtensionDirectoryEntry[];
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true }) as ExtensionDirectoryEntry[];
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const discovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(resolvedDirectory, entry.name);
    if (entry.isFile() && isSupportedExtensionModulePath(candidate)) {
      discovered.push(candidate);
      continue;
    }
    if (entry.isDirectory()) {
      const entrypoint = await tryResolveDirectoryEntrypoint(candidate);
      if (entrypoint) {
        discovered.push(entrypoint);
      }
    }
  }

  return discovered;
}

export async function discoverDefaultExtensions(): Promise<string[]> {
  return discoverExtensionsInDirectory(getDefaultExtensionDirectory());
}
