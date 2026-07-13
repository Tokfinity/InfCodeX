import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyA2AServerChange,
  parseA2AIntegrationDocument,
  readA2AIntegration,
  removeA2AOutboundAgent,
  setA2AServerConfig,
  upsertA2AOutboundAgent,
} from './config.js';

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-config-'));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

function published() {
  return {
    name: 'KodaX Agent',
    description: 'Completes approved general tasks.',
    version: '0.7.69',
    skills: [{
      id: 'general',
      name: 'General',
      description: 'Complete general tasks.',
      tags: [],
    }],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  } as const;
}

function authentication() {
  return {
    type: 'bearer-env',
    tokenEnv: 'KODAX_A2A_TOKEN',
    principalId: 'configured-client',
  } as const;
}

describe('FEATURE_267/268 A2A integration config', () => {
  it('materializes safe managed-workspace defaults', () => {
    const parsed = parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    });
    expect(parsed.server?.execution.workspace).toEqual({ mode: 'managed' });
    expect(parsed.server?.execution.toolPolicy).toEqual({
      workspace: 'write',
      process: 'deny',
      network: { mode: 'deny' },
      tools: [],
      mcp: {},
      skillScripts: {},
      subagents: 'deny',
    });
    expect(parsed.server?.limits.maxConcurrentTasks).toBe(4);
  });

  it('rejects partial policy, wildcard authority, and process/script mismatches', () => {
    const base = {
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    };
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: { kind: 'runtime-default', toolPolicy: { workspace: 'read' } },
      },
    })).toThrow(/toolPolicy/i);
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: {
          kind: 'runtime-default',
          toolPolicy: {
            workspace: 'write', process: 'deny', network: { mode: 'deny' },
            tools: ['*'], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
      },
    })).toThrow(/wildcard/i);
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: {
          kind: 'runtime-default',
          toolPolicy: {
            workspace: 'write', process: 'isolated', network: { mode: 'deny' },
            tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
      },
    })).toThrow(/skillScripts/i);
  });

  it('rejects credentials embedded in outbound and public A2A URLs', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 1,
      agents: {
        reporting: {
          cardUrl: 'https://user:secret@agents.example.com/.well-known/agent-card.json',
          effect: 'read',
        },
      },
    })).toThrow(/embedded credentials/i);
    expect(() => parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        publicBaseUrl: 'https://user:secret@agents.example.com',
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/embedded credentials/i);
  });

  it('forces fixed writable workspaces to serial task admission', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: {
          kind: 'runtime-default',
          workspace: { mode: 'fixed', root: path.resolve(configHome, 'workspace') },
          toolPolicy: {
            workspace: 'write', process: 'deny', network: { mode: 'deny' },
            tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
        published: published(),
        authentication: authentication(),
        limits: {
          maxRequestBytes: 1024,
          maxPartBytes: 512,
          maxConcurrentTasks: 2,
          maxActiveTasksPerPrincipal: 2,
          maxRetainedTasksPerPrincipal: 10,
          maxEventsPerTask: 100,
          maxEventBytesPerTask: 4096,
          maxWorkspaceBytesPerContext: 8192,
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/maxConcurrentTasks.*1/i);
  });

  it('preserves the inbound singleton across outbound mutations and vice versa', () => {
    const server = parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    setA2AServerConfig(configHome, server);
    upsertA2AOutboundAgent(configHome, 'reporting', {
      cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
      credentialEnv: 'REPORTING_A2A_TOKEN',
      effect: 'read',
    });
    expect(readA2AIntegration(configHome).document.server).toEqual(server);
    expect(readA2AIntegration(configHome).document.agents.reporting?.credentialEnv)
      .toBe('REPORTING_A2A_TOKEN');
    expect(removeA2AOutboundAgent(configHome, 'reporting')).toBe(true);
    expect(readA2AIntegration(configHome).document.server).toEqual(server);
  });

  it('classifies publication/auth/limits as hot and execution/store as restart-required', () => {
    const current = parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    const hot = { ...current, published: { ...current.published, description: 'Updated.' } };
    expect(classifyA2AServerChange(current, hot)).toEqual({
      kind: 'hot',
      fields: ['published'],
    });
    const restart = {
      ...current,
      execution: { ...current.execution, profileId: 'a2a/new-profile' },
    };
    expect(classifyA2AServerChange(current, restart)).toEqual({
      kind: 'restart-required',
      fields: ['execution'],
    });
  });
});
