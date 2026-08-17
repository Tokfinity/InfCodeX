import * as readline from 'readline';
import chalk from 'chalk';
import { buildToolConfirmationDisplay } from '../common/tool-confirmation.js';
import type { ConfirmResult, PermissionMode } from '../permission/types.js';
import {
  RUNTIME_PERMISSION_PENDING_NOTICE,
  type ReplRuntimePermissionGrantSuggestion,
} from '../runtime-permission.js';
import { supportsUnicode as terminalSupportsUnicode } from '../ui/utils/terminalCapabilities.js';

export interface ConfirmOption {
  key: string;
  label: string;
  description: string;
  value: string;
}

export interface ConfirmOptions {
  message: string;
  default?: string;
  options?: ConfirmOption[];
  showDescription?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_YES_NO_OPTIONS: ConfirmOption[] = [
  { key: 'y', label: 'Yes', description: 'Confirm the action', value: 'yes' },
  { key: 'n', label: 'No', description: 'Cancel the action', value: 'no' },
];

const SAFETY_CONFIRM_OPTIONS: ConfirmOption[] = [
  { key: 'y', label: 'Yes', description: 'Allow this once', value: 'yes' },
  { key: 'n', label: 'No', description: 'Cancel', value: 'no' },
  { key: 'a', label: 'Always', description: 'Always allow this kind of action', value: 'always' },
];

function formatOptions(options: ConfirmOption[], showDescription: boolean = true): string {
  return options
    .map((option) => {
      const keyPart = chalk.dim(`[${option.key}]`);
      if (!showDescription) {
        return `${keyPart} ${option.label}`;
      }
      return `${keyPart} ${chalk.cyan(option.label)} ${chalk.dim(`- ${option.description}`)}`;
    })
    .join('  ');
}

export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

export function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && process.stdout.hasColors());
}

export function supportsUnicode(): boolean {
  return terminalSupportsUnicode();
}

export function getSymbols() {
  const unicode = supportsUnicode();
  return {
    success: unicode ? '\u2713' : '[OK]',
    error: unicode ? '\u2717' : '[X]',
    warning: unicode ? '\u26A0' : '[!]',
    info: unicode ? '\u2139' : '[i]',
    arrow: unicode ? '\u2192' : '->',
    bullet: unicode ? '\u2022' : '*',
    check: unicode ? '\u2713' : '[v]',
    cross: unicode ? '\u2717' : '[x]',
  };
}

export async function confirmEnhanced(
  rl: readline.Interface,
  options: ConfirmOptions,
): Promise<string> {
  const {
    message,
    default: defaultKey,
    options: customOptions,
    showDescription = true,
    signal,
  } = options;

  const promptOptions = customOptions ?? DEFAULT_YES_NO_OPTIONS;
  const optionsText = formatOptions(promptOptions, showDescription);

  console.log();
  console.log(chalk.cyan(`? ${message}`));

  const width = getTerminalWidth();
  if (optionsText.length > width - 4) {
    for (const option of promptOptions) {
      const keyPart = chalk.dim(`  [${option.key}]`);
      console.log(`${keyPart} ${chalk.cyan(option.label)}`);
      if (showDescription) {
        console.log(chalk.dim(`        ${option.description}`));
      }
    }
  } else {
    console.log(chalk.dim(`  ${optionsText}`));
  }

  if (signal?.aborted) return 'no';
  return new Promise((resolve) => {
    const defaultHint = defaultKey ? ` (${defaultKey})` : '';
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish('no');
    const onAnswer = (answer: string): void => {
      const input = answer.trim().toLowerCase() || defaultKey || '';
      const matched = promptOptions.find(
        (option) =>
          option.key === input
          || option.value === input
          || option.label.toLowerCase() === input,
      );

      if (matched) {
        finish(matched.value);
      } else if (input === '') {
        finish('no');
      } else {
        finish(input);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) {
      rl.question(chalk.dim(`  Choose${defaultHint}: `), { signal }, onAnswer);
    } else {
      rl.question(chalk.dim(`  Choose${defaultHint}: `), onAnswer);
    }
  });
}

export async function confirmWithAlways(
  rl: readline.Interface,
  message: string,
  context?: string,
): Promise<'yes' | 'no' | 'always'> {
  const fullMessage = context ? `${message}\n  ${chalk.dim(context)}` : message;
  const result = await confirmEnhanced(rl, {
    message: fullMessage,
    default: 'n',
    options: SAFETY_CONFIRM_OPTIONS,
  });
  return result as 'yes' | 'no' | 'always';
}

export async function confirmToolExecution(
  rl: readline.Interface,
  tool: string,
  input: Record<string, unknown>,
  options?: {
    isOutsideProject?: boolean;
    reason?: string;
    isProtectedPath?: boolean;
    permissionMode?: PermissionMode;
    runtimeGrantSuggestions?: readonly ReplRuntimePermissionGrantSuggestion[];
    signal?: AbortSignal;
  },
): Promise<ConfirmResult> {
  const {
    isOutsideProject = false,
    isProtectedPath = false,
    permissionMode = 'accept-edits',
    runtimeGrantSuggestions,
    signal,
  } = options ?? {};
  const symbols = getSymbols();

  let message: string;
  let promptOptions: ConfirmOption[];
  const displayInput = {
    ...input,
    ...(isOutsideProject ? { _outsideProject: true } : {}),
    ...(isProtectedPath ? { _alwaysConfirm: true } : {}),
  };
  const display = buildToolConfirmationDisplay(tool, displayInput);
  const detailLines = display.details.map((line) => `  ${chalk.dim(line)}`);

  if (isOutsideProject || isProtectedPath) {
    message = `${chalk.yellow(symbols.warning)} Safety Warning`;
    if (detailLines.length > 0) {
      message += `\n${detailLines.join('\n')}`;
    }

    promptOptions = [
      { key: 'y', label: 'Yes', description: 'Allow this once', value: 'yes' },
      { key: 'n', label: 'No', description: 'Cancel', value: 'no' },
    ];
  } else {
    message = display.title;
    if (detailLines.length > 0) {
      message += `\n${detailLines.join('\n')}`;
    }
    if (runtimeGrantSuggestions !== undefined) {
      message += `\n  ${chalk.dim(RUNTIME_PERMISSION_PENDING_NOTICE)}`;
      message += `\n${runtimeGrantSuggestions
        .map((suggestion) => `  ${chalk.dim(`Runtime scope: ${suggestion.label}`)}`)
        .join('\n')}`;
    }

    if (runtimeGrantSuggestions !== undefined) {
      promptOptions = [
        { key: 'y', label: 'Once', description: 'Allow this operation once', value: 'yes' },
        ...(runtimeGrantSuggestions.some((suggestion) => suggestion.kind === 'session')
          ? [{
              key: 's',
              label: 'Session',
              description: 'Allow this Runtime-issued scope for this session',
              value: 'session',
            }]
          : []),
        ...(runtimeGrantSuggestions.some((suggestion) => suggestion.kind === 'persistent')
          ? [{
              key: 'a',
              label: 'Always',
              description: 'Always allow this Runtime-issued scope',
              value: 'always',
            }]
          : []),
        { key: 'n', label: 'No', description: 'Cancel', value: 'no' },
      ];
    } else {
      promptOptions = permissionMode === 'accept-edits'
        ? SAFETY_CONFIRM_OPTIONS
        : [
            { key: 'y', label: 'Yes', description: 'Confirm the action', value: 'yes' },
            { key: 'n', label: 'No', description: 'Cancel', value: 'no' },
          ];
    }
  }

  const result = await confirmEnhanced(rl, {
    message,
    default: 'n',
    options: promptOptions,
    signal,
  });

  if (result === 'always') {
    return runtimeGrantSuggestions !== undefined
      ? { confirmed: true, runtimeGrantKind: 'persistent' }
      : { confirmed: true, always: true };
  }
  if (result === 'session') return { confirmed: true, runtimeGrantKind: 'session' };

  return { confirmed: result === 'yes' };
}

export async function selectFromList<T extends string>(
  rl: readline.Interface,
  message: string,
  items: Array<{ value: T; label: string; description?: string }>,
): Promise<T> {
  const symbols = getSymbols();

  console.log();
  console.log(chalk.cyan(`? ${message}`));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const num = chalk.dim(`${i + 1}.`.padStart(4));
    let line = `  ${num} ${item.label}`;
    if (item.description) {
      line += ` ${chalk.dim(`- ${item.description}`)}`;
    }
    console.log(line);
  }

  return new Promise((resolve) => {
    rl.question(chalk.dim(`  ${symbols.arrow} Select (1-${items.length}): `), (answer) => {
      const num = Number.parseInt(answer.trim(), 10);
      if (num >= 1 && num <= items.length) {
        resolve(items[num - 1]!.value);
        return;
      }

      const matched = items.find(
        (item) => item.label.toLowerCase() === answer.trim().toLowerCase(),
      );
      resolve(matched?.value ?? items[0]!.value);
    });
  });
}

export function showResult(success: boolean, message: string): void {
  const symbols = getSymbols();
  if (success) {
    console.log(chalk.green(`  ${symbols.success} ${message}`));
  } else {
    console.log(chalk.red(`  ${symbols.error} ${message}`));
  }
}

export function showInfo(message: string): void {
  const symbols = getSymbols();
  console.log(chalk.blue(`  ${symbols.info} ${message}`));
}

export function showWarning(message: string): void {
  const symbols = getSymbols();
  console.log(chalk.yellow(`  ${symbols.warning} ${message}`));
}
