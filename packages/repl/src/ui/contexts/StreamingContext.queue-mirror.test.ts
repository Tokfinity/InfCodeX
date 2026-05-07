/**
 * FEATURE_115 v0.7.36 Phase 1B — pending-inputs ↔ MessageQueue mirror invariant.
 *
 * StreamingContext keeps `pendingInputs: string[]` as the canonical React
 * state for UI rendering and `MAX_PENDING_INPUTS` gating; every mutation
 * also resyncs the agent-side `MessageQueue` main-thread `user` priority
 * slice. The runner-driven mid-turn drain (Phase 1C) consumes from the
 * queue, so the two surfaces must stay in lockstep.
 */
import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from "@kodax/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStreamingManager } from "./StreamingContext.js";

function mainThreadUserContents(): string[] {
  return getMessageQueue()
    .peek({ maxPriority: "user" })
    .map((m) => m.content);
}

describe("StreamingContext pending-inputs ↔ MessageQueue mirror", () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it("addPendingInput enqueues to MessageQueue with priority='user' / agentId undefined", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("first follow-up");
    expect(mainThreadUserContents()).toEqual(["first follow-up"]);
  });

  it("multiple addPendingInput calls preserve insertion order in the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.addPendingInput("three");
    expect(mainThreadUserContents()).toEqual(["one", "two", "three"]);
  });

  it("removeLastPendingInput drops the tail item from the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.addPendingInput("three");
    mgr.removeLastPendingInput();
    expect(mainThreadUserContents()).toEqual(["one", "two"]);
  });

  it("shiftPendingInput drops the head item from the queue and returns it", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    const next = mgr.shiftPendingInput();
    expect(next).toBe("one");
    expect(mainThreadUserContents()).toEqual(["two"]);
  });

  it("clearPendingInputs empties the queue's main-thread user slice", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.clearPendingInputs();
    expect(mainThreadUserContents()).toEqual([]);
  });

  it("consumePendingInputs returns the React-state contents and empties the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    const consumed = mgr.consumePendingInputs();
    expect(consumed).toEqual(["one", "two"]);
    expect(mainThreadUserContents()).toEqual([]);
  });

  it("background-priority and subagent-scoped messages survive a sync pass", () => {
    // Out-of-band enqueues that the StreamingContext mirror must NOT
    // disturb when it resyncs the main-thread user slice.
    const queue = getMessageQueue();
    queue.enqueue({
      priority: "background",
      mode: "task-notification",
      content: "bg-keep",
    });
    queue.enqueue({
      priority: "user",
      mode: "prompt",
      content: "subagent-keep",
      agentId: "sub-1",
    });

    const mgr = createStreamingManager();
    mgr.addPendingInput("main-1");
    mgr.removeLastPendingInput();
    mgr.addPendingInput("main-2");

    // Main-thread slice reflects React state.
    expect(mainThreadUserContents()).toEqual(["main-2"]);
    // Background is untouched.
    expect(
      queue.peek({ maxPriority: "background" }).map((m) => m.content),
    ).toContain("bg-keep");
    // Sub-1 user-priority message is untouched.
    expect(
      queue.peek({ agentId: "sub-1", maxPriority: "user" }).map((m) => m.content),
    ).toEqual(["subagent-keep"]);
  });

  it("addPendingInput rejects empty trimmed input and does NOT touch the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("real");
    mgr.addPendingInput("   ");
    mgr.addPendingInput("");
    expect(mainThreadUserContents()).toEqual(["real"]);
  });

  it("addPendingInput respects MAX_PENDING_INPUTS gating", () => {
    const mgr = createStreamingManager();
    for (let i = 0; i < 10; i++) {
      mgr.addPendingInput(`m${i}`);
    }
    // MAX_PENDING_INPUTS is 5; React state caps; queue mirrors react state.
    expect(mainThreadUserContents()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});
