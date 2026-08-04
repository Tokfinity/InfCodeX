const PROGRESS_CHECKPOINTS = new Map<number, string>([
  [
    12,
    [
      '[SEMANTIC PROGRESS CHECKPOINT 12]',
      'State the current primary hypothesis, concrete supporting evidence, and concrete disconfirming evidence before making another broad probe.',
      'If the original hypothesis has been contradicted, invalidate it now and revise or cancel the affected plan items. Do not search for another caller merely to preserve a disproven premise.',
      'Do not re-verify facts already established in this run unless the underlying code/state changed or new evidence directly conflicts with them.',
    ].join('\n'),
  ],
  [
    24,
    [
      '[SEMANTIC PROGRESS CHECKPOINT 24]',
      'Converge now: identify the evidence delta since checkpoint 12. If there is no material delta, pivot to a different falsifiable approach or conclude from the evidence already collected.',
      'Respect the requested deliverable. If the user asked for diagnosis/report only, answer it; do not silently upgrade the task into implementation and testing.',
      'Do not repeat repository inspection, fixture reading, git checks, or plan synchronization already completed in this run.',
    ].join('\n'),
  ],
  [
    40,
    [
      '[SEMANTIC PROGRESS CHECKPOINT 40]',
      'Stop broad exploratory probing. Produce the best evidence-backed conclusion or complete the already-authorized bounded change.',
      'If a concrete external dependency is genuinely required, state it precisely and ask for that input. Do not invent more scope, hypotheses, plan items, or verification rituals to keep the loop alive.',
    ].join('\n'),
  ],
]);

/** A one-shot reminder for the exact provider iteration checkpoint. */
export function buildManagedProgressGateReminder(iteration: number): string | undefined {
  return PROGRESS_CHECKPOINTS.get(iteration);
}
