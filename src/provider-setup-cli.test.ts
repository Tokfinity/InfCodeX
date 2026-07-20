import { describe, expect, it } from 'vitest';

import { shouldAutoLaunchProviderSetup } from './provider-setup-cli.js';

describe('shouldAutoLaunchProviderSetup', () => {
  it('allows only a bare, interactive text launch', () => {
    expect(shouldAutoLaunchProviderSetup({
      outputMode: 'text',
      prompt: [],
      isInputTty: true,
      isOutputTty: true,
    })).toBe(true);
  });

  it.each([
    { outputMode: 'json' as const, prompt: [], isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: ['inspect'], isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], print: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], continue: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], resumeRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], sessionRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], helpRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], extensionRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], isInputTty: false, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], isInputTty: true, isOutputTty: false },
  ])('does not interrupt explicit or non-interactive invocation %#', (input) => {
    expect(shouldAutoLaunchProviderSetup(input)).toBe(false);
  });
});
