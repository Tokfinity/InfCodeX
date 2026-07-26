/**
 * FEATURE_217 (v0.7.49) Phase J — small reusable workflow pattern templates.
 *
 * These are examples, not a new abstraction layer. They give the generator
 * and users concrete Claude-style workflow shapes without forcing every task
 * through a static harness.
 */

import {
  createRestrictedWorkflowModule,
  validateWorkflowScriptManifest,
  type WorkflowModule,
  type WorkflowPatternId,
  type WorkflowScriptManifest,
} from '@kodax-ai/agent';
import { getCollaborationPatternDefinition } from '../orchestration/pattern-catalog.js';

export interface WorkflowPatternTemplate {
  readonly name: string;
  readonly pattern: WorkflowPatternId;
  readonly description: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
}

const FAN_OUT_AND_SYNTHESIZE_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Split the task and synthesize the results.";
  const angles = ["scope", "evidence", "risks", "recommendation"];
  const results = await wf.parallel(
    angles.map((angle) => () => wf.runAgent({
      name: "fanout-" + angle,
      prompt: "Analyze the request from the " + angle + " angle. Return concise, evidence-backed findings.\\n" + request,
      readOnly: true,
      modelHint: angle === "risks" ? "deep" : "balanced"
    })),
    { concurrency: 4 }
  );
  return await wf.synthesize({
    inputs: results.filter((result) => result !== null).map((result) => result.finalText),
    rubric: "Merge the independent findings into one deduplicated answer with clear conclusions."
  });
}
`.trim();

const ADVERSARIAL_VERIFICATION_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Review the target work.";
  return await wf.phase("adversarial-verification", async () => {
    const candidate = await wf.runAgent({
      name: "candidate-worker",
      prompt: "Produce the strongest answer for this request:\\n" + request,
      readOnly: true,
      modelHint: "deep"
    });
    if (candidate === null) return "candidate-worker did not complete";
    const verifier = await wf.runAgent({
      name: "adversarial-verifier",
      prompt: "Attack this answer against the request and list only evidence-backed concerns:\\n" + candidate.finalText,
      readOnly: true,
      evidenceRefs: ["task_id:" + candidate.taskId],
      modelHint: "deep"
    });
    return await wf.synthesize({
      inputs: [candidate.finalText, verifier === null ? "(verification did not complete)" : verifier.finalText],
      rubric: "Return the final answer plus any verified fixes or caveats."
    });
  });
}
`.trim();

const TOURNAMENT_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Find the best option.";
  const approaches = ["conservative", "creative", "risk-focused"];
  const entries = await wf.parallel(
    approaches.map((approach) => () => wf.runAgent({
      name: "contestant-" + approach,
      prompt: "Solve using a " + approach + " approach:\\n" + request,
      readOnly: true,
      modelHint: approach === "risk-focused" ? "deep" : "balanced"
    })),
    { concurrency: 3 }
  );
  return await wf.synthesize({
    inputs: entries.filter((entry) => entry !== null).map((entry) => entry.finalText),
    rubric: "Judge pairwise, explain tradeoffs, and pick the top result."
  });
}
`.trim();

const LOOP_UNTIL_DONE_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Investigate until no new findings remain.";
  const findings = [];
  for (let round = 1; round <= 3; round += 1) {
    const result = await wf.runAgent({
      name: "round-" + round,
      prompt: "Round " + round + ": continue the investigation. Stop with NO_NEW_FINDINGS if exhausted.\\n" + request,
      readOnly: true,
      modelHint: "balanced",
      evidenceRefs: findings.map((item) => "task_id:" + item.taskId)
    });
    if (result === null) break;
    findings.push(result);
    if (/NO_NEW_FINDINGS/i.test(result.finalText)) break;
  }
  return await wf.synthesize({
    inputs: findings.map((finding) => finding.finalText),
    rubric: "Deduplicate findings and clearly state whether more work remains."
  });
}
`.trim();

const GENERATE_AND_FILTER_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Generate options and filter them.";
  const generated = await wf.parallel(
    [1, 2, 3, 4].map((n) => () => wf.runAgent({
      name: "generator-" + n,
      prompt: "Generate distinct candidates for:\\n" + request,
      readOnly: true,
      modelHint: "balanced"
    })),
    { concurrency: 4 }
  );
  const filtered = await wf.runAgent({
    name: "filter",
    prompt: "Filter, dedupe, and rank these candidates against the request:\\n" + JSON.stringify(generated.filter((g) => g !== null)),
    readOnly: true,
    modelHint: "deep"
  });
  if (filtered === null) return "filter step did not complete";
  return await wf.synthesize({
    inputs: [filtered.finalText],
    rubric: "Return only the strongest candidates with reasons."
  });
}
`.trim();

const CLASSIFY_AND_ACT_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Classify and route this task.";
  const classification = await wf.runAgent({
    name: "classifier",
    prompt: "Classify this request as research, verification, migration, triage, or creative:\\n" + request,
    readOnly: true,
    modelHint: "fast"
  });
  if (classification === null) return "classifier did not complete";
  const label = classification.finalText.toLowerCase();
  const action = label.includes("verification") ? "verify every claim" :
    label.includes("migration") ? "plan safe code changes without editing files" :
    label.includes("triage") ? "dedupe and prioritize" :
    "research and synthesize";
  const result = await wf.runAgent({
    name: "routed-worker",
    prompt: "Route: " + action + "\\nRequest:\\n" + request,
    readOnly: true,
    modelHint: label.includes("verification") ? "deep" : "balanced",
    evidenceRefs: ["task_id:" + classification.taskId]
  });
  return await wf.synthesize({
    inputs: [classification.finalText, result === null ? "(routed worker did not complete)" : result.finalText],
    rubric: "Explain the route and final result."
  });
}
`.trim();

function manifest(
  name: string,
  description: string,
  patterns: readonly WorkflowPatternId[],
  phases: readonly string[],
  maxAgents: number,
  readOnly: boolean,
): WorkflowScriptManifest {
  return validateWorkflowScriptManifest({
    name,
    description,
    phases,
    readOnly,
    maxAgents,
    maxConcurrency: Math.min(4, maxAgents),
    tokenBudget: 20000,
    mayUseWorktree: !readOnly,
    patterns,
  });
}

const TEMPLATES: readonly WorkflowPatternTemplate[] = [
  {
    name: 'fan-out-and-synthesize',
    pattern: 'fan-out-and-synthesize',
    description: getCollaborationPatternDefinition('fan-out-and-synthesize').purpose,
    manifest: manifest(
      'fan-out-and-synthesize-template',
      'Parallel workers followed by a synthesis barrier.',
      ['fan-out-and-synthesize'],
      ['fan-out', 'synthesize'],
      5,
      true,
    ),
    source: FAN_OUT_AND_SYNTHESIZE_SOURCE,
  },
  {
    name: 'adversarial-verification',
    pattern: 'adversarial-verification',
    description: getCollaborationPatternDefinition('adversarial-verification').purpose,
    manifest: manifest(
      'adversarial-verification-template',
      'Candidate worker plus adversarial verifier.',
      ['adversarial-verification'],
      ['adversarial-verification', 'synthesize'],
      3,
      true,
    ),
    source: ADVERSARIAL_VERIFICATION_SOURCE,
  },
  {
    name: 'tournament',
    pattern: 'tournament',
    description: getCollaborationPatternDefinition('tournament').purpose,
    manifest: manifest(
      'tournament-template',
      'Competing agents judged by synthesis.',
      ['tournament'],
      ['contest', 'judge'],
      4,
      true,
    ),
    source: TOURNAMENT_SOURCE,
  },
  {
    name: 'loop-until-done',
    pattern: 'loop-until-done',
    description: getCollaborationPatternDefinition('loop-until-done').purpose,
    manifest: manifest(
      'loop-until-done-template',
      'Bounded investigation loop with a stop phrase.',
      ['loop-until-done'],
      ['iterate', 'synthesize'],
      4,
      true,
    ),
    source: LOOP_UNTIL_DONE_SOURCE,
  },
  {
    name: 'generate-and-filter',
    pattern: 'generate-and-filter',
    description: getCollaborationPatternDefinition('generate-and-filter').purpose,
    manifest: manifest(
      'generate-and-filter-template',
      'Parallel generators with a filter pass.',
      ['generate-and-filter', 'fan-out-and-synthesize'],
      ['generate', 'filter', 'synthesize'],
      6,
      true,
    ),
    source: GENERATE_AND_FILTER_SOURCE,
  },
  {
    name: 'classify-and-act',
    pattern: 'classify-and-act',
    description: getCollaborationPatternDefinition('classify-and-act').purpose,
    manifest: manifest(
      'classify-and-act-template',
      'Classifier-routed worker workflow.',
      ['classify-and-act'],
      ['classify', 'act', 'synthesize'],
      3,
      true,
    ),
    source: CLASSIFY_AND_ACT_SOURCE,
  },
];

export function listWorkflowPatternTemplates(): readonly WorkflowPatternTemplate[] {
  return TEMPLATES;
}

export function getWorkflowPatternTemplate(name: string): WorkflowPatternTemplate | undefined {
  return TEMPLATES.find((template) => template.name === name);
}

export function createWorkflowPatternTemplateModule(name: string): WorkflowModule {
  const template = getWorkflowPatternTemplate(name);
  if (!template) {
    throw new Error(`unknown workflow pattern template: ${name}`);
  }
  return createRestrictedWorkflowModule({
    manifest: template.manifest,
    source: template.source,
  });
}
