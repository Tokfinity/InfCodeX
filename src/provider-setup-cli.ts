import type { CliOutputMode } from './cli_option_helpers.js';

/** Keep first-run setup out of every scripted, resumed, and sub-mode path. */
export function shouldAutoLaunchProviderSetup(input: {
  readonly outputMode: CliOutputMode;
  readonly prompt: readonly string[];
  readonly print?: boolean;
  readonly continue?: boolean;
  readonly resumeRequested?: boolean;
  readonly sessionRequested?: boolean;
  readonly helpRequested?: boolean;
  readonly extensionRequested?: boolean;
  readonly isInputTty: boolean | undefined;
  readonly isOutputTty: boolean | undefined;
}): boolean {
  return input.outputMode === 'text'
    && input.prompt.length === 0
    && input.print !== true
    && input.continue !== true
    && input.resumeRequested !== true
    && input.sessionRequested !== true
    && input.helpRequested !== true
    && input.extensionRequested !== true
    && input.isInputTty === true
    && input.isOutputTty === true;
}
