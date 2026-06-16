/**
 * FEATURE_206 (v0.7.45) — `/review` slash command.
 *
 * Minimalist design: gather the git diff for the requested scope and submit it
 * to the agent for review (via the standard `invocation` prompt mechanism).
 * No new reviewer LLM subsystem / prompt-eval — the agent already reviews; a
 * structured multi-model reviewer with an objective arbiter is FEATURE_102
 * Phase 2's territory.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Command } from './types.js';

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
      // try the next candidate
    }
  }
  return 'HEAD';
}

async function getDiff(args: string[], cwd: string): Promise<{ diff: string; label: string }> {
  const sub = args[0];
  if (sub === 'base') {
    const base = await detectBaseBranch(cwd);
    return { diff: await git(['diff', `${base}...HEAD`], cwd), label: `changes against ${base}` };
  }
  if (sub === 'sha' && args[1]) {
    return { diff: await git(['show', args[1]], cwd), label: `commit ${args[1]}` };
  }
  return { diff: await git(['diff', 'HEAD'], cwd), label: 'uncommitted changes' };
}

export interface ReviewInvocation {
  readonly workflow: boolean;
  readonly diffArgs: string[];
}

export function parseReviewInvocation(args: readonly string[]): ReviewInvocation {
  return {
    workflow: args.some((arg) => arg === '--workflow' || arg === 'workflow'),
    diffArgs: args.filter((arg) => arg !== '--workflow' && arg !== 'workflow'),
  };
}

export function buildReviewWorkflowRequest(label: string): string {
  return [
    `Review ${label} with a dynamic workflow.`,
    'Create independent reviewers for correctness, security, performance, and design.',
    'Have each reviewer inspect the relevant git diff evidence independently, then synthesize findings.',
    'Final output must lead with verified findings, cite files or diff hunks, and state when no issues are found.',
  ].join('\n');
}

export const reviewCommand: Command = {
  name: 'review',
  description: 'Review code changes (git diff) for bugs, security, performance, and design',
  usage: '/review [--workflow] [base | sha <hash>]   (default: uncommitted changes)',
  handler: async (args, context) => {
    const cwd = context.gitRoot ?? process.cwd();
    const invocation = parseReviewInvocation(args);
    let diff: string;
    let label: string;
    try {
      ({ diff, label } = await getDiff(invocation.diffArgs, cwd));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `/review: git failed — ${message}` };
    }

    if (!diff.trim()) {
      return { success: true, message: 'No changes to review.' };
    }

    if (invocation.workflow) {
      return {
        success: true,
        workflow: {
          request: buildReviewWorkflowRequest(label),
          source: 'command',
          displayName: '/review --workflow',
          processSource: 'review',
        },
      };
    }

    let body = diff;
    if (body.length > MAX_DIFF_CHARS) {
      body = `${body.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated to ${MAX_DIFF_CHARS} chars — review the rest with a narrower scope]`;
    }

    const prompt = [
      `Review the following ${label} as a third-party reviewer (not the author).`,
      'Look for bugs (logic errors, null/undefined handling, off-by-one, races),',
      'security (injection, secret exposure, auth bypass), performance hotpaths,',
      'and design (over-engineering vs missing abstraction).',
      'Cite specific diff lines. For each finding, note whether it is verifiable by',
      'tsc / lint / test / build. If the diff is small or risk-free, say so briefly.',
      '',
      '```diff',
      body,
      '```',
    ].join('\n');

    return {
      success: true,
      invocation: { prompt, source: 'prompt', displayName: '/review' },
    };
  },
};
