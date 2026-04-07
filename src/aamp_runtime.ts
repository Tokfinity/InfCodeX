import type { KodaXSessionStorage, KodaXResult } from '@kodax/coding';
import { runKodaX } from '@kodax/coding';
import { getSkillRegistry, initializeSkillRegistry } from '@kodax/skills';
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
    const log = (msg: string) => process.stdout.write(msg);
    log(`\n[AAMP] task=${dispatch.taskId} from=${dispatch.from}\n`);

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
          onTextDelta: (text) => process.stdout.write(text),
          onThinkingDelta: (text) => log(`[thinking] ${text}`),
          onToolUseStart: (tool) => log(`\n[tool:${tool.name}] ${JSON.stringify(tool.input ?? {})}\n`),
          onToolResult: (result) => log(`[tool:${result.name}] done\n`),
          onComplete: () => log(`\n[AAMP] task=${dispatch.taskId} completed\n`),
          onError: (err) => log(`\n[AAMP] task=${dispatch.taskId} error: ${err.message}\n`),
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
