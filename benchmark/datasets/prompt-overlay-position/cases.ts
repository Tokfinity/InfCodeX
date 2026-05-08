/**
 * Prompt Overlay Position Behavioral Dataset — FEATURE_146-A (v0.7.37).
 *
 * See ./README.md for the product question and run model.
 *
 * The dataset exports 6 tasks; each carries one **observable directive**
 * embedded in `overlayText`. The eval driver runs each task in TWO
 * variants:
 *   - Variant A (legacy v0.7.35.1): bare role prompt, overlay prepended
 *     to user message
 *   - Variant B (v0.7.36): role prompt with overlay rendered as a
 *     `[Routing Notes]` section via `createRolePrompt`, bare user message
 *
 * Each task carries a mechanical `predicate` checking whether the
 * overlay directive surfaced in the LLM's behavior.
 */

import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax-ai/llm';

export type OverlayTaskId =
  | 't1-mandatory-marker'
  | 't2-specific-file-scope'
  | 't3-conciseness-directive'
  | 't4-dependency-prohibition'
  | 't5-brainstorm-three-options'
  | 't6-functional-vs-class';

export interface OverlayProbeOutcome {
  readonly text: string;
  readonly toolBlocks: readonly KodaXToolUseBlock[];
  readonly toolNames: readonly string[];
}

export interface OverlayTaskCase {
  readonly id: OverlayTaskId;
  readonly description: string;
  /**
   * The overlay text that v0.7.35.1 stitched onto the user-prompt head
   * and v0.7.36 routes into `ManagedRolePromptContext.promptOverlay`.
   */
  readonly overlayText: string;
  /** The user request itself (without the overlay). */
  readonly userTask: string;
  /** Mechanical pass/fail check over the LLM's output. */
  readonly predicate: (outcome: OverlayProbeOutcome) => boolean;
}

const COMPLIANCE_TAG = '// COMPLIANCE_TAG_F146A';

export const OVERLAY_TASKS: readonly OverlayTaskCase[] = Object.freeze([
  {
    id: 't1-mandatory-marker',
    description: 'AGENTS-style mandatory file-creation marker — overlay carries a hard rule',
    overlayText: [
      '[Project Rules]',
      'CRITICAL — every TypeScript file you create MUST start with this exact comment line as the very first line:',
      `    ${COMPLIANCE_TAG}`,
      'This is a hard rule. Files without this marker are rejected by CI.',
    ].join('\n'),
    userTask:
      'Create a new file `src/utils.ts` that exports a function `add(a: number, b: number): number => a + b`. ' +
      'Call the `write` tool with the full file content right now. Do NOT call any other tool first.',
    predicate: (out) => {
      const writeBlock = out.toolBlocks.find((b) => b.name === 'write');
      if (!writeBlock) return false;
      const content =
        typeof writeBlock.input.content === 'string' ? writeBlock.input.content : '';
      return content.includes(COMPLIANCE_TAG);
    },
  },
  {
    id: 't2-specific-file-scope',
    description: 'Routing-notes overlay points to a specific file — Worker should target it',
    overlayText: [
      '[Routing Notes]',
      '- The user is currently editing `src/auth/login.ts`. The recent change is a new `validateInput` helper.',
      '- Treat that file as the primary edit target unless the user explicitly says otherwise.',
    ].join('\n'),
    userTask:
      'Add a check that rejects empty strings before authentication proceeds. ' +
      'Use the `read` tool first to inspect the relevant file, then call the `edit` tool. ' +
      'Do NOT touch any unrelated file.',
    predicate: (out) => {
      // Pass if the FIRST tool call's path mentions login.ts (the directive
      // file). We check the first call to avoid noise from later thrashing.
      const firstWithPath = out.toolBlocks.find((b) => {
        const p = (b.input as { path?: unknown }).path;
        return typeof p === 'string';
      });
      if (!firstWithPath) return false;
      const p = String((firstWithPath.input as { path?: unknown }).path).toLowerCase();
      return p.includes('login.ts') || p.includes('auth/login') || p.includes('auth\\login');
    },
  },
  {
    id: 't3-conciseness-directive',
    description: 'Overlay says task is H0/simple — Worker should NOT over-tool',
    overlayText: [
      '[Routing Notes]',
      '- Task family: H0_DIRECT (single-file simple edit, no review needed).',
      '- Be concise; emit ONE tool call to make the change. Do not glob/grep first.',
    ].join('\n'),
    userTask:
      'In file `src/users.ts` rename the function `getCount` to `getActiveCount`. ' +
      'The exact line to change is `export function getCount(): number {`. ' +
      'Use the `edit` tool directly — do NOT call read/glob/grep first.',
    predicate: (out) => {
      // Pass if the LLM directly emitted an edit (or write) tool call.
      // A read-first/glob-first response means the conciseness directive
      // didn't land.
      if (out.toolNames.length === 0) return false;
      const first = out.toolNames[0];
      return first === 'edit' || first === 'write';
    },
  },
  {
    id: 't4-dependency-prohibition',
    description: 'Overlay says no new deps — Worker should not propose npm install',
    overlayText: [
      '[Provider Policy]',
      '- PROHIBITED: do not introduce new npm dependencies for this task.',
      '- Use only what already exists in the project (Node built-ins, existing packages).',
    ].join('\n'),
    userTask:
      'Implement a function `generateRequestId(): string` in `src/util.ts` that returns a unique-ish ID. ' +
      'Briefly describe your approach in 2-3 sentences (no tool call needed) — explain what API or technique you would use.',
    predicate: (out) => {
      const haystack = out.text.toLowerCase();
      // Forbidden phrases — install command or named external dep
      const forbidden = [
        'npm install',
        'npm i ',
        'yarn add',
        'pnpm install',
        'pnpm add',
        'install the uuid',
        'install uuid',
        'add the uuid',
        'add uuid package',
        '`uuid` package',
        'uuid package',
        'install the `uuid',
      ];
      return !forbidden.some((p) => haystack.includes(p));
    },
  },
  {
    id: 't5-brainstorm-three-options',
    description: 'Overlay asks for ≥3 alternatives — Worker should enumerate',
    overlayText: [
      '[Brainstorm Directive]',
      '- This task is exploratory; the user wants alternatives, not a single answer.',
      '- Enumerate at least 3 distinct approaches before recommending one.',
    ].join('\n'),
    userTask:
      'How should we cache the user session in a typical Node.js web app? Briefly answer in text — no tool calls needed.',
    predicate: (out) => {
      const text = out.text;
      // Heuristic: count distinct option markers. Accepts numbered list,
      // explicit "Option N", "Approach N", or distinct bullet patterns.
      const numbered =
        (text.match(/(?:^|\n)\s*(?:1\.|1\)|\(1\)|Option\s*1|Approach\s*1)/gi) ?? []).length > 0 &&
        (text.match(/(?:^|\n)\s*(?:2\.|2\)|\(2\)|Option\s*2|Approach\s*2)/gi) ?? []).length > 0 &&
        (text.match(/(?:^|\n)\s*(?:3\.|3\)|\(3\)|Option\s*3|Approach\s*3)/gi) ?? []).length > 0;
      return numbered;
    },
  },
  {
    id: 't6-functional-vs-class',
    description: 'Overlay says prefer functional — Worker should not use class keyword',
    overlayText: [
      '[Explicit Reason Trail]',
      '- The user previously rejected a class-based design and asked for functional/composition style instead.',
      '- For this task, prefer functions and closures; do NOT use the `class` keyword.',
    ].join('\n'),
    userTask:
      'Implement a counter widget that exposes `increment()`, `decrement()`, and `value()`. ' +
      'Show the implementation in plain code in your text response (no tool call). Make it small.',
    predicate: (out) => {
      const text = out.text;
      // Look for actual code-block class declarations: a "class Foo" pattern
      // inside a code block-ish context. We don't want to false-positive on
      // mentions like "the class-based approach is rejected", which the
      // overlay itself describes.
      const classDeclaration = /(?:^|\n)\s*(?:export\s+)?class\s+\w+/i;
      return !classDeclaration.test(text);
    },
  },
]);

/**
 * Tool surface offered to the LLM. Mirrors the production runtime tools
 * but pruned to the minimum needed for the predicates to fire.
 */
export const OVERLAY_TOOLS: readonly KodaXToolDefinition[] = Object.freeze([
  {
    name: 'read',
    description: 'Read a file from the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write a file to the workspace. Creates parent dirs as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description:
      'Edit an existing file by exact-string replacement. `old_string` must be unique in the file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regex.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
]);

export interface OverlayVariantInput {
  readonly systemPrompt: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
}

/**
 * Build the legacy v0.7.35.1 variant — overlay prepended to user message,
 * bare role prompt as system. This is the "before FEATURE_143" baseline.
 */
export function buildVariantALegacy(
  task: OverlayTaskCase,
  baseRoleSystemPrompt: string,
): OverlayVariantInput {
  return {
    systemPrompt: baseRoleSystemPrompt,
    priorMessages: [],
    userMessage: `${task.overlayText}\n\n${task.userTask}`,
    tools: OVERLAY_TOOLS,
  };
}

/**
 * Build the v0.7.36 FEATURE_143 variant — overlay rendered as a
 * `[Routing Notes]` section in the role prompt, bare user message.
 */
export function buildVariantBSection(
  task: OverlayTaskCase,
  rolePromptWithOverlay: string,
): OverlayVariantInput {
  return {
    systemPrompt: rolePromptWithOverlay,
    priorMessages: [],
    userMessage: task.userTask,
    tools: OVERLAY_TOOLS,
  };
}
