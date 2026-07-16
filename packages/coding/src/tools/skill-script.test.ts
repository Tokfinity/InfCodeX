import { describe, expect, it, vi } from 'vitest';

import { toolRunSkillScript } from './skill-script.js';

describe('run_skill_script tool', () => {
  it('is unavailable without a run-scoped sandbox broker', async () => {
    await expect(toolRunSkillScript({ skill: 'reports', script: 'scripts/render.py' }, {
      backups: new Map(), executionCwd: '/workspace',
    })).rejects.toThrow(/unavailable/i);
  });

  it('passes only validated structured mappings to the broker', async () => {
    const run = vi.fn(async () => 'rendered');
    await expect(toolRunSkillScript({
      skill: 'reports',
      script: 'scripts/render.py',
      args: ['--title', 'Quarterly'],
      inputs: [{ path: 'data/report.csv', as: 'report.csv' }],
      outputs: [{ path: 'deck.pptx', target: 'deliverables/deck.pptx' }],
    }, {
      backups: new Map(),
      executionCwd: '/workspace',
      skillScriptRunner: { run, dispose: async () => undefined },
    })).resolves.toBe('rendered');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      skill: 'reports',
      script: 'scripts/render.py',
      inputs: [{ path: 'data/report.csv', as: 'report.csv' }],
      outputs: [{ path: 'deck.pptx', target: 'deliverables/deck.pptx' }],
    }), expect.objectContaining({ workspaceRoot: '/workspace' }));
  });

  it('rejects unknown mapping fields before the host boundary', async () => {
    const run = vi.fn(async () => 'unused');
    await expect(toolRunSkillScript({
      skill: 'reports', script: 'scripts/render.py', inputs: [{ path: 'x', secret: true }],
    }, {
      backups: new Map(), executionCwd: '/workspace',
      skillScriptRunner: { run, dispose: async () => undefined },
    })).rejects.toThrow(/unknown field/i);
    expect(run).not.toHaveBeenCalled();
  });
});
