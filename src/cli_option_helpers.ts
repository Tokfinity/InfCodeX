import { Command, InvalidArgumentError } from 'commander';
import {
  KodaXOptions,
  KodaXReasoningMode,
  KODAX_REASONING_MODE_SEQUENCE,
} from '@kodax/coding';
import {
  createCliEvents,
  FileSessionStorage,
  type PermissionMode,
} from '@kodax/repl';

export const ACP_PERMISSION_MODES: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];

export interface CliOptions {
  provider: string;
  model?: string;
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  session?: string;
  parallel: boolean;
  team?: string;
  init?: string;
  append: boolean;
  overwrite: boolean;
  maxIter?: number;
  autoContinue: boolean;
  maxSessions: number;
  maxHours: number;
  prompt: string[];
  continue?: boolean;
  resume?: string;
  noSession: boolean;
  print?: boolean;
}

export function parsePermissionModeOption(value: string): PermissionMode {
  if (ACP_PERMISSION_MODES.includes(value as PermissionMode)) {
    return value as PermissionMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${ACP_PERMISSION_MODES.join(', ')}.`,
  );
}

export function resolveCliReasoningMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  const reasoningSource = program.getOptionValueSource('reasoning');
  if (reasoningSource === 'cli' && typeof opts.reasoning === 'string') {
    if (!KODAX_REASONING_MODE_SEQUENCE.includes(opts.reasoning as KodaXReasoningMode)) {
      throw new Error(
        `Invalid reasoning mode "${opts.reasoning}". Expected one of: ${KODAX_REASONING_MODE_SEQUENCE.join(', ')}`,
      );
    }
    return opts.reasoning as KodaXReasoningMode;
  }

  const thinkingSource = program.getOptionValueSource('thinking');
  if (thinkingSource === 'cli' && opts.thinking === true) {
    return 'auto';
  }

  if (config.reasoningMode) {
    return config.reasoningMode;
  }

  if (config.thinking === true) {
    return 'auto';
  }

  return 'auto';
}

export function resolveCliParallel(
  program: Command,
  opts: Record<string, unknown>,
  config: { parallel?: boolean },
): boolean {
  const parallelSource = program.getOptionValueSource('parallel');
  if (parallelSource === 'cli') {
    return opts.parallel === true;
  }

  return config.parallel ?? false;
}

export function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function parseNonNegativeIntWithFallback(value: string | undefined, fallback: number): number {
  return parseOptionalNonNegativeInt(value) ?? fallback;
}

export function parsePositiveNumberWithFallback(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function createKodaXOptions(cliOptions: CliOptions, isPrintMode = false): KodaXOptions {
  return {
    provider: cliOptions.provider,
    model: cliOptions.model,
    thinking: cliOptions.thinking,
    reasoningMode: cliOptions.reasoningMode,
    maxIter: cliOptions.maxIter,
    parallel: cliOptions.parallel,
    session: buildSessionOptions(cliOptions),
    events: createCliEvents(!isPrintMode),
  };
}

export function buildSessionOptions(
  cliOptions: CliOptions,
): { id?: string; resume?: boolean; storage: FileSessionStorage; autoResume?: boolean } | undefined {
  const storage = new FileSessionStorage();

  if (cliOptions.print && cliOptions.noSession) {
    return undefined;
  }

  if (cliOptions.resume) {
    return { id: cliOptions.resume, storage };
  }

  if (cliOptions.continue) {
    return { resume: true, storage };
  }

  if (cliOptions.session === 'resume') {
    return { resume: true, storage };
  }

  if (
    cliOptions.session
    && cliOptions.session !== 'list'
    && cliOptions.session !== 'delete-all'
    && !cliOptions.session.startsWith('delete ')
  ) {
    return { id: cliOptions.session, storage };
  }

  if (cliOptions.print) {
    return { storage };
  }

  if (!cliOptions.prompt?.length) {
    return { storage };
  }

  return { storage };
}
