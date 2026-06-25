import { describe, expect, it } from 'vitest';
import { resolvePermissionModeEffort } from './utils.js';

describe('resolvePermissionModeEffort', () => {
  it('uses planModeEffort in plan mode when no session override exists', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'medium',
      permissionMode: 'plan',
    })).toBe('medium');
  });

  it('lets explicit session effort override planModeEffort', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      effortOverride: true,
      planModeEffort: 'medium',
      permissionMode: 'plan',
    })).toBe('high');
  });

  it('treats planModeEffort none as an explicit plan-mode default', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'none',
      permissionMode: 'plan',
    })).toBe('none');
  });

  it('falls back to global effort outside plan mode', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'medium',
      permissionMode: 'accept-edits',
    })).toBe('high');
  });
});
