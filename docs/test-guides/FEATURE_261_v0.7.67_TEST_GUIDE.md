# FEATURE_261 Searchable Session Resume - Human Test Guide

## Overview

- **Feature**: Searchable Session Resume TUI + Session Listing Pagination
- **Version**: v0.7.67 (release pending)
- **Date**: 2026-07-11
- **Tester**: _TBD_

This guide verifies the new bare `-r` picker, legacy list improvements, direct
resume compatibility, and SDK surface/cursor pagination.

## Environment

- Node.js 20 or 22
- A terminal with raw-mode support (Windows Terminal / PowerShell recommended)
- At least 12 non-empty sessions in the current repository for paging coverage
- A clean build: `npm run build:packages`

## Test Cases

### TC-001: Bare `-r` opens the searchable picker

**Priority**: High
**Type**: Positive / UI

1. Run `npm run dev -- -r`.
2. Observe the initial picker.
3. Type a word that exists in an older session title.
4. Clear characters with Backspace.

Expected:

- [ ] The CLI does not auto-resume the newest session.
- [ ] The picker shows Search, navigation, paging, completion, resume, and cancel hints.
- [ ] Results filter after every keystroke without requiring Enter.
- [ ] Search matches title, session ID, surface, timestamp, and message count.
- [ ] The full ID of the currently selected result is visible.

### TC-002: Keyboard navigation, completion, and paging

**Priority**: High
**Type**: UI / Boundary

1. Use Up/Down to move the highlighted row.
2. Use PageDown and PageUp across at least two pages.
3. Press End, then Home.
4. Select a result and press Tab.
5. Press Enter.

Expected:

- [ ] Selection always stays inside the visible page.
- [ ] Page indicator changes correctly.
- [ ] Home/End jump to first/last filtered result.
- [ ] Tab completes the search field with the selected title.
- [ ] Enter resumes exactly the highlighted session.

### TC-003: Cancel is non-destructive

**Priority**: High
**Type**: Negative

1. Run `npm run dev -- -r`.
2. Press Escape; repeat with Ctrl+C.

Expected:

- [ ] The picker exits cleanly with `Session resume cancelled.`
- [ ] No new session is created.
- [ ] No existing session is changed or archived.

### TC-004: Direct ID/title resume and duplicate-title disambiguation

**Priority**: High
**Type**: Compatibility

1. Copy a valid session ID from `npm run dev -- -s list`.
2. Run `npm run dev -- -r <SESSION_ID>`.
3. Run `npm run dev -- -r "<UNIQUE_EXACT_TITLE>"`.
4. Create or identify two non-empty sessions with the same title, then resume
   using that title.
5. Exit, then run `npm run dev -- -c`.

Expected:

- [ ] `-r <id>` bypasses the picker and resumes that ID.
- [ ] A unique title resolves case-insensitively and bypasses the picker.
- [ ] A partial title does not count as a direct match.
- [ ] Duplicate titles open a picker containing only the matching sessions.
- [ ] The duplicate picker exposes the full selected ID, time, and surface.
- [ ] `-c` keeps its existing most-recent-session behavior.

### TC-005: Legacy list remains useful with large history

**Priority**: Medium
**Type**: Positive / Boundary

1. Run `npm run dev -- -s list` in a repository with more than 50 sessions.

Expected:

- [ ] Up to 50 non-empty sessions are printed.
- [ ] Empty ACP placeholders do not consume the visible rows.
- [ ] A remaining-count hint points to `kodax -r` for search and paging.

### TC-006: SDK surface filter and opaque cursor

**Priority**: High
**Type**: API / Compatibility

1. Create at least three `surface: 'acp'` sessions and one `surface: 'repl'`
   session in an isolated Runtime home.
2. Call `runtime.sessions.list({ surface: 'acp', limit: 2 })`.
3. Pass the last item's `cursor` to a second list call.
4. Repeat through Daemon mode.

Expected:

- [ ] Every result has `surface === 'acp'`.
- [ ] Pages do not overlap and collectively return all three ACP sessions.
- [ ] Cursor is treated as opaque.
- [ ] Embedded and Daemon results agree.

## Summary

| Cases | Passed | Failed | Blocked |
|---:|---:|---:|---:|
| 6 |  |  |  |

**Conclusion**: _TBD_
