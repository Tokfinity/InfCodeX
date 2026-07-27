# Issue 217 v0.7.77 Regression Guide

## Scope

Verify the CLI bridge keeps generated ACP conversation IDs separate from
native Codex/Gemini CLI resume IDs, prevents stateless calls from sharing a
global session, releases one-shot mappings, and reports native process
failures.

## Native Session Binding

1. Create a pseudo-ACP session and submit its first prompt.
2. Verify the backing executor receives no `sessionId`, so Codex uses a fresh
   `exec` turn and Gemini uses a fresh `-p` turn.
3. Emit `session_start` with a native CLI session ID.
4. Submit a second prompt to the same ACP session and verify only that reported
   native ID is passed to the executor.
5. Repeat two turns in a second ACP session and verify it binds and resumes a
   different native ID.

## Stateless Isolation And Cleanup

1. Call `KodaXAcpProvider.stream()` twice without
   `KodaXProviderStreamOptions.sessionId`.
2. Verify two independent ACP sessions are created and released.
3. Repeat twice with explicit conversation A and B. Verify each conversation
   reuses its own ACP session and never the other's.
4. Release a pseudo-ACP session and verify a later prompt cannot resume its
   removed native mapping.
5. Start two stateless calls during first connection and verify both await one
   connection, then receive distinct ACP sessions.
6. Start two concurrent prompts for one explicit conversation and verify the
   second fails visibly instead of overwriting the first stream.

## Transport Lifecycle

1. Force the initial ACP handshake to fail, retry, and verify the replacement
   client receives newly created input/output streams.
2. Connect successfully, call `disconnect()`, reconnect, and verify the closed
   pseudo transport is not reused.
3. Abort a connected pseudo transport while its internal reader and writer
   hold the stream locks. Verify the pending client read and later client write
   both terminate instead of leaving the background loop alive.
4. Disconnect while the ACP handshake is still pending and verify its process
   or in-memory transport closes immediately. Then close a previously connected
   transport during a request and verify the next Runtime retry creates a new
   client and ACP session.

## Process Failure

1. Run the shared CLI executor against a fixture process that exits with a
   non-zero code and diagnostic stderr.
2. Verify the generator rejects with the exit code rather than completing with
   an empty successful turn.
3. Verify pseudo-ACP returns a JSON-RPC failure and `AcpClient.prompt()` rejects
   instead of returning normal `end_turn`.
4. Repeat with normalized CLI `error` and failed `complete` events even when
   the child process exits zero.
5. Verify an already-aborted request is rejected before dispatch and an
   in-flight aborted process remains cancellation, not a false provider
   failure.
6. Emit a successful CLI `complete` event and then fail the executor with a
   non-zero exit. Verify the pseudo bridge drains the generator and the ACP
   prompt rejects rather than returning the earlier success.
7. End a zero-exit CLI stream without any `complete` event and verify it is not
   accepted as an empty successful turn.
8. Abort once with the default `AbortError` and verify it remains user
   cancellation. Abort again with a hard/idle timeout `Error` as the signal
   reason; verify both a rejected ACP prompt and a resolved
   `stopReason: cancelled` response propagate that exact failure to Runtime.
9. Emit a successful `complete` event but leave the CLI process and stdout
   open. Advance the configured executor timeout and verify the process tree is
   terminated and the prompt rejects with the deadline instead of hanging.
10. Leave a native ACP `prompt()` unresolved and ignore its cancel request.
    Abort the caller signal and verify `AcpClient.prompt()` rejects promptly
    with that exact reason while a late server rejection remains observed.

## Commands

```bash
npx vitest run \
  packages/llm/src/cli-events/executor.test.ts \
  packages/llm/src/cli-events/acp-client.test.ts \
  packages/llm/src/cli-events/pseudo-acp-server.test.ts \
  packages/llm/src/providers/acp-base.test.ts \
  packages/llm/src/providers/cli-bridge-providers.test.ts \
  packages/llm/src/cli-events/codex-parser.test.ts \
  packages/llm/src/cli-events/gemini-parser.test.ts
```
