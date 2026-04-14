#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const releaseScript = fileURLToPath(new URL('./release.mjs', import.meta.url));
const result = spawnSync(
  process.execPath,
  [releaseScript, '--brand=infcodex', '--pack-only', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`InfCodeX release terminated by signal ${result.signal}`);
}
process.exitCode = result.status ?? 1;
