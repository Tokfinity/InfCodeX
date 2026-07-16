import type { LocalToolDefinition, ToolHandlerSync } from './types.js';

export const TOOL_DESCRIBE_NAME = 'tool_describe';
export const TOOL_CALL_NAME = 'tool_call';

const bridgeDispatchUnavailable: ToolHandlerSync = async (_input, _context) => (
  '[Tool Error] tool bridge dispatch is unavailable outside the agent runtime.'
);

export const TOOL_DESCRIBE_DEFINITION: LocalToolDefinition = {
  name: TOOL_DESCRIBE_NAME,
  description:
    'Return the full bounded description and input schema for one active tool. Use this after tool_search when a tool schema is hidden behind the portable bridge.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active tool to describe.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of active tool names to describe. Capped by the runtime.',
      },
    },
  },
  handler: bridgeDispatchUnavailable,
  sideEffect: 'readonly',
  planModeAllowed: true,
  toClassifierInput: () => '',
};

export const TOOL_CALL_DEFINITION: LocalToolDefinition = {
  name: TOOL_CALL_NAME,
  description:
    'Call one active tool through the portable bridge after discovering or describing it. The runtime re-applies the target tool policy, permission checks, and result guardrails.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active target tool to call.',
      },
      input: {
        type: 'object',
        description: 'JSON object passed as the target tool input.',
      },
    },
    required: ['name', 'input'],
  },
  handler: bridgeDispatchUnavailable,
  sideEffect: 'mutates-state',
  planModeAllowed: true,
  toClassifierInput: (input) => {
    const record = input && typeof input === 'object'
      ? input as { name?: unknown }
      : {};
    return `ToolBridgeCall: ${typeof record.name === 'string' ? record.name : '<missing-name>'}`;
  },
};
