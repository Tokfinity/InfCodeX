import type { BashOutputFilterInput } from './types.js';

const COMMAND_SEPARATOR = /&&|\|\||[;|]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
const SHELL_PREFIXES = new Set(['cd', 'pushd', 'popd', 'set', 'export']);

export function commandHead(command: string): string {
  for (const rawSegment of command.split(COMMAND_SEPARATOR)) {
    let rest = rawSegment.trim();
    while (ENV_ASSIGNMENT.test(rest)) {
      rest = rest.replace(ENV_ASSIGNMENT, '');
    }

    const windowsExe = rest.match(/[A-Za-z]:\\.*?\\([^\\]+?)\.(?:cmd|exe|bat|ps1)\b/i);
    if (windowsExe) {
      return (windowsExe[1] ?? '').toLowerCase();
    }

    const token = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find((value) => value);
    if (!token) continue;

    const basename = token.replace(/\\/g, '/').split('/').pop() ?? token;
    const head = basename.replace(/\.(?:cmd|exe|bat|ps1)$/i, '').toLowerCase();
    if (!SHELL_PREFIXES.has(head)) return head;
  }

  return '';
}

export function commandMatches(input: BashOutputFilterInput, pattern: RegExp): boolean {
  return pattern.test(commandHead(input.command)) || pattern.test(input.command);
}

export function outputMatches(input: BashOutputFilterInput, pattern: RegExp): boolean {
  return pattern.test(input.stdout) || pattern.test(input.stderr);
}
