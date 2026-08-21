import type { KodaXSkillInvocationContext } from './types.js';

/** Render the single authoritative full-content block for an active Skill. */
export function formatFullSkillSection(
  skillInvocation: KodaXSkillInvocationContext,
): string {
  return [
    'Full expanded skill (authoritative execution reference):',
    '```markdown',
    skillInvocation.expandedContent.trim(),
    '```',
  ].join('\n');
}
