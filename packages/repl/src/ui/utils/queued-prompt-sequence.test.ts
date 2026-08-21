import { describe, expect, it, vi } from "vitest";
import { runQueuedPromptSequence } from "./queued-prompt-sequence.js";

describe("runQueuedPromptSequence", () => {
  // FEATURE_149 Phase B3 (v0.7.38): drained prompts collapse into a SINGLE
  // batched round so N submits cost 1 agent invocation instead of N. The
  // join separator matches `popAllEditable`'s `\n\n---\n\n`.
  it("batches multiple queued prompts into a single round (FEATURE_149 B3)", async () => {
    const completed: string[] = [];
    const beforeQueued: string[] = [];
    const prompts = ["follow-up one", "follow-up two"];
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt: () => prompts.shift(),
      onRoundComplete: async (round) => {
        completed.push(round.prompt);
      },
      onBeforeQueuedRound: async (prompt) => {
        beforeQueued.push(prompt);
      },
      shouldContinue: (round) => !round.interrupted,
    });

    // Initial round + ONE batched round (not 2 separate rounds).
    expect(runRound).toHaveBeenCalledTimes(2);
    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "follow-up one\n\n---\n\nfollow-up two",
    ]);
    expect(result.prompt).toBe("follow-up one\n\n---\n\nfollow-up two");
    expect(completed).toEqual(["initial", "follow-up one\n\n---\n\nfollow-up two"]);
    expect(beforeQueued).toEqual(["follow-up one\n\n---\n\nfollow-up two"]);
  });

  it("uses the bare prompt (no separator) when only one item is drained", async () => {
    const prompts = ["solo"];
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt: () => prompts.shift(),
      shouldContinue: (round) => !round.interrupted,
    });

    expect(runRound).toHaveBeenCalledTimes(2);
    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual(["initial", "solo"]);
    expect(result.prompt).toBe("solo");
  });

  it("does not batch a host-owned Skill with a later Runtime prompt", async () => {
    const prompts = [
      { text: "/skill-a args", delivery: "host" as const },
      { text: "ordinary follow-up", delivery: "runtime" as const },
    ];
    const runRound = vi.fn(async (prompt: string) => ({ prompt }));

    await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      peekPendingPromptDelivery: () => prompts[0]?.delivery,
      shiftPendingPrompt: () => prompts.shift()?.text,
    });

    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "/skill-a args",
      "ordinary follow-up",
    ]);
  });

  it("executes consecutive host-owned Skills as separate queued rounds", async () => {
    const prompts = [
      { text: "/skill-a one", delivery: "host" as const },
      { text: "/skill-b two", delivery: "host" as const },
    ];
    const runRound = vi.fn(async (prompt: string) => ({ prompt }));

    await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      peekPendingPromptDelivery: () => prompts[0]?.delivery,
      shiftPendingPrompt: () => prompts.shift()?.text,
    });

    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "/skill-a one",
      "/skill-b two",
    ]);
  });

  it("stops before consuming queued prompts when the current round should not continue", async () => {
    const runRound = vi.fn(async (prompt: string) => ({
      prompt,
      interrupted: true,
    }));
    const shiftPendingPrompt = vi.fn(() => "queued");

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt,
      shouldContinue: (round) => !round.interrupted,
    });

    expect(result.prompt).toBe("initial");
    expect(shiftPendingPrompt).not.toHaveBeenCalled();
  });

  it("can finish the current round without consuming queued prompts", async () => {
    const runRound = vi.fn(async (prompt: string) => ({
      prompt,
      interrupted: false,
    }));
    const shiftPendingPrompt = vi.fn(() => "stale queued prompt");

    const result = await runQueuedPromptSequence({
      initialPrompt: "fresh prompt",
      runRound,
      shiftPendingPrompt,
      shouldDrainQueuedPrompts: () => false,
    });

    expect(result.prompt).toBe("fresh prompt");
    expect(runRound).toHaveBeenCalledOnce();
    expect(shiftPendingPrompt).not.toHaveBeenCalled();
  });

  it("skips blank entries while batching the rest into a single round", async () => {
    const prompts = ["   ", "", "follow-up A", "  ", "follow-up B"];
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt: () => prompts.shift(),
      shouldContinue: (round) => !round.interrupted,
    });

    // Whitespace-only entries are filtered; A and B are batched together.
    expect(runRound).toHaveBeenCalledTimes(2);
    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "follow-up A\n\n---\n\nfollow-up B",
    ]);
    expect(result.prompt).toBe("follow-up A\n\n---\n\nfollow-up B");
  });

  it("returns initial result when the pending queue is empty after the first round", async () => {
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));
    const shiftPendingPrompt = vi.fn(() => undefined);

    const result = await runQueuedPromptSequence({
      initialPrompt: "lone",
      runRound,
      shiftPendingPrompt,
      shouldContinue: (round) => !round.interrupted,
    });

    expect(runRound).toHaveBeenCalledTimes(1);
    expect(result.prompt).toBe("lone");
  });
});
