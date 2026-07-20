#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProvider } from '../packages/llm/src/providers/registry.js';
import type { KodaXReasoningRequest, KodaXTokenUsage } from '../packages/llm/src/types.js';

const MAX_PROVIDER_CALLS = 40;
const MAX_OUTPUT_TOKENS = 128;
const MAX_TOTAL_TOKENS = 10_000;
const MAX_EXTERNAL_SPEND_USD = 1;
const TIMEOUT_MS = 90_000;
const USER_MESSAGE = 'Reply with exactly OK. Do not explain.';
const SYSTEM_MESSAGE = 'Return only the requested final answer.';

interface ProbeTarget {
  readonly provider: string;
  readonly model: string;
}

interface ProbeResult extends ProbeTarget {
  readonly expectation: 'disabled' | 'always-on' | 'unknown';
  readonly status: string;
  readonly durationMs: number;
  readonly text: string;
  readonly thinking: readonly string[];
  readonly usage?: KodaXTokenUsage;
  readonly error?: string;
}

function parseTarget(value: string): ProbeTarget {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid target "${value}"; expected provider/model.`);
  }
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

function usage(): never {
  process.stderr.write(
    'Usage: npm run probe:reasoning -- provider/model [provider/model ...]\n',
  );
  process.exit(2);
}

async function probe(target: ProbeTarget): Promise<ProbeResult> {
  const provider = getProvider(target.provider);
  const profile = provider.getReasoningProfile(target.model);
  const expectation = profile?.supportsDisabledThinking === true
    ? 'disabled'
    : profile?.localRejectEfforts?.includes('none') === true
      ? 'always-on'
      : 'unknown';
  const reasoning: KodaXReasoningRequest | undefined = expectation === 'disabled'
    ? {
        enabled: true,
        effort: 'none',
        taskType: 'plan',
        executionMode: 'planning',
      }
    : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const result = await provider.stream(
      [{ role: 'user', content: USER_MESSAGE }],
      [],
      SYSTEM_MESSAGE,
      reasoning,
      {
        modelOverride: target.model,
        maxOutputTokensOverride: MAX_OUTPUT_TOKENS,
      },
      controller.signal,
    );
    const thinking = result.thinkingBlocks.map((block) => block.thinking);
    const hasThinking = thinking.some((value) => value.trim().length > 0);
    const status = expectation === 'disabled'
      ? hasThinking ? 'FAIL-thinking-present' : 'PASS-disabled'
      : expectation === 'always-on'
        ? hasThinking ? 'PASS-always-on' : 'INCONCLUSIVE-no-thinking'
        : hasThinking ? 'OBSERVED-thinking' : 'OBSERVED-no-thinking';
    return {
      ...target,
      expectation,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      text: result.textBlocks.map((block) => block.text).join(''),
      thinking,
      usage: result.usage,
    };
  } catch (error: unknown) {
    return {
      ...target,
      expectation,
      status: 'ERROR',
      durationMs: Math.round(performance.now() - startedAt),
      text: '',
      thinking: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const targetArgs = process.argv.slice(2);
if (targetArgs.length === 0) usage();
if (targetArgs.length > MAX_PROVIDER_CALLS) {
  throw new Error(`Refusing ${targetArgs.length} targets; maximum is ${MAX_PROVIDER_CALLS}.`);
}

const targets = targetArgs.map(parseTarget);
const grouped = new Map<string, ProbeTarget[]>();
for (const target of targets) {
  const providerTargets = grouped.get(target.provider) ?? [];
  providerTargets.push(target);
  grouped.set(target.provider, providerTargets);
}
const providerRuns = [...grouped.values()].map(async (providerTargets) => {
  const results: ProbeResult[] = [];
  for (const target of providerTargets) {
    process.stdout.write(`Probing ${target.provider}/${target.model} ... `);
    const result = await probe(target);
    process.stdout.write(`${result.status} (${result.durationMs}ms)\n`);
    results.push(result);
  }
  return results;
});
const results = (await Promise.all(providerRuns)).flat();
const totalTokens = results.reduce(
  (sum, result) => sum + (result.usage?.totalTokens ?? 0),
  0,
);
const dumpDir = join(tmpdir(), 'kodax-eval-dumps', 'v073-reasoning-disable');
mkdirSync(dumpDir, { recursive: true });
const dumpPath = join(dumpDir, `probe-${Date.now()}.json`);
writeFileSync(dumpPath, JSON.stringify({
  case: 'provider_reasoning_disable',
  stage: 'live-capability-probe',
  userMessage: USER_MESSAGE,
  limits: {
    maxProviderCalls: MAX_PROVIDER_CALLS,
    actualProviderCalls: results.length,
    maxCallsPerCell: 1,
    maxRoundsPerCell: 1,
    maxOutputTokensPerCall: MAX_OUTPUT_TOKENS,
    maxTotalTokens: MAX_TOTAL_TOKENS,
    actualTotalTokens: totalTokens,
    maxExternalSpendUsd: MAX_EXTERNAL_SPEND_USD,
    timeoutMs: TIMEOUT_MS,
  },
  results,
}, null, 2));

process.stdout.write(`Raw dump: ${dumpPath}\n`);
if (
  totalTokens > MAX_TOTAL_TOKENS
  || results.some((result) => result.status.startsWith('FAIL') || result.status === 'ERROR')
) {
  process.exitCode = 1;
}
