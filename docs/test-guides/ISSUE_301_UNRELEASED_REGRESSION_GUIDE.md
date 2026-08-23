# Issue 301 / Unreleased Lock, Terminal, Skill, and Runtime Recovery Guide

> Release/version assignment is owned by the maintainer. This Unreleased guide
> neither prepares nor publishes a new package version.

## Scope

Verify that KodaX automatically recovers stale invalid learning locks, always
returns an interactive terminal from fullscreen mouse mode, preserves exact
explicit-Skill identity and hook policy, and prevents stale Runtime observations
after terminal persistence failure. Run destructive lock fixtures only under an
isolated temporary `KODAX_CONFIG_HOME`; never alter a real user's live lock
files.

## Automated gates

Run:

```text
npx vitest run packages/agent/src/learning/store-lock.test.ts packages/agent/src/learning/learning.test.ts
npx vitest run packages/agent/src/memory-control/review-inbox.test.ts
npx vitest run packages/repl/src/tui/components/AlternateScreen.test.tsx packages/repl/src/tui/core/termio.test.ts packages/repl/src/tui/core/engine.test.ts
npx vitest run packages/repl/src/interactive/invocation-runtime.test.ts packages/repl/src/interactive/user-skill-invocation.test.ts packages/coding/src/skill-invocation-policy.test.ts packages/coding/src/agent-runtime/run-substrate.capacity-accounting.test.ts
npx vitest run packages/agent/src/runtime/windows-effect-job.test.ts src/sandbox-runtime.test.ts src/runtime-daemon/exit-settlement.test.ts src/sdk-runtime.test.ts
```

Required assertions:

1. A 60-second-old zero-byte lock is reclaimed through
   `withLearningFileLock()` and the operation completes.
2. A stale non-empty malformed or truncated lock is reclaimed only after an
   unchanged bytes/mtime/size comparison; valid live owners are never stolen.
3. A competing successor cannot be removed after the stale snapshot changes.
4. Normal React unmount and the renderer-ordered final process-exit fallback
   each emit the same mouse-disable plus alternate-screen-exit sequence exactly
   once, after any renderer final frame.
5. If final rendering throws during renderer unmount, terminal restoration is
   still written synchronously before the original error propagates.
6. Sequential and concurrent renderers emit one exit sequence, never render a
   frame after it, and retain cleanup when the enter write reports backpressure.
7. Same-boot `unconfirmed-owner` ACL tickets remain fenced while the sandbox SID
   is active and clear automatically after the exact SID probe reports idle.
8. Canonical history retains the exact slash query; multiple Skill references
   produce one user-visible rejection; failed/malformed `PreToolUse` hooks deny.
9. Terminal status persistence failure yields `unknown`; a doubly fenced event
   journal invalidates active Session observations for resnapshot.
10. Delayed text cleanup retains its consumed attestation and converges after a
    transient workspace cleanup or policy-reset failure without replay.

## Manual test cases

### TC-001: stale empty lock recovers without a five-minute stall

**Priority**: High
**Type**: 正向测试

**前置条件**: Use an isolated temporary config home and a fixture that creates
the target authority lock as zero bytes with an mtime at least 60 seconds old.

**测试步骤**:
1. Start the same review/learning operation that owns the fixture lock.
2. Observe the first lock acquisition and subsequent task progress.

**预期效果**:
- [ ] The stale file is reclaimed automatically.
- [ ] The operation advances in under one second on a local disk.
- [ ] No manual deletion prompt or persistent recovery marker is created.

### TC-002: stale malformed ownership recovers without stealing successors

**优先级**: High
**类型**: 负向测试

**前置条件**: In the isolated config home, create stale fixtures containing
`corrupt owner` and a truncated structured owner record.

**测试步骤**:
1. Start a lock-protected learning operation.
2. Confirm each operation reclaims the unchanged stale fixture.
3. Replace one observed fixture before cleanup and let acquisition retry.

**预期效果**:
- [ ] Both unchanged malformed fixtures recover automatically.
- [ ] KodaX does not remove the replacement/successor record.
- [ ] A valid live owner remains protected.

### TC-003: 30-second stale boundary is respected

**优先级**: High
**类型**: 边界测试

**前置条件**: Prepare otherwise identical zero-byte locks aged 29 seconds and
31 seconds.

**测试步骤**:
1. Attempt acquisition against the 29-second fixture.
2. Attempt acquisition against the 31-second fixture.

**预期效果**:
- [ ] The 29-second fixture is not reclaimed.
- [ ] The 31-second fixture is reclaimed only if its stat and bytes remain
  unchanged through removal.

### TC-004: orderly early exit restores the terminal

**优先级**: High
**类型**: UI测试

**前置条件**: Windows Terminal with PowerShell; KodaX fullscreen mode enabled.

**测试步骤**:
1. Start KodaX and confirm mouse selection/click handling is active in the TUI.
2. Exercise both `/exit` and the test harness's renderer-ordered process-exit
   fallback.
3. Repeat with the harness configured to throw during the renderer's final
   frame.
4. At the PowerShell prompt, click several terminal locations and select text.

**预期效果**:
- [ ] The alternate screen closes and the normal PowerShell buffer returns.
- [ ] Clicks do not print SGR sequences such as `[<...M`.
- [ ] Text selection behaves normally.

### TC-005: recovery remains bounded under repeated acquisition

**优先级**: Medium
**类型**: 性能测试

**前置条件**: Ten isolated stale zero-byte fixtures on a local disk.

**测试步骤**:
1. Acquire and release each lock sequentially.
2. Record total elapsed time and inspect queue directories.

**预期效果**:
- [ ] No acquisition consumes the five-minute Memory authority timeout.
- [ ] Queue tickets and owner locks are removed after completion.

### TC-006: live-owner and successor identity remain protected

**优先级**: High
**类型**: 安全测试

**前置条件**: Use the existing live-owner and successor-replacement fixtures.

**测试步骤**:
1. Hold a valid lock with the current PID beyond the stale threshold.
2. Race two reclaimers against a stale empty fixture and then publish a
   successor owner before deletion.

**预期效果**:
- [ ] The valid live lock is never reclaimed.
- [ ] Neither reclaimer removes the successor lock.
- [ ] At most one protected operation runs at a time.

### TC-007: terminal restore is portable

**优先级**: Medium
**类型**: 兼容性测试

**前置条件**: Windows Terminal/PowerShell and one POSIX terminal supported by
the release matrix.

**测试步骤**:
1. Repeat TC-004 on each terminal.
2. Repeat with mouse tracking disabled by host policy.

**预期效果**:
- [ ] Enabled mouse tracking is disabled on exit on both platforms.
- [ ] A host with mouse tracking disabled receives no mouse-mode toggles.
- [ ] No duplicate visible escape output is produced.

### TC-008: same-boot ACL poison recovers automatically

**优先级**: High
**类型**: Windows recovery

1. Seed a stale same-boot `unconfirmed-owner` ticket with no Job evidence.
2. Report the sandbox SID active and attempt one sandboxed command.
3. Report the SID idle and retry.

**预期效果**:
- [ ] The first attempt stays fenced and preserves the ticket.
- [ ] The retry clears the ticket and runs without manual file deletion.
- [ ] A probe error emits a warning and schedules automatic retry.

### TC-009: explicit Skill identity remains user-authored

**优先级**: High
**类型**: Transcript / policy

1. Submit `/writing-great-skills 请检查刚刚写的技能`.
2. Inspect the provider prompt and canonical transcript separately.
3. In both Classic and Ink, submit `/first-skill one /second-skill two` and
   `/skill:first-skill one /second-skill two`.
4. Inject malformed/failing `PreToolUse` hooks.

**预期效果**:
- [ ] The provider receives expanded Skill context exactly once.
- [ ] History/title contain the exact slash query, never generated
  `User request: the active Skill ...` text.
- [ ] Both leading-slash multi-Skill forms are rejected visibly before either
  Skill executes; both failing hook shapes are also denied.

### TC-010: terminal persistence uncertainty invalidates stale observers

**优先级**: High
**类型**: Runtime durability

1. Observe a Session with an active Run.
2. Inject terminal status-write failure with a healthy event journal.
3. Repeat while the event journal is already fenced.

**预期效果**:
- [ ] The first Run publishes durable `run.updated` with `phase:'unknown'`.
- [ ] The second Run resolves `unknown` and the observation invalidates with
  `delivery_failed`.
- [ ] `runs.get()` stays `unknown` and the Session execution fence stays closed.

### TC-011: delayed text cleanup survives partial failure

**优先级**: High
**类型**: Windows recovery

1. Start a sandboxed text read and inject an initially unconfirmed Windows Job
   drain so cleanup moves to the automatic retry path.
2. Allow the drain to settle, then fail the first workspace cleanup response
   after the broker attestation has been read.
3. Allow the next cleanup response and reacquire the host filesystem lease.

**预期效果**:
- [ ] Workspace cleanup is retried and succeeds without rerunning the text read.
- [ ] The consumed attestation is retained; no false missing-attestation error
  appears on the retry.
- [ ] The workspace owner and filesystem lease are released automatically.

## Test summary

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 11 | - | - | - |

**测试结论**: [待填写]
**发现的问题**: [如有问题请在此记录]

*测试指导生成时间: 2026-08-23*
*Issue ID: 301*
