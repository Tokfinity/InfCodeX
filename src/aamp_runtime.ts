import type { KodaXSessionStorage, KodaXResult } from '@kodax/coding';
import { runKodaX } from '@kodax/coding';
import type { AampDispatchEnvelope, AampTaskRecord, AampTaskResult } from './aamp_types.js';

export interface KodaXAampRuntimeOptions {
  provider: string;
  model?: string;
  repoRoot: string;
  sessionStorage: KodaXSessionStorage;
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
          gitRoot: this.options.repoRoot,
          executionCwd: this.options.repoRoot,
          rawUserInput: dispatch.bodyText,
          taskSurface: 'cli',
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
