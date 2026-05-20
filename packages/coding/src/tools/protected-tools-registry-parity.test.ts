/**
 * FEATURE_183 (v0.7.42) — cross-package parity test.
 *
 * `PROTECTED_TOOL_NAMES` is declared in `@kodax-ai/session-lineage`
 * (compaction layer can't reach into @kodax-ai/coding without circular
 * tsc -b dependency). Its membership names KodaX tool registrations
 * declared in `@kodax-ai/coding`'s registry. This test verifies the two
 * stay in sync — any drift (renamed registry tool, removed name, typo)
 * breaks here rather than silently in production.
 *
 * If this test fails:
 *   - registry.ts tool name added/removed but PROTECTED_TOOL_NAMES not
 *     updated  →  decide whether the new tool is high-value (add to
 *     PROTECTED_TOOL_NAMES) or compactable (leave it out, update this
 *     test's expected list).
 *   - PROTECTED_TOOL_NAMES name doesn't match any registry entry  →
 *     likely a typo or the registry was renamed; update one to match.
 */

import { describe, expect, it } from 'vitest';
import { PROTECTED_TOOL_NAMES } from '@kodax-ai/session-lineage';
import {
  MCP_TOOL_NAMES,
  REPO_INTELLIGENCE_WORKING_TOOL_NAMES,
} from './registry.js';

describe('FEATURE_183 (v0.7.42): PROTECTED_TOOL_NAMES ↔ registry parity', () => {
  it('every MCP_TOOL_NAMES entry is in PROTECTED_TOOL_NAMES', () => {
    // MCP tools wrap user-configured external commands; their outputs are
    // typically high-value (config files / database queries / external API
    // responses) and should never be silently replaced with placeholders.
    for (const name of MCP_TOOL_NAMES) {
      expect(
        PROTECTED_TOOL_NAMES.has(name),
        `MCP tool '${name}' should be in PROTECTED_TOOL_NAMES`,
      ).toBe(true);
    }
  });

  it('every REPO_INTELLIGENCE_WORKING_TOOL_NAMES entry is in PROTECTED_TOOL_NAMES', () => {
    // Repo-intelligence tools already produce condensed capsules; pruning
    // them strips the very condensation the capsule format provides.
    for (const name of REPO_INTELLIGENCE_WORKING_TOOL_NAMES) {
      expect(
        PROTECTED_TOOL_NAMES.has(name),
        `repo-intelligence tool '${name}' should be in PROTECTED_TOOL_NAMES`,
      ).toBe(true);
    }
  });

  it('all expected control-plane / delegation / user-interaction tools are protected', () => {
    // Spot-pin the rest of the PROTECTED set with the registry's tool
    // names so a registry rename is caught immediately. Lists kept literal
    // (not pulled from a constant) so this test fails loudly on rename.
    const requiredProtected = [
      'skill',
      'ask_user_question',
      'exit_plan_mode',
      'dispatch_child_task',
      'task_stop',
      'send_message',
      'emit_managed_protocol',
      'worktree_create',
      'worktree_remove',
      'undo',
    ];
    for (const name of requiredProtected) {
      expect(
        PROTECTED_TOOL_NAMES.has(name),
        `'${name}' should be in PROTECTED_TOOL_NAMES`,
      ).toBe(true);
    }
  });

  it('"execution / exploration" tools are deliberately NOT in PROTECTED_TOOL_NAMES', () => {
    // The 12 tools below are high-frequency, large-result, low-density-of-
    // decision — exactly the right shape for placeholder substitution
    // under context pressure. If any of these gets promoted to PROTECTED,
    // context budget regressions will follow silently.
    const intentionallyCompactable = [
      'read', 'write', 'edit', 'multi_edit', 'insert_after_anchor',
      'bash',
      'glob', 'grep', 'code_search', 'semantic_lookup',
      'web_search', 'web_fetch',
    ];
    for (const name of intentionallyCompactable) {
      expect(
        PROTECTED_TOOL_NAMES.has(name),
        `'${name}' must remain compactable — do NOT add to PROTECTED_TOOL_NAMES`,
      ).toBe(false);
    }
  });
});
