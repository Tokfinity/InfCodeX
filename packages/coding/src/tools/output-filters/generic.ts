import type { BashOutputFilterInput, FilterResult } from './types.js';

const ANSI_PATTERN = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))|(?:\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function applyGenericOutputFilter(input: BashOutputFilterInput): FilterResult {
  return {
    stdout: stripAnsiCodes(input.stdout),
    stderr: stripAnsiCodes(input.stderr),
    lossiness: input.lossiness,
    note: input.note,
  };
}
