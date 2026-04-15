import type { KodaXSessionStorage, KodaXResult } from '@kodax-ai/coding';
import { runKodaX } from '@kodax-ai/coding';
import { getSkillRegistry, initializeSkillRegistry } from '@kodax-ai/agent';
import type { AampLogger } from './aamp_logger.js';
import { evaluateAampToolPermission } from './aamp_permissions.js';
import { AampTerminalOutput } from './aamp_terminal_output.js';
import type { AampDispatchEnvelope, AampTaskRecord, AampTaskResult } from './aamp_types.js';

export interface KodaXAampRuntimeOptions {
  provider: string;
  model?: string;
  repoRoot: string;
  sessionStorage: KodaXSessionStorage;
  dangerousFullPermissions?: boolean;
  logger?: AampLogger;
  /** When set, called for each text delta to push streaming events. */
  onStreamDelta?: (text: string) => void;
}

export interface AampTaskExecutionResult {
  result: KodaXResult;
  outbound: AampTaskResult;
}

function buildDispatchPrompt(dispatch: AampDispatchEnvelope): string {
  const lines = [
    'You are handling an asynchronous AAMP task.',
    `Sender: ${dispatch.from}`,
    `Task ID: ${dispatch.taskId}`,
  ];

  if (dispatch.dispatchContext && Object.keys(dispatch.dispatchContext).length > 0) {
    lines.push('', 'Dispatch Context:');
    for (const [key, value] of Object.entries(dispatch.dispatchContext)) {
      lines.push(`- ${key}=${value}`);
    }
  }

  lines.push('', 'User request:', dispatch.bodyText);
  return lines.join('\n');
}

function buildResultOutput(result: KodaXResult): string {
  const text = result.lastText.trim();
  if (text) {
    return text;
  }

  if (result.signal === 'BLOCKED') {
    return result.signalReason?.trim() || 'Task blocked before producing a final answer.';
  }

  return result.success
    ? 'Task completed without a visible final summary.'
    : 'Task failed without a visible final summary.';
}

function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { input };
  }

  const record = input as Record<string, unknown>;
  return {
    ...('command' in record ? { command: record.command } : {}),
    ...('cmd' in record ? { cmd: record.cmd } : {}),
    ...('path' in record ? { path: record.path } : {}),
    ...('paths' in record ? { paths: record.paths } : {}),
    ...('uri' in record ? { uri: record.uri } : {}),
    ...('ref_id' in record ? { refId: record.ref_id } : {}),
  };
}

function getToolErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

export class KodaXAampRuntime {
  private readonly options: KodaXAampRuntimeOptions;

  constructor(options: KodaXAampRuntimeOptions) {
    this.options = options;
  }

  async execute(dispatch: AampDispatchEnvelope, record: AampTaskRecord): Promise<AampTaskExecutionResult> {
    const terminal = new AampTerminalOutput();
    terminal.writeTaskStart(dispatch);

    const repoRoot = this.options.repoRoot;
    await initializeSkillRegistry(repoRoot);
    const skillsPrompt = getSkillRegistry(repoRoot).getSystemPromptSnippet();
    const logger = this.options.logger;

    const result = await runKodaX(
      {
        provider: this.options.provider,
        model: this.options.model,
        session: {
          id: record.sessionId,
          storage: this.options.sessionStorage,
          scope: 'user',
        },
        context: {
          gitRoot: repoRoot,
          executionCwd: repoRoot,
          rawUserInput: dispatch.bodyText,
          taskSurface: 'cli',
          skillsPrompt,
        },
        events: {
          onTextDelta: (text) => {
            terminal.writeAgentText(text);
            this.options.onStreamDelta?.(text);
          },
          onThinkingDelta: (text) => terminal.writeThinking(text),
          onToolUseStart: (tool) => {
            terminal.writeToolUseStart(tool);
            logger?.info('tool.execution_started', 'tool execution started', {
              taskId: dispatch.taskId,
              sessionId: record.sessionId,
              toolId: tool.id ?? null,
              toolName: tool.name,
              ...summarizeToolInput(tool.input),
            });
          },
          onToolResult: (result) => {
            terminal.writeToolResult(result.name);
            logger?.info('tool.execution_finished', 'tool execution finished', {
              taskId: dispatch.taskId,
              sessionId: record.sessionId,
              toolId: result.id ?? null,
              toolName: result.name,
              isError: false,
            });
          },
          onComplete: () => terminal.writeTaskComplete(dispatch.taskId),
          onError: (err) => {
            terminal.writeTaskError(dispatch.taskId, err.message);
            logger?.error('tool.execution_failed', 'tool execution failed', {
              taskId: dispatch.taskId,
              sessionId: record.sessionId,
              error: getToolErrorMessage(err),
            });
          },
          beforeToolExecute: async (toolName, input, context) => {
            const decision = await evaluateAampToolPermission(toolName, input, {
              dangerousFullPermissions: this.options.dangerousFullPermissions,
            });

            if (decision !== true) {
              logger?.error('tool.execution_blocked', 'tool execution blocked by permissions', {
                taskId: dispatch.taskId,
                sessionId: record.sessionId,
                toolId: context?.toolId ?? null,
                toolName,
                reason: decision,
                ...summarizeToolInput(input),
              });
            }

            return decision;
          },
        },
      },
      buildDispatchPrompt(dispatch),
    );

    const output = buildResultOutput(result);
    return {
      result,
      outbound: {
        taskId: dispatch.taskId,
        to: dispatch.from,
        status: result.success && result.signal !== 'BLOCKED' ? 'completed' : 'failed',
        output,
        inReplyToMessageId: dispatch.messageId,
      },
    };
  }
}
