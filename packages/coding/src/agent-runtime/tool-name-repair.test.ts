import { describe, expect, it } from 'vitest';
import { resolveToolNameAlias, repairToolBlockNames } from './tool-name-repair.js';

const TOOLS = ['write', 'read', 'edit', 'todo_create', 'bash'];

describe('resolveToolNameAlias', () => {
  it('returns null when the name is already a valid candidate', () => {
    expect(resolveToolNameAlias('write', TOOLS)).toBeNull();
  });

  it('repairs a case difference', () => {
    expect(resolveToolNameAlias('Write', TOOLS)).toBe('write');
    expect(resolveToolNameAlias('WRITE', TOOLS)).toBe('write');
  });

  it('repairs a separator/case difference', () => {
    expect(resolveToolNameAlias('todoCreate', TOOLS)).toBe('todo_create');
    expect(resolveToolNameAlias('todo-create', TOOLS)).toBe('todo_create');
    expect(resolveToolNameAlias('TodoCreate', TOOLS)).toBe('todo_create');
  });

  it('does NOT edit-distance-correct a genuinely different name', () => {
    // `red` is one edit from `read` but normalizes to a different key — must NOT repair.
    expect(resolveToolNameAlias('red', TOOLS)).toBeNull();
    expect(resolveToolNameAlias('reader', TOOLS)).toBeNull();
  });

  it('returns null on an unknown name with no normalized match', () => {
    expect(resolveToolNameAlias('frobnicate', TOOLS)).toBeNull();
  });

  it('returns null on an ambiguous tie (two candidates normalize the same)', () => {
    // Contrived registry where two names collide after normalization.
    const ambiguous = ['my_tool', 'mytool'];
    expect(resolveToolNameAlias('MyTool', ambiguous)).toBeNull();
  });

  it('returns null for empty / separator-only input', () => {
    expect(resolveToolNameAlias('', TOOLS)).toBeNull();
    expect(resolveToolNameAlias('__', TOOLS)).toBeNull();
  });
});

describe('repairToolBlockNames', () => {
  it('rewrites repairable names and preserves other fields (e.g. _truncated)', () => {
    const blocks = [
      { type: 'tool_use', id: 'a', name: 'Write', input: { x: 1 }, _truncated: true },
      { type: 'tool_use', id: 'b', name: 'read', input: {} },
    ];
    const out = repairToolBlockNames(blocks, TOOLS);
    expect(out[0]!.name).toBe('write');
    expect(out[0]!._truncated).toBe(true); // preserved
    expect(out[0]!.input).toEqual({ x: 1 });
    expect(out[1]).toBe(blocks[1]); // unchanged block returned by reference (no needless copy)
  });

  it('leaves unknown names untouched (the unknown-tool error path still handles them)', () => {
    const blocks = [{ type: 'tool_use', id: 'a', name: 'frobnicate', input: {} }];
    expect(repairToolBlockNames(blocks, TOOLS)[0]!.name).toBe('frobnicate');
  });
});
