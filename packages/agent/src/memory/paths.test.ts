/**
 * FEATURE_124 (v0.7.43) — paths.ts unit tests.
 *
 * Covers sanitize collision-safety, no-remote fallback, NFC / lowercase
 * normalization, and isAutoManagedMemoryFile prefix matching.
 *
 * Does NOT exercise the real `git config` call — `tryGitRemote` is
 * tested via the integration path in resolveMemoryRoot only when a
 * real .git/config is present. Tests inject expected sanitize inputs
 * directly via `sanitizeProjectKey` to keep coverage hermetic.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '../runtime/agent-home.js';
import {
  hashCwd,
  isAutoManagedMemoryFile,
  parseMemoryTypeFromFilename,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  sanitizeProjectKey,
} from './paths.js';

describe('sanitizeProjectKey', () => {
  it('strips https:// + .git → host-user-repo', () => {
    expect(sanitizeProjectKey('https://github.com/user/repo.git')).toBe(
      'github.com-user-repo',
    );
  });

  it('strips ssh:// + git@ + .git → same key as HTTPS', () => {
    const httpsKey = sanitizeProjectKey('https://github.com/user/repo.git');
    const sshKey = sanitizeProjectKey('git@github.com:user/repo.git');
    expect(sshKey).toBe(httpsKey);
  });

  it('strips ssh:// protocol prefix', () => {
    expect(sanitizeProjectKey('ssh://git@gitlab.example.com/team/repo')).toBe(
      'gitlab.example.com-team-repo',
    );
  });

  it('lowercases host part', () => {
    expect(sanitizeProjectKey('https://GitHub.com/User/Repo.git')).toBe(
      'github.com-user-repo',
    );
  });

  it('handles missing .git suffix', () => {
    expect(sanitizeProjectKey('https://github.com/user/repo')).toBe(
      'github.com-user-repo',
    );
  });

  it('does not produce leading/trailing dashes', () => {
    const key = sanitizeProjectKey('git@github.com:user/repo.git');
    expect(key.startsWith('-')).toBe(false);
    expect(key.endsWith('-')).toBe(false);
  });
});

describe('hashCwd', () => {
  it('returns 16 hex chars', () => {
    const hash = hashCwd('/Users/foo/repo');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is case-insensitive (Windows + macOS default FS)', () => {
    // Compare cwd absolute paths to avoid divergence on Windows where
    // `path.resolve('/users/foo/repo')` may prepend the drive letter.
    const lower = hashCwd(path.resolve('/users/foo/repo'));
    const upper = hashCwd(path.resolve('/Users/Foo/Repo'));
    expect(lower).toBe(upper);
  });

  it('differs for different cwds', () => {
    const a = hashCwd('/Users/foo/repo-a');
    const b = hashCwd('/Users/foo/repo-b');
    expect(a).not.toBe(b);
  });
});

describe('resolveMemoryRoot / resolveMemoryEntrypoint', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-paths-'));
    setAgentConfigHome(tempHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('uses agent config home from setAgentConfigHome override', () => {
    // cwd has no remote → fallback to local-<hash>
    const root = resolveMemoryRoot(tempHome);
    expect(root.startsWith(tempHome)).toBe(true);
    expect(root.includes('projects')).toBe(true);
    expect(root.endsWith('memory')).toBe(true);
  });

  it('fallback key for no-remote cwd starts with local-', () => {
    const root = resolveMemoryRoot(tempHome);
    const segments = root.split(path.sep);
    const keyIdx = segments.indexOf('projects') + 1;
    expect(segments[keyIdx]).toMatch(/^local-[0-9a-f]{16}$/);
  });

  it('resolveMemoryEntrypoint returns <root>/MEMORY.md', () => {
    const entrypoint = resolveMemoryEntrypoint(tempHome);
    expect(entrypoint.endsWith(path.join('memory', 'MEMORY.md'))).toBe(true);
  });
});

describe('isAutoManagedMemoryFile', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-isfile-'));
    setAgentConfigHome(tempHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns true for memory/*.md under projects/<key>/', () => {
    const memoryFile = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      'feedback_no_mock.md',
    );
    expect(isAutoManagedMemoryFile(memoryFile)).toBe(true);
  });

  it('returns false for non-.md files', () => {
    const non = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      'README.txt',
    );
    expect(isAutoManagedMemoryFile(non)).toBe(false);
  });

  it('returns false for files in projects/<key>/ but not under memory/', () => {
    const sessions = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'sessions',
      'foo.md',
    );
    expect(isAutoManagedMemoryFile(sessions)).toBe(false);
  });

  it('returns false for paths outside agent config home', () => {
    const outside = path.join(os.homedir(), 'unrelated', 'memory', 'x.md');
    expect(isAutoManagedMemoryFile(outside)).toBe(false);
  });

  it('handles path traversal (.. segments) via path.resolve', () => {
    // path.resolve('<home>/projects/<key>/memory/../sessions/x.md')
    // normalizes to '<home>/projects/<key>/sessions/x.md' which is NOT
    // memory.
    const traversal = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      '..',
      'sessions',
      'x.md',
    );
    expect(isAutoManagedMemoryFile(traversal)).toBe(false);
  });
});

describe('parseMemoryTypeFromFilename', () => {
  it('recognizes the 4 type prefixes', () => {
    expect(parseMemoryTypeFromFilename('user_role.md')).toBe('user');
    expect(parseMemoryTypeFromFilename('feedback_no_mock.md')).toBe('feedback');
    expect(parseMemoryTypeFromFilename('project_q2.md')).toBe('project');
    expect(parseMemoryTypeFromFilename('reference_grafana.md')).toBe(
      'reference',
    );
  });

  it('is case-insensitive', () => {
    expect(parseMemoryTypeFromFilename('Feedback_No_Mock.md')).toBe('feedback');
  });

  it('returns undefined for files not matching the convention', () => {
    expect(parseMemoryTypeFromFilename('random.md')).toBeUndefined();
    expect(parseMemoryTypeFromFilename('MEMORY.md')).toBeUndefined();
    expect(parseMemoryTypeFromFilename('my-feedback.md')).toBeUndefined();
  });

  it('accepts bare type-name files (no underscore suffix)', () => {
    expect(parseMemoryTypeFromFilename('user.md')).toBe('user');
  });
});
