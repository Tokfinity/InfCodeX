import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { KodaXEvents, KodaXMessage, KodaXOptions } from '@kodax/coding';
import type { ProjectFeature } from './project-state.js';
import { ProjectStorage } from './project-storage.js';
import { buildProjectQualityReport } from './project-quality.js';

const execAsync = promisify(execCallback);

export interface ProjectHarnessCheckConfig {
  id: string;
  command: string;
  required: boolean;
}

export interface ProjectHarnessConfig {
  version: 1;
  generatedAt: string;
  protectedArtifacts: string[];
  checks: ProjectHarnessCheckConfig[];
  completionRules: {
    requireProgressUpdate: boolean;
    requireChecksPass: boolean;
    requireCompletionReport: boolean;
  };
  advisoryRules: {
    warnOnLargeUnrelatedDiff: boolean;
    warnOnRepeatedFailure: boolean;
  };
}

export interface ProjectHarnessViolation {
  rule: string;
  severity: 'warn' | 'high';
  evidence: string;
}

export interface ProjectHarnessCheckResult {
  id: string;
  command: string;
  required: boolean;
  passed: boolean;
  output: string;
}

export interface ProjectHarnessCompletionReport {
  status: 'complete' | 'needs_review' | 'blocked';
  summary: string;
  evidence?: string[];
  tests?: string[];
  changedFiles?: string[];
  blockers?: string[];
}

export interface ProjectHarnessRunRecord {
  runId: string;
  featureIndex: number;
  mode: 'next' | 'auto' | 'verify' | 'manual';
  attempt: number;
  decision: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked';
  changedFiles: string[];
  checks: ProjectHarnessCheckResult[];
  qualityBefore: number;
  qualityAfter: number;
  violations: ProjectHarnessViolation[];
  repairHints: string[];
  evidence: string[];
  completionReport: ProjectHarnessCompletionReport | null;
  createdAt: string;
}

export interface ProjectHarnessEvidenceRecord {
  featureIndex: number;
  status: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked' | 'manual_override';
  changedFiles: string[];
  progressUpdated: boolean;
  checksPassed: boolean;
  qualityDelta: number;
  completionSource: 'auto_verified' | 'verification_failed' | 'manual_override';
  updatedAt: string;
}

export interface ProjectHarnessVerificationResult {
  decision: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked';
  reasons: string[];
  repairPrompt?: string;
  runRecord: ProjectHarnessRunRecord;
  evidenceRecord: ProjectHarnessEvidenceRecord;
}

interface HarnessAttemptSnapshot {
  progressText: string;
  qualityScore: number;
}

function getProjectRoot(storage: ProjectStorage): string {
  return path.dirname(storage.getPaths().features);
}

function buildRunId(featureIndex: number, attempt: number): string {
  return `feature-${featureIndex}-${Date.now()}-attempt-${attempt}`;
}

function extractAssistantText(messages: KodaXMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !message.content) {
      continue;
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .map(part => ('text' in part ? part.text : '') || '')
      .join('');
  }

  return '';
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function getWriteTarget(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== 'write' && tool !== 'edit') {
    return null;
  }

  const rawPath = input.path;
  return typeof rawPath === 'string' && rawPath.trim().length > 0
    ? normalizePath(rawPath)
    : null;
}

function parseCompletionReport(messages: KodaXMessage[]): ProjectHarnessCompletionReport | null {
  const text = extractAssistantText(messages);
  const match = text.match(/<project-harness>\s*([\s\S]*?)\s*<\/project-harness>/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as ProjectHarnessCompletionReport;
  } catch {
    return null;
  }
}

function buildScriptCommand(packageManager: string, script: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    default:
      return `npm run ${script}`;
  }
}

async function detectPackageManager(projectRoot: string): Promise<string> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  try {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content) as { packageManager?: string };
    if (packageJson.packageManager?.startsWith('pnpm@')) {
      return 'pnpm';
    }
    if (packageJson.packageManager?.startsWith('yarn@')) {
      return 'yarn';
    }
  } catch {
    // Fall through to lock-file detection.
  }

  const lockFiles = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
  ];

  for (const candidate of lockFiles) {
    try {
      await fs.access(path.join(projectRoot, candidate.file));
      return candidate.manager;
    } catch {
      // Keep searching.
    }
  }

  return 'npm';
}

async function discoverHarnessConfig(projectRoot: string): Promise<ProjectHarnessConfig> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  let scripts: Record<string, string> = {};

  try {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content) as { scripts?: Record<string, string> };
    scripts = packageJson.scripts ?? {};
  } catch {
    scripts = {};
  }

  const packageManager = await detectPackageManager(projectRoot);
  const knownScripts = ['test', 'typecheck', 'lint', 'build'];
  const checks = knownScripts
    .filter(script => typeof scripts[script] === 'string')
    .map<ProjectHarnessCheckConfig>(script => ({
      id: script,
      command: buildScriptCommand(packageManager, script),
      required: script === 'test' || script === 'build',
    }));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    protectedArtifacts: ['feature_list.json', '.agent/project/harness'],
    checks,
    completionRules: {
      requireProgressUpdate: true,
      requireChecksPass: true,
      requireCompletionReport: true,
    },
    advisoryRules: {
      warnOnLargeUnrelatedDiff: true,
      warnOnRepeatedFailure: true,
    },
  };
}

async function calculateQualityScore(storage: ProjectStorage): Promise<number> {
  const featureList = await storage.loadFeatures();
  if (!featureList) {
    return 0;
  }

  const report = buildProjectQualityReport(
    featureList.features,
    await storage.readProgress(),
    await storage.readSessionPlan(),
  );
  return report.overallScore;
}

async function runHarnessChecks(
  projectRoot: string,
  checks: ProjectHarnessCheckConfig[],
): Promise<ProjectHarnessCheckResult[]> {
  const results: ProjectHarnessCheckResult[] = [];

  for (const check of checks) {
    try {
      const { stdout, stderr } = await execAsync(check.command, {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10,
      });
      results.push({
        id: check.id,
        command: check.command,
        required: check.required,
        passed: true,
        output: `${stdout}${stderr}`.trim(),
      });
    } catch (error) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      results.push({
        id: check.id,
        command: check.command,
        required: check.required,
        passed: false,
        output: `${execError.stdout ?? ''}${execError.stderr ?? ''}${execError.message ?? ''}`.trim(),
      });
    }
  }

  return results;
}

export async function loadOrCreateProjectHarnessConfig(storage: ProjectStorage): Promise<ProjectHarnessConfig> {
  const existing = await storage.readHarnessConfig<ProjectHarnessConfig>();
  if (existing?.version === 1) {
    return existing;
  }

  const config = await discoverHarnessConfig(getProjectRoot(storage));
  await storage.writeHarnessConfig(config);
  return config;
}

export class ProjectHarnessAttempt {
  private touchedFiles = new Set<string>();
  private violations: ProjectHarnessViolation[] = [];

  constructor(
    private readonly storage: ProjectStorage,
    private readonly feature: ProjectFeature,
    private readonly featureIndex: number,
    private readonly mode: 'next' | 'auto' | 'verify',
    private readonly config: ProjectHarnessConfig,
    private readonly before: HarnessAttemptSnapshot,
    private readonly attempt: number,
  ) {}

  wrapOptions(options: KodaXOptions): KodaXOptions {
    const baseEvents = options.events;

    const wrappedEvents: KodaXEvents = {
      ...baseEvents,
      beforeToolExecute: async (tool, input) => {
        const targetPath = getWriteTarget(tool, input);
        if (targetPath) {
          this.touchedFiles.add(targetPath);
          const featuresPath = normalizePath(this.storage.getPaths().features);
          const harnessRoot = normalizePath(this.storage.getPaths().harnessRoot);

          if (targetPath === featuresPath) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: 'feature_list.json can only be updated by the project harness after verification',
            });
            return '[Blocked by Project Harness] Do not edit feature_list.json during /project next or /project auto. The command layer updates it after verification.';
          }

          if (targetPath.startsWith(harnessRoot)) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: '.agent/project/harness/** is reserved for verifier-owned artifacts',
            });
            return '[Blocked by Project Harness] Do not edit .agent/project/harness artifacts directly.';
          }
        }

        return baseEvents?.beforeToolExecute
          ? await baseEvents.beforeToolExecute(tool, input)
          : true;
      },
    };

    return {
      ...options,
      events: wrappedEvents,
    };
  }

  async verify(messages: KodaXMessage[]): Promise<ProjectHarnessVerificationResult> {
    const completionReport = parseCompletionReport(messages);
    const progressAfter = await this.storage.readProgress();
    const progressUpdated = normalizeText(progressAfter) !== normalizeText(this.before.progressText);
    const qualityAfter = await calculateQualityScore(this.storage);
    const checks = await runHarnessChecks(getProjectRoot(this.storage), this.config.checks);
    const requiredCheckFailures = checks.filter(check => check.required && !check.passed);

    const changedFiles = Array.from(
      new Set([
        ...Array.from(this.touchedFiles),
        ...(completionReport?.changedFiles ?? []).map(file => normalizePath(file)),
      ]),
    );

    const reasons: string[] = [];
    const repairHints: string[] = [];
    const evidence: string[] = [];

    if (completionReport?.summary) {
      evidence.push(completionReport.summary);
    }
    if (completionReport?.evidence?.length) {
      evidence.push(...completionReport.evidence);
    }
    if (progressUpdated) {
      evidence.push('PROGRESS.md was updated during the attempt.');
    }
    if (checks.length > 0) {
      evidence.push(`Executed ${checks.length} project check(s).`);
    }

    let decision: ProjectHarnessVerificationResult['decision'] = 'verified_complete';

    if (this.violations.length > 0) {
      reasons.push(...this.violations.map(violation => `${violation.rule}: ${violation.evidence}`));
      repairHints.push('Stop editing protected artifacts directly; let the command layer own completion and harness files.');
      decision = 'retryable_failure';
    }

    if (this.config.completionRules.requireCompletionReport && !completionReport) {
      reasons.push('Missing <project-harness> completion report in the final assistant response.');
      repairHints.push('End the attempt with a valid <project-harness>{...}</project-harness> JSON report.');
      decision = 'retryable_failure';
    }

    if (completionReport?.status === 'blocked') {
      reasons.push(...(completionReport.blockers?.length
        ? completionReport.blockers
        : ['The implementation attempt reported a blocked state.']));
      decision = 'blocked';
    } else if (completionReport?.status === 'needs_review' && decision !== 'blocked') {
      reasons.push(completionReport.summary || 'The implementation requested human review.');
      decision = 'needs_review';
    }

    if (this.config.completionRules.requireProgressUpdate && completionReport?.status === 'complete' && !progressUpdated) {
      reasons.push('PROGRESS.md was not updated with attempt evidence.');
      repairHints.push('Append an attempt summary to PROGRESS.md before finishing.');
      decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
    }

    if (
      this.config.completionRules.requireChecksPass &&
      completionReport?.status === 'complete' &&
      requiredCheckFailures.length > 0
    ) {
      reasons.push(...requiredCheckFailures.map(check => `Required check failed: ${check.id}`));
      repairHints.push('Fix the failing required checks before asking the command layer to complete the feature.');
      decision = 'retryable_failure';
    }

    if (completionReport?.status === 'complete' && decision === 'verified_complete') {
      reasons.push('Completion report present, progress evidence recorded, and required checks passed.');
    }

    const runRecord: ProjectHarnessRunRecord = {
      runId: buildRunId(this.featureIndex, this.attempt),
      featureIndex: this.featureIndex,
      mode: this.mode,
      attempt: this.attempt,
      decision,
      changedFiles,
      checks,
      qualityBefore: this.before.qualityScore,
      qualityAfter,
      violations: [...this.violations],
      repairHints,
      evidence,
      completionReport,
      createdAt: new Date().toISOString(),
    };

    const evidenceRecord: ProjectHarnessEvidenceRecord = {
      featureIndex: this.featureIndex,
      status: decision,
      changedFiles,
      progressUpdated,
      checksPassed: requiredCheckFailures.length === 0,
      qualityDelta: qualityAfter - this.before.qualityScore,
      completionSource: decision === 'verified_complete' ? 'auto_verified' : 'verification_failed',
      updatedAt: new Date().toISOString(),
    };

    await this.storage.appendHarnessRun(runRecord);
    await this.storage.writeHarnessEvidence(this.featureIndex, evidenceRecord);

    return {
      decision,
      reasons,
      repairPrompt: repairHints.length > 0 || reasons.length > 0
        ? [
            'The previous attempt did not satisfy the project harness.',
            ...reasons.map(reason => `- ${reason}`),
            ...repairHints.map(hint => `- ${hint}`),
            'Retry the same feature with the verifier feedback above and end with a valid <project-harness> JSON report.',
          ].join('\n')
        : undefined,
      runRecord,
      evidenceRecord,
    };
  }
}

export async function createProjectHarnessAttempt(
  storage: ProjectStorage,
  feature: ProjectFeature,
  featureIndex: number,
  mode: 'next' | 'auto' | 'verify',
  attempt: number,
): Promise<ProjectHarnessAttempt> {
  const config = await loadOrCreateProjectHarnessConfig(storage);
  const before: HarnessAttemptSnapshot = {
    progressText: await storage.readProgress(),
    qualityScore: await calculateQualityScore(storage),
  };

  return new ProjectHarnessAttempt(storage, feature, featureIndex, mode, config, before, attempt);
}

export async function readLatestHarnessRun(
  storage: ProjectStorage,
): Promise<ProjectHarnessRunRecord | null> {
  const runs = await storage.readHarnessRuns<ProjectHarnessRunRecord>();
  return runs.length > 0 ? runs[runs.length - 1] ?? null : null;
}

export async function recordManualHarnessOverride(
  storage: ProjectStorage,
  featureIndex: number,
  status: 'done' | 'skip',
): Promise<void> {
  const now = new Date().toISOString();
  await storage.writeHarnessEvidence(featureIndex, {
    featureIndex,
    status: 'manual_override',
    changedFiles: [],
    progressUpdated: false,
    checksPassed: false,
    qualityDelta: 0,
    completionSource: 'manual_override',
    updatedAt: now,
    overrideStatus: status,
  });
}

export function formatProjectHarnessSummary(run: ProjectHarnessRunRecord): string {
  const lines = [
    '## Project Harness Verification',
    `- Decision: ${run.decision}`,
    `- Feature: #${run.featureIndex}`,
    `- Attempt: ${run.attempt}`,
    `- Quality: ${run.qualityBefore} -> ${run.qualityAfter}`,
  ];

  if (run.changedFiles.length > 0) {
    lines.push(`- Changed files: ${run.changedFiles.join(', ')}`);
  }

  if (run.checks.length > 0) {
    const checkSummary = run.checks
      .map(check => `${check.id}:${check.passed ? 'pass' : 'fail'}`)
      .join(', ');
    lines.push(`- Checks: ${checkSummary}`);
  }

  if (run.violations.length > 0) {
    lines.push(`- Violations: ${run.violations.map(violation => violation.evidence).join(' | ')}`);
  }

  if (run.repairHints.length > 0) {
    lines.push(`- Repair hints: ${run.repairHints.join(' | ')}`);
  }

  return lines.join('\n');
}
