/**
 * Skill tool — claudecode-parity invocation path for skills.
 *
 * Before this tool, the `getSystemPromptSnippet()` injected into every
 * AMA worker's system prompt told the model: "Use the read tool to load
 * the skill's `SKILL.md` and follow its instructions." That routed skill
 * invocation through generic `read` on a .md file — the model then had
 * to interpret raw markdown to figure out what to do. For a skill like
 * `agent-browser` whose description mentions "screenshots / data
 * extraction", a model handling a pasted PNG would:
 *
 *   1. Match the skill description → BLOCKING REQUIREMENT to load first
 *   2. Call `read` on `~/.claude/skills/agent-browser/SKILL.md`
 *   3. Read full markdown describing the browser-automation CLI
 *   4. Conclude "I should run `agent-browser open <path>` in the shell"
 *   5. Shell out, fail (image is already inline, not a URL), give up
 *
 * claudecode handles this differently. It has a dedicated `Skill` tool
 * (see `c:/Works/claudecode/src/tools/SkillTool/SkillTool.ts`) that
 * takes a skill name and returns structured skill content as a
 * `tool_result`. The model invokes by name, not by file path; the tool
 * does the loading + variable resolution.
 *
 * KodaX skill tool — minimal port. Replicates the invocation surface
 * (`{skill: string, args?: string}`) and content delivery, without the
 * sub-agent forking / permission UI / model-override coordination
 * claudecode layers on top (those can come incrementally if needed).
 */

import { getSkillRegistry } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';

export async function toolSkill(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const rawSkill = input.skill;
  if (typeof rawSkill !== 'string' || rawSkill.trim().length === 0) {
    return '[Tool Error] skill: missing required argument `skill` (string).';
  }
  // Strip a leading slash if present — users sometimes type `/commit`
  // out of slash-command muscle memory. Stay forgiving.
  const trimmed = rawSkill.trim();
  const skillName = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;

  const args = typeof input.args === 'string' ? input.args : '';

  const registry = getSkillRegistry();
  if (!registry.has(skillName)) {
    const available = registry
      .list()
      .map((s) => s.name)
      .sort()
      .join(', ');
    return `[Tool Error] skill: unknown skill "${skillName}". Available skills: ${available || '(none)'}.`;
  }

  const cwd = ctx.executionCwd ?? process.cwd();
  const result = await registry.invoke(skillName, args, {
    workingDirectory: cwd,
    projectRoot: ctx.gitRoot ?? cwd,
  });

  if (!result.success) {
    return `[Tool Error] skill ${skillName}: ${result.error ?? 'invocation failed'}`;
  }
  return result.content;
}
