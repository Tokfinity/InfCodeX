import chalk from 'chalk';
import type { AampDispatchEnvelope } from './aamp_types.js';

type Writable = Pick<NodeJS.WriteStream, 'write'>;

const AAMP_TASK_PREFIX = '[aamp/task]';
const AGENT_LINE_PREFIX = '  | ';
const AGENT_THINKING_PREFIX = '[agent/thinking]';

function serializeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) {
    return '{}';
  }
  return JSON.stringify(input);
}

export class AampTerminalOutput {
  private readonly stdout: Writable;
  private agentLineStart = true;

  constructor(stdout: Writable = process.stdout) {
    this.stdout = stdout;
  }

  writeTaskStart(dispatch: AampDispatchEnvelope): void {
    this.writeTaskLine(`task=${dispatch.taskId} from=${dispatch.from}`);
  }

  writeTaskComplete(taskId: string): void {
    this.writeTaskLine(`task=${taskId} completed`);
  }

  writeTaskError(taskId: string, message: string): void {
    this.writeTaskLine(`task=${taskId} error: ${message}`, 'error');
  }

  writeAgentText(text: string): void {
    this.writePrefixedAgentText(text);
  }

  writeThinking(text: string): void {
    this.writeAgentMetaLine(AGENT_THINKING_PREFIX, text);
  }

  writeToolUseStart(tool: { name: string; input?: Record<string, unknown> }): void {
    this.writeAgentMetaLine(`[agent/tool:${tool.name}]`, serializeToolInput(tool.input));
  }

  writeToolResult(toolName: string): void {
    this.writeAgentMetaLine(`[agent/tool:${toolName}]`, 'done');
  }

  private writeTaskLine(message: string, level: 'info' | 'error' = 'info'): void {
    this.ensureAgentLineEnded();
    const prefix = level === 'error'
      ? chalk.redBright(AAMP_TASK_PREFIX)
      : chalk.cyanBright(AAMP_TASK_PREFIX);
    this.stdout.write(`\n${prefix} ${message}\n`);
  }

  private writeAgentMetaLine(prefix: string, message: string): void {
    this.ensureAgentLineEnded();
    this.stdout.write(`${chalk.dim(prefix)} ${chalk.dim(message)}\n`);
    this.agentLineStart = true;
  }

  private ensureAgentLineEnded(): void {
    if (!this.agentLineStart) {
      this.stdout.write('\n');
      this.agentLineStart = true;
    }
  }

  private writePrefixedAgentText(text: string): void {
    let cursor = 0;
    while (cursor < text.length) {
      const newlineIndex = text.indexOf('\n', cursor);
      if (newlineIndex === -1) {
        this.writeAgentTextSegment(text.slice(cursor));
        return;
      }

      this.writeAgentTextSegment(text.slice(cursor, newlineIndex));
      this.stdout.write('\n');
      this.agentLineStart = true;
      cursor = newlineIndex + 1;
    }
  }

  private writeAgentTextSegment(segment: string): void {
    if (!segment) {
      return;
    }

    if (this.agentLineStart) {
      this.stdout.write(chalk.dim(AGENT_LINE_PREFIX));
      this.agentLineStart = false;
    }

    this.stdout.write(chalk.dim(segment));
  }
}
