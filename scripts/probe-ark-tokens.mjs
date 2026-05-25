#!/usr/bin/env node
// Drill-down: look at Ark's response in detail for the models KodaX actually uses.
import process from 'node:process';

const key = process.env.ARK_API_KEY;
if (!key) { console.error('ARK_API_KEY not set'); process.exit(1); }

const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/models', {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(15_000),
});
const body = await res.json();
const list = body.data ?? body.models ?? body;

// What KodaX exposes via ark-coding snapshot
const interesting = [
  'glm-5.1', 'glm-4.7',
  'kimi-k2.6', 'kimi-k2.5',
  'minimax-latest',
  'deepseek-v3.2', 'deepseek-v4-pro', 'deepseek-v4-flash',
  'doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite',
];

console.log(`Total models returned: ${list.length}`);
console.log(`\nSample first entry (full):`);
console.log(JSON.stringify(list[0], null, 2));

console.log(`\n\nKodaX-relevant model entries:`);
let foundCount = 0;
for (const want of interesting) {
  const hits = list.filter((m) => m.id === want || m.name === want || m.id?.startsWith(want + '-'));
  if (hits.length === 0) {
    console.log(`\n[${want}] NOT FOUND`);
    continue;
  }
  foundCount += hits.length;
  for (const m of hits) {
    console.log(`\n[${want}] match: id=${m.id} name=${m.name}`);
    console.log(JSON.stringify(m, null, 2));
  }
}

// Any populated token_limits anywhere?
const withTokenLimits = list.filter((m) => m.token_limits && Object.keys(m.token_limits).length > 0);
console.log(`\n\nModels with populated token_limits: ${withTokenLimits.length} / ${list.length}`);
if (withTokenLimits.length > 0) {
  console.log(`First with token_limits:`);
  console.log(JSON.stringify(withTokenLimits[0], null, 2));
}

const withFeatures = list.filter((m) => m.features && Object.keys(m.features).length > 0);
console.log(`\nModels with populated features: ${withFeatures.length} / ${list.length}`);
if (withFeatures.length > 0) {
  console.log(`First with features:`);
  console.log(JSON.stringify(withFeatures[0], null, 2));
}
