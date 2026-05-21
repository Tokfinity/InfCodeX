/**
 * v0.7.35.1 FEATURE_145 — agent-home 3-tier resolution unit tests.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAgentConfigHome,
  getAgentConfigPath,
  getAppDataDir,
  setAgentConfigHome,
} from './agent-home.js';

describe('agent-home — 3-tier resolution', () => {
  const originalEnv = process.env.KODAX_HOME;

  beforeEach(() => {
    setAgentConfigHome(undefined);
    delete process.env.KODAX_HOME;
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    if (originalEnv === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = originalEnv;
    }
  });

  describe('tier 3 — default', () => {
    it('returns ~/.kodax when neither override nor env is set', () => {
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });

    it('getAgentConfigPath joins under the default home', () => {
      expect(getAgentConfigPath('mcp-tokens', 'foo.json')).toBe(
        join(homedir(), '.kodax', 'mcp-tokens', 'foo.json'),
      );
    });

    it('getAgentConfigPath with no segments returns the home dir itself', () => {
      expect(getAgentConfigPath()).toBe(getAgentConfigHome());
    });
  });

  describe('tier 2 — KODAX_HOME env var', () => {
    it('returns the env var value when set', () => {
      process.env.KODAX_HOME = '/tmp/kodax-test-env';
      expect(getAgentConfigHome()).toBe('/tmp/kodax-test-env');
    });

    it('sub-paths are joined under the env value', () => {
      process.env.KODAX_HOME = '/tmp/kodax-test-env';
      expect(getAgentConfigPath('skills', 'foo')).toBe(
        join('/tmp/kodax-test-env', 'skills', 'foo'),
      );
    });

    it('empty env var falls through to default', () => {
      process.env.KODAX_HOME = '';
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });

  describe('tier 1 — programmatic override', () => {
    it('overrides env var', () => {
      process.env.KODAX_HOME = '/tmp/from-env';
      setAgentConfigHome('/tmp/from-override');
      expect(getAgentConfigHome()).toBe('/tmp/from-override');
    });

    it('overrides default', () => {
      setAgentConfigHome('/tmp/from-override');
      expect(getAgentConfigHome()).toBe('/tmp/from-override');
    });

    it('setting to undefined resets to env / default', () => {
      setAgentConfigHome('/tmp/something');
      setAgentConfigHome(undefined);
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });

  describe('priority order — full 3-tier chain', () => {
    it('override > env > default — verifying full chain', () => {
      // Default (no override, no env)
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));

      // Env beats default
      process.env.KODAX_HOME = '/from-env';
      expect(getAgentConfigHome()).toBe('/from-env');

      // Override beats env
      setAgentConfigHome('/from-override');
      expect(getAgentConfigHome()).toBe('/from-override');

      // Reset override → env wins again
      setAgentConfigHome(undefined);
      expect(getAgentConfigHome()).toBe('/from-env');

      // Unset env → default wins again
      delete process.env.KODAX_HOME;
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });
});

describe('getAppDataDir — third-party namespace under ~/.kodax/apps/', () => {
  let tmpHome: string;
  const originalEnv = process.env.KODAX_HOME;

  beforeEach(() => {
    setAgentConfigHome(undefined);
    delete process.env.KODAX_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'kodax-appdata-test-'));
    setAgentConfigHome(tmpHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    if (originalEnv === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = originalEnv;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates ~/.kodax/apps/<appId>/ and returns it', () => {
    const dir = getAppDataDir('space');
    expect(dir).toBe(join(tmpHome, 'apps', 'space'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent — second call on existing dir returns same path', () => {
    const a = getAppDataDir('space');
    const b = getAppDataDir('space');
    expect(a).toBe(b);
  });

  it('accepts valid kebab-case appIds', () => {
    expect(() => getAppDataDir('vs-code-ext')).not.toThrow();
    expect(() => getAppDataDir('a1')).not.toThrow();
    expect(() => getAppDataDir('a'.repeat(32))).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['single char (too short)', 'a'],
    ['too long (33 chars)', 'a'.repeat(33)],
    ['starts with digit', '1space'],
    ['starts with dash', '-space'],
    ['uppercase', 'Space'],
    ['underscore', 'my_app'],
    ['dot', 'my.app'],
    ['slash', 'my/app'],
    ['backslash', 'my\\app'],
    ['traversal', '..'],
    ['nested traversal', 'a/../b'],
    ['space char', 'my app'],
    ['unicode', 'spáce'],
  ])('rejects invalid appId: %s', (_label, appId) => {
    expect(() => getAppDataDir(appId)).toThrow(/invalid appId/);
  });

  it.each([
    ['reserved literal', 'kodax'],
    ['reserved prefix', 'kodax-space'],
    ['reserved prefix-only', 'kodax-'],
  ])('rejects reserved name: %s', (_label, appId) => {
    expect(() => getAppDataDir(appId)).toThrow(/reserved/);
  });

  it('rejects non-string appId', () => {
    // @ts-expect-error — testing runtime validation
    expect(() => getAppDataDir(undefined)).toThrow(/invalid appId/);
    // @ts-expect-error
    expect(() => getAppDataDir(123)).toThrow(/invalid appId/);
    // @ts-expect-error
    expect(() => getAppDataDir(null)).toThrow(/invalid appId/);
  });

  it('honors setAgentConfigHome override (programmatic)', () => {
    const dir = getAppDataDir('myapp');
    expect(dir.startsWith(tmpHome)).toBe(true);
  });
});
