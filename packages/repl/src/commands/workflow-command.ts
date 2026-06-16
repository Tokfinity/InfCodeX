/**
 * FEATURE_217/229 /workflow slash command wiring.
 * Parser, formatting, live updates, and builder helpers live beside this file.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowModule,
  WorkflowCapsule,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
  listWorkflowPatternTemplates,
  discoverSavedWorkflows,
  generateWorkflowFromOptions,
  getDefaultWorkflowRunManager,
  loadGeneratedWorkflowFromRun,
  loadSavedWorkflow,
  loadSavedWorkflowCapsule,
  preflightWorkflowCapsule,
  renameSavedWorkflow,
  replaceSavedWorkflow,
  resolveWorkflowIdentity,
  saveGeneratedWorkflow,
  saveGeneratedWorkflowFromRun,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import type { Command, CommandCallbacks } from './types.js';
import {
  buildWorkflowProcessMetadata,
  startGeneratedWorkflowFromRequest,
} from './workflow-command-builder.js';
export { startGeneratedWorkflowFromRequest } from './workflow-command-builder.js';
import {
  createWorkflowLiveUpdateEmitter,
  emitWorkflowRunMessage,
  observeManagedWorkflowDone,
  subscribeWorkflowLiveProcess,
  workflowEventSink,
} from './workflow-command-live.js';
export {
  createWorkflowLiveUpdateEmitter,
  observeManagedWorkflowDone,
  type GeneratedWorkflowApprovalMode,
  type GeneratedWorkflowStartOutcome,
  type StartGeneratedWorkflowFromRequestOptions,
  type WorkflowBuilderEvent,
  type WorkflowBuilderStage,
  type WorkflowLiveUpdateEmitter,
} from './workflow-command-live.js';
import {
  buildWorkflowRevisionProvenance,
  canRerunWorkflowRun,
  currentWorkflowPreflightEnv,
  detectWorkflowLocale,
  ensureSafeRunId,
  formatManagedRunsList,
  formatRunsList,
  formatSavedList,
  formatWorkflowList,
  formatWorkflowNextActions,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  inferWorkflowLocaleFromParts,
  isActiveManagedWorkflowRun,
  nextRevisionWorkflowName,
  prepareSavedWorkflow,
  printPreflightFailure,
  printPreflightWarnings,
  printWorkflowHelp,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  selectWorkflowPruneCandidates,
  writeWorkflowRunDisplayName,
  type WorkflowApprovalRenderContext,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
} from './workflow-command-helpers.js';
export {
  createWorkflowAgentDigestLimiter,
  formatFinalEventSummary,
  formatManagedRunsList,
  formatResult,
  formatRunsList,
  formatSavedList,
  formatWorkflowAgentDigest,
  formatWorkflowList,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  isActiveManagedWorkflowRun,
  isSafeWorkflowRunId,
  isTerminalWorkflowStatus,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  renderWorkflowHelp,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  selectWorkflowPruneCandidates,
  type WorkflowApprovalRenderContext,
  type WorkflowPruneCandidate,
  type WorkflowRunDetail,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
  type WorkflowRunSnapshotFormatOptions,
  type WorkflowRunSummary,
  type WorkflowRunsListFormatOptions,
} from './workflow-command-helpers.js';
import {
  buildWorkflowRevisionRequest,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowPruneOptions,
} from './workflow-command-parse.js';
export {
  buildWorkflowRevisionRequest,
  DEFAULT_WORKFLOW_PRUNE_KEEP,
  DEFAULT_WORKFLOW_RUNS_LIMIT,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowInvocation,
  type WorkflowPruneOptions,
  type WorkflowRunsOptions,
} from './workflow-command-parse.js';

/* ----------------------------- pure helpers ----------------------------- */

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [help | list | runs | show | pause | resume | stop | delete | prune | rerun | save | rename | revise | create | <name> [args]]',
  argumentHint: 'help | list | runs [--all|--limit N] | show [runId] | pause <runId> | resume <runId> | stop [runId] | delete <runId> | prune --dry-run|--keep N|--older-than Nd | rerun <runId|savedName> [args] | save <runId> <name> | rename <runId|alias|savedName> <newName> | revise [--replace] <runId|alias|savedName> <change> | create <request> | <name> [args]',
  detailedHelp: printWorkflowHelp,
  handler: async (args, _context, callbacks, currentConfig) => {
    const invocation = parseWorkflowInvocation(args);
    const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
    const baseDir = getAgentConfigPath('workflow-runs', projectKey);
    const manager = getDefaultWorkflowRunManager();

    const dirs = savedWorkflowDirs(process.cwd());

    if (invocation.kind === 'help') {
      printWorkflowHelp();
      return;
    }

    if (invocation.kind === 'list') {
      console.log(chalk.bold('\nBuilt-in workflows:'));
      console.log(formatWorkflowList(listBuiltinWorkflows()));
      console.log(chalk.bold('\nPattern templates:'));
      for (const template of listWorkflowPatternTemplates()) {
        console.log(`  ${chalk.cyan(template.name)} ${chalk.dim(`(${template.pattern})`)} - ${template.description}`);
      }
      const saved = await discoverSavedWorkflows(dirs);
      if (saved.length > 0) {
        console.log(chalk.bold('\nSaved workflows:'));
        console.log(formatSavedList(saved));
      }
      console.log(chalk.dim('\n  Run one with: /workflow <name> <question or JSON args>'));
      console.log(chalk.dim('  Show usage with: /workflow help\n'));
      return;
    }

    if (invocation.kind === 'runs') {
      const options = parseWorkflowRunsOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow runs [--all] [--limit N]\n${options.error}\n`));
        return;
      }
      const processSnapshots = new Map(
        manager.listWorkflowProcessSnapshots({ activeOnly: false })
          .map((snapshot) => [snapshot.runId, snapshot]),
      );
      const active = manager.list().filter(isActiveManagedWorkflowRun);
      if (active.length > 0) {
        console.log(chalk.bold('\nActive workflow runs:'));
        console.log(formatManagedRunsList(active, { processSnapshots }));
      }
      console.log(chalk.bold('\nWorkflow runs:'));
      console.log(formatRunsList(readWorkflowRuns(baseDir), {
        limit: options.all ? undefined : options.limit,
        showLimitHint: !options.all,
        processSnapshots,
      }));
      console.log();
      return;
    }

    if (invocation.kind === 'show') {
      const persistedRuns = readWorkflowRuns(baseDir);
      const runId = invocation.runId
        || selectDefaultWorkflowRunId(manager.list(), persistedRuns);
      if (!runId) {
        console.log(chalk.yellow('\nNo workflow runs yet. Start one with /workflow create <request>.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const managed = manager.get(runId);
      const detail = readWorkflowRunDetail(baseDir, runId);
      const processSnapshot = manager.getWorkflowProcessSnapshot(runId);
      console.log(chalk.bold('\nWorkflow run:'));
      console.log(formatWorkflowRunSnapshot(managed, detail, {
        full: invocation.full === true,
        ...(processSnapshot ? { processSnapshot } : {}),
      }));
      console.log();
      return;
    }

    if (invocation.kind === 'pause') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.pause(invocation.runId);
      console.log(ok ? chalk.dim(`Paused workflow ${invocation.runId}.\n`) : chalk.yellow(`No running workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'resume') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.resume(invocation.runId);
      console.log(ok ? chalk.dim(`Resumed workflow ${invocation.runId}.\n`) : chalk.yellow(`No paused workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'stop') {
      const runId = invocation.runId || selectDefaultActiveWorkflowRunId(manager.list());
      if (!runId) {
        console.log(chalk.yellow('\nNo active workflow to stop.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const ok = manager.stop(runId, 'stopped by user');
      const snapshot = manager.get(runId);
      const detail = snapshot ? readWorkflowRunDetail(baseDir, runId) : undefined;
      const nextActions = formatWorkflowNextActions(
        runId,
        canRerunWorkflowRun(snapshot, detail),
      );
      console.log(ok
        ? chalk.dim(`Stopped workflow ${runId}.\n`)
        : snapshot && !isActiveManagedWorkflowRun(snapshot)
          ? chalk.yellow(`Workflow ${runId} is already ${snapshot.status}. Next: ${nextActions}.\n`)
          : chalk.yellow(`No active workflow ${runId}.\n`));
      return;
    }

    if (invocation.kind === 'delete') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const snapshot = manager.get(invocation.runId);
      if (snapshot && isActiveManagedWorkflowRun(snapshot)) {
        console.log(chalk.yellow(`\nWorkflow ${invocation.runId} is ${snapshot.status}. Stop it before deleting the run record.\n`));
        return;
      }
      const runDir = join(baseDir, invocation.runId);
      if (!existsSync(runDir)) {
        console.log(chalk.yellow(`\nNo persisted workflow run ${invocation.runId}.\n`));
        return;
      }
      rmSync(runDir, { recursive: true, force: true });
      console.log(chalk.dim(`\nDeleted workflow run ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'prune') {
      const options = parseWorkflowPruneOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\n${options.error}\n`));
        return;
      }
      if (!options.dryRun && options.keep === undefined && options.olderThanMs === undefined) {
        console.log(chalk.yellow('\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\nNo cleanup rule was provided.\n'));
        return;
      }
      const activeIds = new Set(manager.list().filter(isActiveManagedWorkflowRun).map((run) => run.runId));
      const candidates = selectWorkflowPruneCandidates(readWorkflowRuns(baseDir), options)
        .filter((run) => !activeIds.has(run.runId));
      console.log(chalk.bold(options.dryRun ? '\nWorkflow prune preview:' : '\nWorkflow prune:'));
      console.log(formatWorkflowPruneCandidates(candidates));
      if (!options.dryRun) {
        for (const run of candidates) {
          rmSync(join(baseDir, run.runId), { recursive: true, force: true });
        }
        console.log(chalk.dim(`\nDeleted ${candidates.length} workflow run${candidates.length === 1 ? '' : 's'}.\n`));
      } else {
        console.log(chalk.dim('\nDry run only. Add --keep N or --older-than Nd without --dry-run to delete.\n'));
      }
      return;
    }

    if (invocation.kind === 'save') {
      if (!invocation.runId || !invocation.name) {
        console.log(chalk.yellow('\nUsage: /workflow save <runId> <name>\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      try {
        const ref = await saveGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
          targetDir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
          name: invocation.name,
        });
        console.log(chalk.green(`\nSaved workflow ${ref.name} to ${ref.path}\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] save failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'rename') {
      if (!invocation.target || !invocation.newName) {
        console.log(chalk.yellow('\nUsage: /workflow rename <runId|alias|savedName> <newName>\n'));
        return;
      }
      const resolution = await resolveWorkflowIdentity({
        target: invocation.target,
        runBaseDir: baseDir,
        savedWorkflowDirs: dirs,
      });
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rename target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] rename target not found: ${invocation.target}\n`));
        return;
      }
      if (resolution.kind === 'run') {
        if (!writeWorkflowRunDisplayName(baseDir, resolution.runId, invocation.newName)) {
          console.log(chalk.red(`\n[workflow] rename failed: ${resolution.runId}\n`));
          return;
        }
        console.log(chalk.green(`\nRenamed workflow run ${resolution.runId} to ${invocation.newName.trim()}.\n`));
        return;
      }
      try {
        const renamed = await renameSavedWorkflow({
          dirs,
          name: resolution.savedWorkflow.name,
          newName: invocation.newName,
          source: resolution.savedWorkflow.source,
        });
        console.log(chalk.green(`\nRenamed saved workflow ${invocation.target} to ${renamed.name}.\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rename failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'revise') {
      if (!invocation.target || !invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow revise [--replace] <runId|alias|savedName> <change request>\n'));
        return;
      }
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to revise a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot revise - REPL options unavailable in this context.\n'));
        return;
      }
      const resolution = await resolveWorkflowIdentity({
        target: invocation.target,
        runBaseDir: baseDir,
        savedWorkflowDirs: dirs,
      });
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous revise target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] revise target not found: ${invocation.target}\n`));
        return;
      }
      if (invocation.replace === true && resolution.kind !== 'saved') {
        console.log(chalk.red('\n[workflow] revise --replace requires a saved workflow name target.\n'));
        return;
      }
      let capsule: WorkflowCapsule;
      try {
        if (resolution.kind === 'run') {
          capsule = (await loadGeneratedWorkflowFromRun({ runDir: resolution.runDir })).capsule;
        } else {
          if (resolution.savedWorkflow.execution !== 'capability-generated') {
            console.log(chalk.red('\n[workflow] only generated workflow capsules can be revised.\n'));
            return;
          }
          capsule = await loadSavedWorkflowCapsule(resolution.savedWorkflow.path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise failed: ${message}\n`));
        return;
      }

      const revisionRequest = buildWorkflowRevisionRequest({
        target: invocation.target,
        capsule,
        changeRequest: invocation.request,
      });
      let generated: Awaited<ReturnType<typeof generateWorkflowFromOptions>>;
      try {
        generated = await generateWorkflowFromOptions({
          request: revisionRequest,
          options: createOptions(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise generation failed: ${message}\n`));
        return;
      }
      if (generated.kind === 'declined') {
        console.log(chalk.dim(`\nWorkflow revision not created: ${generated.reason}\n`));
        return;
      }
      const replaceSavedResolution = invocation.replace === true && resolution.kind === 'saved'
        ? resolution
        : undefined;
      const replaceWorkflowName = replaceSavedResolution?.savedWorkflow.name;
      const savedName = replaceWorkflowName
        ?? await nextRevisionWorkflowName(dirs, generated.manifest.name);
      const manifest = savedName === generated.manifest.name
        ? generated.manifest
        : { ...generated.manifest, name: savedName };
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary({ meta: manifest, run: generated.module.run }), {
          source: replaceWorkflowName
            ? `revision-replace:${replaceWorkflowName}`
            : `revision:${invocation.target}`,
          sandbox: 'capability-generated',
          mayUseWorktree: manifest.mayUseWorktree === true,
          rawScript: generated.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow revision cancelled.\n'));
        return;
      }
      const revisionInput = {
        name: savedName,
        manifest,
        source: generated.source,
        intent: {
          taskClass: manifest.patterns[0] ?? manifest.name,
          originalRequest: invocation.request,
          reusableFor: [manifest.description],
        },
        ...(capsule.inputs !== undefined ? { inputs: capsule.inputs } : {}),
        ...(capsule.requires !== undefined ? { requires: capsule.requires } : {}),
        provenance: buildWorkflowRevisionProvenance({
          capsule,
          resolution,
          ...(replaceWorkflowName !== undefined ? { replacesWorkflowName: replaceWorkflowName } : {}),
        }),
      };
      if (replaceSavedResolution) {
        const ref = await replaceSavedWorkflow({
          ...revisionInput,
          dirs,
          savedSource: replaceSavedResolution.savedWorkflow.source,
        });
        console.log(
          chalk.green(
            `\nReplaced saved workflow ${ref.name} with revised capsule at ${ref.path}\n`,
          ),
        );
        console.log(chalk.dim(`Previous capsule archived at ${ref.previousPath}\n`));
        return;
      }

      const ref = await saveGeneratedWorkflow({
        ...revisionInput,
        dir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
      });
      console.log(chalk.green(`\nSaved workflow revision ${ref.name} to ${ref.path}\n`));
      return;
    }

    if (invocation.kind === 'rerun') {
      if (!invocation.runId) {
        console.log(chalk.yellow('\nUsage: /workflow rerun <runId|savedName> [args]\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to rerun a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
        return;
      }
      const savedRef = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.runId);
      const targetMatchesRun = manager.list().some((run) => run.runId === invocation.runId) ||
        existsSync(join(baseDir, invocation.runId, 'run.json'));
      if (savedRef && targetMatchesRun) {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rerun target: ${invocation.runId} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        console.log(
          chalk.yellow(
            `Use /workflow ${invocation.runId} to run the saved workflow, or rerun a unique run id/name.\n`,
          ),
        );
        return;
      }
      if (savedRef && !targetMatchesRun) {
        const prepared = await prepareSavedWorkflow(savedRef, confirm);
        if (!prepared) return;
        const locale = inferWorkflowLocaleFromParts(
          invocation.rawArgs,
          prepared.module.meta.name,
          prepared.module.meta.description,
          prepared.scriptSnapshot?.source,
        );
        const presentation: WorkflowRunPresentation = 'agentic';
        const approved = await confirm(
          renderApprovalPrompt(buildApprovalSummary(prepared.module), prepared.approvalContext),
        );
        if (!approved) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
        const newRunId = `run-${Date.now().toString(36)}`;
        const newRunDir = join(baseDir, newRunId);
        console.log(chalk.dim(`\nStarted workflow ${prepared.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
        const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, prepared.module.meta, locale);
        live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
        const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
        const managed = manager.startFromOptions({
          module: prepared.module,
          args: parseWorkflowArgs(invocation.rawArgs),
          options: createOptions(),
          runId: newRunId,
          runDir: newRunDir,
          ...(prepared.scriptSnapshot ? { scriptSnapshot: prepared.scriptSnapshot } : {}),
          processMetadata: buildWorkflowProcessMetadata({
            source: 'capsule',
            displayName: prepared.module.meta.name,
            savedWorkflowName: savedRef.name,
            sourceWorkflowName: savedRef.name,
          }),
          onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
        });
        void managed.done.finally(unsubscribeProcess);
        observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
          canRerun: prepared.scriptSnapshot !== undefined,
          presentation,
          locale,
        });
        return;
      }
      let loaded: Awaited<ReturnType<typeof loadGeneratedWorkflowFromRun>>;
      try {
        loaded = await loadGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rerun failed: ${message}\n`));
        return;
      }
      const runDetail = readWorkflowRunDetail(baseDir, invocation.runId);
      const rawScriptPath = runDetail?.scriptSnapshotPath ?? join(baseDir, invocation.runId, 'script.js');
      const locale = inferWorkflowLocaleFromParts(
        invocation.rawArgs,
        loaded.capsule.manifest.name,
        loaded.capsule.manifest.description,
        loaded.capsule.source,
      );
      const presentation: WorkflowRunPresentation = 'agentic';
      const preflight = preflightWorkflowCapsule(loaded.capsule, currentWorkflowPreflightEnv());
      if (!preflight.ok) {
        printPreflightFailure(preflight);
        return;
      }
      printPreflightWarnings(preflight);
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary(loaded.module), {
          source: `run:${invocation.runId}`,
          sandbox: 'capability-generated',
          mayUseWorktree: loaded.capsule.manifest.mayUseWorktree === true,
          rawScriptPath,
          rawScript: loaded.capsule.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow cancelled.\n'));
        return;
      }
      const newRunId = `run-${Date.now().toString(36)}`;
      const newRunDir = join(baseDir, newRunId);
      console.log(chalk.dim(`\nStarted workflow ${loaded.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
      const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, loaded.module.meta, locale);
      live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
      const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
      const managed = manager.startFromOptions({
        module: loaded.module,
        args: parseWorkflowArgs(invocation.rawArgs),
        options: createOptions(),
        runId: newRunId,
        runDir: newRunDir,
        scriptSnapshot: {
          manifest: loaded.capsule.manifest,
          source: loaded.capsule.source,
        },
        processMetadata: buildWorkflowProcessMetadata({
          source: 'command',
          displayName: loaded.module.meta.name,
          sourceRunId: invocation.runId,
        }),
        onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
      });
      void managed.done.finally(unsubscribeProcess);
      observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
        canRerun: true,
        presentation,
        locale,
      });
      return;
    }

    if (invocation.kind === 'create') {
      if (!invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow create <request>\n'));
        return;
      }
      await startGeneratedWorkflowFromRequest({
        request: invocation.request,
        callbacks,
        approval: currentConfig.permissionMode === 'plan' ? 'required' : 'silent',
        presentation: 'agentic',
        sourceLabel: 'generated',
        processSource: 'command',
        onBuilderEvent: callbacks.onWorkflowBuilderEvent,
      });
      return;
    }

    const confirm = resolveConfirm(callbacks);
    if (!confirm) {
      console.log(
        chalk.red('\n[workflow] refusing to start a workflow without an interactive approval channel.\n'),
      );
      return;
    }
    let approvalContext: WorkflowApprovalRenderContext = {
      source: 'built-in',
      sandbox: 'trusted package',
      mayUseWorktree: false,
    };
    let scriptSnapshot: { readonly manifest: WorkflowScriptManifest; readonly source: string } | undefined;
    let module: WorkflowModule | undefined = getBuiltinWorkflow(invocation.name);
    let savedWorkflowRef: SavedWorkflowRef | undefined;
    if (!module) {
      // Not a built-in — try a saved workflow. Loading EXECUTES local
      // code, so it is hard-gated behind a trusted-local confirmation:
      // with no interactive channel we refuse rather than run unconfirmed.
      const ref = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.name);
      if (!ref) {
        console.log(chalk.yellow(`\nUnknown workflow: ${invocation.name}`));
        console.log(formatWorkflowList(listBuiltinWorkflows()));
        console.log();
        return;
      }
      savedWorkflowRef = ref;
      if (ref.execution === 'trusted-local') {
        const trusted = await confirm(
          `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
        );
        if (!trusted) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
      }
      try {
        if (ref.execution === 'capability-generated') {
          const capsule = await loadSavedWorkflowCapsule(ref.path);
          const preflight = preflightWorkflowCapsule(capsule, currentWorkflowPreflightEnv());
          if (!preflight.ok) {
            printPreflightFailure(preflight);
            return;
          }
          printPreflightWarnings(preflight);
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: capsule.manifest.mayUseWorktree === true,
            rawScriptPath: ref.path,
            rawScript: capsule.source,
          };
          scriptSnapshot = {
            manifest: capsule.manifest,
            source: capsule.source,
          };
        }
        module = await loadSavedWorkflow(ref.path);
        if (ref.execution === 'trusted-local') {
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: false,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] failed to load ${ref.path}: ${message}\n`));
        return;
      }
    }

    const createOptions = callbacks.createKodaXOptions;
    if (!createOptions) {
      console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
      return;
    }

    const approved = await confirm(renderApprovalPrompt(buildApprovalSummary(module), approvalContext));
    if (!approved) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return;
    }

    const runId = `run-${Date.now().toString(36)}`;
    const runDir = join(baseDir, runId);
    console.log(chalk.dim(`\nStarted workflow ${module.meta.name} (${runId}). Use /workflow show ${runId} for status.\n`));
    const locale = inferWorkflowLocaleFromParts(
      invocation.rawArgs,
      module.meta.name,
      module.meta.description,
      scriptSnapshot?.source,
    );
    const live = createWorkflowLiveUpdateEmitter(callbacks, runId, module.meta, locale);
    live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);
    const presentation: WorkflowRunPresentation = 'agentic';
    const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, runId);

    const managed = manager.startFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      ...(scriptSnapshot ? { scriptSnapshot } : {}),
      processMetadata: savedWorkflowRef
        ? buildWorkflowProcessMetadata({
            source: 'capsule',
            displayName: module.meta.name,
            savedWorkflowName: savedWorkflowRef.name,
            sourceWorkflowName: savedWorkflowRef.name,
          })
        : buildWorkflowProcessMetadata({
            source: 'command',
            displayName: module.meta.name,
          }),
      onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId }),
    });
    void managed.done.finally(unsubscribeProcess);

    observeManagedWorkflowDone(managed, callbacks, runId, live, {
      canRerun: scriptSnapshot !== undefined,
      presentation,
      locale,
    });
  },
};
