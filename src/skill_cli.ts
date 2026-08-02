import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import {
  getDefaultSkillPaths,
  killChildProcessTreeSync,
  prepareInternalNodeLaunch,
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

export const INTERNAL_SKILL_DISPATCH_ENV = 'KODAX_INTERNAL_SKILL_DISPATCH';

export function consumeInternalSkillDispatchFlag(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[INTERNAL_SKILL_DISPATCH_ENV] !== '1') return false;
  delete env[INTERNAL_SKILL_DISPATCH_ENV];
  return true;
}

export interface SkillToolLaunchOptions {
  readonly bundled: boolean;
  readonly executable: string;
  readonly electron: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export interface SkillToolLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

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

export function prepareSkillToolLaunch(
  action: SkillCreatorToolAction,
  scriptPath: string,
  args: string[],
  options: SkillToolLaunchOptions,
): SkillToolLaunch {
  if (options.bundled) {
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      [INTERNAL_SKILL_DISPATCH_ENV]: '1',
    };
    delete env.BUN_BE_BUN;
    delete env.ELECTRON_RUN_AS_NODE;
    return {
      command: options.executable,
      args: ['__skill-tool', action, ...args],
      env,
    };
  }

  const launch = prepareInternalNodeLaunch({
    args: [scriptPath, ...args],
    env: options.env,
    isElectron: options.electron,
  });
  return { command: options.executable, ...launch };
}

export async function defaultSkillToolRunner(
  scriptPath: string,
  args: string[],
  action: SkillCreatorToolAction,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const launch = prepareSkillToolLaunch(action, scriptPath, args, {
      bundled: process.env.KODAX_BUNDLED === 'true',
      executable: process.execPath,
      electron: process.versions.electron !== undefined,
      env: process.env,
    });
    const child = spawn(launch.command, launch.args, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: launch.env,
    });
    const unregisterManagedChild = registerManagedChildProcess(child, {
      kind: 'skill-cli',
      command: launch.command,
      args: launch.args,
    });
    const cleanupOnProcessExit = (): void => {
      killChildProcessTreeSync(child);
    };
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
  runner?: (scriptPath: string, args: string[]) => Promise<number>,
): Promise<void> {
  const scriptPath = resolveSkillCreatorToolPath(action);
  const exitCode = runner
    ? await runner(scriptPath, args)
    : await defaultSkillToolRunner(scriptPath, args, action);
  if (exitCode !== 0) {
    throw new Error(`skill ${action} failed with exit code ${exitCode}`);
  }
}

export function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
