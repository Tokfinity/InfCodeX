import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderSetupCatalogEntry } from '../common/provider-setup.js';
import {
  runProviderSetupWizard,
  type ProviderSetupInteraction,
} from './provider-setup.js';

let tempDirectory: string;
let configPath: string;

const catalog: readonly ProviderSetupCatalogEntry[] = [{
  name: 'alpha',
  apiKeyEnv: 'ALPHA_API_KEY',
  defaultModel: 'alpha-default',
  models: ['alpha-default', 'alpha-fast'],
}];

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'kodax-provider-wizard-'));
  configPath = join(tempDirectory, 'config.json');
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function scriptedInteraction(input: {
  readonly choices?: readonly string[];
  readonly texts?: readonly string[];
  readonly confirm?: boolean;
}): { readonly interaction: ProviderSetupInteraction; readonly prompts: string[] } {
  const choices = [...(input.choices ?? [])];
  const texts = [...(input.texts ?? [])];
  const prompts: string[] = [];
  return {
    prompts,
    interaction: {
      choose: async (message) => {
        prompts.push(message);
        return choices.shift();
      },
      text: async (message) => {
        prompts.push(message);
        return texts.shift();
      },
      confirm: async (message) => {
        prompts.push(message);
        return input.confirm ?? false;
      },
    },
  };
}

describe('runProviderSetupWizard', () => {
  it('persists a built-in provider/model without ever collecting a secret', async () => {
    const scripted = scriptedInteraction({
      choices: ['builtin:alpha', 'alpha-fast'],
      confirm: true,
    });

    const result = await runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    });

    expect(result).toMatchObject({
      status: 'configured',
      selection: { provider: 'alpha', model: 'alpha-fast', apiKeyEnv: 'ALPHA_API_KEY' },
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      provider: 'alpha',
      model: 'alpha-fast',
    });
    expect(scripted.prompts.join('\n')).not.toMatch(/enter|paste|input.*api key/i);
  });

  it('cancels without creating config', async () => {
    const scripted = scriptedInteraction({ choices: ['cancel'] });

    await expect(runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });

  it('persists only public custom-provider metadata', async () => {
    const scripted = scriptedInteraction({
      choices: ['custom', 'openai'],
      texts: ['local', 'https://example.test/v1', 'LOCAL_API_KEY', 'local-model'],
      confirm: true,
    });

    const result = await runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    });

    expect(result.status).toBe('configured');
    const persisted = readFileSync(configPath, 'utf8');
    expect(persisted).toContain('LOCAL_API_KEY');
    expect(persisted).not.toMatch(/apiKeyValue|secret|token/i);
  });

  it('rejects credential-bearing endpoint metadata before confirmation can echo it', async () => {
    const privateUrl = 'https://user:private-value@example.test/v1';
    const scripted = scriptedInteraction({
      choices: ['custom', 'openai'],
      texts: ['unsafe', privateUrl, 'UNSAFE_API_KEY', 'unsafe-model'],
      confirm: true,
    });

    await expect(runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    })).rejects.toThrow(/must not contain credentials/i);
    expect(scripted.prompts.join('\n')).not.toContain(privateUrl);
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });
});
