import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DAEMON_METHODS,
} from './protocol.js';
import {
  RUNTIME_DAEMON_METHOD_SCHEMAS,
  RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON,
  validateRuntimeDaemonJsonSchema,
} from './schema.js';

describe('runtime daemon protocol schema', () => {
  it('covers every daemon protocol method with params and result schemas', () => {
    expect(Object.keys(RUNTIME_DAEMON_METHOD_SCHEMAS).sort()).toEqual([...RUNTIME_DAEMON_METHODS].sort());
    expect(RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON).not.toContain('agentTasks.');

    for (const method of RUNTIME_DAEMON_METHODS) {
      const schema = RUNTIME_DAEMON_METHOD_SCHEMAS[method];
      expect(schema.params).toBeDefined();
      expect(schema.result).toBeDefined();
    }
  });

  it('publishes one schema artifact with method and notification families', () => {
    expect(RUNTIME_DAEMON_PROTOCOL_SCHEMA).toMatchObject({
      protocol: 'kodax-runtime-daemon',
      version: 1,
      methods: RUNTIME_DAEMON_METHOD_SCHEMAS,
      notifications: RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
    });
    expect(JSON.parse(RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON)).toMatchObject({
      protocol: 'kodax-runtime-daemon',
      version: 1,
      methods: {
        'provider.custom.list': expect.any(Object),
        'mcp.server.validate': expect.any(Object),
        'extension.list': expect.any(Object),
      },
    });
  });

  it('includes diagnostic daemon methods in the generated method schema map', () => {
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['context.budget.get'].params).toMatchObject({
      properties: {
        sessionId: { type: 'string' },
        runId: { type: 'string' },
      },
    });
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['tool.exposure.preview'].result).toMatchObject({
      oneOf: expect.arrayContaining([{ type: 'null' }]),
    });
  });

  it('validates required, typed, and additional properties', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['session.load'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, { sessionId: 'session-1' })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, { sessionId: 42 })).toContain(
      '$.sessionId must be string.',
    );
    expect(validateRuntimeDaemonJsonSchema(schema, {})).toContain(
      '$.sessionId is required.',
    );
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      unexpected: true,
    })).toContain('$.unexpected is not allowed.');
  });

  it('accepts surface and cursor fields for session.list pagination', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['session.list'].params;
    expect(validateRuntimeDaemonJsonSchema(schema, {
      surface: 'acp',
      cursor: 'opaque-cursor',
      limit: 20,
    })).toEqual([]);
  });

  it('validates registration ownership and revision-CAS mutation fields', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['agentRegistrations.setEnabled'].params;
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'runtime-config-test',
      claimOwner: 'runtime-config-test',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      claimOwner: 42,
    })).toContain('$.claimOwner must be string.');
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedManagementOwner: 42,
    })).toContain('$.expectedManagementOwner must match exactly one allowed schema.');
    for (const method of ['agentRegistrations.upsert', 'agentRegistrations.remove'] as const) {
      const mutationSchema = RUNTIME_DAEMON_METHOD_SCHEMAS[method].params;
      const required = method === 'agentRegistrations.upsert'
        ? { registration: {} }
        : { agentId: 'external:managed' };
      expect(validateRuntimeDaemonJsonSchema(mutationSchema, {
        ...required,
        expectedManagementOwner: null,
      })).toEqual([]);
    }
  });

  it('publishes and validates the run permission broker wire field', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['run.start'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      permissionBroker: 'client',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      permissionBroker: 'unknown',
    })).toContain('$.permissionBroker must be one of: runtime, client.');
  });

  it('carries the effective execution directory on permission requests', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['permission.request'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      executionCwd: 'C:\\work\\project',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      executionCwd: 42,
    })).toContain('$.executionCwd must be string.');
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      inputPreview: 'x'.repeat(8_193),
    })).toEqual([]);
  });
});
