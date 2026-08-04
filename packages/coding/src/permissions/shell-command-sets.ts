import { listBuiltinToolDefinitions } from '../tools/registry.js';

/** Permission sets shared by the REPL gate and the auto-mode analyzer. */
const builtinTools = listBuiltinToolDefinitions();

export const FILE_MODIFICATION_TOOLS: Set<string> = new Set(
  builtinTools
    .filter((tool) => tool.sideEffect === 'mutates-fs' && tool.requiredParams.includes('path'))
    .map((tool) => tool.name),
);

export const MODIFICATION_TOOLS: Set<string> = new Set(
  builtinTools.filter((tool) => tool.sideEffect !== 'readonly').map((tool) => tool.name),
);

export const BASH_WRITE_COMMANDS = new Set([
  'npm install', 'npm i', 'npm uninstall', 'npm remove', 'npm update', 'npm ci',
  'yarn add', 'yarn remove', 'yarn upgrade',
  'pnpm add', 'pnpm remove', 'pnpm update',
  'git clean', 'git reset', 'git checkout', 'git switch', 'git merge', 'git rebase',
  'git cherry-pick', 'git revert', 'git commit', 'git push', 'git pull',
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown',
  'del', 'erase', 'rd', 'copy', 'move', 'ren',
  'curl', 'wget', 'dd', 'tar',
  'kill', 'pkill', 'killall',
]);

export const BASH_SAFE_READ_COMMANDS = new Set([
  'ls', 'cat', 'pwd', 'echo', 'whoami', 'date', 'which', 'whereis', 'tree',
  'dir', 'type', 'get-childitem', 'get-content', 'select-string', 'get-location',
  'where', 'grep', 'find', 'head', 'tail', 'more', 'wc', 'findstr',
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'git remote', 'git ls-files', 'git rev-parse', 'git grep',
  'git tag', 'git stash list', 'git describe', 'git config --get',
  'npm', 'tsc', 'go', 'cargo', 'rustc',
]);
