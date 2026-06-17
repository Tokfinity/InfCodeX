import { describe, expect, it } from 'vitest';
import {
  SLASH_MID_TASK_GUARD_DEDUPE_KEY,
  SLASH_MID_TASK_GUARD_MESSAGE,
  isSlashCommandText,
} from './slash-mid-task-guard.js';

describe('slash-mid-task-guard (FEATURE_149 Slice C6)', () => {
  describe('isSlashCommandText', () => {
    it('detects a leading slash', () => {
      expect(isSlashCommandText('/cost')).toBe(true);
      expect(isSlashCommandText('/clear')).toBe(true);
      expect(isSlashCommandText('/help')).toBe(true);
      expect(isSlashCommandText('/agents list')).toBe(true);
    });

    it('detects a slash after leading whitespace (soft-tab muscle memory)', () => {
      expect(isSlashCommandText(' /cost')).toBe(true);
      expect(isSlashCommandText('  /cost')).toBe(true);
      expect(isSlashCommandText('\t/cost')).toBe(true);
      expect(isSlashCommandText('\n/cost')).toBe(true);
    });

    it('rejects regular prompts that merely mention a slash', () => {
      expect(isSlashCommandText('use the /api endpoint')).toBe(false);
      expect(isSlashCommandText('foo/bar')).toBe(false);
      expect(isSlashCommandText('a / b')).toBe(false);
      expect(isSlashCommandText('explain how /etc/hosts works')).toBe(false);
    });

    it('rejects empty input and whitespace-only input', () => {
      expect(isSlashCommandText('')).toBe(false);
      expect(isSlashCommandText(' ')).toBe(false);
      expect(isSlashCommandText('   ')).toBe(false);
      expect(isSlashCommandText('\t\t')).toBe(false);
      expect(isSlashCommandText('\n\n')).toBe(false);
    });

    it('treats only a single solitary slash as a slash command', () => {
      // Pathological input — a user mashing Enter on a `/` is still a
      // slash command attempt. Better to tell them to abort than send
      // "/" verbatim to the LLM.
      expect(isSlashCommandText('/')).toBe(true);
    });
  });

  describe('exported constants', () => {
    it('message text mentions double Esc and Ctrl+C as abort gestures', () => {
      // The message must tell the user how to recover. Pin both the
      // gesture name and the imperative form so a wording drift gets
      // caught — the parity-audit ship gate depends on this UX.
      expect(SLASH_MID_TASK_GUARD_MESSAGE).toContain('Esc');
      expect(SLASH_MID_TASK_GUARD_MESSAGE).toContain('twice');
      expect(SLASH_MID_TASK_GUARD_MESSAGE).toContain('Ctrl+C');
      expect(SLASH_MID_TASK_GUARD_MESSAGE).toContain('abort');
    });

    it('dedupe key is distinct from queue-limit so the two notices coexist', () => {
      // FEATURE_149 review found that sharing the `'queue-limit'` key
      // caused the slash notice to be silently swallowed when both
      // conditions hit in close succession. Pin the key separation.
      expect(SLASH_MID_TASK_GUARD_DEDUPE_KEY).toBe('slash-guard');
      expect(SLASH_MID_TASK_GUARD_DEDUPE_KEY).not.toBe('queue-limit');
    });
  });
});
