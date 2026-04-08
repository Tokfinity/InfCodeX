import type { KodaXSessionStorage, KodaXResult } from '@kodax-ai/coding';
import { runKodaX } from '@kodax-ai/coding';
import { getSkillRegistry, initializeSkillRegistry } from '@kodax-ai/agent';
import { evaluateAampToolPermission } from './aamp_permissions.js';
import { AampTerminalOutput } from './aamp_terminal_output.js';
import type { AampDispatchEnvelope, AampTaskRecord, AampTaskResult } from './aamp_types.js';

export interface KodaXAampRuntimeOptions {
  provider: string;
  model?: string;
  repoRoot: string;
  sessionStorage: KodaXSessionStorage;
  dangerousFullPermissions?: boolean;
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
          onTextDelta: (text) => terminal.writeAgentText(text),
          onThinkingDelta: (text) => terminal.writeThinking(text),
          onToolUseStart: (tool) => terminal.writeToolUseStart(tool),
          onToolResult: (result) => terminal.writeToolResult(result.name),
          onComplete: () => terminal.writeTaskComplete(dispatch.taskId),
          onError: (err) => terminal.writeTaskError(dispatch.taskId, err.message),
          beforeToolExecute: async (toolName, input) =>
            evaluateAampToolPermission(toolName, input, {
              dangerousFullPermissions: this.options.dangerousFullPermissions,
            }),
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
