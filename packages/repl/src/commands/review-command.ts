import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import chalk from 'chalk';

import type { Command } from './types.js';
import { writeReviewPacket } from './review-packet.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 100_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function detectBaseBranch(cwd: string): Promise<string> {
  for (const branch of ['main', 'master', 'develop']) {
    try {
      await git(['rev-parse', '--verify', branch], cwd);
      return branch;
    } catch {
      // Try the next candidate.
    }
  }
  return 'HEAD';
}

async function getDiff(args: readonly string[], cwd: string): Promise<{ diff: string; label: string }> {
  const sub = args[0];
  if (sub === 'base') {
    const base = await detectBaseBranch(cwd);
    return { diff: await git(['diff', `${base}...HEAD`], cwd), label: `changes against ${base}` };
  }
  if (sub === 'sha' && args[1]) {
    return { diff: await git(['show', args[1]], cwd), label: `commit ${args[1]}` };
  }
  if (sub === 'sha') {
    throw new Error('missing commit hash for sha scope; use /review sha <hash>');
  }
  return { diff: await git(['diff', 'HEAD'], cwd), label: 'uncommitted changes' };
}

export interface ReviewInvocation {
  readonly workflow: boolean;
  readonly lean: boolean;
  readonly diffArgs: string[];
  readonly prompt?: string;
  readonly error?: string;
}

export function parseReviewInvocation(args: readonly string[]): ReviewInvocation {
  let workflow = false;
  let lean = false;
  let scopeConsumed = false;
  let promptMode = false;
  const diffArgs: string[] = [];
  const promptArgs: string[] = [];

  const applyModeArg = (arg: string): boolean => {
    if (arg === '--workflow' || arg === 'workflow') {
      workflow = true;
      return true;
    }
    if (arg === '--lean' || arg === 'lean') {
      lean = true;
      return true;
    }
    return false;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (promptMode) {
      promptArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      promptMode = true;
      continue;
    }

    if (applyModeArg(arg)) {
      continue;
    }

    if (!scopeConsumed && arg === 'base') {
      diffArgs.push('base');
      scopeConsumed = true;
      continue;
    }

    if (!scopeConsumed && arg === 'sha') {
      diffArgs.push('sha');
      scopeConsumed = true;
      while (i + 1 < args.length) {
        const next = args[i + 1];
        if (next === undefined) {
          break;
        }
        if (next === '--') {
          promptMode = true;
          i += 1;
          break;
        }
        if (applyModeArg(next)) {
          i += 1;
          continue;
        }
        diffArgs.push(next);
        i += 1;
        break;
      }
      continue;
    }

    promptArgs.push(arg);
  }

  const prompt = promptArgs.join(' ').trim();
  const error = diffArgs[0] === 'sha' && !diffArgs[1]
    ? 'missing commit hash for sha scope; use /review sha <hash>'
    : undefined;
  return {
    workflow,
    lean,
    diffArgs,
    prompt: prompt.length > 0 ? prompt : undefined,
    ...(error ? { error } : {}),
  };
}

export interface ReviewWorkflowRequestOptions {
  readonly lean?: boolean;
  readonly customPrompt?: string;
  readonly packetPath?: string;
  readonly packetHash?: string;
}

export function buildReviewWorkflowRequest(
  label: string,
  options: ReviewWorkflowRequestOptions = {},
): string {
  const lines = [
    `Review ${label} with a dynamic workflow.`,
    'Use changed_scope once to partition the change into stable, non-overlapping review scopes.',
    'For each scope, run one capable reviewer that returns both specVerdict and qualityVerdict, citing the same evidence packet instead of repeating the full diff.',
    'Send only candidate findings to one fresh independent verifier per scope, then reconcile cross-scope interactions in a final synthesis.',
    'Final output must lead with verified findings, cite files or diff hunks, and state when no issues are found.',
  ];

  if (options.lean === true) {
    lines.splice(
      2,
      0,
      'Add one lean/minimal-diff reviewer: find code that can be deleted or replaced by existing repo code, stdlib/native platform features, or already-installed dependencies.',
      'Lean review must not recommend cutting trust-boundary validation, security checks, data-loss protection, accessibility basics, or explicitly requested behavior.',
    );
  }

  if (options.customPrompt) {
    lines.push(`User review focus: ${options.customPrompt}`);
  }

  if (options.packetPath) {
    lines.push(
      `Review packet: ${options.packetPath}${options.packetHash ? ` (sha256 ${options.packetHash})` : ''}.`,
      'Treat the packet manifest and its evidence chunks as the sole captured review input; read every listed chunk before returning a verdict.',
    );
  }

  return lines.join('\n');
}

export interface BuildReviewPromptOptions {
  readonly label: string;
  readonly diff: string;
  readonly lean?: boolean;
  readonly customPrompt?: string;
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated to ${MAX_DIFF_CHARS} chars - review the rest with a narrower scope]`;
}

export function buildReviewPrompt(options: BuildReviewPromptOptions): string {
  const body = truncateDiff(options.diff);
  const lines = [
    `Review the following ${options.label} as a third-party reviewer (not the author).`,
    'Look for bugs (logic errors, null/undefined handling, off-by-one, races),',
    'security (injection, secret exposure, auth bypass), performance hotpaths,',
    'and design (over-engineering vs missing abstraction).',
    'Cite specific diff lines. For each finding, note whether it is verifiable by',
    'tsc / lint / test / build. If the diff is small or risk-free, say so briefly.',
  ];

  if (options.lean === true) {
    lines.push(
      '',
      'Lean pass:',
      '- After correctness/security findings, look for unnecessary code introduced by the diff.',
      '- Prefer deletion or replacement with existing repo code, stdlib/native platform features, or already-installed dependencies when that is verifiably simpler.',
      '- Do not recommend cutting trust-boundary validation, security checks, data-loss protection, accessibility basics, or explicitly requested behavior.',
      '- For each lean suggestion, say what was skipped or can be removed, and when it should be added back.',
    );
  }

  if (options.customPrompt) {
    lines.push('', `User review focus: ${options.customPrompt}`);
  }

  lines.push('', '```diff', body, '```');
  return lines.join('\n');
}

function buildDisplayName(invocation: ReviewInvocation): string {
  const flags = [
    invocation.workflow ? '--workflow' : undefined,
    invocation.lean ? '--lean' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length > 0 ? `/review ${flags.join(' ')}` : '/review';
}

function printReviewHelp(): void {
  console.log(chalk.bold('\n/review - Review Git Changes\n'));
  console.log('Usage:');
  console.log(chalk.cyan('  /review [--lean] [--workflow] [base | sha <hash>] [prompt...]'));
  console.log();
  console.log('Scopes:');
  console.log(chalk.dim('  default       ') + 'Review uncommitted changes against HEAD');
  console.log(chalk.dim('  base          ') + 'Review changes against the detected base branch');
  console.log(chalk.dim('  sha <hash>    ') + 'Review a specific commit');
  console.log();
  console.log('Options:');
  console.log(chalk.dim('  --lean        ') + 'Add a minimal-diff/YAGNI review pass');
  console.log(chalk.dim('  --workflow    ') + 'Generate a dynamic multi-reviewer workflow');
  console.log();
  console.log('Examples:');
  console.log(chalk.dim('  /review --lean'));
  console.log(chalk.dim('  /review base focus on auth and data loss'));
  console.log(chalk.dim('  /review sha abc123 --lean -- check for native platform replacements'));
}

export const reviewCommand: Command = {
  name: 'review',
  description: 'Review git changes for bugs, security, performance, design, and optional lean diffs',
  usage: '/review [--lean] [--workflow] [base | sha <hash>] [prompt...]',
  argumentHint: '[--lean] [--workflow] [base | sha <hash>] [prompt...]',
  detailedHelp: printReviewHelp,
  handler: async (args, context) => {
    const cwd = context.gitRoot ?? process.cwd();
    const invocation = parseReviewInvocation(args);
    if (invocation.error) {
      return { success: false, message: `/review: ${invocation.error}` };
    }
    let diff: string;
    let label: string;
    try {
      ({ diff, label } = await getDiff(invocation.diffArgs, cwd));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `/review: git failed - ${message}` };
    }

    if (!diff.trim()) {
      return { success: true, message: 'No changes to review.' };
    }

    if (invocation.workflow) {
      let packet: Awaited<ReturnType<typeof writeReviewPacket>>;
      try {
        packet = await writeReviewPacket({
          cwd,
          sessionId: context.sessionId,
          label,
          diff,
          customPrompt: invocation.prompt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `/review: could not create review packet - ${message}` };
      }
      return {
        success: true,
        workflow: {
          request: buildReviewWorkflowRequest(label, {
            lean: invocation.lean,
            customPrompt: invocation.prompt,
            packetPath: packet.packetPath,
            packetHash: packet.contentHash,
          }),
          source: 'command',
          displayName: buildDisplayName(invocation),
          processSource: 'review',
        },
      };
    }

    return {
      success: true,
      invocation: {
        prompt: buildReviewPrompt({
          label,
          diff,
          lean: invocation.lean,
          customPrompt: invocation.prompt,
        }),
        source: 'prompt',
        displayName: buildDisplayName(invocation),
      },
    };
  },
};
