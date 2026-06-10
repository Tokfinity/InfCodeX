import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import {
  getDefaultSkillPaths,
  killChildProcessTreeSync,
  registerManagedChildProcess,
} from '@kodax-ai/agent';

export const SKILL_CREATOR_TOOLS = {
  init: 'init-skill.js',
  validate: 'quick-validate.js',
  eval: 'run-eval.js',
  grade: 'grade-evals.js',
  analyze: 'analyze-benchmark.js',
  compare: 'compare-runs.js',
  package: 'package-skill.js',
  install: 'install-skill.js',
} as const;

export type SkillCreatorToolAction = keyof typeof SKILL_CREATOR_TOOLS;

export function resolveSkillCreatorToolPath(
  action: SkillCreatorToolAction,
  builtinPath: string = getDefaultSkillPaths().builtinPath
): string {
  return path.join(
    builtinPath,
    'skill-creator',
    'scripts',
    SKILL_CREATOR_TOOLS[action]
  );
}

export async function defaultSkillToolRunner(
  scriptPath: string,
  args: string[]
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
    });
    const unregisterManagedChild = registerManagedChildProcess(child, {
      kind: 'skill-cli',
      command: process.execPath,
      args: [scriptPath, ...args],
    });
    const cleanupOnProcessExit = (): void => killChildProcessTreeSync(child);
    process.once('exit', cleanupOnProcessExit);
    const cleanup = (): void => {
      process.off('exit', cleanupOnProcessExit);
      unregisterManagedChild();
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

export async function runSkillCreatorTool(
  action: SkillCreatorToolAction,
  args: string[],
  runner: (scriptPath: string, args: string[]) => Promise<number> = defaultSkillToolRunner
): Promise<void> {
  const scriptPath = resolveSkillCreatorToolPath(action);
  const exitCode = await runner(scriptPath, args);
  if (exitCode !== 0) {
    throw new Error(`skill ${action} failed with exit code ${exitCode}`);
  }
}

export function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
