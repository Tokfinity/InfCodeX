/**
 * FEATURE_132 — cross-platform process spawn for language servers / installers.
 *
 * Centralizes the Windows shell decision so callers don't repeat it:
 *   - `node` (process.execPath) and native `.exe` binaries spawn directly.
 *   - A Windows `.cmd`/`.bat` shim (or a bare name like `go`) needs a shell.
 *
 * When a shell is needed we pass a SINGLE quoted command string (not a
 * shell + args array) — that avoids Node's DEP0190 warning and quotes the
 * program path for spaces. The args are fixed KodaX constants (`--stdio`,
 * `install …`) with no shell metacharacters, so concatenation is safe.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

export function needsShell(command: string): boolean {
  return process.platform === 'win32' && command !== process.execPath && !/\.exe$/i.test(command);
}

export function spawnLspProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (needsShell(command)) {
    const line = [quoteIfNeeded(command), ...args].join(' ');
    return spawn(line, { ...options, shell: true });
  }
  return spawn(command, [...args], { ...options, shell: false });
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
