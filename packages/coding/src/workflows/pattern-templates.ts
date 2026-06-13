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

export interface WorkflowPatternTemplate {
  readonly name: string;
  readonly pattern: WorkflowPatternId;
  readonly description: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
}

const ADVERSARIAL_VERIFICATION_SOURCE = `
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Review the target work.";
  return await wf.phase("adversarial-verification", async () => {
    const candidate = await wf.runAgent({
      name: "candidate-worker",
      prompt: "Produce the strongest answer for this request:\\n" + request,
      readOnly: false,
      isolation: "worktree",
      modelHint: "deep"
    });
    const verifier = await wf.runAgent({
      name: "adversarial-verifier",
      prompt: "Attack this answer against the request and list only evidence-backed concerns:\\n" + candidate.finalText,
      readOnly: true,
      evidenceRefs: ["task_id:" + candidate.taskId],
      modelHint: "deep"
    });
    return await wf.synthesize({
      inputs: [candidate, verifier],
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
    inputs: entries,
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
      evidenceRefs: findings.map((item) => "task_id:" + item.taskId)
    });
    findings.push(result);
    if (/NO_NEW_FINDINGS/i.test(result.finalText)) break;
  }
  return await wf.synthesize({
    inputs: findings,
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
    prompt: "Filter, dedupe, and rank these candidates against the request:\\n" + JSON.stringify(generated),
    readOnly: true,
    modelHint: "deep"
  });
  return await wf.synthesize({
    inputs: [filtered],
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
  const label = classification.finalText.toLowerCase();
  const action = label.includes("verification") ? "verify every claim" :
    label.includes("migration") ? "plan safe code changes" :
    label.includes("triage") ? "dedupe and prioritize" :
    "research and synthesize";
  const result = await wf.runAgent({
    name: "routed-worker",
    prompt: "Route: " + action + "\\nRequest:\\n" + request,
    readOnly: !label.includes("migration"),
    isolation: label.includes("migration") ? "worktree" : "shared-cwd",
    evidenceRefs: ["task_id:" + classification.taskId]
  });
  return await wf.synthesize({
    inputs: [classification, result],
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
): WorkflowScriptManifest {
  return validateWorkflowScriptManifest({
    name,
    description,
    phases,
    readOnly: false,
    maxAgents,
    maxConcurrency: Math.min(4, maxAgents),
    tokenBudget: 20000,
    mayUseWorktree: true,
    patterns,
  });
}

const TEMPLATES: readonly WorkflowPatternTemplate[] = [
  {
    name: 'adversarial-verification',
    pattern: 'adversarial-verification',
    description: 'Generate a candidate answer, then attack it with an independent verifier.',
    manifest: manifest(
      'adversarial-verification-template',
      'Candidate worker plus adversarial verifier.',
      ['adversarial-verification'],
      ['adversarial-verification', 'synthesize'],
      3,
    ),
    source: ADVERSARIAL_VERIFICATION_SOURCE,
  },
  {
    name: 'tournament',
    pattern: 'tournament',
    description: 'Run competing approaches and pick the best result.',
    manifest: manifest(
      'tournament-template',
      'Competing agents judged by synthesis.',
      ['tournament'],
      ['contest', 'judge'],
      4,
    ),
    source: TOURNAMENT_SOURCE,
  },
  {
    name: 'loop-until-done',
    pattern: 'loop-until-done',
    description: 'Repeat bounded investigation rounds until no new findings remain.',
    manifest: manifest(
      'loop-until-done-template',
      'Bounded investigation loop with a stop phrase.',
      ['loop-until-done'],
      ['iterate', 'synthesize'],
      4,
    ),
    source: LOOP_UNTIL_DONE_SOURCE,
  },
  {
    name: 'generate-and-filter',
    pattern: 'generate-and-filter',
    description: 'Generate several candidates, then dedupe and rank them.',
    manifest: manifest(
      'generate-and-filter-template',
      'Parallel generators with a filter pass.',
      ['generate-and-filter', 'fan-out-and-synthesize'],
      ['generate', 'filter', 'synthesize'],
      6,
    ),
    source: GENERATE_AND_FILTER_SOURCE,
  },
  {
    name: 'classify-and-act',
    pattern: 'classify-and-act',
    description: 'Classify the task, then route to the appropriate worker behavior.',
    manifest: manifest(
      'classify-and-act-template',
      'Classifier-routed worker workflow.',
      ['classify-and-act'],
      ['classify', 'act', 'synthesize'],
      3,
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
