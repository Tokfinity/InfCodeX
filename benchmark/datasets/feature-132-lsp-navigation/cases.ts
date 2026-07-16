/**
 * FEATURE_132 Phase E — LSP-navigation routing dataset.
 *
 * Single-turn probe (FEATURE_104 style): given the REAL production tool
 * descriptions for the 4 `lsp_*` navigation tools AND the competing
 * repo-intelligence / grep tools, does the model route a precise,
 * single-point, position-anchored question to an `lsp_*` tool (positive),
 * and route a repo-scope or literal-string question to repo-intelligence /
 * grep instead (boundary / anti-trigger)?
 *
 * The tools are NOT executed — we only observe which was selected. Uses the
 * REAL `getBuiltinToolDefinition` bytes (per anti-pattern 8), advertised
 * through the harness `tools` channel so the LLM sees production descriptions.
 */

import { getBuiltinToolDefinition } from '@kodax-ai/coding';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

// The realistic choice set: the 4 navigation tools + their nearest
// repo-intelligence rivals + grep/read. Without the rivals present, an lsp_*
// selection would be uninformative (nothing else to pick).
const TOOL_NAMES = [
  'lsp_definition',
  'lsp_hover',
  'lsp_references',
  'lsp_document_symbols',
  'symbol_context',
  'impact_estimate',
  'module_context',
  'grep',
  'read',
] as const;

const resolved: KodaXToolDefinition[] = TOOL_NAMES.map((n) => {
  const def = getBuiltinToolDefinition(n);
  if (!def) throw new Error(`FEATURE_132 eval: tool "${n}" is not registered`);
  return def;
});

export const TOOLS: readonly KodaXToolDefinition[] = resolved;

const LSP_TOOLS = new Set(['lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols']);

export const SYSTEM_PROMPT = [
  'You are KodaX, a multi-provider AI coding CLI working inside a user\'s git repository.',
  'You have tools available. Pick the single most appropriate tool for the user\'s request.',
].join('\n');

export type Kind = 'lsp' | 'boundary';

export interface Case {
  readonly id: string;
  readonly kind: Kind;
  /** The lsp_* tool we'd expect for an `lsp` case (for inspection, not the gate). */
  readonly expected?: string;
  readonly prompt: string;
}

export const CASES: readonly Case[] = [
  // lsp → should select an lsp_* tool (precise, position-anchored, real-time)
  {
    id: 'definition',
    kind: 'lsp',
    expected: 'lsp_definition',
    prompt:
      "In src/app.ts I'm looking at the call `parseConfig(raw)` on line 42. Take me to where `parseConfig` is actually defined (it's imported from somewhere).",
  },
  {
    id: 'hover',
    kind: 'lsp',
    expected: 'lsp_hover',
    prompt:
      "What is the exact resolved type of the variable `result` at line 18, column 9 of src/server.ts? I need the compiler's view, including how the generic is filled in here.",
  },
  {
    id: 'references',
    kind: 'lsp',
    expected: 'lsp_references',
    prompt:
      "I'm about to change the signature of the method at line 12 of src/user.ts. List every place that exact symbol is used so I know what will break.",
  },
  {
    id: 'symbols',
    kind: 'lsp',
    expected: 'lsp_document_symbols',
    prompt:
      'Give me an outline of all the classes, methods and functions declared in src/big-module.ts so I can find my way around it without reading the whole file.',
  },
  // boundary → should NOT select an lsp_* tool (repo-scope / literal string)
  {
    id: 'neg-impact',
    kind: 'boundary',
    prompt:
      "What's the blast radius across the whole repo if I change the `User` model — which packages and call sites depend on it? I don't have a specific line, I want the repo-wide impact.",
  },
  {
    id: 'neg-symbol-graph',
    kind: 'boundary',
    prompt:
      'Trace the callers and callees of the `dispatchTask` function across the repository so I understand how it fits into the call graph.',
  },
  {
    id: 'neg-grep',
    kind: 'boundary',
    prompt: "Find everywhere the literal string 'DEPRECATED: use v2 instead' appears in the codebase.",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 4-syntax tool-name detection in raw text (per anti-pattern 7 §4). */
function textMentionsTool(text: string, toolName: string): boolean {
  const esc = escapeRegExp(toolName);
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
  ].some((p) => p.test(text));
}

/**
 * Collect the tool names the model selected — binding tool_calls are the
 * ground truth; fall back to 4-syntax text scan for models that emit a tool
 * call as text with an empty binding.
 */
export function collectSelectedTools(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  text: string,
): Set<string> {
  const selected = new Set(toolCalls.map((c) => c.name));
  if (selected.size === 0) {
    for (const name of TOOL_NAMES) {
      if (textMentionsTool(text, name)) selected.add(name);
    }
  }
  return selected;
}

/** True when any lsp_* navigation tool was selected. */
export function selectedLspTool(selected: ReadonlySet<string>): boolean {
  for (const name of selected) if (LSP_TOOLS.has(name)) return true;
  return false;
}

/**
 * Binding-based PASS: an `lsp` case should select an lsp_* tool; a `boundary`
 * case should NOT (it should use repo-intelligence / grep instead).
 */
export function isAppropriateRouting(kind: Kind, selected: ReadonlySet<string>): boolean {
  const lsp = selectedLspTool(selected);
  return kind === 'lsp' ? lsp : !lsp;
}
