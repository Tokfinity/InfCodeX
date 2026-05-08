/**
 * Unicode Edit Fallback Behavioral Dataset — FEATURE_146-C (v0.7.37).
 *
 * See ./README.md for the product question and run model. This module
 * exports:
 *
 *   - `UNICODE_EDIT_TASKS`        — 10 edit tasks (5 positive Unicode-prone
 *                                   + 5 negative ASCII-only false-positive
 *                                   guards). Each task carries a haystack,
 *                                   a user instruction asking for a
 *                                   targeted edit, and `expectedClass`.
 *   - `UNICODE_EDIT_TOOLS`        — minimal tool surface (just `edit`,
 *                                   shaped to the runtime schema)
 *   - `buildUnicodeEditSystemPrompt()` — system prompt under test;
 *                                   instructs the LLM to use `edit` and
 *                                   produce verbatim `old_string`
 *
 * Why we provide the haystack inline in the user message rather than via
 * a `read` tool: the eval is single-turn (one provider.stream call per
 * cell). Forcing the LLM to read first would require multi-turn infra.
 * Embedding the haystack inline is a faithful proxy — if anything, it
 * makes byte-exact matching MORE likely (the haystack bytes are right
 * there in context), so any Unicode drift the LLM still emits is a
 * conservative (lower-bound) estimate of in-the-wild rates.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

export type UnicodeTaskClass = 'positive' | 'negative';
export type UnicodeTaskId =
  | 'p1-smart-quotes-comment'
  | 'p2-em-dash-doc'
  | 'p3-nbsp-todo-comment'
  | 'p4-smart-single-quote-docstring'
  | 'p5-en-dash-range-comment'
  | 'n1-plain-rename-symbol'
  | 'n2-plain-update-import'
  | 'n3-plain-add-return-type'
  | 'n4-plain-rename-string'
  | 'n5-plain-update-numeric-literal';

export interface UnicodeEditTaskCase {
  readonly id: UnicodeTaskId;
  readonly taskClass: UnicodeTaskClass;
  readonly description: string;
  readonly haystack: string;
  /**
   * The line / region in the haystack the user wants modified. The LLM
   * is given the haystack inline and asked to emit an `edit` tool call
   * with `old_string` matching this region (verbatim or as the LLM
   * chooses to copy it).
   */
  readonly userInstruction: string;
}

const POSITIVE_CASES: readonly UnicodeEditTaskCase[] = Object.freeze([
  {
    id: 'p1-smart-quotes-comment',
    taskClass: 'positive',
    description: 'Comment around "user input" — LLM may emit smart quotes',
    haystack: [
      'function authenticate(user) {',
      '  // "user" must be non-empty and trimmed',
      '  if (!user) throw new Error("empty");',
      '  return user.trim();',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'In the file content I just showed you, change the comment line ' +
      '(the one mentioning "user" must be non-empty and trimmed) so it instead reads: ' +
      '`// "user" must be non-empty, trimmed, and lowercased`. ' +
      'Use the `edit` tool with old_string copied verbatim from the file and a new_string ' +
      'that reflects the updated comment.',
  },
  {
    id: 'p2-em-dash-doc',
    taskClass: 'positive',
    description: 'Doc comment with -- separator — LLM may emit em-dash',
    haystack: [
      '// args -- the command-line arguments parsed by the CLI',
      'export function parseArgs(args: string[]): ParsedArgs {',
      '  return { positional: args };',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'In the file I just showed you, update the first line (the comment line about ' +
      '`args -- the command-line arguments parsed by the CLI`) to read instead: ' +
      '`// args -- the command-line arguments after option parsing`. ' +
      'Call the `edit` tool with old_string copied verbatim from the file and the updated ' +
      'new_string.',
  },
  {
    id: 'p3-nbsp-todo-comment',
    taskClass: 'positive',
    description: 'TODO comment — LLM may emit nbsp inside the comment text',
    haystack: [
      'export function compute(x: number): number {',
      '  // TODO: refactor this branch when the new pipeline lands',
      '  return x * 2;',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'In the file I just showed you, change the TODO comment line to instead read: ' +
      '`// TODO: refactor this branch once the new pipeline lands and is tested`. ' +
      'Use the `edit` tool with old_string copied verbatim from the file and the updated new_string.',
  },
  {
    id: 'p4-smart-single-quote-docstring',
    taskClass: 'positive',
    description: 'Docstring with `Don\'t` — LLM may emit smart single quote',
    haystack: [
      '/**',
      " * Don't pass null here — pass undefined or the empty string instead.",
      ' */',
      'export function process(input: string | undefined): string {',
      "  return input ?? '';",
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'In the file I just showed you, update the docstring line that says ' +
      '`Don\'t pass null here — pass undefined or the empty string instead.` ' +
      'to instead say: ' +
      '`Don\'t pass null here. Use undefined or the empty string instead.` ' +
      'Use the `edit` tool with old_string copied verbatim from the file and the updated new_string.',
  },
  {
    id: 'p5-en-dash-range-comment',
    taskClass: 'positive',
    description: 'Range comment 1-10 — LLM may emit en-dash',
    haystack: [
      '// range: 1-10 inclusive',
      'for (let i = 1; i <= 10; i++) {',
      '  doSomething(i);',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'In the file I just showed you, update the range comment ' +
      '(the line saying `range: 1-10 inclusive`) to read instead: ' +
      '`// range: 1-10 inclusive (inclusive on both ends)`. ' +
      'Use the `edit` tool with old_string copied verbatim from the file and the updated new_string.',
  },
]);

const NEGATIVE_CASES: readonly UnicodeEditTaskCase[] = Object.freeze([
  {
    id: 'n1-plain-rename-symbol',
    taskClass: 'negative',
    description: 'Plain ASCII function rename — false-positive guard',
    haystack: [
      'export function getUserCount(): number {',
      '  return users.length;',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'Rename the function `getUserCount` to `getActiveUserCount` in the file I just showed you. ' +
      'Use the `edit` tool with old_string copied verbatim from the file (the line containing ' +
      '`export function getUserCount(): number {`) and the corresponding renamed new_string.',
  },
  {
    id: 'n2-plain-update-import',
    taskClass: 'negative',
    description: 'Plain ASCII import update — false-positive guard',
    haystack: [
      "import { foo } from './foo';",
      "import { bar } from './bar';",
      '',
      'export function combined() {',
      '  return foo() + bar();',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'Update the first import line (`import { foo } from \'./foo\';`) so it imports `bar` and `foo` ' +
      'from `./foo`: that is, the new line should be `import { bar, foo } from \'./foo\';`. ' +
      'Use the `edit` tool with old_string copied verbatim and the rewritten new_string.',
  },
  {
    id: 'n3-plain-add-return-type',
    taskClass: 'negative',
    description: 'Plain ASCII return-type addition — false-positive guard',
    haystack: [
      'export function double(x: number) {',
      '  return x * 2;',
      '}',
      '',
    ].join('\n'),
    userInstruction:
      'Add an explicit `: number` return type annotation to the `double` function. ' +
      'Use the `edit` tool: old_string should be `export function double(x: number) {` ' +
      '(copied verbatim from the file) and new_string should be `export function double(x: number): number {`.',
  },
  {
    id: 'n4-plain-rename-string',
    taskClass: 'negative',
    description: 'Plain ASCII string-literal rename — false-positive guard',
    haystack: [
      "const STATUS_OK = 'ok';",
      "const STATUS_FAIL = 'fail';",
      '',
    ].join('\n'),
    userInstruction:
      'Change the value of `STATUS_OK` from `\'ok\'` to `\'success\'`. ' +
      'Use the `edit` tool with old_string equal to the line `const STATUS_OK = \'ok\';` ' +
      '(copied verbatim from the file) and new_string equal to `const STATUS_OK = \'success\';`.',
  },
  {
    id: 'n5-plain-update-numeric-literal',
    taskClass: 'negative',
    description: 'Plain ASCII numeric literal update — false-positive guard',
    haystack: [
      'const TIMEOUT_MS = 3000;',
      'const RETRY_LIMIT = 3;',
      '',
    ].join('\n'),
    userInstruction:
      'Change `TIMEOUT_MS` from `3000` to `5000`. ' +
      'Use the `edit` tool with old_string equal to `const TIMEOUT_MS = 3000;` ' +
      '(copied verbatim from the file) and new_string equal to `const TIMEOUT_MS = 5000;`.',
  },
]);

export const UNICODE_EDIT_TASKS: readonly UnicodeEditTaskCase[] = Object.freeze([
  ...POSITIVE_CASES,
  ...NEGATIVE_CASES,
]);

export const UNICODE_EDIT_TOOLS: readonly KodaXToolDefinition[] = Object.freeze([
  {
    name: 'edit',
    description:
      'Edit an existing file by replacing an exact-string anchor `old_string` with `new_string`. ' +
      '`old_string` MUST be copied verbatim from the file content — byte-for-byte. ' +
      'Use this tool to make a precise targeted change.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit.' },
        old_string: {
          type: 'string',
          description: 'Verbatim text from the file to replace. Must be unique in the file.',
        },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
]);

/**
 * System prompt for the eval — instructs the LLM to use `edit` with a
 * verbatim `old_string`. Mirrors the runtime `MUTATION DISCIPLINE`
 * guidance in `worker-role-prompt.ts`.
 */
export function buildUnicodeEditSystemPrompt(): string {
  return [
    'You are a coding assistant editing TypeScript files.',
    '',
    'MUTATION DISCIPLINE:',
    '- Prefer `edit` over `write` for existing files (smaller token footprint, diff-safe).',
    '- `old_string` MUST be copied verbatim from the file content — byte-for-byte. ' +
      'Mismatched bytes (smart quotes vs straight quotes, em-dash vs ASCII --, ' +
      'non-breaking space vs space) cause the edit to fail.',
    '- Pick a unique `old_string` snippet — usually a single line is enough. ' +
      'Include enough surrounding context to disambiguate if the line text appears more than once.',
    '',
    'When the user asks for an edit, immediately emit a single `edit` tool_use ' +
    'call with `path`, `old_string`, and `new_string`.',
  ].join('\n');
}
