/**
 * FEATURE_134 (v0.7.40) — cross-platform clipboard image reader.
 *
 * Reads a binary image from the OS clipboard via platform-specific
 * subprocess invocations:
 *   - macOS:  `osascript` writes clipboard PNG to a temp file
 *   - Windows: `powershell Get-Clipboard -Format Image` → temp PNG
 *   - Linux:   prefer `wl-paste` (Wayland), fall back to `xclip` (X11)
 *
 * Returns the image as a Buffer (caller passes to `normalizePastedImage`).
 * Returns `null` if the clipboard does not contain an image or the
 * platform helper is unavailable. Never throws on the "no image"
 * path — REPL maps `null` to a silent no-op (e.g., user pressed Alt+V
 * with text on the clipboard).
 *
 * Subprocess timeout: 5 seconds. Long-running clipboard helpers usually
 * indicate the user denied access or the helper hangs on missing
 * dependency; both should fail fast rather than block the UI thread.
 *
 * The temp file is always deleted in `finally`, even on error.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIPBOARD_READ_TIMEOUT_MS = 5_000;

export async function readClipboardImage(): Promise<Buffer | null> {
  switch (process.platform) {
    case 'darwin':
      return readMacClipboard();
    case 'win32':
      return readWinClipboard();
    case 'linux':
      return readLinuxClipboard();
    default:
      return null;
  }
}

async function runWithTempPng<T>(
  fn: (tempPngPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kodax-clip-'));
  const pngPath = path.join(dir, 'clip.png');
  try {
    return await fn(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

async function readMacClipboard(): Promise<Buffer | null> {
  return runWithTempPng(async (pngPath) => {
    // AppleScript: write the clipboard's PNG representation to disk, or
    // exit with error if the clipboard does not contain a PNG.
    const script = `set png_data to (the clipboard as «class PNGf»)
set fh to open for access POSIX file "${pngPath.replace(/"/g, '\\"')}" with write permission
write png_data to fh
close access fh`;
    const ok = await runCommand('osascript', ['-e', script]);
    if (!ok) return null;
    try {
      const buf = await readFile(pngPath);
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  });
}

async function readWinClipboard(): Promise<Buffer | null> {
  return runWithTempPng(async (pngPath) => {
    // Use PowerShell `Get-Clipboard -Format Image` and save as PNG.
    // System.Drawing is the .NET Framework path; it's available in
    // Windows PowerShell 5.x (default on Windows 10/11). For PS 7+
    // (pwsh) System.Drawing.Common is platform-specific but Windows
    // ships System.Drawing in the Windows-only build.
    const script = [
      'Add-Type -AssemblyName System.Drawing | Out-Null',
      '$img = Get-Clipboard -Format Image',
      'if ($null -eq $img) { exit 1 }',
      `$img.Save('${pngPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join('; ');
    const ok = await runCommand('powershell', ['-NoProfile', '-Command', script]);
    if (!ok) return null;
    try {
      const buf = await readFile(pngPath);
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  });
}

async function readLinuxClipboard(): Promise<Buffer | null> {
  // Wayland first (most modern desktops).
  const wlBuf = await readLinuxWaylandClipboard();
  if (wlBuf) return wlBuf;
  // X11 fallback.
  return readLinuxX11Clipboard();
}

async function readLinuxWaylandClipboard(): Promise<Buffer | null> {
  return collectStdoutBytes('wl-paste', ['--type', 'image/png']);
}

async function readLinuxX11Clipboard(): Promise<Buffer | null> {
  return collectStdoutBytes('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
}

/**
 * Run a command, returning true on exit code 0. Discards stdout/stderr.
 * Used for write-to-tempfile flows (macOS / Windows).
 */
function runCommand(cmd: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args as string[], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, CLIPBOARD_READ_TIMEOUT_MS);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Run a command and collect its stdout as a Buffer. Used for direct
 * binary stdout flows (Linux wl-paste / xclip).
 */
function collectStdoutBytes(cmd: string, args: readonly string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, CLIPBOARD_READ_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(buf.length > 0 ? buf : null);
    });
  });
}
