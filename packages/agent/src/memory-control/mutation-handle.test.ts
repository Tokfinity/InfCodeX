import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryMutationHandle, matchesMemoryMutationHandle } from './mutation-handle.js';
import type { MemoryItemRef, MemoryScope } from './types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('memoryMutationHandle', () => {
  it('disambiguates the same topic basename across governed scopes', () => {
    const project = memoryRef('project', join('root', 'project', 'editor.md'));
    const agent = memoryRef('agent', join('root', 'agent', 'editor.md'));
    const user = memoryRef('user', join('root', 'user', 'editor.md'));
    const handles = [project, agent, user].map(memoryMutationHandle);

    expect(new Set(handles)).toHaveLength(3);
    expect(handles[0]).toMatch(/^memdir:project:[a-f0-9]{12}:editor\.md$/u);
    expect(handles[1]).toMatch(/^memdir:agent:[a-f0-9]{12}:editor\.md$/u);
    expect(handles[2]).toMatch(/^memdir:user:[a-f0-9]{12}:editor\.md$/u);
    expect(handles.every((handle) => !handle.includes('project:applicability'))).toBe(true);
    expect(matchesMemoryMutationHandle(project, handles[0]!)).toBe(true);
  });

  it('normalizes Windows storage-path casing for a stable handle', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const upper = memoryRef('project', 'C:\\Memory\\Editor.md');
    const lower = memoryRef('project', 'c:\\memory\\editor.md');

    expect(memoryMutationHandle(upper)).toBe(memoryMutationHandle(lower));
  });
});

function memoryRef(scope: MemoryScope, storageUri: string): MemoryItemRef {
  return {
    kind: 'memdir',
    id: `memdir:${scope}:applicability:editor.md`,
    scope,
    owner: scope === 'user' ? 'user' : scope === 'agent' ? 'agent' : 'project',
    lifecycle: 'active',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    storageUri,
  };
}
