import path from 'path';
import { access, readdir, realpath, stat } from 'fs/promises';
import { constants } from 'fs';
import { getAgentConfigHome } from '@kodax-ai/agent';

const EXTENSION_MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

interface ExtensionDirectoryEntry {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

export type ExtensionDiscoverySkipReason =
  | 'unsupported_module'
  | 'missing_entrypoint'
  | 'unsupported_target';

export interface SkippedExtensionDiscoveryEntry {
  path: string;
  reason: ExtensionDiscoverySkipReason;
  message: string;
}

export interface ExtensionDiscoveryResult {
  paths: string[];
  skipped: SkippedExtensionDiscoveryEntry[];
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

async function tryResolveDiscoveredEntrypoint(candidate: string): Promise<string | undefined> {
  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) {
      return isSupportedExtensionModulePath(candidate)
        ? path.resolve(candidate)
        : undefined;
    }
    if (candidateStat.isDirectory()) {
      return tryResolveDirectoryEntrypoint(candidate);
    }
    return undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function canonicalEntrypointIdentity(entrypoint: string): Promise<string> {
  try {
    return await realpath(entrypoint);
  } catch (error) {
    // If realpath cannot canonicalize the target, keep a deterministic path
    // identity and let the later load step surface the actionable diagnostic.
    void error;
    return path.resolve(entrypoint);
  }
}

async function getExtensionEntrypointIdentity(extensionPath: string): Promise<string> {
  const normalized = extensionPath.trim();
  try {
    return await canonicalEntrypointIdentity(await resolveExtensionEntrypoint(normalized));
  } catch (error) {
    // Identity calculation must not consume load diagnostics; invalid paths
    // still flow to KodaXExtensionRuntime.loadExtension and fail there.
    void error;
    return path.resolve(normalized);
  }
}

export async function dedupeExtensionPathsByEntrypoint(paths: string[]): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const identity = await getExtensionEntrypointIdentity(normalized);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    result.push(normalized);
  }
  return result;
}

export async function excludeExtensionPathsByEntrypoint(
  paths: string[],
  blockedPaths: string[],
): Promise<string[]> {
  const blocked = new Set<string>();
  for (const value of blockedPaths) {
    const normalized = value.trim();
    if (normalized) {
      blocked.add(await getExtensionEntrypointIdentity(normalized));
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const identity = await getExtensionEntrypointIdentity(normalized);
    if (blocked.has(identity) || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    result.push(normalized);
  }
  return result;
}

function skippedEntry(
  candidate: string,
  reason: ExtensionDiscoverySkipReason,
  message: string,
): SkippedExtensionDiscoveryEntry {
  return { path: candidate, reason, message };
}

export async function discoverExtensionsInDirectoryDetailed(
  directory: string,
): Promise<ExtensionDiscoveryResult> {
  const resolvedDirectory = path.resolve(directory);
  let entries: ExtensionDirectoryEntry[];
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true }) as ExtensionDirectoryEntry[];
  } catch (error) {
    if (isMissingPathError(error)) {
      return { paths: [], skipped: [] };
    }
    throw error;
  }

  const paths: string[] = [];
  const skipped: SkippedExtensionDiscoveryEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(resolvedDirectory, entry.name);
    if (entry.isFile()) {
      if (isSupportedExtensionModulePath(candidate)) {
        paths.push(candidate);
      } else {
        skipped.push(skippedEntry(
          candidate,
          'unsupported_module',
          'File extension is not supported for KodaX runtime extensions.',
        ));
      }
      continue;
    }
    if (entry.isDirectory()) {
      const entrypoint = await tryResolveDirectoryEntrypoint(candidate);
      if (entrypoint) {
        paths.push(entrypoint);
      } else {
        skipped.push(skippedEntry(
          candidate,
          'missing_entrypoint',
          `Directory does not contain one of: ${EXTENSION_ENTRY_FILENAMES.join(', ')}.`,
        ));
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      const entrypoint = await tryResolveDiscoveredEntrypoint(candidate);
      if (entrypoint) {
        paths.push(entrypoint);
      } else {
        skipped.push(skippedEntry(
          candidate,
          'unsupported_target',
          'Symlink target is not a supported extension file or package directory.',
        ));
      }
    }
  }

  return { paths, skipped };
}

export async function discoverExtensionsInDirectory(directory: string): Promise<string[]> {
  return (await discoverExtensionsInDirectoryDetailed(directory)).paths;
}

export async function discoverDefaultExtensions(): Promise<string[]> {
  return discoverExtensionsInDirectory(getDefaultExtensionDirectory());
}
