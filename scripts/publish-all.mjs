import { spawnSync } from 'node:child_process';

const passthroughArgs = process.argv.slice(2);
const commands = [
  ['npm', ['publish', '--workspaces', ...passthroughArgs]],
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
