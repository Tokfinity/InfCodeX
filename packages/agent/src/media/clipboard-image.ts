import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KodaXMediaError } from './errors.js';
import {
  normalizePastedImage,
  type NormalizedImage,
  type NormalizeImageOptions,
} from './image-normalize.js';

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
      throw new KodaXMediaError(
        'UNSUPPORTED_PLATFORM',
        `Clipboard image fallback is not supported on platform "${process.platform}".`,
      );
  }
}

export async function readAndNormalizeClipboardImage(
  options: NormalizeImageOptions = {},
): Promise<NormalizedImage | null> {
  const buffer = await readClipboardImage();
  return buffer ? normalizePastedImage(buffer, options) : null;
}

async function runWithTempPng<T>(
  fn: (tempPngPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kodax-clip-'));
  const pngPath = path.join(dir, 'clip.png');
  try {
    return await fn(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      void error;
      // Best-effort cleanup; the temp file no longer matters after the read.
    });
  }
}

async function readMacClipboard(): Promise<Buffer | null> {
  return runWithTempPng(async (pngPath) => {
    const script = `set png_data to (the clipboard as «class PNGf»)
set fh to open for access POSIX file "${pngPath.replace(/"/g, '\\"')}" with write permission
write png_data to fh
close access fh`;
    const ok = await runCommand('osascript', ['-e', script]);
    if (!ok) return null;
    return readNonEmptyFile(pngPath);
  });
}

async function readWinClipboard(): Promise<Buffer | null> {
  return runWithTempPng(async (pngPath) => {
    const script = [
      'Add-Type -AssemblyName System.Drawing | Out-Null',
      '$img = Get-Clipboard -Format Image',
      'if ($null -eq $img) { exit 1 }',
      `$img.Save('${pngPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join('; ');
    const ok = await runCommand('powershell', ['-NoProfile', '-Command', script]);
    if (!ok) return null;
    return readNonEmptyFile(pngPath);
  });
}

async function readLinuxClipboard(): Promise<Buffer | null> {
  return (await collectStdoutBytes('wl-paste', ['--type', 'image/png']))
    ?? collectStdoutBytes('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
}

async function readNonEmptyFile(filePath: string): Promise<Buffer | null> {
  try {
    const buffer = await readFile(filePath);
    return buffer.length > 0 ? buffer : null;
  } catch (error) {
    void error;
    // The temp writer failed or produced no file; callers treat this as no clipboard image.
    return null;
  }
}

function runCommand(cmd: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, [...args], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
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

function collectStdoutBytes(cmd: string, args: readonly string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
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
      const buffer = Buffer.concat(chunks);
      resolve(buffer.length > 0 ? buffer : null);
    });
  });
}
