#!/usr/bin/env node

import { createHash } from 'node:crypto';
import process from 'node:process';

import { getProvider } from '../packages/llm/dist/providers/registry.js';

const intervals = [
  ['seed', 0],
  ['10s', 10_000],
  ['1m', 60_000],
  ['5m', 300_000],
  ['10m', 600_000],
];
const args = process.argv.slice(2);
const confirmed = args.includes('--confirm-cost');
const positional = args.filter((arg) => arg !== '--confirm-cost');

if (!confirmed || positional.length < 1 || args.includes('--help')) {
  process.stdout.write([
    'Usage: node scripts/probe-prompt-cache.mjs <provider> [model] --confirm-cost',
    '',
    'Runs five real, paid requests with one byte-stable prefix after waits of',
    '0s, 10s, 1m, 5m, and 10m. Build packages first with npm run build:packages.',
    'Only provider-reported cache usage is recorded; prompt text is never logged.',
    '',
  ].join('\n'));
  process.exit(confirmed || args.includes('--help') ? 0 : 2);
}

const providerName = positional[0];
const provider = getProvider(providerName);
const model = positional[1] ?? provider.getModel();
if (!provider.isConfigured()) {
  process.stderr.write(`Provider ${providerName} is not configured.\n`);
  process.exit(2);
}

const system = 'KodaX controlled prompt-cache lifetime probe. Keep this prefix stable. '
  .repeat(1_200);
const tools = [{
  name: 'cache_probe_marker',
  description: 'Stable no-op schema used only to measure provider prompt-cache behavior.',
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
    required: ['value'],
  },
}];
const messages = [{
  role: 'user',
  content: 'Reply with exactly: cache-probe-ok',
}];

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sanitizeEndpoint(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return {
      origin: url.origin,
      pathHash: hash(url.pathname),
    };
  } catch {
    return undefined;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const endpointIdentity = sanitizeEndpoint(provider.getBaseUrl());
const identity = {
  provider: providerName,
  model,
  wireModel: provider.getWireModel(model),
  endpoint: endpointIdentity?.origin,
  endpointPathHash: endpointIdentity?.pathHash,
  systemPromptHash: hash(system),
  toolSchemaHash: hash(tools),
  messagePrefixHash: hash(messages),
};
process.stdout.write(`${JSON.stringify({ kind: 'prompt-cache-probe', ...identity })}\n`);

for (const [label, delayMs] of intervals) {
  if (delayMs > 0) {
    process.stdout.write(`${JSON.stringify({ kind: 'waiting', label, delayMs })}\n`);
    await wait(delayMs);
  }
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const result = await provider.stream(
      messages,
      tools,
      system,
      false,
      { modelOverride: model },
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify({
      kind: 'result',
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      ...identity,
      usage: result.usage,
    })}\n`);
  } finally {
    clearTimeout(timer);
  }
}
