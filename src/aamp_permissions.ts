import { isBashReadCommand } from '@kodax-ai/repl';

export interface AampPermissionGuardOptions {
  dangerousFullPermissions?: boolean;
}

const DANGEROUS_FULL_ACCESS_BASH_BLACKLIST: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\bdd(\s|$)/i,
    reason: 'raw disk writes via dd are blocked',
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9_-]+)?(\s|$)/i,
    reason: 'filesystem formatting commands are blocked',
  },
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff)(\s|$)/i,
    reason: 'system shutdown commands are blocked',
  },
  {
    pattern: /\bsudo(\s|$)/i,
    reason: 'privilege escalation via sudo is blocked',
  },
  {
    pattern: /\bsu(\s|$)/i,
    reason: 'user switching via su is blocked',
  },
  {
    pattern: /\bcurl\b[\s\S]*\|\s*(?:sh|bash|zsh)(\s|$)/i,
    reason: 'remote shell execution via curl pipe is blocked',
  },
  {
    pattern: /\bwget\b[\s\S]*\|\s*(?:sh|bash|zsh)(\s|$)/i,
    reason: 'remote shell execution via wget pipe is blocked',
  },
  {
    pattern: /\bremove-item\b[\s\S]*\s-(?:recurse|r)\b[\s\S]*\s-(?:force|f)\b/i,
    reason: 'recursive forced deletion via Remove-Item is blocked',
  },
];

export function getAampDangerousCommandBlockReason(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  for (const entry of DANGEROUS_FULL_ACCESS_BASH_BLACKLIST) {
    if (entry.pattern.test(normalized)) {
      return entry.reason;
    }
  }

  return null;
}

function emitAampShellWarning(command: string): void {
  const normalized = command.trim().replace(/\s+/g, ' ');
  const preview = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
  process.stderr.write(
    `[AAMP] Blocking shell command without --dangerous-full-permissions: ${preview}\n`,
  );
}

export function evaluateAampToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  options: AampPermissionGuardOptions,
): true | string {
  if (toolName !== 'bash') {
    return true;
  }

  const command = typeof input.command === 'string' ? input.command : '';
  const blockReason = getAampDangerousCommandBlockReason(command);
  if (blockReason) {
    return `[Blocked] AAMP shell hard blacklist: ${blockReason}.`;
  }

  if (options.dangerousFullPermissions || isBashReadCommand(command)) {
    return true;
  }

  emitAampShellWarning(command);
  return '[Blocked] AAMP async worker cannot request interactive approval for non-read shell commands. Restart `kodax aamp serve` with `--dangerous-full-permissions` to allow this shell execution.';
}
