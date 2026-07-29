import chalk from 'chalk';

import {
  approveStoredLearningProposal,
  readLearningProposalStore,
  resolveLearningProposalStore,
  updateLearningProposalStatus,
  type SkillConsumerImpact,
  type StoredLearningProposal,
} from '@kodax-ai/agent';

import type { Command } from './types.js';

function resolveCwd(context: { runtimeInfo?: { workspaceRoot?: string; executionCwd?: string } }): string {
  return (
    context.runtimeInfo?.workspaceRoot
    ?? context.runtimeInfo?.executionCwd
    ?? process.cwd()
  );
}

function proposalLabel(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  switch (proposal.destination) {
    case 'skill_patch':
    case 'skill_create':
      return `${proposal.userLabel} ${proposal.destination} ${proposal.skillName}`;
    case 'workflow_handoff':
      return `${proposal.userLabel} ${proposal.suggestedAction} ${proposal.evidenceRunIds.join(',')}`;
    case 'memdir_handoff':
      return `${proposal.userLabel} ${proposal.memoryKind}`;
    case 'reasoning_handoff':
      return `${proposal.userLabel} ${proposal.title}`;
  }
}

function writeOutput(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    writeOutput(chalk.yellow(`[learn] ${warning}`));
  }
}

function printConsumerImpact(impact: SkillConsumerImpact): void {
  writeOutput(chalk.yellow('\nConsumer impact:'));
  writeOutput(chalk.dim(`  action: ${impact.action}`));
  const groups: readonly [string, readonly string[]][] = [
    ['workflow capsules', impact.workflowCapsules],
    ['saved workflows', impact.savedWorkflows],
    ['constructed agents', impact.constructedAgents],
    ['prompt references', impact.promptReferences],
  ];
  for (const [label, values] of groups) {
    if (values.length === 0) continue;
    writeOutput(chalk.dim(`  ${label}:`));
    for (const value of values) {
      writeOutput(chalk.dim(`    - ${value}`));
    }
  }
}


async function readStore(cwd: string) {
  const storePath = resolveLearningProposalStore(cwd);
  const store = await readLearningProposalStore(storePath);
  printWarnings(store.warnings);
  return { storePath, store };
}

function findProposal(entries: readonly StoredLearningProposal[], proposalId: string): StoredLearningProposal | undefined {
  return entries.find((entry) => entry.proposalId === proposalId);
}

function printPending(entries: readonly StoredLearningProposal[], storePath: string): void {
  const pending = entries.filter((entry) => entry.status === 'pending');
  writeOutput(chalk.cyan('\n[learn] pending learning suggestions'));
  writeOutput(chalk.dim(`  ${storePath}`));
  if (pending.length === 0) {
    writeOutput(chalk.dim('  (none)\n'));
    return;
  }
  for (const entry of pending) {
    const plan = entry.applyPlan ? 'apply-plan' : 'handoff';
    writeOutput(`  ${chalk.cyan(entry.proposalId)} ${chalk.dim(`[${plan}]`)} ${proposalLabel(entry)}`);
  }
  writeOutput(chalk.dim('\n  Use /learn diff <id>, /learn approve <id>, or /learn reject <id>.\n'));
}

function printDiff(entry: StoredLearningProposal): void {
  writeOutput(chalk.cyan(`\n[learn] ${entry.proposalId}`));
  writeOutput(chalk.dim(`  status: ${entry.status}`));
  writeOutput(chalk.dim(`  kind  : ${entry.proposal.destination}`));
  writeOutput('\nProposal:');
  writeOutput(JSON.stringify(entry.proposal, null, 2));
  if (entry.proposal.destination === 'workflow_handoff') {
    printConsumerImpact(entry.proposal.consumerImpact);
  }
  if (!entry.applyPlan) {
    writeOutput(chalk.dim('\nNo F224 apply plan is attached. Approval records the handoff only.\n'));
    return;
  }
  writeOutput('\nApply plan:');
  writeOutput(chalk.dim(`  kind     : ${entry.applyPlan.kind}`));
  writeOutput(chalk.dim(`  skillRoot: ${entry.applyPlan.skillRoot}`));
  for (const change of entry.applyPlan.changes) {
    writeOutput(chalk.dim(`  - ${change.kind} ${change.relativePath}`));
    if (change.kind === 'write') {
      writeOutput(change.content);
    }
  }
  writeOutput();
}

async function approveProposal(
  storePath: string,
  entry: StoredLearningProposal,
  options: {
    readonly acknowledgeImpact?: boolean;
  } = {},
): Promise<void> {
  const result = await approveStoredLearningProposal(storePath, entry, options);
  switch (result.status) {
    case 'approved_already_applied':
      writeOutput(chalk.green(`\n[learn] approved ${entry.proposalId}; files already match the apply plan.`));
      writeOutput(chalk.dim('  recovered a pending proposal without applying it again.\n'));
      return;
    case 'blocked_snapshot_conflict':
      writeOutput(chalk.red(`\n[learn] refusing to reapply ${entry.proposalId}; ${result.relativePath} changed after the last snapshot.`));
      writeOutput(chalk.dim(`  snapshot: ${result.snapshotPath}`));
      writeOutput(chalk.dim('  Review the file manually, then reject or recreate the learning proposal.\n'));
      return;
    case 'approved_applied':
      writeOutput(chalk.green(`\n[learn] approved and applied ${entry.proposalId}.`));
      writeOutput(chalk.dim(`  changed: ${result.changedPaths.join(', ') || '(none)'}\n`));
      return;
    case 'blocked_missing_apply_plan':
      writeOutput(chalk.red(`\n[learn] ${entry.proposalId} has no skill apply plan; nothing was applied.\n`));
      return;
    case 'blocked_consumer_impact':
      writeOutput(chalk.yellow(`\n[learn] ${entry.proposalId} requires manual consumer-impact review before approval.`));
      writeOutput(chalk.dim(`  Run /learn diff ${entry.proposalId}, then /learn approve ${entry.proposalId} --ack-impact after review.\n`));
      printConsumerImpact(result.impact);
      writeOutput();
      return;
    case 'approved_handoff':
      writeOutput(chalk.green(`\n[learn] approved ${entry.proposalId} as a downstream handoff.`));
      writeOutput(chalk.dim('  F224 does not mutate workflow, memory, or reasoning carriers directly.\n'));
      return;
    case 'blocked_not_pending':
      writeOutput(chalk.dim(`\n[learn] ${entry.proposalId} is already ${result.reviewStatus}.\n`));
      return;
  }
}

function printHelp(): void {
  writeOutput(chalk.cyan('\n/learn - Inspect and control learned capabilities'));
  writeOutput(chalk.dim('  /learn                      Open the Learning Center'));
  writeOutput(chalk.dim('  /learn list [search]        List learned capabilities'));
  writeOutput(chalk.dim('  /learn show <name|slug>     Inspect a capability'));
  writeOutput(chalk.dim('  /learn trust|reject|disable|rollback <name|slug>'));
  writeOutput(chalk.dim('  /learn promote <name|slug|capability-id> [--scope user]'));
  writeOutput(chalk.dim('  /learn promote --help       Explain formal user-catalog promotion'));
  writeOutput(chalk.dim('  Compatibility: pending, diff, approve and reject remain accepted.'));
  writeOutput(chalk.dim('  /learn help\n'));
}

interface LearnPromoteInvocation {
  readonly target?: string;
  readonly scope: 'user';
  readonly help: boolean;
  readonly error?: string;
}

function invalidPromoteInvocation(
  error: string,
  target?: string,
): LearnPromoteInvocation {
  return { ...(target === undefined ? {} : { target }), scope: 'user', help: false, error };
}

function parsePromoteOptions(
  target: string,
  options: readonly string[],
): LearnPromoteInvocation {
  let scope: string = 'user';
  let scopeSeen = false;
  for (let index = 0; index < options.length; index += 1) {
    const value = options[index]!;
    if (value === '--scope') {
      if (scopeSeen) return invalidPromoteInvocation('duplicate --scope option', target);
      const requestedScope = options[index + 1];
      if (!requestedScope) return invalidPromoteInvocation('missing value for --scope', target);
      scope = requestedScope;
      scopeSeen = true;
      index += 1;
      continue;
    }
    if (value.startsWith('--scope=')) {
      if (scopeSeen) return invalidPromoteInvocation('duplicate --scope option', target);
      scope = value.slice('--scope='.length);
      if (!scope) return invalidPromoteInvocation('missing value for --scope', target);
      scopeSeen = true;
      continue;
    }
    const error = value.startsWith('-')
      ? `unknown promote option: ${value}`
      : `unexpected promote argument: ${value}`;
    return invalidPromoteInvocation(error, target);
  }
  if (scope !== 'user') {
    return invalidPromoteInvocation(
      `unsupported promote scope: ${scope}; only user is supported`,
      target,
    );
  }
  return { target, scope: 'user', help: false };
}

function parseLearnPromoteInvocation(args: readonly string[]): LearnPromoteInvocation {
  const operands = args.slice(1);
  if (operands.some((value) => value === '--help' || value === '-h')
    || operands[0]?.toLowerCase() === 'help') {
    return { scope: 'user', help: true };
  }
  const target = operands[0];
  if (!target) {
    return invalidPromoteInvocation('missing learned Skill name, slug, or capability ID');
  }
  if (target.startsWith('-')) {
    return invalidPromoteInvocation(`unknown promote option: ${target}`);
  }
  return parsePromoteOptions(target, operands.slice(1));
}

function printPromoteHelp(): void {
  writeOutput(chalk.cyan('\n/learn promote - Move one learned Skill into the formal user catalog'));
  writeOutput(chalk.bold('\nUsage:'));
  writeOutput(chalk.dim('  /learn promote <name|slug|capability-id> [--scope user]'));
  writeOutput(chalk.dim('  /learn promote --help'));
  writeOutput(chalk.dim('  /help learn promote'));
  writeOutput(chalk.bold('\nWhat it does:'));
  writeOutput(chalk.dim('  Promote is an explicit ownership transfer, not automatic canary activation.'));
  writeOutput(chalk.dim('  Automatic evidence: testing -> active_learned inside the project Learned Area.'));
  writeOutput(chalk.dim('  Explicit promote: reviewed ready or active_learned -> promoted_user.'));
  writeOutput(chalk.dim('  The exact fingerprinted revision is copied to the configured KodaX'));
  writeOutput(chalk.dim('  user Skill directory (normally ~/.kodax/skills/<slug>/SKILL.md).'));
  writeOutput(chalk.dim('  Promotion never overwrites different formal Skill content.'));
  writeOutput(chalk.bold('\nBefore promoting:'));
  writeOutput(chalk.dim('  Use /learn show <name|slug> to inspect the exact revision and lifecycle.'));
  writeOutput(chalk.dim('  The Learning Center offers this action for active_learned Skills.'));
  writeOutput(chalk.bold('\nExamples:'));
  writeOutput(chalk.dim('  /learn promote normalize-release-notes'));
  writeOutput(chalk.dim('  /learn promote normalize-release-notes --scope user\n'));
}

async function runLearningCenterCommand(
  args: readonly string[],
  callbacks: Parameters<Command['handler']>[2],
): Promise<boolean> {
  const learning = callbacks.learning;
  if (!learning) return false;
  const subcommand = (args[0] ?? '').toLowerCase();
  if (subcommand === '' && callbacks.openLearningCenter) {
    await callbacks.openLearningCenter();
    return true;
  }
  if (subcommand === '' || subcommand === 'list' || subcommand === 'pending') {
    const page = await learning.list({
      search: args.slice(1).join(' ').trim() || undefined,
      ...(subcommand === 'pending' ? { lifecycle: 'ready' as const } : {}),
      limit: 200,
    });
    writeOutput(chalk.cyan('\n[learn] Learning Center'));
    if (page.items.length === 0) writeOutput(chalk.dim('  (none)'));
    const slugCounts = new Map<string, number>();
    for (const item of page.items) {
      slugCounts.set(item.slug, (slugCounts.get(item.slug) ?? 0) + 1);
    }
    for (const item of page.items) {
      const exactId = (slugCounts.get(item.slug) ?? 0) > 1
        ? ` ${chalk.dim(`id=${item.capabilityId}`)}`
        : '';
      writeOutput(`  ${chalk.cyan(item.slug)}${exactId} ${chalk.dim(`[${item.carrier}/${item.lifecycle}]`)} ${item.displayName}`);
    }
    writeOutput();
    return true;
  }
  const promoteInvocation = subcommand === 'promote'
    ? parseLearnPromoteInvocation(args)
    : undefined;
  const requestedName = promoteInvocation?.target ?? args[1];
  const capabilityId = requestedName
    ? await resolveLearningCapabilityId(learning, requestedName)
    : undefined;
  if ((subcommand === 'show' || subcommand === 'diff') && capabilityId) {
    if (callbacks.openLearningCenter) await callbacks.openLearningCenter(capabilityId);
    else writeOutput(`${JSON.stringify(await learning.get(capabilityId), null, 2)}\n`);
    return true;
  }
  if (!capabilityId) return false;
  if (subcommand === 'trust' || subcommand === 'approve') await learning.trust(capabilityId);
  else if (subcommand === 'reject') await learning.reject(capabilityId);
  else if (subcommand === 'disable') await learning.disable(capabilityId);
  else if (subcommand === 'rollback') await learning.rollback(capabilityId);
  else if (subcommand === 'promote') {
    if (!promoteInvocation || promoteInvocation.help || promoteInvocation.error) return false;
    await learning.promote(capabilityId, promoteInvocation.scope);
  }
  else if (subcommand === 'review') await learning.review(capabilityId);
  else return false;
  const displayTarget = requestedName ?? capabilityId;
  writeOutput(subcommand === 'promote'
    ? chalk.green(`\n[learn] promoted ${displayTarget} to the formal user Skill catalog.\n`)
    : chalk.dim(`\n[learn] ${subcommand} accepted for ${displayTarget}.\n`));
  return true;
}

async function resolveLearningCapabilityId(
  learning: NonNullable<Parameters<Command['handler']>[2]['learning']>,
  nameOrSlugOrLegacyId: string,
): Promise<string> {
  try {
    return (await learning.get(nameOrSlugOrLegacyId)).capabilityId;
  } catch (error: unknown) {
    const page = await learning.list({ limit: 200 });
    const legacyMatch = page.items.find((item) => (
      item.source.kind === 'f224_proposal'
      && item.source.proposalId === nameOrSlugOrLegacyId
    ));
    if (legacyMatch) return legacyMatch.capabilityId;
    throw error;
  }
}

export const learnCommand: Command = {
  name: 'learn',
  description: 'Inspect and control the Learning Center',
  usage: '/learn [list|show|review|trust|reject|disable|rollback|promote|help] [name|slug|capability-id] [--scope user]',
  argumentHint: 'list | show <slug> | trust <slug> | disable <slug> | promote <slug> [--scope user] | help [promote]',
  handler: async (args, context, callbacks) => {
    const cwd = resolveCwd(context);
    const subcommand = (args[0] ?? 'pending').toLowerCase();

    if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
      if (args[1]?.toLowerCase() === 'promote') printPromoteHelp();
      else printHelp();
      return;
    }

    if (subcommand === 'promote') {
      const invocation = parseLearnPromoteInvocation(args);
      if (invocation.help) {
        printPromoteHelp();
        return;
      }
      if (invocation.error) {
        writeOutput(chalk.yellow(`\n[learn] ${invocation.error}.\n`));
        printPromoteHelp();
        return;
      }
    }

    if (await runLearningCenterCommand(args, callbacks)) return;

    if (subcommand === 'promote') {
      writeOutput(chalk.yellow('\n[learn] Learning Center controls are unavailable in this runtime.\n'));
      return;
    }

    const { storePath, store } = await readStore(cwd);

    if (subcommand === 'pending' || subcommand === 'list') {
      printPending(store.proposals, storePath);
      return;
    }

    const proposalId = args[1];
    if (!proposalId) {
      writeOutput(chalk.yellow(`\n[learn] missing proposal id for ${subcommand}.\n`));
      printHelp();
      return;
    }
    const entry = findProposal(store.proposals, proposalId);
    if (!entry) {
      writeOutput(chalk.yellow(`\n[learn] proposal not found: ${proposalId}\n`));
      return;
    }

    if (subcommand === 'diff') {
      printDiff(entry);
      return;
    }
    if (subcommand === 'approve') {
      if (store.warnings.length > 0) {
        writeOutput(chalk.red('\n[learn] refusing to mutate a corrupt learning store.\n'));
        return;
      }
      if (entry.status !== 'pending') {
        writeOutput(chalk.dim(`\n[learn] ${entry.proposalId} is already ${entry.status}.\n`));
        return;
      }
      const flags = new Set(args.slice(2));
      await approveProposal(storePath, entry, {
        acknowledgeImpact: flags.has('--ack-impact'),
      });
      return;
    }
    if (subcommand === 'reject') {
      if (store.warnings.length > 0) {
        writeOutput(chalk.red('\n[learn] refusing to mutate a corrupt learning store.\n'));
        return;
      }
      if (entry.status !== 'pending') {
        writeOutput(chalk.dim(`\n[learn] ${entry.proposalId} is already ${entry.status}.\n`));
        return;
      }
      const reason = args.slice(2).join(' ').trim();
      await updateLearningProposalStatus(
        storePath,
        proposalId,
        'rejected',
        reason.length > 0 ? { rejectedReason: reason } : {},
      );
      writeOutput(chalk.dim(`\n[learn] rejected ${proposalId}.\n`));
      return;
    }

    writeOutput(chalk.yellow(`\n[learn] unknown subcommand: ${subcommand}\n`));
    printHelp();
  },
  detailedHelp: (args = []) => {
    if (args[0]?.toLowerCase() === 'promote') printPromoteHelp();
    else printHelp();
  },
};
