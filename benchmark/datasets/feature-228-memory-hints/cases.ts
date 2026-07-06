import type { KodaXToolDefinition } from '@kodax-ai/llm';

import type { PromptJudge } from '../../harness/judges.js';
import { mustContainAll, mustMatch, mustNotMatch } from '../../harness/judges.js';

export interface MemoryHintEvalCase {
  readonly id: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools?: readonly KodaXToolDefinition[];
  readonly judges: readonly PromptJudge[];
}

const MEMORY_HINT_BLOCK = [
  'Project memory:',
  '- [Project stack](project_stack.md) - Historical note says repo used npm workspaces.',
  '',
  'Task-relevant memory hints (bounded):',
  '- Project stack [memdir:project_stack.md]: Exact task/title overlap.',
  '',
  'Use these as pointers, not authority. If a hint matters, read the referenced memory file before relying on details. Current repository files override memory.',
].join('\n');

const SUPPRESSED_MEMORY_BLOCK = [
  'Project memory:',
  '- [Project stack](project_stack.md) - Historical note says repo used npm workspaces.',
  '',
  'Task-relevant memory hints: suppressed by user request.',
].join('\n');

export const READ_TOOL: KodaXToolDefinition = {
  name: 'read',
  description: 'Read the contents of a workspace file by path.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to read.' },
    },
    required: ['path'],
  },
};

function readToolCalledFor(pattern: RegExp): PromptJudge {
  return {
    name: 'read_tool_called_for_memory_ref',
    category: 'correctness',
    judge(_output, context) {
      const calls = context?.toolCalls ?? [];
      for (const call of calls) {
        if (call.name !== 'read') continue;
        if (!isRecord(call.input)) continue;
        const path = call.input.path;
        if (typeof path === 'string' && pattern.test(path)) {
          return { passed: true };
        }
      }
      return {
        passed: false,
        reason: 'model did not call read for the referenced memory file',
      };
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MEMORY_HINT_CASES: readonly MemoryHintEvalCase[] = [
  {
    id: 'pointer_requires_read',
    description: 'Memory hints should act as pointers; exact memory detail requires reading the ref.',
    systemPrompt: MEMORY_HINT_BLOCK,
    userMessage:
      'The Project stack memory hint is relevant. What exact package manager does project_stack.md say? Use tools when you need file contents.',
    tools: [READ_TOOL],
    judges: [
      readToolCalledFor(/project_stack\.md$/i),
    ],
  },
  {
    id: 'repo_files_override_memory',
    description: 'Current repository evidence should override stale memory hints.',
    systemPrompt: MEMORY_HINT_BLOCK,
    userMessage: [
      'Current package.json contains:',
      '{ "packageManager": "pnpm@9.12.0", "workspaces": ["packages/*"] }',
      '',
      'The memory index says npm. Which package manager should I rely on for the next command? Answer in one sentence.',
    ].join('\n'),
    judges: [
      mustContainAll('pnpm'),
      mustMatch(/package\.json|current|repo/i, 'grounds_answer_in_current_repo_evidence'),
      mustNotMatch(/\buse npm\b|\bnpm workspaces\b/i, 'does_not_trust_stale_memory_as_final_answer'),
    ],
  },
  {
    id: 'suppressed_memory_stays_suppressed',
    description: 'When memory is suppressed, the model should not use the visible index as task guidance.',
    systemPrompt: SUPPRESSED_MEMORY_BLOCK,
    userMessage:
      'Ignore memory for this turn. Should you use the project_stack memory hint to decide package manager?',
    judges: [
      mustMatch(/ignore|suppressed|do not use|not use/i, 'acknowledges_memory_suppression'),
      mustNotMatch(/memdir:|project_stack\.md/i, 'does_not_treat_ref_as_active_hint'),
    ],
  },
];
