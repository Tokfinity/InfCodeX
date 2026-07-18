import { pathToFileURL } from 'node:url';

export type BootstrapResumeRoute =
  | { readonly kind: 'continue'; readonly argv: readonly string[] }
  | { readonly kind: 'exit' };

interface ResumeModule {
  readonly resolveBareResume: (options?: {
    readonly beforeSelect?: () => Promise<void>;
  }) => Promise<BootstrapResumeRoute>;
}

interface CliModule {
  readonly main: () => Promise<void>;
}

export interface KodaXBootstrapOptions {
  readonly argv?: string[];
  readonly loadResume?: () => Promise<ResumeModule>;
  readonly loadCli?: () => Promise<CliModule>;
  readonly stdin?: {
    readonly isTTY?: boolean;
    readonly pause?: () => void;
    readonly ref?: () => void;
    readonly unref?: () => void;
  };
}

export function isBareResumeRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '-r' || args[0] === '--resume');
}

export async function runKodaXBootstrap(options: KodaXBootstrapOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const stdin = options.stdin ?? process.stdin;
  const loadResume = options.loadResume ?? (() => import('./kodax_resume.js'));
  const loadCli = options.loadCli ?? (() => import('./kodax_cli.js'));
  let cliModulePromise: Promise<CliModule> | undefined;
  const loadCliOnce = (): Promise<CliModule> => {
    cliModulePromise ??= loadCli();
    return cliModulePromise;
  };
  if (isBareResumeRequest(argv.slice(2))) {
    const route = await (await loadResume()).resolveBareResume({
      beforeSelect: async () => {
        await loadCliOnce();
      },
    });
    if (route.kind === 'exit') {
      stdin.pause?.();
      stdin.unref?.();
      return;
    }
    argv.splice(2, argv.length - 2, ...route.argv);
    if (route.argv.length > 0 && stdin.isTTY === true) {
      stdin.pause?.();
      stdin.ref?.();
    }
  }
  await (await loadCliOnce()).main();
}

export async function runKodaXBootstrapAsEntry(): Promise<void> {
  try {
    await runKodaXBootstrap();
  } catch (error: unknown) {
    process.stdin.pause();
    process.stdin.unref?.();
    const message = error instanceof Error ? error.message : String(error);
    try {
      const { default: chalk } = await import('chalk');
      console.error(chalk.red(`[Error] ${message}`));
    } catch {
      console.error(`[Error] ${message}`);
    }
    process.exitCode = 1;
  }
}

const scriptPath = process.argv[1];
const isMainModule = scriptPath !== undefined
  && import.meta.url === pathToFileURL(scriptPath).href;

if (isMainModule) {
  void runKodaXBootstrapAsEntry();
}
