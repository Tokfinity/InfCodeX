#!/usr/bin/env node
/**
 * Wire-level smoke probe — verifies every (provider, model) pair in the
 * registry will round-trip a real single-turn stream against its upstream
 * gateway. Catches gateway-specific config drift (the canonical example:
 * a `maxOutputTokens` set higher than the gateway accepts, which 400s
 * the first stream and yields no usable diagnostic for the user).
 *
 * ## When to run
 *
 *   - After editing `provider-capabilities.json` (any maxOutputTokens
 *     / contextWindow / new model / new provider).
 *   - Before bumping a release that touches LLM provider wiring.
 *   - When a user reports a 400-on-first-call from a specific provider.
 *
 * ## What it does
 *
 *   For every non–CLI-bridge provider that has its API key set, sends
 *   a "hi" single-turn `stream()` call to each routed model with the
 *   provider's configured per-turn `max_tokens` on the wire. Reports
 *   per-pair OK / ERR-max-tokens / ERR-context / ERR-other / SKIP.
 *
 * ## Usage
 *
 *   node scripts/probe-max-tokens.mjs               # probe everything
 *   node scripts/probe-max-tokens.mjs ark-coding     # probe one provider
 *   node scripts/probe-max-tokens.mjs --help
 *
 * ## Exit code
 *
 *   0 if every reachable pair succeeded; 1 if any failure (so it can
 *   gate a CI smoke job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProvider } from '../packages/llm/dist/providers/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CAPS_PATH = join(
  REPO_ROOT,
  'packages/llm/src/providers/provider-capabilities.json',
);

const TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/probe-max-tokens.mjs [provider-name]\n' +
        '\n' +
        '  Probes every (provider, model) pair in provider-capabilities.json\n' +
        '  via a real single-turn "hi" stream call. Reports any pair whose\n' +
        '  upstream gateway rejects the configured max_tokens or returns a\n' +
        '  non-OK status.\n' +
        '\n' +
        '  Pass a single provider name to limit the probe to that provider\n' +
        '  (e.g. `ark-coding`, `zhipu-coding`). Without args, every non-\n' +
        '  CLI-bridge provider that has its API key set is probed.\n',
    );
    process.exit(0);
  }
  return { providerFilter: args[0] };
}

function loadTargets(providerFilter) {
  const raw = JSON.parse(readFileSync(CAPS_PATH, 'utf8'));
  const targets = [];
  for (const [name, snapshot] of Object.entries(raw.providers)) {
    if (snapshot.cliBridge) continue;
    if (providerFilter && name !== providerFilter) continue;
    const ids = new Set([snapshot.model]);
    for (const m of snapshot.models ?? []) ids.add(m.id);
    targets.push([name, [...ids]]);
  }
  if (providerFilter && targets.length === 0) {
    process.stderr.write(`Unknown provider: ${providerFilter}\n`);
    process.exit(2);
  }
  return targets;
}

async function probe(providerName, model) {
  let provider;
  try {
    provider = getProvider(providerName);
  } catch (e) {
    return {
      providerName,
      model,
      status: 'ERR-instantiate',
      detail: String(e?.message ?? e).slice(0, 200),
    };
  }

  if (!provider.isConfigured()) {
    return { providerName, model, status: 'SKIP-no-key', detail: '' };
  }

  const effectiveMaxOutput = provider.getEffectiveMaxOutputTokens?.(model) ?? -1;
  const effectiveCtx = provider.getEffectiveContextWindow?.(model) ?? -1;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const result = await provider.stream(
      [{ role: 'user', content: 'hi' }],
      [],
      'You are concise. Reply with one word.',
      false,
      { modelOverride: model },
      ctrl.signal,
    );
    const text = (result.textBlocks ?? [])
      .map((b) => b.text ?? '')
      .join('')
      .slice(0, 60)
      .replace(/\n/g, ' / ');
    const out = result.usage?.outputTokens ?? '?';
    const stop = result.stopReason ?? '?';
    return {
      providerName,
      model,
      status: 'OK',
      detail: `text="${text}" stop=${stop} out=${out}tk maxOut=${effectiveMaxOutput}`,
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    let status = 'ERR-other';
    if (/max_tokens/i.test(msg) && /(maximum|above|cap|invalid)/i.test(msg)) {
      status = 'ERR-max-tokens';
    } else if (/context|tokens|window/i.test(msg) && /(maximum|above)/i.test(msg)) {
      status = 'ERR-context';
    }
    return {
      providerName,
      model,
      status,
      detail: `ctx=${effectiveCtx} maxOut=${effectiveMaxOutput} err="${msg.slice(0, 300).replace(/\n/g, ' / ')}"`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const { providerFilter } = parseArgs(process.argv);
const targets = loadTargets(providerFilter);
const results = [];

process.stdout.write('=== Probe (provider, model) with simple "hi" prompt ===\n\n');
for (const [providerName, models] of targets) {
  for (const model of models) {
    process.stdout.write(`  ${providerName.padEnd(16)} ${model.padEnd(28)} ... `);
    const r = await probe(providerName, model);
    process.stdout.write(`${r.status}\n`);
    if (r.detail) process.stdout.write(`    ${r.detail}\n`);
    results.push(r);
  }
}

process.stdout.write('\n=== Summary ===\n');
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
for (const [status, count] of Object.entries(byStatus)) {
  process.stdout.write(`  ${status}: ${count}\n`);
}

const failures = results.filter((r) => r.status.startsWith('ERR'));
if (failures.length > 0) {
  process.stdout.write('\n=== Failures detail ===\n');
  for (const f of failures) {
    process.stdout.write(`  ${f.providerName}/${f.model} [${f.status}]\n`);
    process.stdout.write(`    ${f.detail}\n`);
  }
  process.exit(1);
}
