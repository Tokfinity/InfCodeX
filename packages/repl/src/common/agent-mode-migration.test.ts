import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.KODAX_HOME;
const temporaryHomes: string[] = [];

async function loadWithConfig(config: Record<string, unknown>) {
  const home = mkdtempSync(path.join(tmpdir(), 'kodax-agent-mode-'));
  temporaryHomes.push(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), 'utf8');
  process.env.KODAX_HOME = home;
  vi.resetModules();
  const utils = await import('./utils.js');
  return { home, utils };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = originalHome;
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('v0.7.72 agent-mode config migration', () => {
  it.each(['amaw', 'ama-workflow'])('migrates persisted %s to AMA exactly once', async (legacyMode) => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { home, utils } = await loadWithConfig({ agentMode: legacyMode, provider: 'openai' });

    expect(utils.loadConfig()).toMatchObject({ agentMode: 'ama', provider: 'openai' });
    expect(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'))).toMatchObject({
      agentMode: 'ama',
      schemaVersion: 2,
    });
    expect(warning).toHaveBeenCalledTimes(1);

    expect(utils.loadConfig().agentMode).toBe('ama');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown persisted modes instead of silently entering a different mode', async () => {
    const { utils } = await loadWithConfig({ agentMode: 'mystery-mode' });
    expect(() => utils.loadConfig()).toThrow(/Invalid agentMode.*Expected "ama" or "sa"/);
  });
});
