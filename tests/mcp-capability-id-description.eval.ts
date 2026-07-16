/**
 * Eval: MCP capability id descriptions keep the canonical `mcp:` prefix.
 *
 * Why this exists
 *
 * ADR-033 requires a prompt eval when LLM-facing prompt/tool descriptions
 * change. The runtime fix is intentionally not load-bearing on this eval:
 * Layer 1 tests prove `normalizeMcpCapabilityId` accepts the no-scheme form,
 * wrapper tools render canonical ids, and registry tests prove the old
 * `server.name` / `mcp://...` description shapes are gone.
 *
 * This Layer 2 probe closes the remaining behavioral prompt risk: when a live
 * model sees the updated production `mcp_call` tool description plus a search
 * result locator, it should copy the canonical id including the `mcp:` prefix
 * instead of rebuilding the old `git-nexus:tool:...` form.
 *
 * Fixed input
 *
 * - system: short worker-like instruction to use tools directly
 * - user: simulated `mcp_search` result with
 *   `Locator: mcp:git-nexus:tool:list_branches`
 * - tools: production `mcp_call` tool definition only
 *
 * Expected output
 *
 * - provider emits an `mcp_call` tool call
 * - `mcp_call.input.id` is exactly `mcp:git-nexus:tool:list_branches`
 * - `mcp_call.input.id` is not the no-scheme form
 *
 * Pilot run
 *
 *   npm run test:eval -- mcp-capability-id-description
 *
 * Cost budget: 1 alias x 1 case x 1 run, normally below $0.10. Raw dumps land
 * under `os.tmpdir()/kodax-eval-dumps/mcp-capability-id-description/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const CANONICAL_ID = 'mcp:git-nexus:tool:list_branches';
const NO_SCHEME_ID = 'git-nexus:tool:list_branches';
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'mcp-capability-id-description');

const SYSTEM_PROMPT = [
  'You are a KodaX worker. Use the available tool when the user provides an exact MCP locator.',
  'Copy MCP Locator values exactly into mcp_call.id. Do not shorten or rebuild capability ids.',
].join('\n');

const USER_MESSAGE = [
  'Use the MCP capability from this search result now.',
  '',
  'Search result:',
  `Locator: ${CANONICAL_ID}`,
  'Server: git-nexus',
  'Kind: tool',
  'Name: list_branches',
  '',
  'Invoke it with args {"repo":"KodaX"}.',
].join('\n');

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null
    ? input as Record<string, unknown>
    : undefined;
}

function readCapabilityId(input: unknown): string | undefined {
  const record = asRecord(input);
  return typeof record?.id === 'string' ? record.id : undefined;
}

describe('Eval: MCP capability id description canonicalization', () => {
  const aliases = availableAliases(PILOT_ALIAS);
  const mcpCallTool = getToolDefinition('mcp_call');

  if (!mcpCallTool) {
    it('fails: mcp_call tool definition is missing', () => {
      expect(mcpCallTool).toBeDefined();
    });
    return;
  }

  if (aliases.length === 0) {
    it('skips: no pilot alias credentials in env', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const alias of aliases) {
    it(
      `${alias} copies the canonical mcp: locator into mcp_call.id`,
      { timeout: 120_000 },
      async () => {
        const out = await runOneShot(alias, {
          systemPrompt: SYSTEM_PROMPT,
          userMessage: USER_MESSAGE,
          tools: [mcpCallTool],
        });

        const mcpCalls = out.toolCalls.filter((call) => call.name === 'mcp_call');
        const ids = mcpCalls
          .map((call) => readCapabilityId(call.input))
          .filter((id): id is string => typeof id === 'string');
        const firstId = ids[0];
        const passed = firstId === CANONICAL_ID && !ids.includes(NO_SCHEME_ID);

        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(
          join(DUMP_ROOT, `${alias.replace(/[\\/]/g, '__')}.json`),
          JSON.stringify({
            alias,
            canonicalId: CANONICAL_ID,
            noSchemeId: NO_SCHEME_ID,
            text: out.text,
            toolCalls: out.toolCalls,
            ids,
            durationMs: out.durationMs,
            passed,
          }, null, 2),
          'utf8',
        );

        expect(mcpCalls.length, 'model should call mcp_call').toBeGreaterThan(0);
        expect(firstId, 'model should copy the canonical Locator exactly').toBe(CANONICAL_ID);
        expect(ids, 'model must not use the no-scheme id form').not.toContain(NO_SCHEME_ID);
      },
    );
  }
});
