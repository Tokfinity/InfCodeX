import chalk from 'chalk';

import {
  applySkillLearningProposal,
  readLearningProposalStore,
  resolveLearningProposalStore,
  updateLearningProposalStatus,
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

async function approveProposal(storePath: string, entry: StoredLearningProposal): Promise<void> {
  if (entry.applyPlan?.kind === 'skill') {
    const result = await applySkillLearningProposal({
      proposal: entry.proposal,
      governance: entry.applyPlan.governance,
      skillRoot: entry.applyPlan.skillRoot,
      changes: entry.applyPlan.changes,
      approved: true,
      ...(entry.applyPlan.snapshotRoot !== undefined ? { snapshotRoot: entry.applyPlan.snapshotRoot } : {}),
    });
    await updateLearningProposalStatus(storePath, entry.proposalId, 'approved');
    writeOutput(chalk.green(`\n[learn] approved and applied ${entry.proposalId}.`));
    writeOutput(chalk.dim(`  changed: ${result.changedPaths.join(', ') || '(none)'}\n`));
    return;
  }

  if (entry.proposal.destination === 'skill_patch' || entry.proposal.destination === 'skill_create') {
    writeOutput(chalk.red(`\n[learn] ${entry.proposalId} has no skill apply plan; nothing was applied.\n`));
    return;
  }

  await updateLearningProposalStatus(storePath, entry.proposalId, 'approved');
  writeOutput(chalk.green(`\n[learn] approved ${entry.proposalId} as a downstream handoff.`));
  writeOutput(chalk.dim('  F224 does not mutate workflow, memory, or reasoning carriers directly.\n'));
}

function printHelp(): void {
  writeOutput(chalk.cyan('\n/learn - Review procedural learning suggestions'));
  writeOutput(chalk.dim('  /learn pending              List pending suggestions'));
  writeOutput(chalk.dim('  /learn diff <proposalId>    Preview proposal and apply plan'));
  writeOutput(chalk.dim('  /learn approve <proposalId> Approve and apply skill plans, or mark handoffs approved'));
  writeOutput(chalk.dim('  /learn reject <proposalId> [reason]'));
  writeOutput(chalk.dim('  /learn help\n'));
}

export const learnCommand: Command = {
  name: 'learn',
  description: 'Review procedural learning suggestions (FEATURE_224)',
  usage: '/learn [pending|diff|approve|reject|help] [proposalId]',
  argumentHint: 'pending | diff <id> | approve <id> | reject <id> [reason] | help',
  handler: async (args, context) => {
    const cwd = resolveCwd(context);
    const subcommand = (args[0] ?? 'pending').toLowerCase();

    if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
      printHelp();
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
      await approveProposal(storePath, entry);
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
  detailedHelp: printHelp,
};
