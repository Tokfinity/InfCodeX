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
import { prepareJavaScriptChildLaunch } from '@kodax-ai/agent';

export type LspProcessKind = 'native' | 'javascript';

export function needsShell(command: string): boolean {
  return process.platform === 'win32' && command !== process.execPath && !/\.exe$/i.test(command);
}

export function spawnLspProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  kind: LspProcessKind = command === process.execPath ? 'javascript' : 'native',
): ChildProcess {
  if (needsShell(command)) {
    const line = [quoteIfNeeded(command), ...args].join(' ');
    return spawn(line, { ...options, shell: true, windowsHide: true });
  }
  if (kind === 'javascript') {
    const launch = prepareJavaScriptChildLaunch({
      args,
      env: options.env ?? process.env,
      isElectron: process.versions.electron !== undefined,
      executable: command,
    });
    return spawn(launch.command, launch.args, {
      ...options,
      env: launch.env,
      shell: false,
      windowsHide: true,
    });
  }
  return spawn(command, [...args], { ...options, shell: false, windowsHide: true });
}

function quoteIfNeeded(value: string): string {
  // Windows filenames cannot contain `"` (it's illegal), so a resolved binary
  // path never has one — but escape cmd-style (`"` → `""`) defensively so the
  // quoted command line is well-formed for any input. Quote on whitespace or quote.
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
