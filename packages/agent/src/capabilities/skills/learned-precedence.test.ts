import { describe, expect, it } from 'vitest';

import {
  getSkillPathsFlat,
  type ResolvedSkillSource,
  type SkillPathsConfig,
  type SkillSource,
} from './types.js';

describe('learned Skill precedence', () => {
  it('keeps the legacy SkillSource union exhaustive while exposing learned discovery', () => {
    const labels: Record<SkillSource, string> = {
      project: 'project',
      user: 'user',
      plugin: 'plugin',
      builtin: 'builtin',
    };
    const learned: ResolvedSkillSource = 'learned';
    expect(labels.builtin).toBe('builtin');
    expect(learned).toBe('learned');
  });

  it('discovers learned Skills after every formal source', () => {
    const config: SkillPathsConfig = {
      projectPaths: ['project'],
      userPaths: ['user'],
      pluginPaths: ['plugin'],
      builtinPath: 'builtin',
      learnedPath: 'learned',
    };

    expect(getSkillPathsFlat(config)).toEqual([
      { path: 'project', source: 'project' },
      { path: 'user', source: 'user' },
      { path: 'plugin', source: 'plugin' },
      { path: 'builtin', source: 'builtin' },
      { path: 'learned', source: 'learned' },
    ]);
  });
});
