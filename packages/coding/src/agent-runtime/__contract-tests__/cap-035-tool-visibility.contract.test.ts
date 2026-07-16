/**
 * Contract test for CAP-035: tool name visibility classification
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-035-tool-name-visibility-classification
 *
 * Test obligations:
 * - CAP-TOOL-VISIBILITY-001: internal (managed-protocol) tools hidden from
 *   REPL events; user-facing tools (read/edit/bash/...) remain visible.
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/event-emitter.ts (extracted from
 * agent.ts:882-884 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: in event-emission decision.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import { MANAGED_PROTOCOL_TOOL_NAME } from '../../managed-protocol.js';
import { isVisibleToolName } from '../event-emitter.js';

describe('CAP-035: tool name visibility classification contract', () => {
  it('CAP-TOOL-VISIBILITY-001a: managed-protocol tool name returns false (hidden)', () => {
    expect(isVisibleToolName(MANAGED_PROTOCOL_TOOL_NAME)).toBe(false);
    expect(isVisibleToolName('emit_managed_protocol')).toBe(false);
  });

  it('CAP-TOOL-VISIBILITY-001b: user-facing tool names return true (visible)', () => {
    for (const tool of ['read', 'edit', 'bash', 'write', 'multi_edit', 'glob', 'grep']) {
      expect(isVisibleToolName(tool)).toBe(true);
    }
  });

  it('CAP-TOOL-VISIBILITY-001c: case-insensitive + whitespace-trim — managed-protocol still hidden', () => {
    // The underlying isManagedProtocolToolName trims + lowercases, so any
    // casing variant is still classified as internal.
    expect(isVisibleToolName('  Emit_Managed_Protocol  ')).toBe(false);
    expect(isVisibleToolName('EMIT_MANAGED_PROTOCOL')).toBe(false);
  });

  // FEATURE_151 (v0.7.38) Slice E — todo scaffolding tools hidden from
  // user transcript. Mirrors CC TodoWriteTool / TaskListTool / etc all
  // setting `shouldDefer: true + renderToolUseMessage() => null +
  // userFacingName() => ''`.
  it('CAP-TOOL-VISIBILITY-001d: FEATURE_151 todo scaffolding tools hidden', () => {
    expect(isVisibleToolName('todo_update')).toBe(false);
    expect(isVisibleToolName('todo_list')).toBe(false);
  });

  // FEATURE_170 (v0.7.41) — todo_create is the per-item insertion path
  // (mirrors claudecode V2 TaskCreate). Same scaffolding stance as
  // todo_update: the user sees inserted items via TodoListSurface; the
  // raw tool call is pure transcript noise. Surface must stay hidden.
  it('CAP-TOOL-VISIBILITY-001e: FEATURE_170 todo_create tool hidden', () => {
    expect(isVisibleToolName('todo_create')).toBe(false);
  });

  // v0.7.42 — todo_get is read-only per-id lookup (mirrors claudecode V2
  // TaskGet). Same scaffolding stance: staleness refreshes are not user-
  // facing work; the user sees the plan via TodoListSurface, not raw
  // tool-result echoes. Must stay hidden.
  it('CAP-TOOL-VISIBILITY-001f: v0.7.42 todo_get tool hidden', () => {
    expect(isVisibleToolName('todo_get')).toBe(false);
  });
});
