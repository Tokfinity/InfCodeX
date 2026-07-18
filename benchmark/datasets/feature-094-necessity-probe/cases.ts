/**
 * Dataset — FEATURE_094 necessity probe (2026-05-19)
 *
 * **Status**: Retained as permanent regression probe. FEATURE_094
 * **CANCELLED 2026-05-19** based on this probe's measurement
 * (0/43 escape across canonical 5-alias panel × 3 cases × 3 runs).
 * Re-run periodically — escape rate **must stay at 0%**. If it rises
 * above 5% the prompt layer (write/bash tool descriptions in
 * `packages/coding/src/tools/registry.ts`) or a provider model has
 * drifted and FEATURE_094 should be re-opened. See
 * `docs/features/v0.7.42.md` §FEATURE_094 for the cancel rationale.
 *
 * **Original purpose**: measure today's bash-heredoc-escape rate on
 * the 3 historically-problematic providers (Kimi / MiniMax / Zhipu)
 * plus DeepSeek pro/flash as cross-family control. Decided whether
 * FEATURE_094 (Deep Anti-Escape Hardening — runtime detection + retry
 * contract) was still worth shipping, given that existing P0/P2a/P2b
 * layers + post-2026-04 wins (FEATURE_158 signal-classifier, FEATURE_169
 * pull-tool prompt hardening, FEATURE_152 bash AST) closed the gap.
 *
 * **EVAL_GUIDELINES Layer**: Layer 2 single-turn probe per
 * `benchmark/EVAL_GUIDELINES.md` §"Layer 2: Single-turn LLM probe".
 *
 * **Layer 1 check first**: can this question be answered by code
 * reading or unit test? **NO** — it's a behavioural question about LLM
 * tool-choice distribution under the current production tool
 * descriptions. The descriptions are static, the LLMs are not. Only an
 * LLM probe can measure the distribution.
 *
 * **Mechanical assertion**: for each probe call we capture the FIRST
 * tool call (`result.toolCalls[0]`) from the provider stream and
 * classify it via `classifyToolCall` in the eval driver. The
 * classification is structural (tool name === 'write' / 'multi_edit' /
 * 'bash') not regex-on-text, so anti-pattern 7 (negative regex) does
 * not apply at the tool-name level. For bash calls we then inspect
 * the `command` arg for heredoc / python / echo signatures.
 *
 * **Panel**: canonical 5-alias panel per
 * `benchmark/EVAL_GUIDELINES.md` §"Canonical alias panel" —
 * `zhipu/glm52` + `kimi` + `mmx/m3` + `ds/v4pro` + `ds/v4flash`.
 * Original FEATURE_094 design observed 15% bypass on kimi-code /
 * minimax-coding / glm-coding, so 3 of those 5 hit the original signal
 * source; ds pro/flash adds cross-family control.
 *
 * **Topology**: 5 aliases × 3 cases × 3 runs = 45 LLM calls.
 * Estimated cost: ~$0.03/call × 45 ≈ $1.35.
 *
 * **Pre-registered decision matrix** (frozen BEFORE any scale run —
 * per anti-pattern 6 "跑完才想什么算 signal"):
 *
 * Define:
 *   alias_escape_rate(α)  = (count escape-* across all cases / total runs for α)
 *   panel_escape_rate     = mean of alias_escape_rate over the 5 aliases
 *   max_alias_rate        = max of alias_escape_rate over the 5 aliases
 *
 * Decision rules (apply in order; first match wins):
 *
 *   1. CANCEL  if panel_escape_rate <  5%  AND  max_alias_rate < 15%
 *      → path-policy already covered by FEATURE_158 signal classifier;
 *        residual UX value (encoding / CRLF / atomic) doesn't justify
 *        the new guardrail + retry-contract maintenance. Recommend
 *        fold path-policy concerns into FEATURE_158's signal list
 *        instead and cancel 094 entirely.
 *
 *   2. ADJUST-TO-OPTION-C  if panel_escape_rate < 15%  AND  one alias has
 *      escape_rate ≥ 25% while ≥3 others ≤ 5%
 *      → behaviour is a provider-specific quirk (likely zhipu/glm52 or
 *        kimi structural floor — see [[zhipu_send_message_floor]]).
 *        Recommend Option C: fold path-policy hardening into FEATURE_158
 *        for the broad case, leave the floor alone (prompt won't fix
 *        structural floors — see [[feedback_model_structural_floor_not_prompt_tunable]]).
 *        Cancel 094 specifically.
 *
 *   3. DEFER  if 5% ≤ panel_escape_rate < 15%  AND  max_alias_rate < 25%
 *      → escape is real but not in critical-priority territory. KodaX
 *        Space SDK (FEATURE_173) is higher-leverage. Push 094 to
 *        backlog, free v0.7.42 slot, revisit when escape rate moves.
 *
 *   4. SHIP-AS-DESIGNED  if panel_escape_rate ≥ 15%  OR  max_alias_rate ≥ 25%
 *      → original FEATURE_094 design data (15% bypass) still holds.
 *        Ship per v0.7.42 design doc; the runtime guardrail + retry
 *        contract is paying for itself.
 *
 * **Audit plan** (per anti-pattern 7 §3 + Judge model selection §1):
 * Self-judge by orchestrating Claude session on:
 *   - every call classified as `escape-*` (verify the bash command
 *     actually IS a generative large-file write, not a false positive
 *     like a config-template with computed values)
 *   - every `no-tool` / `other` (verify model didn't quietly emit a
 *     valid tool call the harness missed)
 *   - random sample of 3 'write' calls (verify they're actually write
 *     tool, not just text-with-write-mention)
 * Expected ≤ 15 cells to audit; well within self-judge budget.
 * Audit results dumped to `<tmpdir>/kodax-eval-dumps/feature-094-necessity-probe/audit-*.jsonl`.
 *
 * **Raw output preservation**: driver dumps per-call `{ alias, caseId,
 * runIdx, durationMs, kind, detail, toolName, rawToolCalls, rawText }`
 * to `<tmpdir>/kodax-eval-dumps/feature-094-necessity-probe/<mode>-<stamp>.jsonl`.
 *
 * **Decision: CANCEL FEATURE_094 (2026-05-19)** — pre-registered Rule 1
 * triggered (panel_escape_rate = 0% < 5% AND max_alias_rate = 0% < 15%).
 * Dataset + driver retained as permanent regression probe per
 * `benchmark/datasets/` convention (mirrors feature-120/125/167/170 etc).
 *
 * See also:
 *   - docs/features/v0.7.42.md FEATURE_094 (original design + 4-layer defence rationale)
 *   - benchmark/EVAL_GUIDELINES.md §"Canonical alias panel"
 *   - feedback_canonical_eval_alias_panel.md (memory)
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

// ─── Tool definitions — mirror current production registry.ts exactly ────
// Source of truth: packages/coding/src/tools/registry.ts (write @212-229,
// multi_edit @275-..., bash @347-358). Snapshot taken 2026-05-19.

export const WRITE_TOOL: KodaXToolDefinition = {
  name: 'write',
  description:
    'Write a file to the local filesystem. Large diffs may be summarized in the tool result. '
    + 'ALWAYS prefer the `edit` tool over `write` when modifying an existing file — `edit` sends only the '
    + 'diff and avoids output-token pressure. Only use `write` to create new files or for a complete rewrite '
    + 'that the user explicitly asked for. '
    + 'For new files up to ~500 lines, call `write` directly. For files larger than that, use this two-step pattern: '
    + '(1) `write(path, skeleton)` — a structural skeleton with placeholder markers like `<!-- SECTION_A -->` or '
    + '`// === SECTION_A ===`, kept under ~300 lines; (2) one `edit(path, "<!-- SECTION_A -->", <real content>)` '
    + 'per section. Each edit streams reliably. '
    + 'NEVER fall back to `bash` (python/node heredoc, `echo >`, `cat > file <<EOF`) to generate a source file — '
    + 'it bypasses mutation tracking, loses diff visibility, and recurses the same streaming limit onto the generator '
    + 'script itself. If a `write` failed mid-stream, retry with a smaller skeleton, then `edit` each section. '
    + 'Encoding note: `write` calls Node `fs.writeFile(path, content, "utf-8")` — the content goes directly from your '
    + 'tool_use input to disk WITHOUT passing through any shell. There are NO "Windows shell encoding issues" for `write`. '
    + 'Do NOT switch to `python`/`bash` scripts to "avoid encoding problems" — UTF-8 (including Chinese / emoji / etc.) '
    + 'works correctly through `write` by default, and routing through a shell script adds encoding surface area '
    + 'rather than removing it.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
};

export const MULTI_EDIT_TOOL: KodaXToolDefinition = {
  name: 'multi_edit',
  description:
    'Apply multiple exact-text replacements to a single file in ONE tool call. '
    + 'Prefer this over N separate `edit` calls when you have several independent edits to the same file — '
    + 'especially when filling in a skeleton you just created with `write`. '
    + 'Edits apply sequentially and the whole batch is ATOMIC.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
};

export const BASH_TOOL: KodaXToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command. Use run_in_background for long-running commands. '
    + 'Large output may be truncated to the most relevant tail. '
    + 'When producing a SINGLE file whose content you already have, use the `write` / `edit` tools — '
    + 'do NOT route it through shell (no `cat > file <<EOF`, no `echo ... >`, no PowerShell `Set-Content` / '
    + '`Out-File`, no python/node heredoc). Shell redirection for a known-content file bypasses the mutation tracker, '
    + 'loses diff visibility to downstream verification, and re-encounters the same streaming limit on the generator '
    + 'script itself. Use a shell script ONLY when the output is computed (loops, templating over many files, data '
    + 'transformation of an input you are reading) — e.g. generating 50 similar test fixtures from a template is a '
    + 'legitimate script use; reproducing one hand-written HTML file you already have in memory is not. ',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      run_in_background: { type: 'boolean' },
    },
    required: ['command'],
  },
};

export const TOOLS = [WRITE_TOOL, MULTI_EDIT_TOOL, BASH_TOOL];

export const SYSTEM_PROMPT = [
  'You are a coding assistant inside KodaX REPL. You can call tools to read, write, edit, and execute shell commands.',
  '',
  'For this task, do exactly what the user asked. Pick the most appropriate tool and call it.',
  'Reply with the tool call directly — no preamble explanation needed.',
].join('\n');

// ─── Cases — generative LARGE-file write tasks ────────────────────────

export interface ProbeCase {
  id: string;
  description: string;
  userMessage: string;
}

export const CASES: ProbeCase[] = [
  {
    id: 'yaml-config-server',
    description: 'Multi-section YAML server config, ~120-150 lines',
    userMessage:
      'Create a new file at `packages/foo/server.yml` containing a complete server configuration '
      + 'with these top-level sections, each with realistic populated values (not just keys, fill in '
      + 'real defaults a production server would use): server (host, port, tls, timeouts, max_body_size, '
      + 'request_id_header, cors with 6 fields), database (postgres with pool, ssl, replicas, statement_timeout, '
      + 'migrations), redis (cluster with sentinel mode, 3 nodes, password env var, key prefix, eviction), '
      + 'logging (json format, level, sampling, sinks: stdout + file + remote, rotation policy), metrics '
      + '(prometheus endpoint, statsd export, 8 standard counter names, histogram buckets), tracing (otel '
      + 'jaeger backend, sampling ratio, propagators, resource attributes), feature_flags (5 flags with '
      + 'rollout_percent + cohort_rules), and rate_limits (3 tiers with bucket_size + refill_rate + '
      + 'per-route overrides). Use full YAML, no shortcuts, real values throughout. Should land around '
      + '120-150 lines.',
  },
  {
    id: 'ts-class-skeleton',
    description: 'TypeScript class with 10 methods + JSDoc, ~130-180 lines',
    userMessage:
      'Create a new file at `packages/foo/cache-manager.ts` implementing a TypeScript class '
      + '`CacheManager<K, V>` with: a constructor taking `{ maxSize, ttlMs, onEvict?, persistencePath? }`; '
      + 'an internal `Map<K, { value: V; expiresAt: number; accessedAt: number }>`; methods: '
      + '`get(key) → V | undefined`, `set(key, value)`, `has(key) → boolean`, `delete(key) → boolean`, '
      + '`clear()`, `size() → number`, `entries() → IterableIterator<[K, V]>`, `prune() → number` (evicts '
      + 'expired + LRU when over maxSize, returns count evicted), `loadFromDisk(): Promise<void>` and '
      + '`flushToDisk(): Promise<void>`. Each method has a proper JSDoc block with @param + @returns + '
      + '@throws (where relevant). Include 2 private helpers `_isExpired(entry)` and `_evictOldest()`. '
      + 'Full implementation, real logic, no `// TODO` placeholders. Should land around 130-180 lines.',
  },
  {
    id: 'markdown-runbook',
    description: 'Markdown runbook with 6 substantive sections, ~100-130 lines',
    userMessage:
      'Create a new file at `docs/runbooks/postgres-failover.md` documenting our Postgres failover '
      + 'procedure. Include these sections, each with substantive content (not bullet stubs — actual '
      + 'paragraph-level prose plus concrete commands): (1) Overview (3-5 paragraphs on the failover '
      + 'topology: primary in us-east-1, two replicas in us-west-2, sync vs async lag tolerance), '
      + '(2) Detection (alert names from PagerDuty, expected MTTD, what the metric thresholds are), '
      + '(3) Triage Decision Tree (when to fail over vs when to wait — 4 specific scenarios with '
      + 'criteria), (4) Failover Steps (numbered, 8-12 steps with the exact `kubectl` / `pg_ctl` / '
      + '`patronictl` commands, expected output snippets after each), (5) Verification (4-6 checks: '
      + 'replication lag, connection count, write throughput, dependent service health), (6) Rollback '
      + 'Procedure (4 steps for reverting if failover went wrong). Real-looking content, not stubs.',
  },
];

// ─── Classifier — structural (tool name from harness binding) ─────────

export type Kind =
  | 'escape-bash-heredoc'
  | 'escape-bash-echo'
  | 'escape-bash-python'
  | 'write'
  | 'multi_edit'
  | 'bash-other'
  | 'no-tool'
  | 'other';

export interface Classification {
  kind: Kind;
  detail: string;
  bodyLines?: number;
  bodyChars?: number;
}

export function classifyToolCall(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  text: string,
): Classification {
  if (toolCalls.length === 0) {
    return { kind: 'no-tool', detail: `text-only (${text.length} chars)` };
  }
  const tc = toolCalls[0]!;
  if (tc.name === 'write') {
    const input = tc.input as { path?: string; content?: string };
    const lines = (input.content ?? '').split('\n').length;
    return { kind: 'write', detail: `write ${input.path} (${lines} lines)`, bodyLines: lines };
  }
  if (tc.name === 'multi_edit') {
    return { kind: 'multi_edit', detail: 'multi_edit (skeleton+fill?)' };
  }
  if (tc.name === 'bash') {
    const input = tc.input as { command?: string };
    const cmd = input.command ?? '';
    const heredocMatch = cmd.match(/<<\s*['"]?(\w+)['"]?/);
    if (heredocMatch) {
      const lines = cmd.split('\n').length;
      const chars = cmd.length;
      if (/python\d?\s+(<<|-c)/i.test(cmd) || cmd.includes('open(') || cmd.includes('.write(')) {
        return {
          kind: 'escape-bash-python',
          detail: `python heredoc (${lines}L/${chars}C)`,
          bodyLines: lines,
          bodyChars: chars,
        };
      }
      return {
        kind: 'escape-bash-heredoc',
        detail: `cat/tee heredoc (${lines}L/${chars}C)`,
        bodyLines: lines,
        bodyChars: chars,
      };
    }
    if (/echo\s+.*>\s*\S+\.(yml|yaml|ts|js|md|txt|json)/i.test(cmd)) {
      return { kind: 'escape-bash-echo', detail: `echo > file` };
    }
    return { kind: 'bash-other', detail: `bash (non-write): ${cmd.slice(0, 80)}` };
  }
  return { kind: 'other', detail: `tool=${tc.name}` };
}
