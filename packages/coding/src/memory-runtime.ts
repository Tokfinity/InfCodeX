import {
  createMemoryControlPlane,
  type MemoryReviewTrigger,
} from '@kodax-ai/agent';

import { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import type { KodaXOptions } from './types.js';

const ENGLISH_FORGET_RE =
  /\b(forget|do not remember|don't remember|remove (?:this )?from memory|delete .{0,40}memory)\b/i;
const CHINESE_FORGET_RE =
  /(?:\u522b\u8bb0|\u4e0d\u8981\u8bb0\u4f4f|\u5fd8\u8bb0|\u5220\u9664.{0,12}\u8bb0\u5fc6|\u4e0d\u8981\u518d\u8bb0)/u;
const ENGLISH_REMEMBER_RE =
  /\b(remember this|please remember|save this to memory|add this to memory)\b/i;
const CHINESE_REMEMBER_RE =
  /(?:\u8bb0\u4f4f|\u4fdd\u5b58.{0,12}\u8bb0\u5fc6|\u52a0\u5165\u8bb0\u5fc6)/u;
const ENGLISH_MEMORY_ANCHOR_RE =
  /\b(memory|remembered|remember|stored|previously saved|memo(?:ry)? note)\b/i;
const ENGLISH_CORRECTION_MARKER_RE =
  /\b(wrong|incorrect|outdated|actually|correction|correcting|not .{1,80} but|instead|should be)\b/i;
const CHINESE_MEMORY_ANCHOR_RE =
  /(?:\u8bb0\u5fc6|\u8bb0\u4f4f\u7684|\u4e4b\u524d\u8bb0\u7684)/u;
const CHINESE_CORRECTION_MARKER_RE =
  /(?:\u4e0d\u662f.{0,24}\u800c\u662f|\u7ea0\u6b63|\u66f4\u6b63|\u5176\u5b9e|\u5e94\u8be5\u662f|\u4e0d\u5bf9)/u;

export async function maybeRunMemoryMaintenanceWindow(options: KodaXOptions): Promise<void> {
  if (isInternalAgentRun(options)) return;

  const cwd = resolveExecutionCwd(options.context);
  try {
    const result = await createMemoryControlPlane({
      cwd,
      projectDocs: [],
      discoverSkills: false,
    }).maybeRunAutoCurator();
    if (result.ran || result.skippedReason !== 'not_due') {
      emitResilienceDebug('[memory:maintenance]', {
        cwd,
        ran: result.ran,
        skippedReason: result.skippedReason ?? null,
        reportPath: result.reportPath ?? null,
        nextEligibleAt: result.nextEligibleAt ?? null,
      });
    }
  } catch (error) {
    emitResilienceDebug('[memory:maintenance:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function maybeReviewMemoryFeedbackFromPrompt(
  options: KodaXOptions,
  prompt: string,
): Promise<void> {
  if (isInternalAgentRun(options)) return;

  const reviewer = options.memoryReviewer;
  if (reviewer === undefined) return;

  const trigger = detectMemoryReviewTrigger(prompt);
  if (trigger === undefined) return;

  const cwd = resolveExecutionCwd(options.context);
  const task = options.context?.rawUserInput?.trim();
  try {
    const plan = await createMemoryControlPlane({
      cwd,
      projectDocs: [],
      discoverSkills: false,
      memoryReviewer: reviewer,
    }).reviewMemoryFeedback({
      trigger,
      userFeedback: prompt,
      ...(task !== undefined && task.length > 0 ? { task } : {}),
    });
    options.events?.onMemoryReview?.(plan);
    emitResilienceDebug('[memory:review]', {
      cwd,
      trigger,
      actions: plan.actions.length,
      candidates: plan.candidateRefs.map((candidate) => candidate.ref.id),
    });
  } catch (error) {
    emitResilienceDebug('[memory:review:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function detectMemoryReviewTrigger(prompt: string): MemoryReviewTrigger | undefined {
  const text = prompt.trim();
  if (text.length === 0) return undefined;
  if (ENGLISH_FORGET_RE.test(text) || CHINESE_FORGET_RE.test(text)) return 'explicit_forget';
  if (ENGLISH_REMEMBER_RE.test(text) || CHINESE_REMEMBER_RE.test(text)) return 'explicit_remember';
  if (isMemoryCorrection(text)) return 'user_correction';
  return undefined;
}

function isMemoryCorrection(text: string): boolean {
  return (ENGLISH_MEMORY_ANCHOR_RE.test(text) && ENGLISH_CORRECTION_MARKER_RE.test(text))
    || (CHINESE_MEMORY_ANCHOR_RE.test(text) && CHINESE_CORRECTION_MARKER_RE.test(text));
}

function isInternalAgentRun(options: KodaXOptions): boolean {
  return options.context?.currentAgentId !== undefined
    || options.context?.parentAgentId !== undefined;
}
