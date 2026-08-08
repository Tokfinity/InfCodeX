/**
 * FEATURE_124 (v0.7.43) Phase D — `/memory` slash command.
 *
 * Per-project memory subsystem inspection + maintenance. Mirrors
 * claudecode `/memory` semantics (list / rebuild / open) over the
 * substrate in `@kodax-ai/agent` (Phase A) so the user has a stable
 * escape hatch when the LLM-managed index drifts or gets corrupted.
 *
 * Subcommands:
 *   /memory                  — alias for `list`
 *   /memory list             — show MEMORY.md + file count + memory dir
 *   /memory rebuild          — regenerate MEMORY.md from topic frontmatter
 *                              (sorted by mtime descending — newest on top)
 *   /memory open             — print MEMORY.md path so the user can open
 *                              it in their editor (the REPL doesn't ship
 *                              an in-process editor — KodaX is CLI-first)
 *   /memory help             — show usage
 *
 * Rebuild contract: ALWAYS preserves topic files; ONLY rewrites
 * `MEMORY.md`. Files whose frontmatter is missing or malformed get a
 * conservative `[<basename>](<file>) — <basename>` line and a stderr
 * warning so the user can spot and fix them rather than silently lose
 * them. `MEMORY.md` itself is excluded from the scan (it's not a topic
 * file). Files outside the configured memory dir are NEVER touched —
 * this is the only filesystem write the command performs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';

import {
  createMemoryControlPlane,
  listPendingEpisodeReviews,
  parseMemoryFile,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  type MemoryActionProposal,
  type MemoryApplyResult,
  type MemoryGovernanceReport,
  type MemoryRejectResult,
  type MemoryType,
} from '@kodax-ai/agent';
import {
  deriveCodingMemoryIdentity,
  resolveProvider,
} from '@kodax-ai/coding';

import type { Command } from './types.js';
import type { InteractiveContext } from '../interactive/context.js';
const PREVIEW_FINGERPRINT_TTL_MS = 15 * 60 * 1000;

interface ProposalPreviewCacheEntry {
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly createdAtMs: number;
}

const proposalPreviewFingerprints = new Map<string, ProposalPreviewCacheEntry>();

function formatMemoryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCwd(context: { runtimeInfo?: { workspaceRoot?: string; executionCwd?: string } }): string {
  return (
    context.runtimeInfo?.workspaceRoot ??
    context.runtimeInfo?.executionCwd ??
    process.cwd()
  );
}

interface TopicFile {
  filename: string;
  absPath: string;
  mtimeMs: number;
  title: string;
  description: string;
  type: MemoryType | undefined;
  parseOk: boolean;
}

function readTopicFiles(memoryDir: string): TopicFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT = "memory dir not created yet" — expected when the LLM
    // has never written a memory. Surface any other failure (EPERM,
    // ENOTDIR, etc.) so the user notices filesystem problems instead
    // of seeing a silent "0 topic files" — per project rule "NEVER
    // silently swallow errors" (CLAUDE.md).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(chalk.red(`[memory] failed to read memory directory ${memoryDir}: ${formatMemoryError(err)}`));
    }
    return [];
  }

  const result: TopicFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') {
      continue;
    }
    const absPath = path.join(memoryDir, entry.name);
    let raw = '';
    let mtimeMs = 0;
    try {
      raw = fs.readFileSync(absPath, 'utf-8');
      mtimeMs = fs.statSync(absPath).mtimeMs;
    } catch (err) {
      // Per-file read errors (TOCTOU with concurrent delete, unusual
      // permissions, etc.) skip the file but log so the user can spot
      // it. Do NOT abort the whole scan — a single unreadable file
      // shouldn't block rebuild of the rest of the index.
      console.log(chalk.red(`[memory] failed to read ${absPath}: ${formatMemoryError(err)}`));
      continue;
    }
    const parsed = parseMemoryFile(raw);
    const fm = parsed.frontmatter;
    // `parseMemoryFile` ALWAYS returns a frontmatter object (degraded
    // tolerance — see frontmatter.ts contract). Treat "no usable
    // fields" as malformed so the rebuild warning fires correctly when
    // a topic file is missing its `--- name: ... ---` header.
    const parseOk =
      fm.name !== undefined ||
      fm.description !== undefined ||
      fm.type !== undefined;
    const baseTitle = path.basename(entry.name, '.md');
    result.push({
      filename: entry.name,
      absPath,
      mtimeMs,
      title: fm.name?.trim() || baseTitle,
      description: fm.description?.trim() || baseTitle,
      type: fm.type,
      parseOk,
    });
  }
  return result;
}

function buildIndexLines(files: TopicFile[]): string[] {
  return files.map((f) => `- [${f.title}](${f.filename}) — ${f.description}`);
}

async function listMemory(memoryDir: string, entrypointPath: string): Promise<void> {
  console.log(chalk.cyan('\n[memory] per-project memory directory'));
  console.log(chalk.dim(`  ${memoryDir}`));

  const files = readTopicFiles(memoryDir);
  const malformed = files.filter((f) => !f.parseOk);
  console.log(
    chalk.dim(
      `  ${files.length} topic file${files.length === 1 ? '' : 's'}` +
        (malformed.length > 0 ? `, ${malformed.length} without parsable frontmatter` : ''),
    ),
  );

  let indexExists = false;
  let indexRaw = '';
  try {
    indexRaw = fs.readFileSync(entrypointPath, 'utf-8');
    indexExists = true;
  } catch {
    indexExists = false;
  }

  if (!indexExists) {
    console.log(chalk.yellow('\n  MEMORY.md does not exist yet.'));
    if (files.length > 0) {
      console.log(chalk.dim('  Run `/memory rebuild` to seed it from existing topic files.'));
    } else {
      console.log(chalk.dim('  The LLM will create it on first save — no action needed.'));
    }
    console.log();
    return;
  }

  console.log(chalk.cyan('\n--- MEMORY.md ---'));
  if (indexRaw.trim().length === 0) {
    console.log(chalk.dim('  (empty)'));
  } else {
    console.log(indexRaw.trimEnd());
  }
  console.log(chalk.cyan('--- end ---\n'));
}

/**
 * FEATURE_289 (v0.7.85) §3.5 — `/memory status`. Read-only pipeline
 * observability: memory dir stats, this-session lineage counts, the
 * cross-session tenant review backlog, reviewer configuration, and the
 * capture/review segment break diagnosis. Zero schema changes — every
 * data source already exists.
 */
async function statusMemory(
  memoryDir: string,
  entrypointPath: string,
  context: InteractiveContext,
  callbacks: Parameters<Command['handler']>[2],
  cwd: string,
): Promise<void> {
  // Section 1: memory directory stats (reuses the existing list path).
  await listMemory(memoryDir, entrypointPath);

  // Section 2: this-session pipeline counts from the session lineage.
  // Receipts exist only for COMPLETED reviews, so pending counts must
  // come from the inbox (section 3), never from the lineage.
  const entries = context.lineage?.entries ?? [];
  let digests = 0;
  let receipts = 0;
  let notices = 0;
  for (const entry of entries) {
    if (entry.type === 'memory_outcome_digest') digests += 1;
    else if (entry.type === 'memory_review_receipt') receipts += 1;
    else if (entry.type === 'client_notice' && entry.source === 'memory-agent') notices += 1;
  }
  console.log(chalk.cyan('\n[memory] this-session pipeline'));
  console.log(chalk.dim(`  outcome digests : ${digests}`));
  console.log(chalk.dim(`  review receipts : ${receipts}`));
  console.log(chalk.dim(`  client notices  : ${notices}`));

  // Section 3: cross-session pending reviews from the tenant inbox.
  const kodaxOptions = callbacks.createKodaXOptions?.();
  let pendingCount: number | undefined;
  let oldestPendingAge: string | undefined;
  if (kodaxOptions !== undefined) {
    const identity = deriveCodingMemoryIdentity(kodaxOptions, cwd, context.sessionId);
    const pending = await listPendingEpisodeReviews({
      configHome: identity.configHome,
      tenantId: identity.tenantId,
    });
    pendingCount = pending.length;
    const oldest = pending[0];
    if (oldest !== undefined) {
      oldestPendingAge = formatPendingAge(oldest.createdAt, Date.now());
    }
  }
  console.log(chalk.cyan('\n[memory] pending episode reviews (all sessions)'));
  if (pendingCount === undefined) {
    console.log(chalk.dim('  unavailable — KodaX options are not bound in this session'));
  } else {
    console.log(chalk.dim(`  pending: ${pendingCount}`));
    if (oldestPendingAge !== undefined) {
      console.log(chalk.dim(`  oldest pending age: ${oldestPendingAge}`));
    }
  }

  // Section 4: reviewer configuration state — the most common cause of
  // silent drain skips. The production reviewer is auto-installed at
  // session start when no custom reviewer is bound AND the provider has
  // credentials.
  let reviewerStatus: string;
  let reviewerMissing = false;
  if (kodaxOptions === undefined) {
    reviewerStatus = 'unknown — KodaX options are not bound in this session';
  } else if (kodaxOptions.learningReviewer !== undefined || kodaxOptions.memoryReviewer !== undefined) {
    reviewerStatus = 'configured (custom reviewer bound)';
  } else {
    let providerConfigured = false;
    try {
      providerConfigured = resolveProvider(kodaxOptions.provider).isConfigured();
    } catch {
      // Unresolvable provider name => not configured; reported below.
      providerConfigured = false;
    }
    reviewerStatus = providerConfigured
      ? 'production reviewer auto-installed at session start'
      : `MISSING — provider "${kodaxOptions.provider}" is not configured; episode review cannot run`;
    reviewerMissing = !providerConfigured;
  }
  console.log(chalk.cyan('\n[memory] reviewer'));
  console.log(
    reviewerMissing ? chalk.yellow(`  ${reviewerStatus}`) : chalk.dim(`  ${reviewerStatus}`),
  );

  // Diagnosis: locate the broken pipeline segment, if any.
  const warnings: string[] = [];
  if (digests === 0) {
    warnings.push('capture segment: no memory outcome digests recorded in this session yet');
  } else if (receipts === 0) {
    warnings.push(
      pendingCount !== undefined && pendingCount > 0
        ? 'review segment: digests captured but no review ever completed; the backlog is growing'
        : 'review segment: digests captured but no review completed in this session',
    );
  }
  if (reviewerMissing) {
    warnings.push('reviewer missing: configure a provider (`kodax setup`) to unblock episode review');
  }
  if (warnings.length > 0) {
    console.log();
    for (const warning of warnings) {
      console.log(chalk.yellow(`  ! ${warning}`));
    }
    if (pendingCount !== undefined && pendingCount > 0) {
      console.log(chalk.dim('  Run `kodax memory review-drain` to process the backlog in the foreground.'));
    }
  }
  console.log();
}

function formatPendingAge(createdAt: string, nowMs: number): string {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return 'unknown';
  const minutes = Math.max(0, Math.floor((nowMs - parsed) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function rebuildMemory(memoryDir: string, entrypointPath: string): Promise<void> {
  let dirExists = false;
  try {
    dirExists = fs.statSync(memoryDir).isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    console.log(chalk.yellow('\n[memory] memory directory does not exist yet — nothing to rebuild.'));
    console.log(chalk.dim(`  ${memoryDir}`));
    console.log(chalk.dim('  The LLM will create both the directory and MEMORY.md on first save.\n'));
    return;
  }

  const files = readTopicFiles(memoryDir);
  if (files.length === 0) {
    console.log(chalk.yellow('\n[memory] no topic files found — nothing to rebuild.'));
    console.log(chalk.dim(`  ${memoryDir}\n`));
    return;
  }

  // mtime descending = newest on top, matching the natural-LRU ordering
  // documented in memory-rules.ts (PREPEND-to-top creates newest-first).
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lines = buildIndexLines(sorted);
  const body = lines.join('\n') + '\n';

  fs.writeFileSync(entrypointPath, body, 'utf-8');

  console.log(chalk.green(`\n[memory] rebuilt MEMORY.md with ${sorted.length} entries (newest first).`));
  console.log(chalk.dim(`  ${entrypointPath}`));
  const malformed = sorted.filter((f) => !f.parseOk);
  if (malformed.length > 0) {
    console.log(chalk.yellow(`  ${malformed.length} file(s) had no parsable frontmatter — used filename as fallback:`));
    for (const file of malformed) {
      console.log(chalk.dim(`    - ${file.filename}`));
    }
    console.log(chalk.dim('  Tip: add `---\\nname: ...\\ndescription: ...\\ntype: ...\\n---` at the top of those files.'));
  }
  console.log();
}

function openMemory(memoryDir: string, entrypointPath: string): void {
  console.log(chalk.cyan('\n[memory] open these paths in your editor:'));
  console.log(chalk.dim('  index :'), entrypointPath);
  console.log(chalk.dim('  dir   :'), memoryDir);
  console.log(
    chalk.dim(
      '\n  (No in-REPL editor is provided — open the file in your usual editor.\n' +
        '   Use `/memory rebuild` after manual edits if you renamed any topic file.)\n',
    ),
  );
}

function proposalLabel(proposal: MemoryActionProposal): string {
  const targets = proposal.targetRefs.map((ref) => ref.title ?? ref.id).join(', ');
  return `${proposal.action} ${targets || '(report only)'}`;
}

function printMemoryInbox(proposals: readonly MemoryActionProposal[]): void {
  console.log(chalk.cyan('\n[memory] pending memory proposals'));
  if (proposals.length === 0) {
    console.log(chalk.dim('  (none)\n'));
    return;
  }
  for (const proposal of proposals) {
    console.log(`  ${chalk.cyan(proposal.id)} ${chalk.dim(`[${proposal.action}]`)} ${proposalLabel(proposal)}`);
  }
  console.log(chalk.dim('\n  Use /memory show <id>, /memory approve <id>, or /memory reject <id>.\n'));
}

function printMemoryProposal(proposal: MemoryActionProposal): void {
  console.log(chalk.cyan(`\n[memory] ${proposal.id}`));
  console.log(chalk.dim(`  action : ${proposal.action}`));
  console.log(chalk.dim(`  risk   : ${proposal.risk}`));
  console.log(chalk.dim(`  reason : ${proposal.rationale}`));
  console.log(chalk.dim(`  summary: ${proposal.preview.summary}`));
  if (proposal.preview.changedPaths.length > 0) {
    console.log(chalk.dim('  changed paths:'));
    for (const changedPath of proposal.preview.changedPaths) {
      console.log(chalk.dim(`    - ${changedPath}`));
    }
  }
  if (proposal.preview.warnings.length > 0) {
    console.log(chalk.yellow('  warnings:'));
    for (const warning of proposal.preview.warnings) {
      console.log(chalk.yellow(`    - ${warning}`));
    }
  }
  if (proposal.preview.diff !== undefined && proposal.preview.diff.trim().length > 0) {
    console.log(chalk.cyan('\n--- preview ---'));
    console.log(proposal.preview.diff.trimEnd());
    console.log(chalk.cyan('--- end ---'));
  }
  console.log();
}

function printApplyResult(result: MemoryApplyResult): void {
  if (!result.applied) {
    console.log(chalk.yellow(`\n[memory] ${result.proposalId} was not applied.`));
    console.log(chalk.dim(`  ${result.skippedReason ?? 'no reason provided'}\n`));
    return;
  }
  console.log(chalk.green(`\n[memory] approved and applied ${result.proposalId}.`));
  if (result.changedPaths.length > 0) {
    console.log(chalk.dim(`  changed: ${result.changedPaths.join(', ')}`));
  }
  console.log();
}

function printRejectResult(result: MemoryRejectResult): void {
  if (!result.rejected) {
    console.log(chalk.yellow(`\n[memory] ${result.proposalId} was not rejected.`));
    console.log(chalk.dim(`  ${result.skippedReason ?? 'no reason provided'}\n`));
    return;
  }
  console.log(chalk.dim(`\n[memory] rejected ${result.proposalId}.`));
  if (result.review !== undefined) {
    console.log(chalk.dim(`  review actions: ${result.review.actions.length}`));
  }
  for (const warning of result.warnings) {
    console.log(chalk.dim(`  review warning: ${warning}`));
  }
  console.log();
}

function printGovernanceReport(report: MemoryGovernanceReport): void {
  console.log(chalk.cyan(`\n[memory] governance report ${report.reportId}`));
  for (const warning of report.warnings) {
    console.log(chalk.yellow(`  warning: ${warning}`));
  }
  for (const finding of report.findings) {
    console.log(`  ${chalk.dim(`[${finding.severity}]`)} ${finding.kind}: ${finding.summary}`);
    if (finding.refIds.length > 0) {
      console.log(chalk.dim(`    refs: ${finding.refIds.join(', ')}`));
    }
  }
  console.log();
}

function printHelp(): void {
  console.log(chalk.cyan('\n/memory - Inspect or rebuild per-project memory'));
  console.log(chalk.dim('  /memory                 List MEMORY.md + memory directory'));
  console.log(chalk.dim('  /memory list            Same as `/memory`'));
  console.log(chalk.dim('  /memory status          Show pipeline health: digests, receipts, backlog, reviewer'));
  console.log(chalk.dim('  /memory pending         List pending memory learning proposals'));
  console.log(chalk.dim('  /memory show <id>       Preview a memory proposal'));
  console.log(chalk.dim('  /memory approve <id>    Approve and apply a memory proposal'));
  console.log(chalk.dim('  /memory reject <id>     Reject a memory proposal'));
  console.log(chalk.dim('  /memory curate          Report duplicate/stale/quarantined refs'));
  console.log(chalk.dim('  /memory rebuild         Regenerate MEMORY.md from topic frontmatter'));
  console.log(chalk.dim('  /memory open            Print paths so you can open them in your editor'));
  console.log(chalk.dim('  /memory help            Show this help'));
  console.log();
}

function printDetailedHelp(): void {
  console.log(chalk.bold('\n/memory - Inspect or rebuild project memory\n'));
  console.log('Usage:');
  console.log(chalk.cyan('  /memory                 ') + chalk.dim('Show MEMORY.md + topic file count'));
  console.log(chalk.cyan('  /memory list            ') + chalk.dim('Alias for `/memory`'));
  console.log(chalk.cyan('  /memory status          ') + chalk.dim('Show pipeline health + review backlog diagnosis'));
  console.log(chalk.cyan('  /memory pending         ') + chalk.dim('List pending memory learning proposals'));
  console.log(chalk.cyan('  /memory show <id>       ') + chalk.dim('Preview a memory proposal'));
  console.log(chalk.cyan('  /memory approve <id>    ') + chalk.dim('Approve and apply a memory proposal'));
  console.log(chalk.cyan('  /memory reject <id>     ') + chalk.dim('Reject a memory proposal'));
  console.log(chalk.cyan('  /memory curate          ') + chalk.dim('Report duplicate/stale/quarantined refs'));
  console.log(chalk.cyan('  /memory rebuild         ') + chalk.dim('Regenerate MEMORY.md (newest first by mtime)'));
  console.log(chalk.cyan('  /memory open            ') + chalk.dim('Print the index + dir paths for editor use'));
  console.log(chalk.cyan('  /memory help            ') + chalk.dim('Show this help\n'));
  console.log('Description:');
  console.log(
    chalk.dim(
      '  Each project gets its own memory directory under your KodaX agent\n' +
        '  home — `<agentConfigHome>/projects/<project-key>/memory/`. The LLM\n' +
        '  owns reads/writes; this command is your escape hatch when the\n' +
        '  MEMORY.md index drifts from the topic files on disk.\n',
    ),
  );
  console.log('Notes:');
  console.log(chalk.dim('  • Rebuild ONLY rewrites MEMORY.md. Topic files are never touched.'));
  console.log(chalk.dim('  • Rebuild sorts entries by file mtime descending — the same'));
  console.log(chalk.dim('    natural-LRU order the LLM produces by prepending new entries.'));
  console.log(chalk.dim('  • Files missing or with malformed frontmatter still appear in'));
  console.log(chalk.dim('    the rebuilt index using their filename as fallback; the command'));
  console.log(chalk.dim('    prints a warning so you can fix the frontmatter.\n'));
}

/**
 * `/memory` command definition.
 */
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Inspect, govern, or rebuild per-project memory',
  usage: '/memory [list|status|pending|show|approve|reject|curate|rebuild|open|help]',
  argumentHint: 'list | status | pending | show <id> | approve <id> | reject <id> [reason] | curate | rebuild | open | help',
  handler: async (args, context, callbacks) => {
    const cwd = resolveCwd(context);
    const memoryDir = resolveMemoryRoot(cwd);
    const entrypointPath = resolveMemoryEntrypoint(cwd);
    const sub = (args[0] ?? 'list').toLowerCase();
    const memoryReviewer = callbacks.createKodaXOptions?.().memoryReviewer;
    const controller = createMemoryControlPlane({
      cwd,
      ...(memoryReviewer !== undefined ? { memoryReviewer } : {}),
    });

    if (sub === 'help' || sub === '--help' || sub === '-h') {
      printHelp();
      return;
    }
    if (sub === 'list') {
      await listMemory(memoryDir, entrypointPath);
      return;
    }
    if (sub === 'status') {
      await statusMemory(memoryDir, entrypointPath, context, callbacks, cwd);
      return;
    }
    if (sub === 'pending' || sub === 'inbox') {
      printMemoryInbox(await controller.listInbox());
      return;
    }
    if (sub === 'show') {
      const proposalId = args[1];
      if (proposalId === undefined) {
        console.log(chalk.yellow('\n[memory] missing proposal id for show.\n'));
        return;
      }
      const proposal = await controller.showProposal(proposalId);
      if (proposal === undefined) {
        console.log(chalk.yellow(`\n[memory] proposal not found: ${proposalId}\n`));
        return;
      }
      printMemoryProposal(proposal);
      cachePreviewFingerprints(cwd, proposal.id, proposal.expectedFingerprints);
      return;
    }
    if (sub === 'approve') {
      const proposalId = args[1];
      if (proposalId === undefined) {
        console.log(chalk.yellow('\n[memory] missing proposal id for approve.\n'));
        return;
      }
      const cachedFingerprints = readCachedPreviewFingerprints(cwd, proposalId);
      if (cachedFingerprints === undefined) {
        console.log(chalk.yellow(`\n[memory] preview required before approve: /memory show ${proposalId}\n`));
        return;
      }
      const result = await controller.approveProposal(proposalId, cachedFingerprints);
      proposalPreviewFingerprints.delete(previewCacheKey(cwd, proposalId));
      printApplyResult(result);
      return;
    }
    if (sub === 'reject') {
      const proposalId = args[1];
      if (proposalId === undefined) {
        console.log(chalk.yellow('\n[memory] missing proposal id for reject.\n'));
        return;
      }
      const result = await controller.rejectProposal(proposalId, args.slice(2).join(' ').trim());
      proposalPreviewFingerprints.delete(previewCacheKey(cwd, proposalId));
      printRejectResult(result);
      return;
    }
    if (sub === 'curate') {
      printGovernanceReport(await controller.runCurator());
      return;
    }
    if (sub === 'rebuild') {
      await rebuildMemory(memoryDir, entrypointPath);
      return;
    }
    if (sub === 'open') {
      openMemory(memoryDir, entrypointPath);
      return;
    }
    console.log(chalk.yellow(`\n[memory] unknown subcommand: ${sub}`));
    printHelp();
  },
  detailedHelp: printDetailedHelp,
};

function previewCacheKey(cwd: string, proposalId: string): string {
  return `${cwd}\0${proposalId}`;
}

function cachePreviewFingerprints(
  cwd: string,
  proposalId: string,
  fingerprints: Readonly<Record<string, string>>,
): void {
  pruneExpiredPreviewFingerprints(Date.now());
  proposalPreviewFingerprints.set(previewCacheKey(cwd, proposalId), {
    fingerprints,
    createdAtMs: Date.now(),
  });
}

function readCachedPreviewFingerprints(
  cwd: string,
  proposalId: string,
): Readonly<Record<string, string>> | undefined {
  const key = previewCacheKey(cwd, proposalId);
  const cached = proposalPreviewFingerprints.get(key);
  if (cached === undefined) return undefined;
  if (Date.now() - cached.createdAtMs > PREVIEW_FINGERPRINT_TTL_MS) {
    proposalPreviewFingerprints.delete(key);
    return undefined;
  }
  return cached.fingerprints;
}

function pruneExpiredPreviewFingerprints(nowMs: number): void {
  for (const [key, cached] of proposalPreviewFingerprints) {
    if (nowMs - cached.createdAtMs > PREVIEW_FINGERPRINT_TTL_MS) {
      proposalPreviewFingerprints.delete(key);
    }
  }
}
