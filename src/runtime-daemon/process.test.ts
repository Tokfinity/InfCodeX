import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertRuntimeDaemonCliEntryAvailable,
  createRuntimeDaemonServeEnvironment,
} from './process.js';

describe('runtime daemon child process environment', () => {
  it('enables Node execution only for the spawned Electron daemon child', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '0',
      KODAX_HOME: 'parent-config-home',
      PARENT_SENTINEL: 'preserved',
    };

    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: 'runtime-home',
      parentEnv,
      isElectron: true,
    });

    expect(childEnv).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      KODAX_DAEMON_SERVE: '1',
      KODAX_HOME: path.join('runtime-home', '.kodax'),
      PARENT_SENTINEL: 'preserved',
    });
    expect(parentEnv).toEqual({
      ELECTRON_RUN_AS_NODE: '0',
      KODAX_HOME: 'parent-config-home',
      PARENT_SENTINEL: 'preserved',
    });
  });

  it('preserves the ordinary Node child environment contract', () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: 'runtime-home',
      parentEnv: { PARENT_SENTINEL: 'preserved' },
      isElectron: false,
    });

    expect(childEnv).toMatchObject({
      KODAX_DAEMON_SERVE: '1',
      KODAX_HOME: path.join('runtime-home', '.kodax'),
      PARENT_SENTINEL: 'preserved',
    });
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('fails before spawning when an embedder bundle omitted the daemon CLI sidecar', () => {
    const missingEntry = path.join('missing-kodax-package', 'dist', 'kodax_cli.js');

    expect(() => assertRuntimeDaemonCliEntryAvailable(undefined)).not.toThrow();
    expect(() => assertRuntimeDaemonCliEntryAvailable(missingEntry)).toThrow(
      /Keep the published KodaX dist files external/,
    );
  });
});
