#!/usr/bin/env node
// SDK stdin/process state probe — answers "does importing or calling
// @kodax-ai/kodax mutate process.stdin / signal listeners / raw mode?"
//
// Why this exists: KodaX Space (v0.7.43 link target) reported that
// `scripts/dev.mjs` spawn Electron with `stdio: 'inherit'` lost PowerShell
// keyboard input after SDK import, and hypothesised the SDK was attaching
// readline/tty hooks at module-eval time. This probe empirically falsifies
// that hypothesis — see docs/SDK_EMBEDDER_GUIDE.md §8 for the actual root
// cause (Electron + Windows ConPTY stdin handle inheritance).
//
// Usage (from repo root):
//   node scripts/probe-sdk-stdin.mjs           # uses ./dist/
//   node scripts/probe-sdk-stdin.mjs <distDir> # uses absolute dist path
//
// The probe spans two phases:
//   Phase A — pure import of every SDK subpath bundle
//   Phase B — the Space startup-sequence calls
//             (hydrateProcessEnvFromShell / typeof / loadConfig / providers)
//
// A non-zero delta on any step indicates a real SDK regression.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

function snap() {
  return {
    data: process.stdin.listenerCount('data'),
    readable: process.stdin.listenerCount('readable'),
    keypress: process.stdin.listenerCount('keypress'),
    end: process.stdin.listenerCount('end'),
    close: process.stdin.listenerCount('close'),
    rawMode: process.stdin.isRaw ?? null,
    paused: process.stdin.isPaused?.() ?? null,
    flowing: process.stdin._readableState?.flowing ?? null,
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
    exit: process.listenerCount('exit'),
    beforeExit: process.listenerCount('beforeExit'),
    uncaughtException: process.listenerCount('uncaughtException'),
  };
}

function delta(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) out[k] = `${before[k]} → ${after[k]}`;
  }
  return out;
}

const distRoot = path.resolve(process.argv[2] ?? './dist');

console.log(`Node ${process.version} on ${process.platform}`);
console.log(`isTTY: stdin=${process.stdin.isTTY} stdout=${process.stdout.isTTY}`);
console.log(`SHELL: ${process.env.SHELL ?? '(unset)'}`);
console.log(`dist:  ${distRoot}`);
console.log('');

const subpaths = [
  ['root',    `${distRoot}/index.js`],
  ['agent',   `${distRoot}/sdk-agent.js`],
  ['llm',     `${distRoot}/sdk-llm.js`],
  ['coding',  `${distRoot}/sdk-coding.js`],
  ['mcp',     `${distRoot}/sdk-mcp.js`],
  ['session', `${distRoot}/sdk-session.js`],
  ['skills',  `${distRoot}/sdk-skills.js`],
  ['repl',    `${distRoot}/sdk-repl.js`],
];

let regressionFound = false;

console.log('--- Phase A: pure import ---');
for (const [label, target] of subpaths) {
  const before = snap();
  try {
    await import(pathToFileURL(target).href);
  } catch (err) {
    console.log(`  [${label}] IMPORT FAILED: ${err.message}`);
    continue;
  }
  const d = delta(before, snap());
  if (Object.keys(d).length === 0) {
    console.log(`  [${label}] no state change ✓`);
  } else {
    console.log(`  [${label}] REGRESSION:`, d);
    regressionFound = true;
  }
}

console.log('');
console.log('--- Phase B: Space startup-sequence calls ---');
const sdk = await import(pathToFileURL(`${distRoot}/index.js`).href);

{
  const before = snap();
  const result = sdk.hydrateProcessEnvFromShell();
  const d = delta(before, snap());
  console.log(`  hydrateProcessEnvFromShell() → ${result}`);
  if (Object.keys(d).length === 0) console.log('    no state change ✓');
  else { console.log('    REGRESSION:', d); regressionFound = true; }
}

{
  const before = snap();
  void typeof sdk.runKodaX;
  void typeof sdk.startKodaX;
  void typeof sdk.loadConfig;
  const d = delta(before, snap());
  console.log(`  typeof sdk.{runKodaX, startKodaX, loadConfig}`);
  if (Object.keys(d).length === 0) console.log('    no state change ✓');
  else { console.log('    REGRESSION:', d); regressionFound = true; }
}

{
  const before = snap();
  const config = sdk.loadConfig?.() ?? {};
  const mcp = sdk.listMcpServers?.() ?? [];
  const d = delta(before, snap());
  console.log(`  loadConfig() (${Object.keys(config).length} keys) + listMcpServers() (${mcp.length} entries)`);
  if (Object.keys(d).length === 0) console.log('    no state change ✓');
  else { console.log('    REGRESSION:', d); regressionFound = true; }
}

{
  const before = snap();
  void sdk.KODAX_PROVIDER_SNAPSHOTS;
  const providers = sdk.getProviderList?.() ?? [];
  const d = delta(before, snap());
  console.log(`  KODAX_PROVIDER_SNAPSHOTS + getProviderList() (${providers.length} providers)`);
  if (Object.keys(d).length === 0) console.log('    no state change ✓');
  else { console.log('    REGRESSION:', d); regressionFound = true; }
}

console.log('');
if (regressionFound) {
  console.log('RESULT: regression detected — SDK is mutating process state at import or startup call.');
  process.exit(1);
} else {
  console.log('RESULT: clean — SDK import + startup sequence do not mutate process.stdin or signal handlers.');
  process.exit(0);
}
