import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assertContains(content, needle, filePath) {
  if (!content.includes(needle)) {
    console.error(`[verify:publish] Missing expected content in ${filePath}: ${needle}`);
    process.exit(1);
  }
}

const distCliPath = resolve(process.cwd(), 'dist/kodax_cli.js');
const packageJsonPath = resolve(process.cwd(), 'package.json');

let distCli;
let packageJson;

try {
  distCli = readFileSync(distCliPath, 'utf8');
} catch (error) {
  console.error(`[verify:publish] Failed to read ${distCliPath}:`, error.message);
  process.exit(1);
}

try {
  packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
} catch (error) {
  console.error(`[verify:publish] Failed to parse ${packageJsonPath}:`, error.message);
  process.exit(1);
}

assertContains(distCli, '--profile <name>', distCliPath);
assertContains(distCli, 'aamp serve', distCliPath);

if (packageJson?.bin?.kodax !== './dist/kodax_cli.js') {
  console.error('[verify:publish] package.json bin.kodax must point to ./dist/kodax_cli.js');
  process.exit(1);
}

console.log('[verify:publish] OK: dist CLI contains AAMP profile option and bin mapping is correct.');
