# Issue 205 v0.7.75 Regression Guide

## Scope

Verify that packaged KodaX Space using the exact
`@kodax-ai/kodax@0.7.75` release-candidate tarball does not flash visible
`cmd`, PowerShell, or `conhost` windows for Runtime background subprocesses on
Windows 10 and Windows 11, while explicit terminal, PTY, and editor behavior
remains interactive.

This product-level validation is non-blocking. Its status does not gate package
build, tagging, or npm publication.

## Test Record

| Field | Value |
|---|---|
| Tester | |
| Test date | |
| KodaX commit | |
| Tarball filename | |
| Tarball SHA-256 | |
| KodaX Space version/commit | |
| Windows 10 edition/build | |
| Windows 11 edition/build | |

## Preconditions

- Build KodaX from the v0.7.75 release-candidate workspace.
- Run `npm pack` and record the exact tarball filename and SHA-256.
- Install that tarball into a packaged KodaX Space build; do not use an npm
  link or an unpackaged development Electron process for the product-level run.
- Use a disposable workspace and KodaX profile with no unrelated background
  shells running.
- Keep Windows Task Manager or Process Explorer available to identify any
  unexpected console owner.
- Configure at least one normal provider path used by Space. Exercise CLI/ACP
  and LSP variants when those integrations are available in the test profile.

## TC-001: Package provenance and Runtime Worker

**Priority**: High
**Type**: Release integrity

1. Inspect the installed KodaX package in the packaged Space build.
2. Confirm its `package.json` version is `0.7.75`.
3. Confirm `dist/runtime-worker.js` exists.
4. Confirm its tarball SHA-256 matches the value recorded above.

Expected:

- [ ] Space loads the exact locally generated v0.7.75 tarball.
- [ ] The Runtime Worker and required sidecars are present.
- [ ] No fallback to a globally linked or previously cached SDK occurs.

Actual result:

Pass/Fail:

## TC-002: Windows 10 ordinary-query loop

**Priority**: High
**Type**: Product regression

1. Start packaged KodaX Space on the recorded Windows 10 build.
2. Open the disposable Coder workspace.
3. Submit 20 ordinary non-terminal queries in the same Session. Use prompts
   that require normal repository reading or explanation but do not request a
   shell command.
4. Observe the desktop throughout every query, especially query startup.
5. Record any visible console, its title, owner process, query number, and
   approximate timestamp.

Expected:

- [ ] All 20 queries complete successfully.
- [ ] No visible `cmd`, PowerShell, or `conhost` window flashes.
- [ ] Memory/Git metadata activity does not create a visible console.
- [ ] Space remains responsive and reports the normal Runtime result.

Actual result:

Pass/Fail:

## TC-003: Windows 11 ordinary-query loop

**Priority**: High
**Type**: Compatibility regression

Repeat TC-002 on the recorded Windows 11 build with the same tarball and
equivalent Space configuration.

Expected:

- [ ] All 20 queries complete successfully.
- [ ] No visible `cmd`, PowerShell, or `conhost` window flashes.
- [ ] The result is consistent with Windows 10.

Actual result:

Pass/Fail:

## TC-004: Background integration paths

**Priority**: High
**Type**: Integration regression

Where supported by the test profile, trigger each path from packaged Space:

1. Provider CLI installation check and one provider CLI request.
2. ACP server startup and one ACP-backed request.
3. LSP acquisition/startup and one language-aware query.
4. Memory initialization/maintenance and Git remote metadata lookup.
5. Clipboard-image, review, worktree, extension-command, checkpoint, and
   sandbox helpers that are available through normal product flows.

Expected:

- [ ] No background path creates a visible console window.
- [ ] Each exercised integration still returns its normal result or a visible,
  actionable error.
- [ ] No error is silently swallowed.

Actual result:

Pass/Fail:

## TC-005: Interactive-process boundary

**Priority**: High
**Type**: Non-regression

1. Open an explicit terminal flow from Space.
2. Run an interactive PTY command.
3. Open an external editor when that integration is enabled.

Expected:

- [ ] Explicit terminal and PTY sessions remain visible and interactive.
- [ ] Keyboard input, stdout, stderr, exit status, resize, and cancellation
  behave normally.
- [ ] The external editor opens normally.
- [ ] Background console suppression does not hide an explicitly requested
  interactive process.

Actual result:

Pass/Fail:

## TC-006: Packaged Electron SDK boundary

**Priority**: Medium
**Type**: Automated-host confirmation

From the KodaX repository on Windows, after `npm run build`, execute:

```bash
npm run test:electron-daemon:built
```

Expected:

- [ ] The packaged Electron smoke completes 20 ordinary queries.
- [ ] Every query observes the expected Git probes.
- [ ] The Win32 probe reports no visible console window.
- [ ] Daemon and temporary profile cleanup completes.

Actual result:

Pass/Fail:

## Failure Capture

For every failure, record:

- operating-system build and Space build;
- tarball SHA-256 and KodaX commit;
- test case and query number;
- timestamp, screenshot/video, console title, and owner PID/process tree;
- provider/runtime mode and whether the path was background or explicitly
  interactive;
- relevant Space, Runtime daemon, and KodaX logs.

Do not treat mocked option assertions or the generic packaged Electron smoke
alone as product-level validation.

## Summary

| Test case | Windows 10 | Windows 11 | Notes |
|---|---|---|---|
| TC-001 Package provenance | | | |
| TC-002 Ordinary queries | | N/A | |
| TC-003 Ordinary queries | N/A | | |
| TC-004 Background integrations | | | |
| TC-005 Interactive boundary | | | |
| TC-006 Packaged Electron | | | |

Final conclusion:

Product validation result: [ ] Pending / [ ] Passed / [ ] Failed
