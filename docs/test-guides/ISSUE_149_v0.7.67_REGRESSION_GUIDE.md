# ISSUE_149 ACP Session Pollution - Regression Guide

## Overview

- **Issue**: ACP tests persist empty sessions into the real user store
- **Version**: v0.7.67 (release pending)
- **Date**: 2026-07-11
- **Priority**: High

The critical invariant is that ACP tests and handshake-only ACP sessions do not
write empty user sessions or Runtime evidence into the real user home.

## Safety Rules

- Do not run `--apply-session-cleanup` against the real user home during testing.
- Use the default preview against real data; test apply/archive behavior only
  with an isolated HOME/USERPROFILE fixture.
- Record counts before and after the ACP suites.

## Regression Cases

### RG-001: ACP suites create zero real-user placeholders

**Priority**: High

1. Run `npm run dev -- -s cleanup-acp` and record the strict candidate count.
2. Run:

   ```powershell
   npx vitest run tests/acp_server.test.ts src/acp_server.test.ts --maxWorkers=2
   ```

3. Run the preview command again.

Expected:

- [ ] Both ACP suites pass.
- [ ] Candidate count is unchanged.
- [ ] No session newer than the test start time matches the strict predicate.

### RG-002: New ACP session is provisional

**Priority**: High

1. Start an ACP server with isolated `homeDir` and `FileSessionStorage`.
2. Send `newSession` but no prompt.
3. Inspect the isolated sessions directory.
4. Send a valid text prompt and inspect again.

Expected:

- [ ] Step 2 creates no session JSONL file.
- [ ] Step 4 creates exactly one file.
- [ ] Its title is derived from the prompt, not `ACP Session`.
- [ ] `runtimeInfo.surface` equals `acp`.

### RG-003: Invalid prompt remains non-persistent

**Priority**: High
**Type**: Negative

1. Create an ACP protocol session in an isolated home.
2. Send an empty/resource-empty prompt rejected by validation.

Expected:

- [ ] The request fails with invalid params.
- [ ] No durable session is created.

### RG-004: Cleanup preview is strict and read-only

**Priority**: High

1. Run `npm run dev -- -s cleanup-acp` against a fixture containing:
   - one exact empty ACP placeholder;
   - one ACP session with a message;
   - one empty REPL session;
   - one empty ACP session with lineage or an artifact.
2. Compare files before and after.

Expected:

- [ ] Only the exact placeholder is reported.
- [ ] No file is moved or deleted.
- [ ] Output explicitly says Preview only.

### RG-005: Explicit cleanup archives reversibly

**Priority**: Medium

1. In the isolated fixture only, run:

   ```powershell
   npm run dev -- -s cleanup-acp --apply-session-cleanup
   ```

2. List active and archived sessions through the session SDK.
3. Unarchive the matched ID.

Expected:

- [ ] Only strict candidates move to the project `archived` directory.
- [ ] Session and island sidecar move together.
- [ ] The SDK can restore the session.
- [ ] No Runtime run evidence is deleted by this command.

## Summary

| Cases | Passed | Failed | Blocked |
|---:|---:|---:|---:|
| 5 |  |  |  |

**Conclusion**: _TBD_
