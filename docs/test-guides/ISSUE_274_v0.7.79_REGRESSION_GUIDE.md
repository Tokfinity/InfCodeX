# ISSUE_274 v0.7.79 Regression Guide

## Goal

Verify that unchanged A2A content no longer emits false hot-reload notices or
causes the associated root-TUI redraw, while explicit same-revision recovery
continues to work.

## Automated Coverage

Run:

```powershell
npx vitest run src/a2a/runtime-config.test.ts
```

Expected: all tests pass, including:

- unchanged revision produces no `hot-reloaded` event;
- changed revision produces one event;
- same-revision manual reload repairs a missing live registration;
- same-revision manual reload retries a temporary discovery failure.

## Manual Verification

1. Use an A2A v2 config with no enabled Agents and start the Ink REPL.
2. Leave `a2a.json` unchanged and cause harmless metadata/directory activity
   near `~/.kodax/integrations/`.
3. Confirm no `A2A configuration hot-reloaded` toast appears and the TUI does
   not pause for a notice redraw.
4. Make one real A2A content change and save. Confirm exactly one hot-reload
   notice appears and the live desired state updates.

## Pass Criteria

- File-watcher noise is silent for an identical content revision.
- Real content changes remain hot-reloadable.
- Explicit recovery does not require rewriting the file.
