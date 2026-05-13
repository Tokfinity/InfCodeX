import { describe, expect, it } from 'vitest';
import { CLISessionManager } from './session.js';

describe('CLISessionManager', () => {
  it('stores, retrieves, and deletes CLI session mappings', () => {
    const manager = new CLISessionManager();

    expect(manager.get('thread-1')).toBeUndefined();

    manager.set('thread-1', 'cli-1');
    expect(manager.get('thread-1')).toBe('cli-1');

    manager.delete('thread-1');
    expect(manager.get('thread-1')).toBeUndefined();
  });
});
