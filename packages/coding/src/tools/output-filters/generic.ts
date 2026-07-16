import type { BashOutputFilterInput, FilterResult } from './types.js';

const ANSI_SGR_PATTERN = /\u001B\[[0-?]*[ -/]*m/g;
const OSC_METADATA_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const OSC8_LINK_PATTERN = /\u001B\]8;[^;]*;([^\u0007\u001B]*)(?:\u0007|\u001B\\)([\s\S]*?)\u001B\]8;;(?:\u0007|\u001B\\)/g;
const OSC8_OPEN_PATTERN = /\u001B\]8;[^;]*;([^\u0007\u001B]*)(?:\u0007|\u001B\\)/g;

function renderTerminalLink(label: string, url: string): string {
  if (!url || label.includes(url)) return label;
  return label ? `${label} (${url})` : url;
}

export function stripAnsiCodes(text: string): string {
  return text
    .replace(OSC8_LINK_PATTERN, (_match: string, url: string, label: string) => (
      renderTerminalLink(label, url)
    ))
    .replace(OSC8_OPEN_PATTERN, (_match: string, url: string) => url)
    .replace(OSC_METADATA_PATTERN, '')
    .replace(ANSI_SGR_PATTERN, '');
}

export function applyGenericOutputFilter(input: BashOutputFilterInput): FilterResult {
  return {
    stdout: stripAnsiCodes(input.stdout),
    stderr: stripAnsiCodes(input.stderr),
    lossiness: input.lossiness,
    note: input.note,
  };
}
