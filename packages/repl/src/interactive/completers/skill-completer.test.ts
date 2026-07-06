/**
 * Tests for Skill Completer - 技能补全器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test data
const mockSkills = [
  { name: 'feature-list-tracker', description: 'Track features' },
  { name: 'human-test-guide', description: 'Generate test guides' },
  { name: 'start-next-feature', description: 'Start feature implementation' },
  { name: 'complete-feature', description: 'Complete feature' },
  { name: 'github:yeet', description: 'Publish local changes' },
];

// Create mock function at module scope
const mockListUserInvocable = vi.fn();

// Mock the skills module - must be before any imports that use it
vi.mock('@kodax-ai/agent', () => ({
  getSkillRegistry: vi.fn(() => ({
    size: 1,
    listUserInvocable: mockListUserInvocable,
  })),
  initializeSkillRegistry: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock
import { SkillCompleter } from '../completers/skill-completer.js';

describe('SkillCompleter', () => {
  let completer: SkillCompleter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to return skills
    mockListUserInvocable.mockReturnValue([...mockSkills]);
    completer = new SkillCompleter();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canComplete', () => {
    it('should trigger on /skill: prefix', () => {
      // cursorPos = string.length to capture full string with slice(0, cursorPos)
      expect(completer.canComplete('/skill:', 7)).toBe(true);
      expect(completer.canComplete('/skill:f', 8)).toBe(true);
      expect(completer.canComplete('/skill:feature', 14)).toBe(true);
    });

    it('should trigger on direct slash skill prefixes', () => {
      expect(completer.canComplete('/', 1)).toBe(true);
      expect(completer.canComplete('/feat', 5)).toBe(true);
      expect(completer.canComplete('/github:', 8)).toBe(true);
      expect(completer.canComplete('hello /feat', 11)).toBe(true);
    });

    it('should not trigger without a slash prefix', () => {
      expect(completer.canComplete('skill:', 6)).toBe(false);
      expect(completer.canComplete('@file', 5)).toBe(false);
    });

    it('should not trigger after space', () => {
      expect(completer.canComplete('/skill: test', 12)).toBe(false);
    });

    it('should handle cursor at different positions', () => {
      // Cursor before /skill: - should not complete
      expect(completer.canComplete('/skill:feature', 0)).toBe(false);

      // Cursor in the middle of /skill: - should complete
      expect(completer.canComplete('/skill:feature', 7)).toBe(true);
    });

    it('should trigger after a newline boundary', () => {
      expect(completer.canComplete('hello\n/skill:feature', 20)).toBe(true);
      expect(completer.canComplete('hello\n/feature', 14)).toBe(true);
    });
  });

  describe('getCompletions', () => {
    it('should return matching skills for legacy /skill: input', async () => {
      const completions = await completer.getCompletions('/skill:f', 7);

      expect(completions.length).toBeGreaterThan(0);
      expect(completions.some(c => c.display.includes('feature'))).toBe(true);
    });

    it('should return matching skills for direct slash input', async () => {
      const completions = await completer.getCompletions('/feat', 5);

      expect(completions.length).toBeGreaterThan(0);
      expect(completions.some(c => c.text === '/feature-list-tracker')).toBe(true);
    });

    it('should return all skills when pattern is empty', async () => {
      const completions = await completer.getCompletions('/skill:', 7);

      expect(completions.length).toBe(5); // All mock skills
    });

    it('should complete namespaced direct slash skills', async () => {
      const completions = await completer.getCompletions('/github:', 8);

      expect(completions.some(c => c.text === '/github:yeet')).toBe(true);
    });

    it('should filter skills by prefix (case-insensitive)', async () => {
      const completions = await completer.getCompletions('/skill:START', 12);

      // "start-next-feature" matches with prefix, but "start-next-feature" is the only one
      // that starts with "start". However, "complete-feature" might also match via fuzzyIncludes
      // Let's just verify at least one match and it includes the expected skill
      expect(completions.length).toBeGreaterThanOrEqual(1);
      expect(completions.some(c => c.display === 'start-next-feature')).toBe(true);
    });

    it('should return completion with direct slash format by default', async () => {
      const completions = await completer.getCompletions('/feature', 8);

      expect(completions.length).toBeGreaterThan(0);
      const first = completions[0]!;
      expect(first.text).toMatch(/^\/[^/]/);
      expect(first.text).not.toMatch(/^\/skill:/);
      expect(first.display).toBeDefined();
      expect(first.type).toBe('skill');
      expect(first.description).toBeDefined();
    });

    it('should preserve legacy /skill: completion format', async () => {
      const completions = await completer.getCompletions('/skill:feature', 14);

      expect(completions.length).toBeGreaterThan(0);
      const first = completions[0]!;
      expect(first.text).toMatch(/^\/skill:/);
      expect(first.display).toBeDefined();
      expect(first.type).toBe('skill');
      expect(first.description).toBeDefined();
    });

    it('should return empty array for no matches', async () => {
      const completions = await completer.getCompletions('/skill:nonexistent', 18);

      expect(completions).toEqual([]);
    });
  });

  describe('setGitRoot', () => {
    it('should update git root', () => {
      // Should not throw
      expect(() => completer.setGitRoot('/new/path')).not.toThrow();
    });

    it('should invalidate cache when git root changes', async () => {
      // First call to populate cache
      await completer.getCompletions('/skill:', 7);

      // Change git root
      completer.setGitRoot('/new/path');

      // Clear mock call count
      mockListUserInvocable.mockClear();

      // Next call should refresh cache (cache was invalidated)
      await completer.getCompletions('/skill:', 7);
      expect(mockListUserInvocable).toHaveBeenCalled();
    });
  });

  describe('registry reads', () => {
    it('should read the current registry list each time', async () => {
      await completer.getCompletions('/skill:', 7);
      const callCountAfterFirst = mockListUserInvocable.mock.calls.length;

      await completer.getCompletions('/skill:f', 8);

      expect(mockListUserInvocable.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });
  });
});
