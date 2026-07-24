import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  OPTIONAL_FOLLOWUP_REGRESSION_CASES,
  OPTIONAL_FOLLOWUP_REGRESSION_CASE_IDS,
  VERIFIER_REPORT_TOOL,
  VERIFIER_SYSTEM_PROMPT,
  buildTreatmentUserMessage,
  classifyVerdict,
} from '../benchmark/datasets/feature-184-sidecar-verifier/cases.js';

const OPTIONAL_FOLLOWUP_GUIDANCE =
  'If the current request is already satisfied and the final text merely offers optional follow-up or additional work, choose `accept` even when that offer is phrased as a question. Judge completion against the current request, not against work the agent only offered to do next.';
const REQUIRED_CLARIFICATION_GUIDANCE =
  '- A clarifying question is `blocked` only when the user must answer it before the current request can be satisfied.';

function removePromptLine(prompt: string, line: string): string {
  const occurrences = prompt.split(line).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one prompt line occurrence, found ${occurrences}: ${line}`);
  }
  return prompt.replace(`${line}\n`, '');
}

const BASELINE_SYSTEM_PROMPT = removePromptLine(
  removePromptLine(VERIFIER_SYSTEM_PROMPT, OPTIONAL_FOLLOWUP_GUIDANCE),
  REQUIRED_CLARIFICATION_GUIDANCE,
);

const REQUESTED_ALIASES: readonly ModelAlias[] = process.env.KODAX_I206_ALIASES
  ? process.env.KODAX_I206_ALIASES.split(',').map((alias) => alias.trim()) as ModelAlias[]
  : ['zhipu/glm52', 'ark/v4flash'];
const REQUESTED_CASE_IDS = process.env.KODAX_I206_CASES
  ? process.env.KODAX_I206_CASES.split(',').map((caseId) => caseId.trim())
  : undefined;
const EXPERIMENT_REVISION = 2;
const MAX_PROVIDER_CALLS = 16;
const MAX_CALLS_PER_CELL = 1;
const MAX_ROUNDS_PER_CELL = 1;
const MAX_OUTPUT_TOKENS_PER_CALL = 256;
const MAX_TOTAL_TOKENS = 100_000;
const MAX_EXTERNAL_SPEND_USD = 1.60;
const TIMEOUT_MS = 120_000;
const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'issue-206-sidecar-optional-followup',
);

type Arm = 'A' | 'B';

const ARMS: ReadonlyArray<{
  readonly arm: Arm;
  readonly systemPrompt: string;
}> = [
  { arm: 'A', systemPrompt: BASELINE_SYSTEM_PROMPT },
  { arm: 'B', systemPrompt: VERIFIER_SYSTEM_PROMPT },
];

interface ProbeRow {
  readonly caseId: string;
  readonly expectedVerdict: 'accept' | 'revise' | 'blocked';
  readonly arm: Arm;
  readonly alias: ModelAlias;
  readonly inputHash: string;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly verdict: 'accept' | 'revise' | 'blocked' | null;
  readonly reason: string;
  readonly passed: boolean;
}

describe('Eval: Issue 206 Sidecar optional follow-up boundary', () => {
  const aliases = availableAliases(...REQUESTED_ALIASES);
  const cases = REQUESTED_CASE_IDS
    ? OPTIONAL_FOLLOWUP_REGRESSION_CASES.filter(({ id }) => REQUESTED_CASE_IDS.includes(id))
    : OPTIONAL_FOLLOWUP_REGRESSION_CASES;

  if (REQUESTED_CASE_IDS && cases.length !== REQUESTED_CASE_IDS.length) {
    throw new Error(
      `Unknown Issue 206 case id in: ${REQUESTED_CASE_IDS.join(',')}`,
    );
  }

  if (aliases.length === 0) {
    it('skips when no configured pilot provider is available', () => {
      expect(aliases).toEqual([]);
    });
    return;
  }

  it('runs a bounded single-turn production-prompt A/B probe', { timeout: 900_000 }, async () => {
    const expectedCalls = aliases.length * cases.length * ARMS.length;
    expect(cases.map((candidate) => candidate.id)).toEqual(
      REQUESTED_CASE_IDS ?? OPTIONAL_FOLLOWUP_REGRESSION_CASE_IDS,
    );
    expect(MAX_CALLS_PER_CELL).toBe(1);
    expect(MAX_ROUNDS_PER_CELL).toBe(1);
    expect(expectedCalls).toBeLessThanOrEqual(MAX_PROVIDER_CALLS);

    const rows: ProbeRow[] = [];
    let providerCalls = 0;
    let reportedTokens = 0;
    let missingUsageRows = 0;

    for (const candidate of cases) {
      const userMessage = buildTreatmentUserMessage(candidate);
      for (const arm of ARMS) {
        for (const alias of aliases) {
          if (providerCalls >= MAX_PROVIDER_CALLS) {
            throw new Error(`Provider call budget exhausted at ${providerCalls}`);
          }
          const inputHash = createHash('sha256')
            .update(arm.systemPrompt)
            .update('\0')
            .update(userMessage)
            .digest('hex');
          const result = await runOneShot(alias, {
            systemPrompt: arm.systemPrompt,
            userMessage,
            tools: [VERIFIER_REPORT_TOOL],
            timeoutMs: TIMEOUT_MS,
            maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
          });
          providerCalls++;
          const classification = classifyVerdict(
            'treatment',
            candidate.expectedVerdict,
            result.toolCalls,
          );
          if (result.usage) {
            reportedTokens += result.usage.totalTokens;
          } else {
            missingUsageRows++;
          }
          rows.push({
            caseId: candidate.id,
            expectedVerdict: candidate.expectedVerdict,
            arm: arm.arm,
            alias,
            inputHash,
            durationMs: result.durationMs,
            text: result.text,
            toolCalls: result.toolCalls,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            verdict: classification.verdict,
            reason: classification.reason,
            passed: classification.primaryPassed,
          });
          if (reportedTokens > MAX_TOTAL_TOKENS) {
            throw new Error(`Reported token budget exceeded: ${reportedTokens}`);
          }
        }
      }
    }

    mkdirSync(DUMP_ROOT, { recursive: true });
    const dumpPath = join(
      DUMP_ROOT,
      `pilot-r${EXPERIMENT_REVISION}-${Date.now()}.json`,
    );
    writeFileSync(
      dumpPath,
      JSON.stringify({
        experiment: 'issue-206-sidecar-optional-followup',
        revision: EXPERIMENT_REVISION,
        layer: 2,
        stage: `pilot-r${EXPERIMENT_REVISION}`,
        budget: {
          maxProviderCalls: MAX_PROVIDER_CALLS,
          maxCallsPerCell: MAX_CALLS_PER_CELL,
          maxRoundsPerCell: MAX_ROUNDS_PER_CELL,
          maxOutputTokensPerCall: MAX_OUTPUT_TOKENS_PER_CALL,
          maxTotalTokens: MAX_TOTAL_TOKENS,
          maxExternalSpendUsd: MAX_EXTERNAL_SPEND_USD,
          timeoutMs: TIMEOUT_MS,
        },
        aliases,
        providerCalls,
        reportedTokens,
        missingUsageRows,
        rows,
        mainSessionReview: [],
      }, null, 2),
      'utf-8',
    );
    process.stdout.write(`[Issue 206 eval] raw dump: ${dumpPath}\n`);

    expect(rows).toHaveLength(expectedCalls);
    expect(providerCalls).toBe(expectedCalls);
  });
});
