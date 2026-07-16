#!/usr/bin/env node
// v0.7.43 — Probe upstream provider /models APIs to see what model
// metadata they actually return, so we can decide which fields are
// trustworthy to surface in `KodaXModelCapabilities`.
//
// Tested only against providers the operator has keys for. Anthropic
// is intentionally skipped per maintainer instruction (no probe).
//
// Run:
//   node scripts/probe-upstream-model-metadata.mjs
//
// Skips any provider whose API key env var is unset.

import process from 'node:process';

const TARGETS = [
  {
    name: 'zhipu-coding',
    apiKeyEnv: 'ZHIPU_CODING_API_KEY',
    // Coding-plan endpoint is Anthropic-style; the standard model
    // listing lives on the OpenAI-style sibling endpoint.
    url: 'https://open.bigmodel.cn/api/paas/v4/models',
    auth: (k) => `Bearer ${k}`,
  },
  {
    name: 'kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    // Kimi Open Platform and Kimi For Coding use different credentials.
    // This public model list must be queried with the Open Platform key.
    url: 'https://api.moonshot.cn/v1/models',
    auth: (k) => `Bearer ${k}`,
  },
  {
    name: 'minimax-coding',
    apiKeyEnv: 'MINIMAX_CODING_API_KEY',
    // MiniMax doesn't expose a public Anthropic-style /models endpoint
    // on the Token Plan host. Try the platform's official chat host.
    url: 'https://api.minimaxi.com/v1/models',
    auth: (k) => `Bearer ${k}`,
  },
  {
    name: 'ark-coding',
    apiKeyEnv: 'ARK_CODING_API_KEY',
    // Volcengine Ark public catalog endpoint.
    url: 'https://ark.cn-beijing.volces.com/api/v3/models',
    auth: (k) => `Bearer ${k}`,
  },
  {
    name: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/v1/models',
    auth: (k) => `Bearer ${k}`,
  },
];

async function probeOne(target) {
  const key = process.env[target.apiKeyEnv];
  if (!key) {
    console.log(`\n=== ${target.name} ===`);
    console.log(`  [skip] ${target.apiKeyEnv} not set`);
    return { name: target.name, status: 'skip' };
  }

  console.log(`\n=== ${target.name} ===`);
  console.log(`  GET ${target.url}`);
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      headers: { Authorization: target.auth(key) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    console.log(`  HTTP ${res.status} ${res.statusText} · ${text.length} bytes`);
    if (!res.ok) {
      console.log(`  body[:500]:`, text.slice(0, 500));
      return { name: target.name, status: 'http_error', code: res.status };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.log(`  body[:500]:`, text.slice(0, 500));
      return { name: target.name, status: 'non_json' };
    }
    const list =
      Array.isArray(body) ? body
      : Array.isArray(body.data) ? body.data
      : Array.isArray(body.models) ? body.models
      : null;
    if (!list) {
      console.log(`  shape: keys=${Object.keys(body).join(', ')}`);
      console.log(`  body[:500]:`, JSON.stringify(body).slice(0, 500));
      return { name: target.name, status: 'unexpected_shape' };
    }
    console.log(`  ${list.length} models returned`);
    // Aggregate the field set across all entries (so partial fields don't get missed).
    const allFields = new Set();
    for (const m of list) {
      if (m && typeof m === 'object') {
        for (const k of Object.keys(m)) allFields.add(k);
      }
    }
    console.log(`  fields present (union): ${[...allFields].sort().join(', ')}`);
    // Show the first 2 entries verbatim (compact).
    for (const m of list.slice(0, 2)) {
      console.log(`  sample:`, JSON.stringify(m));
    }
    // Look for context-window-like fields.
    const cwLike = [...allFields].filter((f) =>
      /context|window|max.*input|max.*tokens|input.*tokens|max.*length/i.test(f),
    );
    console.log(`  context-window-like fields: ${cwLike.length ? cwLike.join(', ') : '(none found)'}`);
    return { name: target.name, status: 'ok', count: list.length, fields: [...allFields], cwLike };
  } catch (err) {
    console.log(`  [error]`, err.message);
    return { name: target.name, status: 'fetch_error', error: err.message };
  }
}

const summary = [];
for (const target of TARGETS) {
  summary.push(await probeOne(target));
}

console.log(`\n\n=========== SUMMARY ===========`);
for (const r of summary) {
  if (r.status === 'ok') {
    console.log(`${r.name}: ${r.count} models · context fields = ${r.cwLike.length ? r.cwLike.join('|') : '(none)'}`);
  } else {
    console.log(`${r.name}: ${r.status}${r.code ? ` (HTTP ${r.code})` : ''}`);
  }
}
