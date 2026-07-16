/**
 * FEATURE_218 self-knowledge roundtrip — dataset.
 *
 * Single-turn probe (FEATURE_104 style): given the production routing rule +
 * the production kodax_manual tool schema, does the model call kodax_manual
 * for KodaX product/usage questions (positive) and NOT call it for ordinary
 * coding tasks (negative anti-trigger)? The tool is not executed — we only
 * observe whether it was selected.
 *
 * Uses the REAL tool schema (getBuiltinToolDefinition) and the REAL routing
 * rule (SELF_KNOWLEDGE_ROUTING_RULE) so the eval measures production prompt
 * content, not a self-authored stub (per feedback_eval_driver_self_stubs_schema).
 */

import {
  getBuiltinToolDefinition,
  SELF_KNOWLEDGE_ROUTING_RULE,
} from '@kodax-ai/coding';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

// Advertise a REALISTIC tool set (not just kodax_manual). A single-tool
// environment confounds the anti-trigger measurement: a model asked to fix
// code with only kodax_manual available grasps it for lack of a file tool.
// With read/edit/grep present, a coding task routes to those, and calling
// kodax_manual is a genuine over-trigger.
const TOOL_NAMES = ['kodax_manual', 'read', 'edit', 'grep'] as const;
const resolved: KodaXToolDefinition[] = TOOL_NAMES.map((n) => {
  const def = getBuiltinToolDefinition(n);
  if (!def) throw new Error(`FEATURE_218 eval: tool "${n}" is not registered`);
  return def;
});

export const TOOLS: readonly KodaXToolDefinition[] = resolved;

export const SYSTEM_PROMPT = [
  'You are KodaX, a multi-provider AI coding CLI. You have tools available.',
  '',
  SELF_KNOWLEDGE_ROUTING_RULE,
].join('\n');

export type Kind = 'product' | 'coding';

export interface Case {
  readonly id: string;
  readonly kind: Kind;
  readonly prompt: string;
}

export const CASES: readonly Case[] = [
  // product → should call kodax_manual
  { id: 'install', kind: 'product', prompt: 'How do I install and start KodaX?' },
  { id: 'openai-provider', kind: 'product', prompt: 'How do I configure an OpenAI provider in KodaX?' },
  { id: 'custom-provider', kind: 'product', prompt: 'For a custom provider in KodaX, where do I put the baseUrl and model name?' },
  { id: 'permissions', kind: 'product', prompt: "How should I understand KodaX's permission modes?" },
  { id: 'mcp', kind: 'product', prompt: 'How do I configure an MCP server in KodaX?' },
  { id: 'skills-vs-agents', kind: 'product', prompt: "In KodaX, what's the difference between skills and AGENTS.md?" },
  { id: 'resume-cn', kind: 'product', prompt: '怎么 resume 上一次 KodaX 的 session？' },
  { id: 'provider-cn', kind: 'product', prompt: 'KodaX 怎么配置供应商？' },
  { id: 'sdk', kind: 'product', prompt: 'How do I embed KodaX through the SDK?' },
  { id: 'doctor', kind: 'product', prompt: 'KodaX cannot reach my provider — how do I diagnose it?' },
  // coding → should NOT call kodax_manual (anti-trigger)
  { id: 'neg-codefix', kind: 'coding', prompt: 'Add a null check to the function in utils.ts before it dereferences `user.name`.' },
  { id: 'neg-explain', kind: 'coding', prompt: 'Explain what a debounce function does in JavaScript.' },
];

/** True when the model selected the kodax_manual tool. */
export function classifyToolCall(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): boolean {
  return toolCalls.some((c) => c.name === 'kodax_manual');
}

/**
 * Binding-based PASS: a product question should route to kodax_manual; a
 * coding task should NOT (it should use read/edit/grep or answer in text).
 */
export function isAppropriateRouting(kind: Kind, calledManual: boolean): boolean {
  return kind === 'product' ? calledManual : !calledManual;
}
