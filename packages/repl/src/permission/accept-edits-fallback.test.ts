import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { allowsAcceptEditsClassifierFallback } from './accept-edits-fallback.js';

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('allowsAcceptEditsClassifierFallback', () => {
  it('allows an ordinary write inside the workspace', () => {
    const projectRoot = createRoot('kodax-accept-edits-project-');

    expect(allowsAcceptEditsClassifierFallback(
      { id: 'write-1', name: 'write', input: { path: 'docs/report.md' } },
      projectRoot,
      projectRoot,
    )).toBe(true);
  });

  it('requires confirmation for file writes outside the workspace', () => {
    const projectRoot = createRoot('kodax-accept-edits-project-');
    const outsidePath = path.join(os.homedir(), 'kodax-accept-edits-outside', 'report.md');

    expect(allowsAcceptEditsClassifierFallback(
      {
        id: 'write-2',
        name: 'write',
        input: { path: outsidePath },
      },
      projectRoot,
      projectRoot,
    )).toBe(false);
  });

  it('allows safe reads but requires confirmation for shell execution', () => {
    const projectRoot = createRoot('kodax-accept-edits-project-');

    expect(allowsAcceptEditsClassifierFallback(
      { id: 'bash-read', name: 'bash', input: { command: 'git status' } },
      projectRoot,
      projectRoot,
    )).toBe(true);
    expect(allowsAcceptEditsClassifierFallback(
      {
        id: 'bash-run',
        name: 'bash',
        input: { command: 'powershell -File scripts/build.ps1' },
      },
      projectRoot,
      projectRoot,
    )).toBe(false);
  });

  it('keeps the reported PowerShell inspection usable after classifier failure', () => {
    const projectRoot = createRoot('kodax-accept-edits-project-');
    const command = [
      "echo '=== where.exe rg now ==='",
      'where.exe rg 2>&1',
      "echo '=== WinGet Links on PATH? ==='",
      "$env:PATH -split ';' | Where-Object { $_ -like '*WinGet*' }",
      "echo '=== rg version ==='",
      'rg --version 2>&1 | Select-Object -First 2',
    ].join('; ');

    expect(allowsAcceptEditsClassifierFallback(
      { id: 'bash-powershell-read', name: 'bash', input: { command } },
      projectRoot,
      projectRoot,
    )).toBe(true);
    expect(allowsAcceptEditsClassifierFallback(
      {
        id: 'bash-powershell-script',
        name: 'bash',
        input: { command: "& 'C:\\tools\\dsh.cmd' --version" },
      },
      projectRoot,
      projectRoot,
    )).toBe(false);
  });
});
