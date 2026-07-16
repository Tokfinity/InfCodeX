/**
 * FEATURE_208 (v0.7.45) — process hardening tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

import {
  applyProcessHardening,
  prepareInternalNodeLaunch,
  stripHardenedEnvVars,
  ELECTRON_RUN_AS_NODE_ENV,
  HARDENED_ENV_VARS,
  HARDENING_OPT_OUT_ENV,
} from './process-hardening.js';

describe('process hardening', () => {
  beforeEach(() => {
    for (const name of HARDENED_ENV_VARS) delete process.env[name];
    delete process.env[ELECTRON_RUN_AS_NODE_ENV];
    delete process.env[HARDENING_OPT_OUT_ENV];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const name of HARDENED_ENV_VARS) delete process.env[name];
    delete process.env[ELECTRON_RUN_AS_NODE_ENV];
    delete process.env[HARDENING_OPT_OUT_ENV];
  });

  describe('applyProcessHardening', () => {
    it('removes every dynamic-linker preload var from process.env', () => {
      for (const name of HARDENED_ENV_VARS) process.env[name] = '/tmp/evil.so';

      applyProcessHardening();

      for (const name of HARDENED_ENV_VARS) {
        expect(process.env[name]).toBeUndefined();
      }
    });

    it('does not touch unrelated env vars', () => {
      process.env.LD_PRELOAD = '/tmp/evil.so';
      vi.stubEnv('KODAX_KEEP_ME', 'keep');

      applyProcessHardening();

      expect(process.env.LD_PRELOAD).toBeUndefined();
      expect(process.env.KODAX_KEEP_ME).toBe('keep');
    });

    it('is a no-op when KODAX_DISABLE_HARDENING=1', () => {
      process.env[HARDENING_OPT_OUT_ENV] = '1';
      process.env.LD_PRELOAD = '/tmp/evil.so';

      applyProcessHardening();

      expect(process.env.LD_PRELOAD).toBe('/tmp/evil.so');
    });

    it('always removes the Electron bootstrap variable, including when optional hardening is disabled', () => {
      process.env[HARDENING_OPT_OUT_ENV] = '1';
      process.env[ELECTRON_RUN_AS_NODE_ENV] = '1';

      applyProcessHardening();

      expect(process.env[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined();
    });
  });

  describe('prepareInternalNodeLaunch', () => {
    it('limits Electron Node mode to the exec boundary and scrubs it before target code runs', () => {
      const parentEnv: NodeJS.ProcessEnv = {
        ELECTRON_RUN_AS_NODE: 'parent-value',
        KODAX_SENTINEL: 'preserved',
      };
      const launch = prepareInternalNodeLaunch({
        args: [
          '--eval',
          `process.stdout.write(process.env.${ELECTRON_RUN_AS_NODE_ENV} ?? 'absent')`,
        ],
        env: parentEnv,
        isElectron: true,
      });

      expect(launch.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: '1',
        KODAX_SENTINEL: 'preserved',
      });
      expect(launch.args.slice(0, 2)).toEqual([
        '--import',
        expect.stringMatching(/^data:text\/javascript,/),
      ]);
      expect(parentEnv.ELECTRON_RUN_AS_NODE).toBe('parent-value');
      expect(execFileSync(process.execPath, launch.args, {
        env: launch.env,
        encoding: 'utf8',
      })).toBe('absent');
    });

    it('keeps ordinary Node arguments unchanged and removes a stale bootstrap variable', () => {
      const args = ['--version'];

      const launch = prepareInternalNodeLaunch({
        args,
        env: { ELECTRON_RUN_AS_NODE: '1', KODAX_SENTINEL: 'preserved' },
        isElectron: false,
      });

      expect(launch.args).toEqual(args);
      expect(launch.args).not.toBe(args);
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(launch.env.KODAX_SENTINEL).toBe('preserved');
    });
  });

  describe('stripHardenedEnvVars', () => {
    it('returns a new env object without the preload vars', () => {
      const input = {
        LD_PRELOAD: '/tmp/evil.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        PATH: '/usr/bin',
      };

      const out = stripHardenedEnvVars(input);

      expect(out).not.toBe(input); // new object — input not mutated
      expect(input.LD_PRELOAD).toBe('/tmp/evil.so'); // immutable
      expect(out.LD_PRELOAD).toBeUndefined();
      expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(out.PATH).toBe('/usr/bin');
    });

    it('returns the input unchanged when hardening is disabled', () => {
      process.env[HARDENING_OPT_OUT_ENV] = '1';
      const input = { LD_PRELOAD: '/tmp/evil.so' };

      const out = stripHardenedEnvVars(input);

      expect(out).toBe(input);
      expect(out.LD_PRELOAD).toBe('/tmp/evil.so');
    });
  });
});
