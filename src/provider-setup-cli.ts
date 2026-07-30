import type { CliOutputMode } from './cli_option_helpers.js';

export function hasProviderCredentialEnvironment(
  names: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return names.some((name) => Boolean(environment[name]?.trim()));
}

export function renderMissingProviderCredentialGuide(
  environmentNames: readonly string[],
): string {
  const names = [...new Set(environmentNames.map((name) => name.trim()).filter(Boolean))];
  const exampleName = names[0] ?? 'OPENAI_API_KEY';
  return [
    'KodaX did not detect a supported provider API key environment variable.',
    'KodaX does not collect or store API key values. Set one of these variables:',
    ...names.map((name) => `  - ${name}`),
    '',
    names.length > 1
      ? `Choose one listed variable for your provider. The examples below use "${exampleName}".`
      : `Use the listed variable "${exampleName}" for this provider.`,
    '',
    'Windows PowerShell (persistent user environment variable):',
    `  [Environment]::SetEnvironmentVariable("${exampleName}", "<your-key>", "User")`,
    '',
    'macOS (zsh):',
    `  Add \`export ${exampleName}="<your-key>"\` to ~/.zshrc.`,
    '',
    'Linux (bash):',
    `  Add \`export ${exampleName}="<your-key>"\` to ~/.bashrc.`,
    '',
    'After adding the variable, close this terminal and open a new terminal, then run `kodax` again.',
    'For custom providers or providers authenticated by their own CLI, run `kodax setup`.',
  ].join('\n');
}

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
