/**
 * v0.7.41 — SharedSpinnerClock ref-counted lifecycle.
 *
 * Verifies that `<Spinner>` and `<SpinnerStatsTail>` (the two consumers
 * of `useSharedSpinnerTick`) share a SINGLE module-level setInterval:
 *
 *   - N mounted consumers → 1 timer running
 *   - 0 mounted consumers → timer stopped (no idle work)
 *   - mount/unmount cycles correctly increment/decrement the listener
 *     count via React's effect-cleanup contract
 *
 * Without this guarantee, every spinner-row component would carry its
 * own timer (the original v0.7.41 mistake), producing N stdout writes
 * per 80ms cycle and observable glyph/stats drift on Windows ConPTY.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

import {
  Spinner,
  SpinnerStatsTail,
  _peekSharedSpinnerListenerCount,
  _peekSharedSpinnerTimerActive,
} from "./LoadingIndicator.js";

afterEach(() => {
  // Reset to a known-good baseline between tests — render() unmount
  // already runs cleanup, but a defensive check guards against test
  // ordering bugs.
  expect(_peekSharedSpinnerListenerCount()).toBe(0);
  expect(_peekSharedSpinnerTimerActive()).toBe(false);
});

describe("SharedSpinnerClock (v0.7.41) — ref-counted lifecycle", () => {
  it("starts with no listener and no timer", () => {
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
    expect(_peekSharedSpinnerTimerActive()).toBe(false);
  });

  it("one <Spinner> mount registers exactly one listener and starts the timer", () => {
    const handle = render(<Spinner />);
    expect(_peekSharedSpinnerListenerCount()).toBe(1);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);
    handle.unmount();
  });

  it("three concurrent <Spinner> mounts share ONE timer (the whole point)", () => {
    const handle = render(
      <>
        <Spinner />
        <Spinner />
        <Spinner />
      </>,
    );
    expect(_peekSharedSpinnerListenerCount()).toBe(3);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);
    handle.unmount();
  });

  it("<Spinner> + <SpinnerStatsTail> share the same timer (the whole point #2)", () => {
    const startedAt = Date.now();
    const handle = render(
      <>
        <Spinner />
        <SpinnerStatsTail roundStartedAt={startedAt} charCount={100} />
      </>,
    );
    // 2 consumers, 1 timer.
    expect(_peekSharedSpinnerListenerCount()).toBe(2);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);
    handle.unmount();
  });

  it("unmounting the last consumer stops the timer (no idle work)", () => {
    const handle = render(<Spinner />);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);
    handle.unmount();
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
    expect(_peekSharedSpinnerTimerActive()).toBe(false);
  });

  it("<SpinnerStatsTail> with roundStartedAt=null does NOT subscribe (short-circuit)", () => {
    const handle = render(
      <SpinnerStatsTail roundStartedAt={null} charCount={0} />,
    );
    // Inactive prop → useSharedSpinnerTick(false) → no subscribe call.
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
    expect(_peekSharedSpinnerTimerActive()).toBe(false);
    handle.unmount();
  });

  it("<SpinnerStatsTail> with roundStartedAt=null + sibling <Spinner> only counts the Spinner", () => {
    const handle = render(
      <>
        <Spinner />
        <SpinnerStatsTail roundStartedAt={null} charCount={0} />
      </>,
    );
    expect(_peekSharedSpinnerListenerCount()).toBe(1);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);
    handle.unmount();
  });

  it("partial unmount keeps the timer alive while remaining consumers exist", () => {
    const handleA = render(<Spinner />);
    const handleB = render(<Spinner />);
    expect(_peekSharedSpinnerListenerCount()).toBe(2);
    expect(_peekSharedSpinnerTimerActive()).toBe(true);

    handleA.unmount();
    expect(_peekSharedSpinnerListenerCount()).toBe(1);
    expect(_peekSharedSpinnerTimerActive()).toBe(true); // still running for handleB

    handleB.unmount();
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
    expect(_peekSharedSpinnerTimerActive()).toBe(false);
  });

  it("sibling spinners render the same glyph (proves shared tick, not independent timers)", () => {
    // Both spinners read the same `tick` value from `useSharedSpinnerTick`
    // because they subscribe to one shared listener-set. Their frame index
    // is `tick % 10` — identical for both. If they were on independent
    // setIntervals started at different absolute times, this invariant
    // would only hold by luck.
    const handle = render(
      <>
        <Spinner />
        <Spinner />
      </>,
    );
    const frame = handle.lastFrame();
    const brailles = (frame?.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu) ?? []) as string[];
    expect(brailles.length).toBe(2);
    expect(brailles[0]).toBe(brailles[1]);
    handle.unmount();
  });

  it("subscribe/unsubscribe is symmetric across rapid re-mounts (StrictMode safety)", () => {
    // Simulate the React 18 dev-mode pattern: mount → cleanup → re-mount.
    // Each subscribe returns a NEW listener closure; cleanup must remove
    // exactly that closure. After the cycle the count must converge to 1.
    const a = render(<Spinner />);
    expect(_peekSharedSpinnerListenerCount()).toBe(1);
    a.unmount();
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
    const b = render(<Spinner />);
    expect(_peekSharedSpinnerListenerCount()).toBe(1);
    b.unmount();
    expect(_peekSharedSpinnerListenerCount()).toBe(0);
  });
});
