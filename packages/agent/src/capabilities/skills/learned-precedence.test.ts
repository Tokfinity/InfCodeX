import { describe, expect, it } from 'vitest';

import { getSkillPathsFlat, type SkillPathsConfig } from './types.js';

describe('learned Skill precedence', () => {
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
