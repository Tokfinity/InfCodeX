import { describe, expect, it, vi } from 'vitest';
import {
  consumeInternalSkillDispatchFlag,
  INTERNAL_SKILL_DISPATCH_ENV,
  prepareSkillToolLaunch,
  resolveSkillCreatorToolPath,
  runSkillCreatorTool,
  toFileUrl,
} from './skill_cli.js';

describe('skill CLI helpers', () => {
  it('consumes the internal dispatcher flag before tool code can spawn children', () => {
    const env = { [INTERNAL_SKILL_DISPATCH_ENV]: '1', KODAX_SENTINEL: 'preserved' };

    expect(consumeInternalSkillDispatchFlag(env)).toBe(true);
    expect(env).toEqual({ KODAX_SENTINEL: 'preserved' });
    expect(consumeInternalSkillDispatchFlag(env)).toBe(false);
  });

  it('resolves builtin skill-creator tool paths', () => {
    const toolPath = resolveSkillCreatorToolPath('package', 'C:/tmp/builtin');

    expect(toolPath.replace(/\\/g, '/')).toBe('C:/tmp/builtin/skill-creator/scripts/package-skill.js');
    expect(toFileUrl(toolPath)).toContain('package-skill.js');
  });

  it('delegates to the builtin script runner with the expected arguments', async () => {
    const runner = vi.fn<(scriptPath: string, args: string[]) => Promise<number>>(async () => 0);

    await runSkillCreatorTool('install', ['example.skill', '--dest', 'C:/skills'], runner);

    expect(runner).toHaveBeenCalledTimes(1);
    const firstCall = runner.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [scriptPath, args] = firstCall!;
    expect(String(scriptPath).replace(/\\/g, '/')).toContain('/skill-creator/scripts/install-skill.js');
    expect(args).toEqual(['example.skill', '--dest', 'C:/skills']);
  });

  it('supports init and eval tool paths as thin wrappers', () => {
    expect(resolveSkillCreatorToolPath('init', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/init-skill.js');
    expect(resolveSkillCreatorToolPath('eval', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/run-eval.js');
  });

  it('supports phase 3 evaluator tool paths as thin wrappers', () => {
    expect(resolveSkillCreatorToolPath('grade', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/grade-evals.js');
    expect(resolveSkillCreatorToolPath('analyze', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/analyze-benchmark.js');
    expect(resolveSkillCreatorToolPath('compare', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/compare-runs.js');
  });

  it('uses a guarded self-entry for bundled skill tools instead of interpreting a sidecar script', () => {
    const launch = prepareSkillToolLaunch(
      'validate',
      'C:/KodaX/builtin/skill-creator/scripts/quick-validate.js',
      ['C:/skills/example'],
      {
        bundled: true,
        executable: 'C:/KodaX/kodax.exe',
        electron: false,
        env: { KODAX_SENTINEL: 'preserved' },
      },
    );

    expect(launch.command).toBe('C:/KodaX/kodax.exe');
    expect(launch.args).toEqual([
      '__skill-tool',
      'validate',
      'C:/skills/example',
    ]);
    expect(launch.env).toMatchObject({
      KODAX_INTERNAL_SKILL_DISPATCH: '1',
      KODAX_SENTINEL: 'preserved',
    });
    expect(launch.env.BUN_BE_BUN).toBeUndefined();
  });

  it('keeps Node script execution for non-bundled skill tools', () => {
    const launch = prepareSkillToolLaunch(
      'validate',
      '/opt/kodax/builtin/skill-creator/scripts/quick-validate.js',
      ['/tmp/example'],
      {
        bundled: false,
        executable: '/usr/bin/node',
        electron: false,
        env: {},
      },
    );

    expect(launch.command).toBe('/usr/bin/node');
    expect(launch.args).toEqual([
      '/opt/kodax/builtin/skill-creator/scripts/quick-validate.js',
      '/tmp/example',
    ]);
    expect(launch.env.KODAX_INTERNAL_SKILL_DISPATCH).toBeUndefined();
  });
});
