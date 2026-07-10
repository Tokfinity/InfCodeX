import { describe, expect, it } from 'vitest';

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../../types.js';
import {
  registerTool,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
} from '../../tools/index.js';
import { executeToolCall } from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { RunnableToolCall } from '../middleware/edit-recovery.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function makeToolCall(
  name: string,
  input: Record<string, unknown> = {},
): RunnableToolCall {
  return { id: 't1', name, input } as RunnableToolCall;
}

describe('FEATURE_254 portable bridge dispatch', () => {
  it('tool_describe returns bounded schema only for active tools', async () => {
    const unregister = registerTool({
      name: 'bridge_describe_target',
      description: 'test-only bridge description target',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
      sideEffect: 'readonly',
      handler: async () => 'ok',
    });

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_DESCRIBE_NAME, {
          names: ['bridge_describe_target', 'inactive_bridge_target'],
        }),
        makeCtx(),
        freshState(),
        [TOOL_DESCRIBE_NAME, 'bridge_describe_target'],
      );

      expect(result).toContain('<function>');
      expect(result).toContain('"name":"bridge_describe_target"');
      expect(result).toContain('inactive_bridge_target: not active');
      expect(result).not.toContain('"name":"inactive_bridge_target"');
    } finally {
      unregister();
    }
  });

  it('tool_call executes an active target through the target permission gate', async () => {
    const unregister = registerTool({
      name: 'bridge_call_target',
      description: 'test-only bridge call target',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
      sideEffect: 'readonly',
      handler: async (input, ctx) => `target:${String(input.value)}:${ctx.toolCallId ?? 'missing'}`,
    });
    const permissionNames: string[] = [];
    const events: KodaXEvents = {
      beforeToolExecute: async (name) => {
        permissionNames.push(name);
        return undefined;
      },
    };

    try {
      const result = await executeToolCall(
        events,
        makeToolCall(TOOL_CALL_NAME, {
          name: 'bridge_call_target',
          input: { value: 'ok' },
        }),
        makeCtx(),
        freshState(),
        [TOOL_CALL_NAME, 'bridge_call_target'],
      );

      expect(result).toContain('target:ok:t1:bridge_call_target');
      expect(permissionNames).toEqual(['bridge_call_target']);
    } finally {
      unregister();
    }
  });

  it('tool_describe stays read-only without opening a permission request', async () => {
    const permissionNames: string[] = [];
    const result = await executeToolCall(
      {
        beforeToolExecute: async (name) => {
          permissionNames.push(name);
          return undefined;
        },
      },
      makeToolCall(TOOL_DESCRIBE_NAME, { name: TOOL_CALL_NAME }),
      makeCtx(),
      freshState(),
      [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME],
    );

    expect(result).toContain(TOOL_CALL_NAME);
    expect(permissionNames).toEqual([]);
  });

  it('tool_call rejects inactive targets without invoking their handler', async () => {
    let invoked = false;
    const unregister = registerTool({
      name: 'bridge_inactive_target',
      description: 'test-only inactive bridge target',
      input_schema: { type: 'object', properties: {} },
      sideEffect: 'readonly',
      handler: async () => {
        invoked = true;
        return 'should-not-run';
      },
    });

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_CALL_NAME, {
          name: 'bridge_inactive_target',
          input: {},
        }),
        makeCtx(),
        freshState(),
        [TOOL_CALL_NAME],
      );

      expect(result).toBe('[Tool Error] bridge_inactive_target: Tool is not active in the current runtime.');
      expect(invoked).toBe(false);
    } finally {
      unregister();
    }
  });
});
