export interface QueuedPromptSequenceOptions<TResult> {
  initialPrompt: string;
  runRound: (prompt: string) => Promise<TResult>;
  shiftPendingPrompt: () => string | undefined;
  onRoundComplete?: (result: TResult) => Promise<void> | void;
  onBeforeQueuedRound?: (prompt: string) => Promise<void> | void;
  shouldContinue?: (result: TResult) => boolean;
}

/**
 * FEATURE_149 Phase B3 (v0.7.38) — batch separator used to join queued
 * follow-up prompts into a single user message when draining ≥ 2 entries
 * after a round completes. The choice of `\n\n---\n\n` matches the
 * `popAllEditable` join used by `InkREPL.tsx`'s `onPopPendingInputs` so a
 * user who pulled the queue back into the editor and resubmitted sees the
 * same separator the LLM would have seen anyway.
 */
const BATCHED_PROMPT_SEPARATOR = "\n\n---\n\n";

export async function runQueuedPromptSequence<TResult>(
  options: QueuedPromptSequenceOptions<TResult>,
): Promise<TResult> {
  const {
    initialPrompt,
    runRound,
    shiftPendingPrompt,
    onRoundComplete,
    onBeforeQueuedRound,
    shouldContinue = () => true,
  } = options;

  let prompt = initialPrompt;
  let result = await runRound(prompt);

  while (true) {
    await onRoundComplete?.(result);

    if (!shouldContinue(result)) {
      return result;
    }

    // FEATURE_149 Phase B3 (v0.7.38) — drain ALL pending follow-ups into
    // a single batched prompt so N queued submits run as 1 agent
    // invocation (cost: -50~-90% input tokens; cohesion: LLM sees full
    // user intent rather than processing each in isolation). Empty
    // entries are filtered as they were in the legacy single-shift loop.
    const drained: string[] = [];
    while (true) {
      const next = shiftPendingPrompt();
      if (next === undefined) break;
      const trimmed = typeof next === "string" ? next.trim() : "";
      if (trimmed.length > 0) drained.push(trimmed);
    }

    if (drained.length === 0) {
      return result;
    }

    prompt = drained.length === 1 ? drained[0]! : drained.join(BATCHED_PROMPT_SEPARATOR);
    await onBeforeQueuedRound?.(prompt);
    result = await runRound(prompt);
  }
}
