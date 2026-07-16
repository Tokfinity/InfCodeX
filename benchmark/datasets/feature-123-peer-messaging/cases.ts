/**
 * FEATURE_123 v0.7.44 — Peer-to-Peer SendMessage prompt-signal eval.
 *
 * Scope of this dataset: prompt-level signal — given a peer
 * coordination situation, does the child model reach for
 * `send_message` with the right `to=` shape (peer task_id / "worker"
 * / "*"), and does the Worker know to surface and integrate the
 * child-authored messages it receives?
 *
 * **4 cases**:
 *   - C1 (peer-conflict-notify): child A is editing the same file as
 *     a known sibling child B; A should send_message(to=B, …) before
 *     editing.
 *   - C2 (worker-notify): child finds a scope-changing fact mid-task
 *     and should send_message(to="worker", …) so the parent knows.
 *   - C3 (broadcast-system-shift): user added a constraint that
 *     affects ALL running children → child should broadcast
 *     (to="*", …) rather than message peers one at a time.
 *   - C4 (do-not-spam): child finished a unit of work cleanly and has
 *     nothing peer-relevant to share. Should NOT send_message at all
 *     — peer chatter that does not change anyone's plan is noise.
 *
 * Cases C1-C3 reward a positive `send_message(to=…)` call with the
 * right target shape. Case C4 rewards the ABSENCE of `send_message`
 * (false-positive guard).
 *
 * **Pilot vs scale**:
 *   - pilot: ark/v4flash × C1 × 1 = 1 call (~$0.01). Confirms tool-
 *     call shape triggers at all.
 *   - scale: 5 alias × 4 case × 5 run = 100 calls (~$3-5).
 *
 * Phase D MVP wires the routing surface; this dataset measures
 * prompt-level understanding. Full SHIP-gate LLM-judge audit on the
 * panel dump runs alongside the F192 audit in v0.7.45.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

export type PeerCaseId =
  | 'C1_peer_conflict_notify'
  | 'C2_worker_notify'
  | 'C3_broadcast_system_shift'
  | 'C4_no_spam';

/**
 * Tool shape mirrors `packages/coding/src/tools/registry.ts` — kept
 * inline here so the eval is self-contained and the prompt is judged
 * on the same description the runtime advertises.
 */
export const SEND_MESSAGE_TOOL: KodaXToolDefinition = {
  name: 'send_message',
  description:
    'Route a short message to another in-flight agent in this session. Worker → child appends a <coordinator-instruction> at user priority (drained next tool boundary). Child → child peer appends a <peer-message from=…> at background priority (drained when the peer next yields). Child → parent Worker uses to="worker" and appends a <child-notification from=…>. Broadcast to="*" fans the message out to every other in-flight sibling plus the parent Worker, framed as <peer-broadcast from=…>. Use sparingly — most children should not need mid-flight steering, and peer chatter is for coordination notes that change another agent\'s plan, not status updates.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['to', 'content'],
  },
};

/** Filler stand-ins so the eval prompt advertises a realistic child toolset. */
export const READ_TOOL: KodaXToolDefinition = {
  name: 'read',
  description: 'Read a file by absolute path.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

export const EDIT_TOOL: KodaXToolDefinition = {
  name: 'edit',
  description: 'Edit a file by replacing one string with another.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

export interface PeerEvalCase {
  readonly id: PeerCaseId;
  readonly description: string;
  readonly userMessage: string;
  /**
   * For positive cases: expected `to=` target shape (`peer`/`worker`/
   * `broadcast`). For C4 (negative case): `none` — the case PASSes
   * only when `send_message` is NOT called.
   */
  readonly expectedTarget: 'peer' | 'worker' | 'broadcast' | 'none';
  /**
   * For positive cases, regex patterns we expect to match the content
   * or to= field. Loose match — judges fall through to LLM audit for
   * ambiguous cases. Ignored when expectedTarget === 'none'.
   */
  readonly expectedContentSignals: readonly string[];
}

const C1_PROMPT = `
You are a child sub-agent working on task: "Migrate auth/middleware.ts to use the new JWT signing helper."

You have just finished surveying the file. You are about to start editing it.

ACTIVE SIBLINGS (visible in your runtime registry):
- task_id "child-security-audit": auditing the auth path for security regressions, including auth/middleware.ts. Started ~30 seconds ago, still running.
- task_id "child-doc-update": updating the README's auth section.

Before you start editing auth/middleware.ts, what (if any) coordination action should you take? Be specific — name the tool and arguments you would call, or explain why none is needed.
`.trim();

const C2_PROMPT = `
You are a child sub-agent working on task: "Add unit tests for src/api/handlers.ts."

While reading the file, you discovered that the entire \`handlers.ts\` module is being rewritten on a feature branch and \`main\` will replace it next week. Your unit tests on the current shape will be thrown away.

The parent Worker dispatched you 5 minutes ago. They almost certainly do NOT know about the imminent rewrite — it wasn't in their briefing.

What do you do? Be concrete — name the tool and arguments, or explain why no coordination is needed.
`.trim();

const C3_PROMPT = `
You are a child sub-agent working on task: "Refactor packages/coding/src/agents/worker-role-prompt.ts."

You have 4 active sibling children:
- task_id "child-1": refactoring packages/coding/src/agents/coding-agents.ts
- task_id "child-2": refactoring packages/coding/src/agents/task-engine-agents.ts
- task_id "child-3": writing migration tests for the agents package
- task_id "child-4": updating docs/features/v0.7.44.md

A <coordinator-instruction> just arrived from the parent Worker:

"The user just narrowed scope: only touch packages/coding/src/agents/. Do NOT modify anything outside that directory. Stop any cross-package work and confirm you understand."

How do you handle this new constraint? Be specific.
`.trim();

const C4_PROMPT = `
You are a child sub-agent working on task: "Find all uses of the deprecated \`buildLegacyConfig\` function in packages/coding/src."

You finished the search and found 3 call sites:
- packages/coding/src/legacy/init.ts:42
- packages/coding/src/legacy/init.ts:88
- packages/coding/src/migration/migrate-config.ts:14

You have 2 active siblings working on unrelated tasks:
- task_id "child-x": writing tests for packages/llm/
- task_id "child-y": auditing accessibility of REPL UI

Your finding is a straightforward catalog. Nothing about it changes either sibling's plan. What do you do next?
`.trim();

export const PEER_EVAL_CASES: readonly PeerEvalCase[] = [
  {
    id: 'C1_peer_conflict_notify',
    description: 'Same file overlap with a sibling — child should notify the peer before editing.',
    userMessage: C1_PROMPT,
    expectedTarget: 'peer',
    expectedContentSignals: [
      'child-security-audit',
      'auth/middleware\\.ts',
      'editing',
      'heads up|conflict|overlap',
    ],
  },
  {
    id: 'C2_worker_notify',
    description: 'Scope-changing finding — child should notify parent Worker via to="worker".',
    userMessage: C2_PROMPT,
    expectedTarget: 'worker',
    expectedContentSignals: [
      'worker|parent',
      'rewrite|feature branch|imminent',
    ],
  },
  {
    id: 'C3_broadcast_system_shift',
    description: 'System-wide constraint change — single broadcast beats N peer messages.',
    userMessage: C3_PROMPT,
    expectedTarget: 'broadcast',
    expectedContentSignals: [
      'narrow|scope|stop',
      'agents',
    ],
  },
  {
    id: 'C4_no_spam',
    description: 'No peer-relevant finding — should NOT send_message (do-no-harm guard).',
    userMessage: C4_PROMPT,
    expectedTarget: 'none',
    expectedContentSignals: [],
  },
];

/**
 * System prompt the eval feeds to the model. Mirrors the
 * `CHILD_AGENT_SYSTEM_PROMPT` Peer Communication section without
 * pulling in the full child briefing pipeline.
 */
export const PEER_EVAL_SYSTEM_PROMPT = `
You are a focused sub-agent dispatched by a parent Worker. Each turn you should advance the assigned task with tool calls or text — never both in the same final response.

You can address other in-flight agents with send_message:
- send_message(to="<peer task_id>", content="…") — notify a sibling whose plan your work touches.
- send_message(to="worker", content="…") — surface a mid-flight finding to your parent Worker. Drains when the Worker next yields.
- send_message(to="*", content="…") — broadcast to all siblings + the parent Worker. Capped at 20 recipients.

Use peer messages when they would change another agent's plan: shared file edits, scope-changing facts, blockers the parent should know about. Do NOT send routine status pings — peer chatter that does not change anyone's plan is noise.

Respond to each turn with concrete action(s). When tool calls are appropriate, emit them; when only a plan / explanation is needed, respond with text.
`.trim();
