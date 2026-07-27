import { describe, expect, it } from 'vitest';

import {
  normalizeShellExecutionContract,
  shellExecutionContractFingerprint,
} from './contract.js';

describe('shell execution contract', () => {
  it('normalizes a JSON contract without adding dynamic host state', () => {
    const contract = normalizeShellExecutionContract({
      version: 1,
      shell: {
        kind: 'bash',
        executable: '/bin/bash',
        args: ['--posix'],
        profile: 'login',
      },
      environment: {
        inherit: 'filtered',
        set: { KODAX_TOOLCHAIN: 'project' },
        denyPatterns: ['PRIVATE_*'],
        setup: 'export PATH="/toolchain/bin:$PATH"',
      },
      cache: { ttlMs: 12_000, refreshToken: 2 },
      probeTimeoutMs: 5_000,
    });

    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    expect(shellExecutionContractFingerprint(contract)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects command-mode overrides and sensitive host injection', () => {
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'pwsh', args: ['-Command'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', args: ['/Command'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'pwsh', args: ['-NonInteractive'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', args: ['-Interactive'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'pwsh', args: ['-SSHServerMode'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'pwsh', args: ['-Version'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'pwsh', args: ['-wd', 'C:\\other-project'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', args: ['/?'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd', args: ['/?'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd', args: ['/cecho prefix-takeover'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd', args: ['/kecho prefix-takeover'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd', args: [' \t/cecho whitespace-takeover'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', args: ['\t-Command'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', args: ['-Command \t'] },
    })).toThrow(/cannot override/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd' },
      environment: { set: { OPENAI_API_KEY: 'secret' } },
    })).toThrow(/sensitive variable OPENAI_API_KEY/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd' },
      environment: { set: { NODE_OPTIONS: '--require=hook.js' } },
    })).toThrow(/execution-control variable NODE_OPTIONS/i);
  });

  it('fails closed on relative executable paths and unsupported cmd profiles', () => {
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'bash', executable: './bash' },
    })).toThrow(/absolute or a bare executable name/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'cmd', profile: 'interactive' },
    })).toThrow(/cmd supports only/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'powershell', profile: 'login' },
    })).toThrow(/Windows PowerShell supports only/i);
  });

  it('accepts empty non-secret environment values', () => {
    expect(normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'bash' },
      environment: { set: { KODAX_OPTIONAL_VALUE: '' } },
    }).environment?.set).toEqual({ KODAX_OPTIONAL_VALUE: '' });
  });

  it('rejects misspelled fields instead of silently changing shell semantics', () => {
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'bash', profiles: 'login' },
    })).toThrow(/unknown field.*profiles/i);
    expect(() => normalizeShellExecutionContract({
      version: 1,
      shell: { kind: 'bash' },
      environment: { inherit: 'filtered', allowlist: ['PATH'] },
    })).toThrow(/unknown field.*allowlist/i);
  });
});
