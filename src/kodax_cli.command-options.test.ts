import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { mergeCommandOptionsWithGlobals } from './cli_option_helpers.js';
import { configureKodaXRootCommand } from './kodax_cli.js';

describe('KodaX root/subcommand option ownership', () => {
  it('makes a duplicated option after the subcommand available to its action', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    let receivedProvider: string | undefined;
    program.command('host')
      .option('--provider <name>')
      .action((localOptions: { provider?: string }, command: Command) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        receivedProvider = options.provider;
      });

    await program.parseAsync(['node', 'kodax', 'host', '--provider', 'child-provider']);

    expect(receivedProvider).toBe('child-provider');
  });

  it('keeps a prefixed root option visible to a subcommand through global options', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    let receivedProvider: string | undefined;
    program.command('host')
      .option('--provider <name>')
      .action((localOptions: { provider?: string }, command: Command) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        receivedProvider = options.provider;
      });

    await program.parseAsync(['node', 'kodax', '--provider', 'root-provider', 'host']);

    expect(receivedProvider).toBe('root-provider');
    expect(program.args[0]).toBe('host');
  });

  it('preserves root option parsing after a normal prompt argument', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());

    await program.parseAsync(['node', 'kodax', 'summarize', '--provider', 'root-provider']);

    expect(program.opts().provider).toBe('root-provider');
    expect(program.args).toEqual(['summarize']);
  });
});
