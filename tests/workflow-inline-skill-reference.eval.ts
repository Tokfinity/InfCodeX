/**
 * Eval: FEATURE_236 workflow inline skill reference propagation.
 *
 * What this measures
 *
 * The unit tests prove KodaX inserts a `## Referenced Skills` briefing block
 * when a workflow child objective contains `/skill:<name>`. That is Layer 1.
 * This Layer 2 probe checks the LLM-facing behavior the block is meant to
 * cause: with the production `skill` tool definition available, the next
 * assistant action should invoke `skill` for `feature-list-tracker` before
 * doing the task.
 *
 * Fixed input
 *
 * - system: production `CHILD_AGENT_SYSTEM_PROMPT`
 * - user: child briefing slice containing Objective + Referenced Skills block
 * - tools: production `skill` tool definition only
 *
 * Expected output
 *
 * - provider emits a tool call named `skill`
 * - tool input has `skill: "feature-list-tracker"` or
 *   `skill: "/feature-list-tracker"`
 *
 * Pilot run
 *
 *   npm run test:eval -- workflow-inline-skill-reference
 *
 * Cost budget: 1 alias x 1 case x 1 run, normally below $0.10. Raw dumps land
 * under `os.tmpdir()/kodax-eval-dumps/workflow-inline-skill-reference/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { CHILD_AGENT_SYSTEM_PROMPT } from '../packages/coding/src/child-executor.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'workflow-inline-skill-reference');

const USER_MESSAGE = [
  '# Child Agent Task',
  '',
  'You are a focused sub-agent executing a specific task in parallel with siblings.',
  '',
  '## Objective',
  'Register the animation work according to /skill:feature-list-tracker.',
  '',
  '## Referenced Skills',
  'The objective mentions skill reference(s): /skill:feature-list-tracker.',
  'Before acting on those instructions, invoke the `skill` tool for each referenced skill that is not already expanded in this briefing, then follow the returned skill instructions. Do not infer skill-specific rules from the slash token alone.',
  '',
  '## Output Format',
  'When done, provide a concise text summary.',
].join('\n');

function readSkillName(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.skill === 'string' ? record.skill : undefined;
}

describe('Eval: FEATURE_236 workflow inline skill references', () => {
  const aliases = availableAliases(PILOT_ALIAS);
  const skillTool = getToolDefinition('skill');

  if (aliases.length === 0 || !skillTool) {
    it('skips: missing pilot alias credentials or skill tool definition', () => {
      expect(skillTool?.name ?? 'skill').toBe('skill');
    });
    return;
  }

  for (const alias of aliases) {
    it(
      `${alias} calls skill before acting on /skill:feature-list-tracker`,
      { timeout: 120_000 },
      async () => {
        const out = await runOneShot(alias, {
          systemPrompt: CHILD_AGENT_SYSTEM_PROMPT,
          userMessage: USER_MESSAGE,
          tools: [skillTool],
        });

        const skillCalls = out.toolCalls.filter((call) => call.name === 'skill');
        const calledFeatureList = skillCalls.some((call) => {
          const name = readSkillName(call.input);
          return name === 'feature-list-tracker' || name === '/feature-list-tracker';
        });

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${alias.replace(/[\\/]/g, '__')}.json`);
        writeFileSync(
          dumpPath,
          JSON.stringify({
            case: 'child-inline-skill-reference',
            alias,
            userMessage: USER_MESSAGE,
            text: out.text,
            toolCalls: out.toolCalls,
            durationMs: out.durationMs,
            passed: calledFeatureList,
          }, null, 2),
          'utf8',
        );

        expect(calledFeatureList).toBe(true);
      },
    );
  }
});
