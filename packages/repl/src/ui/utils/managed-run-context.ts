import type {
  KodaXContextOptions,
  KodaXContextTokenSnapshot,
} from "@kodax-ai/coding";

export function buildManagedRunContext(
  baseContext: KodaXContextOptions | undefined,
  interactiveGitRoot: string | null | undefined,
  contextTokenSnapshot: KodaXContextTokenSnapshot | undefined,
  skillsPrompt: string,
  interactiveExecutionCwd?: string,
): KodaXContextOptions {
  const gitRoot = baseContext?.gitRoot ?? interactiveGitRoot ?? undefined;
  const executionCwd = baseContext?.executionCwd ?? interactiveExecutionCwd ?? gitRoot ?? process.cwd();

  return {
    ...baseContext,
    gitRoot,
    executionCwd,
    contextTokenSnapshot,
    taskSurface: "repl",
    skillsPrompt,
  };
}
