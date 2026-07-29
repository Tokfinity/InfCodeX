import path from 'node:path';
import type { RunnerToolCall } from '@kodax-ai/agent';

import { isAlwaysConfirmPath, isBashReadCommand } from './permission.js';
import { computeConfirmTools, FILE_MODIFICATION_TOOLS } from './types.js';

const ACCEPT_EDITS_CONFIRM_TOOLS = computeConfirmTools('accept-edits');

/**
 * Classifier-infrastructure fallback with the same effective boundary as
 * Accept-edits: safe shell reads and ordinary workspace edits may continue;
 * executable shell calls and protected/outside writes require confirmation.
 */
export function allowsAcceptEditsClassifierFallback(
  call: RunnerToolCall,
  projectRoot: string,
  executionCwd: string,
): boolean {
  if (call.name === 'bash') {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    return command.length > 0 && isBashReadCommand(command);
  }

  if (FILE_MODIFICATION_TOOLS.has(call.name)) {
    const target = typeof call.input.path === 'string' ? call.input.path : '';
    if (!target || !projectRoot) return false;
    const resolvedTarget = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(executionCwd || projectRoot, target);
    return !isAlwaysConfirmPath(resolvedTarget, projectRoot);
  }

  return !ACCEPT_EDITS_CONFIRM_TOOLS.has(call.name);
}
