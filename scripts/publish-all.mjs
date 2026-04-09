import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workspaceArgs = Array.isArray(packageJson.workspaces)
  ? packageJson.workspaces.flatMap((workspace) => ['--workspace', workspace])
  : [];
const passthroughArgs = process.argv.slice(2);

const commands = [
  ['npm', ['publish', ...workspaceArgs, ...passthroughArgs]],
  ['npm', ['publish', ...passthroughArgs]],
];

for (const [command, args] of commands) {
  console.log(`\n[publish-all] Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
