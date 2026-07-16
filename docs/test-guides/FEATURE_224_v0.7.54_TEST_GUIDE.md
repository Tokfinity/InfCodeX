# FEATURE_224 v0.7.54 Human Test Guide

## Overview

**Feature**: Self-Improvement Skill Loop / Procedural Learning Inbox  
**Version**: v0.7.54  
**Tester**: TBD

This guide is intentionally limited to manual checks that need human judgment:
terminal UX, wording, discoverability, and confidence that the REPL wiring feels
coherent. Deterministic behavior such as proposal-store validation, safe apply,
path traversal rejection, ledgers, filtered inbox logic, and repeat approval
protection is covered by automated tests and should not be repeated here.

## Environment

- Build from the current workspace.
- Use a temporary KodaX home when manually testing:
  `set KODAX_HOME=%TEMP%\kodax-f224-manual`
- Run from a project checkout with at least one available skill so the skill
  list and direct slash behavior are visible.

## Manual Test Cases

### TC-001: Skill help and discoverability are clear

**Priority**: High  
**Type**: UX

1. Start the REPL.
2. Run `/help`.
3. Run `/help skill`.
4. Run `/skill`.

**Expected**

- [ ] `/help` presents skills with `/skill`, `/<skill-name>`, `/skill:<name>`,
      and `/skill pending` without mentioning `/skills` as a command.
- [ ] `/help skill` explains that direct slash skill invocation is preferred,
      and that built-in/extension commands keep priority on name conflicts.
- [ ] `/skill` lists available skills in a readable format.
- [ ] If a skill name conflicts with a command, the list makes the compatibility
      form `/skill:<name>` obvious.

### TC-002: Direct slash skill invocation feels natural

**Priority**: High  
**Type**: UX

1. Pick a real user-invocable skill from `/skill`.
2. Invoke it as `/<skill-name> some human-readable args`.
3. Invoke the same skill as `/skill:<skill-name> some human-readable args`.

**Expected**

- [ ] The direct slash form is accepted when no command owns that name.
- [ ] The compatibility form still works.
- [ ] The terminal output clearly says which skill was activated.
- [ ] Argument display is understandable and not noisy.
- [ ] The next assistant turn uses the selected skill context.

### TC-003: Command conflicts do not surprise the user

**Priority**: High  
**Type**: UX / Regression

1. Find or create a local test skill whose name matches a built-in command, such
   as `help`.
2. Run `/help`.
3. Run `/skill:help`.

**Expected**

- [ ] `/help` still opens command help instead of invoking the skill.
- [ ] `/skill:help` remains available as the explicit compatibility escape hatch.
- [ ] The behavior matches the wording shown in `/help skill` and `/skill`.

### TC-004: Learning inbox language is user-facing, not internal

**Priority**: Medium  
**Type**: UX

1. With a project that has pending learning suggestions, run `/learn pending`.
2. Run `/skill pending`.
3. Run `/workflow pending`.
4. Run `/memory pending`.

**Expected**

- [ ] The headings use user-facing labels such as method guides, runnable
      workflows, and context notes.
- [ ] The output points users to `/learn diff`, `/learn approve`, and
      `/learn reject`.
- [ ] The wording does not require users to understand carrier internals.
- [ ] Empty states are calm and understandable.

### TC-005: Proposal review is understandable before approval

**Priority**: Medium  
**Type**: UX / Safety

1. Run `/learn diff <proposalId>` for a skill learning suggestion that has an
   apply plan.
2. Read the proposal and apply plan as a human reviewer.

**Expected**

- [ ] The proposal ID, status, destination, and target skill are easy to find.
- [ ] The planned changed paths are visible before any approval.
- [ ] The displayed content is enough for a reviewer to decide approve/reject.
- [ ] The command does not imply that workflow or memory handoffs will be
      mutated directly by FEATURE_224.

### TC-006: Autocomplete does not make the REPL feel noisy

**Priority**: Medium  
**Type**: UX

1. Type `/` and observe suggestions.
2. Type the first few characters of a skill name.
3. Type `/skill:` and the first few characters of the same skill.
4. If available, try a namespaced skill such as `/github:`.

**Expected**

- [ ] Built-in commands and skills are both discoverable without visual clutter.
- [ ] Direct slash skill suggestions use `/<skill-name>`.
- [ ] Legacy skill suggestions under `/skill:` preserve `/skill:<name>`.
- [ ] Namespaced skill suggestions, if present, keep the full skill name.

## Automated Coverage Already Run By Codex

Do not repeat these as manual cases unless debugging a failure:

- Learning triage, completed-turn gating, trace-only discard, and proposal-store
  validation.
- Skill safe apply: approval requirement, path traversal rejection, size limits,
  symlink/directory refusal, atomic writes, dry-run, and snapshots.
- Usage/trust ledgers and consumer-impact scanning.
- `/learn approve` idempotence and corrupt-store read-only behavior.
- Filtered inbox correctness for `/skill pending`, `/workflow pending`, and
  `/memory pending`.
- Direct slash and legacy slash command parsing, including namespaced skills.
- Classic REPL skill prompt initialization and coding-side `skill` tool fallback
  initialization.

## Summary

| Cases | Passed | Failed | Blocked |
|---:|---:|---:|---:|
| 6 | TBD | TBD | TBD |

**Conclusion**: TBD
