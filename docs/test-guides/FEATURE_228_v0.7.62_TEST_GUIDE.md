# FEATURE_228 Unified Memory Control Plane - Human Test Guide

## Overview

**Feature**: Unified Memory Control Plane + Memory Governance  
**Version**: v0.7.62  
**Date**: 2026-07-06  
**Tester**: TBD

FEATURE_228 turns FEATURE_224 memory handoffs into a governed memory control
plane. It must reuse the existing learning proposal store, expose typed memory
refs, require approval before mutation, fail closed on stale fingerprints, and
provide deterministic task-aware retrieval hints plus feedback-triggered
semantic review hooks.

## Environment

### Prerequisites

- Node.js 20 or newer.
- Dependencies installed with `npm install`.
- A clean or intentionally reviewed working tree.
- Use a temporary `KODAX_HOME` for manual runs to avoid polluting real memory:

```powershell
$env:KODAX_HOME = Join-Path $PWD ".agent/tmp/manual-f228"
```

### Automated Gate Before Manual Testing

Run these commands first:

```powershell
npx vitest run packages/agent/src/memory-control/memory-control.test.ts packages/agent/src/learning/learning.test.ts packages/repl/src/commands/memory-command.test.ts packages/repl/src/commands/learn-command.test.ts packages/repl/src/interactive/completers/argument-completer.test.ts packages/coding/src/prompts/memory-section.test.ts packages/coding/src/prompts/memory-rules.test.ts packages/coding/src/prompts/capability-sections.test.ts
npm run build -w @kodax-ai/agent
npm run build -w @kodax-ai/coding
npm run build -w @kodax-ai/repl
```

Expected result:

- [ ] All targeted tests pass.
- [ ] All three package builds pass.
- [ ] No unrelated files are required for the feature to work.

## Test Cases

### TC-001: Memory Inbox Reuses F224 Store

**Priority**: High
**Type**: Positive

Steps:

1. Start KodaX from the repository with `npm run dev`.
2. Create or use a pending FEATURE_224 `memdir_handoff` learning proposal.
3. Run `/learn pending`.
4. Run `/memory pending`.
5. Compare the proposal ids.

Expected result:

- [ ] `/learn pending` shows the global learning proposal.
- [ ] `/memory pending` shows the same memory proposal id with `memory:` prefix.
- [ ] No second memory-only store or divergent approval state is visible.

### TC-002: Show Preview Includes Read/Write Contract

**Priority**: High
**Type**: Positive

Steps:

1. Run `/memory show <memory-proposal-id>`.
2. Inspect the displayed action, target refs, changed paths, fingerprints, and preview.

Expected result:

- [ ] The action is `write_memdir` for memdir handoffs.
- [ ] The preview lists the target topic file and `MEMORY.md`.
- [ ] Fingerprints are shown or represented in the preview contract.
- [ ] The command does not write files.

### TC-003: Approval Writes Topic And Index Atomically

**Priority**: High
**Type**: Positive

Steps:

1. Capture the proposal preview from `/memory show <memory-proposal-id>`.
2. Run `/memory approve <memory-proposal-id>`.
3. Inspect the memory directory and the learning proposal status.

Expected result:

- [ ] A deterministic topic `.md` file is created under the memory directory.
- [ ] `MEMORY.md` receives an index line for that topic.
- [ ] The F224 learning proposal status becomes `approved`.
- [ ] The command reports changed paths.

### TC-004: Stale Fingerprints Fail Closed

**Priority**: High
**Type**: Negative

Steps:

1. Open a pending memory proposal preview.
2. Modify the target memory file or `MEMORY.md` before approval.
3. Attempt approval using the old preview contract.

Expected result:

- [ ] Approval is skipped.
- [ ] The proposal remains pending.
- [ ] Existing memory files are not overwritten.
- [ ] The user sees a stale fingerprint or changed-after-preview reason.

### TC-005: Reasoning Handoff Does Not Invent A Carrier

**Priority**: Medium  
**Type**: Positive

Steps:

1. Create or use a pending `reasoning_handoff` proposal.
2. Run `/memory pending`.
3. Run `/memory show <reasoning-memory-proposal-id>`.
4. Approve it.

Expected result:

- [ ] The proposal is visible in the memory inbox.
- [ ] The action is `no_op`.
- [ ] The preview explains that no stable reasoning-strategy carrier exists yet.
- [ ] Approval updates the same F224 proposal store without writing arbitrary files.

### TC-006: Curator Reports Governance Findings Without Mutation

**Priority**: High  
**Type**: Positive

Steps:

1. Prepare memory refs with at least one duplicate fingerprint, one conflicting title, and one orphaned related ref.
2. Run `/memory curate`.
3. Inspect files and proposal statuses afterward.

Expected result:

- [ ] The report includes duplicate, conflict, or orphaned findings when present.
- [ ] Stale and quarantined refs are reported when present.
- [ ] No memory file is changed by the curator.
- [ ] No proposal status is changed by the curator.

### TC-007: Retrieval Hints Are Deterministic And Bounded

**Priority**: High  
**Type**: Positive

Steps:

1. Create several approved memory topic files with frontmatter.
2. Trigger a coding prompt build for a task that mentions one topic title.
3. Repeat the same prompt build.

Expected result:

- [ ] A small governed memory hints block is included.
- [ ] The task-relevant memory pack is based on the current raw user request.
- [ ] Hints are sorted deterministically.
- [ ] Stale, pending, quarantined, private, and sensitive refs are not injected by default.
- [ ] Repeating the same input produces the same hint order.
- [ ] Topic file bodies are not injected unless the agent reads them on demand.

### TC-008: Large Memory Index Stays Bounded In Prompt

**Priority**: High
**Type**: Boundary

Steps:

1. Create a `MEMORY.md` with more than 60 index lines or more than 8KB of index text.
2. Trigger a coding prompt build.
3. Inspect the `project-memory` section.

Expected result:

- [ ] The section contains only a bounded index preview.
- [ ] The section includes a note explaining that topic files should be read on demand.
- [ ] Entries beyond the preview budget are not injected directly.
- [ ] Governed frontmatter hints may still appear as a small deterministic list.

### TC-009: Prompt Build Does Not Run Curator

**Priority**: High
**Type**: Negative

Steps:

1. Prepare at least two managed memory refs that would be curator candidates.
2. Trigger a coding prompt build with a task that can use memory.
3. Inspect the memory root `.governance/` directory.

Expected result:

- [ ] The prompt includes only bounded memory index/hints.
- [ ] No `.governance/reports/*.json` file is created by prompt build.
- [ ] No `.governance/auto-curate-state.json` file is created by prompt build.
- [ ] No memory topic file or `MEMORY.md` content is modified.

### TC-010: Maintenance Curator Writes Audit Report Without Mutation

**Priority**: High
**Type**: Positive

Steps:

1. Prepare at least two managed memory refs, preferably duplicate or conflicting refs.
2. Call `maybeRunAutoCurator()` from a host maintenance harness.
3. Inspect the memory root `.governance/` directory.
4. Trigger the same path again immediately.

Expected result:

- [ ] The first eligible run writes `.governance/reports/*.json`.
- [ ] `.governance/auto-curate-state.json` records the last run.
- [ ] No memory topic file or `MEMORY.md` content is modified.
- [ ] The second immediate run skips as `not_due`.

### TC-011: Feedback Review Uses Injected LLM Reviewer Without Direct Writes

**Priority**: High
**Type**: Positive

Steps:

1. Prepare an approved memory topic that says "Repo uses npm workspaces."
2. Provide user feedback such as "Actually this repo now uses pnpm, not npm."
3. Call `reviewMemoryFeedback()` from a host harness with an injected reviewer.
4. Inspect returned actions and memory files.

Expected result:

- [ ] The reviewer receives only bounded candidate refs/snippets, not the whole memory store.
- [ ] The returned action is proposal-shaped, for example `patch_memdir`.
- [ ] The returned action requires approval.
- [ ] No memory file is modified by the review call itself.
- [ ] Actual mutation still goes through the normal approval/fingerprint path.

### TC-012: Ignore Memory Suppresses Retrieval

**Priority**: High  
**Type**: Negative

Steps:

1. Use a prompt such as "Ignore memory for this answer."
2. Build or run a task that would otherwise match existing memory.

Expected result:

- [ ] No memory hints are injected.
- [ ] Trace metadata marks memory as suppressed.
- [ ] The selected ref id list is empty.

### TC-013: Session And Artifact Refs Are Inventory Only By Default

**Priority**: Medium  
**Type**: Boundary

Steps:

1. Run with a session lineage and artifact ledger present.
2. List memory refs through the controller or a host harness.
3. Build a normal memory pack.

Expected result:

- [ ] Session trace refs are listed as `session_trace`.
- [ ] Artifact ledger refs are listed as `artifact_ledger`.
- [ ] They are snapshot-readable.
- [ ] Their provisional lifecycle keeps them out of normal prompt injection.

### TC-014: Read-Only And Protected Refs Are Not Mutated

**Priority**: High  
**Type**: Negative

Steps:

1. Include read-only project docs, builtin skills, or pinned refs in inventory.
2. Attempt to route a mutating proposal toward one of those refs.

Expected result:

- [ ] The mutation is skipped.
- [ ] The skipped reason identifies the protected ref.
- [ ] The original file/ref remains unchanged.

## Regression Checklist

- [ ] Existing `/learn pending|diff|approve|reject` behavior still works.
- [ ] Existing `/memory list|rebuild|open|help` behavior still works.
- [ ] Root package independence is preserved: `@kodax-ai/agent` builds without coding or REPL imports.
- [ ] No `any` is introduced in F228 TypeScript surfaces.
- [ ] No vector DB, SQLite, embeddings, or second memory database is introduced.
- [ ] Coding prompt construction remains side-effect-free for memory governance.

## Summary

| Cases | Passed | Failed | Blocked |
|---:|---:|---:|---:|
| 14 | TBD | TBD | TBD |

**Conclusion**: TBD

**Feature ID**: FEATURE_228
