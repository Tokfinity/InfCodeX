import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import {
  getDirectShellBypassBlockReason,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isBashWriteCommand,
  isCommandOnProtectedPath,
  isPlanModeAllowedPath,
} from './permission.js';

const createdRoots: string[] = [];

function createProjectRoot(): string {
  const root = createTempDirSync('kodax-plan-mode-', process.cwd());
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    removeTempDirSync(root);
  }
});

describe('plan mode writable path whitelist', () => {
  it('allows writes to the project plan mode document', () => {
    const projectRoot = createProjectRoot();

    expect(isPlanModeAllowedPath('.agent/plan_mode_doc.md', projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: '.agent/plan_mode_doc.md' }, projectRoot)).toBeNull();
    expect(
      getPlanModeBlockReason(
        'edit',
        { path: path.join(projectRoot, '.agent', 'plan_mode_doc.md') },
        projectRoot
      )
    ).toBeNull();
  });

  it('allows writes in the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(isPlanModeAllowedPath(tempFile, projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: tempFile }, projectRoot)).toBeNull();
  });

  it('blocks other workspace files and other .agent files', () => {
    const projectRoot = createProjectRoot();

    expect(getPlanModeBlockReason('write', { path: 'README.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
    expect(getPlanModeBlockReason('edit', { path: '.agent/other.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
  });

  it('allows bash writes only when every target stays in the whitelist', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > .agent/plan_mode_doc.md' }, projectRoot)
    ).toBeNull();
    expect(
      getPlanModeBlockReason('bash', { command: `echo hi > "${tempFile}"` }, projectRoot)
    ).toBeNull();
  });

  it('blocks bash writes outside the whitelist or without a safe target', () => {
    const projectRoot = createProjectRoot();

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > README.md' }, projectRoot)
    ).toContain('Blocked target: README.md');
    expect(
      getPlanModeBlockReason('bash', { command: 'mkdir scratch-output' }, projectRoot)
    ).toContain('Could not determine a safe target');
  });
});

describe('isAlwaysConfirmPath — system temp as safe scratchpad', () => {
  it('does NOT require confirmation for paths inside the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-test-${Date.now()}.txt`);
    expect(isAlwaysConfirmPath(tempFile, projectRoot)).toBe(false);
  });

  it('does NOT require confirmation for paths inside the project root', () => {
    const projectRoot = createProjectRoot();
    const projectFile = path.join(projectRoot, 'src', 'example.ts');
    expect(isAlwaysConfirmPath(projectFile, projectRoot)).toBe(false);
  });

  it('DOES require confirmation for paths outside both project and system temp', () => {
    const projectRoot = createProjectRoot();
    const homeFile = path.join(os.homedir(), 'Documents', 'other-project-file.ts');
    expect(isAlwaysConfirmPath(homeFile, projectRoot)).toBe(true);
  });

  it('DOES require confirmation for .kodax/ project config even inside project root', () => {
    const projectRoot = createProjectRoot();
    const kodaxFile = path.join(projectRoot, '.kodax', 'config.json');
    expect(isAlwaysConfirmPath(kodaxFile, projectRoot)).toBe(true);
  });

  it('DOES require confirmation for ~/.kodax user config', () => {
    const projectRoot = createProjectRoot();
    const userKodaxFile = path.join(os.homedir(), '.kodax', 'auth.json');
    expect(isAlwaysConfirmPath(userKodaxFile, projectRoot)).toBe(true);
  });

  it('bash commands writing to system temp are not flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-bash-${Date.now()}.txt`);
    // extractPathsFromCommand needs patterns it recognizes — use absolute path in arg
    expect(isCommandOnProtectedPath(`echo hi > "${tempFile}"`, projectRoot)).toBe(false);
  });

  it('bash commands writing outside project+temp are still flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const outsideFile = path.join(os.homedir(), 'Documents', 'unrelated.txt');
    expect(isCommandOnProtectedPath(`echo hi > "${outsideFile}"`, projectRoot)).toBe(true);
  });
});

describe('direct shell syntax guardrails', () => {
  it('allows safe read-only exploration commands', () => {
    expect(getDirectShellBypassBlockReason('git status --short')).toBeNull();
    expect(getDirectShellBypassBlockReason('cd src && pwd')).toBeNull();
  });

  it('blocks write or shell-chaining commands outside the safe whitelist', () => {
    expect(getDirectShellBypassBlockReason('npm install')).toContain('safe read-only commands');
    expect(getDirectShellBypassBlockReason('echo hi > out.txt')).toContain('safe read-only commands');
  });
});

// Issue 129: pure read-only commands containing 2>NUL / 2>/dev/null fd-redirects,
// pipes between safe-read stages, or Windows-native search tools were misclassified
// as "Modify files" and forced confirmation in auto mode.
describe('isBashWriteCommand — fd-redirect to null device is not a write (Issue 129)', () => {
  it('does not flag stderr-discard 2>NUL (Windows null device)', () => {
    expect(isBashWriteCommand('findstr foo bar 2>NUL')).toBe(false);
    expect(isBashWriteCommand('findstr foo bar 2>nul')).toBe(false);
  });

  it('does not flag stderr-discard 2>/dev/null (POSIX null device)', () => {
    expect(isBashWriteCommand('ls 2>/dev/null')).toBe(false);
    expect(isBashWriteCommand('grep foo file 2>>/dev/null')).toBe(false);
  });

  it('does not flag combined-stream discard &>/dev/null', () => {
    expect(isBashWriteCommand('grep foo bar &>/dev/null')).toBe(false);
  });

  it('still flags real file writes (regression guard)', () => {
    expect(isBashWriteCommand('echo hi > out.txt')).toBe(true);
    expect(isBashWriteCommand('echo hi >> out.txt')).toBe(true);
    expect(isBashWriteCommand('cat foo > /tmp/x')).toBe(true);
  });

  it('still flags real writes that also contain a null-device redirect', () => {
    // 2>NUL stripped, but the > out.txt write must still be detected.
    expect(isBashWriteCommand('cmd 2>NUL > out.txt')).toBe(true);
  });
});

describe('isBashReadCommand — Windows search tools and pipe chains (Issue 129)', () => {
  it('treats findstr as a safe read command', () => {
    expect(isBashReadCommand('findstr foo file.txt')).toBe(true);
  });

  it('treats fc and where as safe read commands', () => {
    expect(isBashReadCommand('fc a.txt b.txt')).toBe(true);
    expect(isBashReadCommand('where node')).toBe(true);
  });

  it('allows pipe chains where every stage is a safe-read command', () => {
    expect(isBashReadCommand('findstr foo a.txt | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file | grep bar | wc -l')).toBe(true);
  });

  it('allows null-device fd-redirects inside read chains', () => {
    expect(isBashReadCommand('findstr foo a.txt 2>NUL | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file 2>/dev/null')).toBe(true);
  });

  it('allows the original Issue 129 reproduction command', () => {
    expect(
      isBashReadCommand(
        'cd C:\\Works\\claudecode && findstr /S /I /N "todos" src\\bootstrap\\state.ts 2>NUL | findstr /V "node_modules"',
      ),
    ).toBe(true);
  });

  it('rejects pipe chains where any stage is a write command (regression guard)', () => {
    expect(isBashReadCommand('ls | rm -rf /')).toBe(false);
    expect(isBashReadCommand('cat file | tee out.txt')).toBe(false);
  });

  it('rejects redirects to real files even with a read-only base command', () => {
    expect(isBashReadCommand('grep foo file > out.txt')).toBe(false);
  });
});
