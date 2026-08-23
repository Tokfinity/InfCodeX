# Issue 301 / v0.7.95 Stale Empty Lock and Terminal Restore Regression Guide

## Scope

Verify that KodaX automatically recovers a stale zero-byte learning lock and
always returns an interactive terminal from fullscreen mouse mode on orderly
process exit. Run destructive lock fixtures only under an isolated temporary
`KODAX_CONFIG_HOME`; never alter a real user's live lock files.

## Automated gates

Run:

```text
npx vitest run packages/agent/src/learning/store-lock.test.ts packages/agent/src/learning/learning.test.ts
npx vitest run packages/agent/src/memory-control/review-inbox.test.ts
npx vitest run packages/repl/src/tui/components/AlternateScreen.test.tsx packages/repl/src/tui/core/termio.test.ts packages/repl/src/tui/core/engine.test.ts
```

Required assertions:

1. A 60-second-old zero-byte lock is reclaimed through
   `withLearningFileLock()` and the operation completes.
2. A non-empty malformed stale lock remains held until an operator-controlled
   test fixture releases it; valid live owners are never stolen.
3. A competing successor cannot be removed after the stale snapshot changes.
4. Normal React unmount and the renderer-ordered final process-exit fallback
   each emit the same mouse-disable plus alternate-screen-exit sequence exactly
   once, after any renderer final frame.
5. If final rendering throws during renderer unmount, terminal restoration is
   still written synchronously before the original error propagates.
6. Sequential and concurrent renderers emit one exit sequence, never render a
   frame after it, and retain cleanup when the enter write reports backpressure.

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

### TC-002: unverifiable non-empty ownership stays fail-closed

**优先级**: High  
**类型**: 负向测试

**前置条件**: In the isolated config home, create a stale lock containing
`corrupt owner`.

**测试步骤**:
1. Start a lock-protected learning operation.
2. Confirm it does not enter the protected section during the observation
   window.
3. Remove the fixture and allow the operation to continue.

**预期效果**:
- [ ] KodaX does not guess an owner or steal the non-empty malformed lock.
- [ ] Removing the isolated fixture lets the pending operation complete.

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

## Test summary

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 7 | - | - | - |

**测试结论**: [待填写]  
**发现的问题**: [如有问题请在此记录]

*测试指导生成时间: 2026-08-23*  
*Issue ID: 301*
