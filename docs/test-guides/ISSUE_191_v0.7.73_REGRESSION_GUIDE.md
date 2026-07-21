# Issue 191 Regression Guide (v0.7.73)

## Purpose

Verify that Auto permission review is both safe and compact: PowerShell
mutation targets are bound by command semantics, moves remain atomic, the LLM
reviews outside-workspace risk, and explicit rules mode only auto-allows fully
resolved in-boundary effects.

## Automated Gate

Run:

```powershell
npx vitest run packages/repl/src/permission/powershell-mutation.test.ts packages/repl/src/permission/auto-rules.test.ts packages/repl/src/permission/permission.test.ts packages/repl/src/permission/repl-bash-signals.test.ts packages/coding/src/guardrails/auto-mode/permission-intent.test.ts packages/coding/src/guardrails/auto-mode/classifier-prompt.test.ts packages/coding/src/guardrails/auto-mode/classify.test.ts packages/coding/src/guardrails/auto-mode/guardrail.test.ts packages/repl/src/interactive/auto-mode-bootstrap.test.ts
npx tsc -b packages/coding packages/repl --pretty false
```

## Manual Scenarios

Use a disposable workspace with sibling directory `outside`. Do not point the
commands at valuable files.

### PowerShell binding

In `Auto[rules]`, confirm that each command below requests confirmation and is
never automatically executed:

```powershell
Copy-Item "src/inside.txt" "../outside/copied.txt"
Move-Item -Force "src/inside.txt" "../outside/moved.txt"
Set-Content -Value data "../outside/set.txt"
Out-File -InputObject data -FilePath "../outside/out.txt"
New-Item -ItemType File "../outside/new.txt"
Remove-Item -Filter harmless.txt "../outside/old.txt"
```

Change only the target paths to `build/...`; fully resolved commands should run
without a rules-mode prompt. Unknown parameters, variables, wildcards, arrays,
broken links, unresolved paths, PowerShell provider paths such as `HKLM:` or
`Env:`, `Copy-Item -ToSession/-FromSession`, and link-producing `New-Item`
types must still request confirmation. A fully modeled command carrying
`-WhatIf` must not be treated as a real mutation.

### LLM review

In `Auto[LLM]`, run the outside-workspace `Move-Item` case. The permission
reviewer should receive one `move` operation with source and destination
boundaries plus cross-boundary/source-removal risks. It should decide allow or
block from user intent; the outside boundary itself must not open a dialog.

Inspect provider tracing if enabled. The classifier request must contain
`intent_evidence` and `operation_facts`, and must not contain Assistant prose,
tool-result bodies, or AGENTS.md content.

### Oversized payload

Ask the agent to run a disposable inline generator larger than 16 KiB. The raw
payload should be represented as compact incomplete/opaque facts with bounded
head/tail action evidence, original byte count, and SHA-256 identity. Size
alone must not open a confirmation dialog; the permission reviewer may block
when the available evidence is insufficient.

## Pass Criteria

- None of the six outside-workspace PowerShell forms is rules-auto-allowed.
- Equivalent fully resolved workspace/temp mutations retain auto-allow.
- Move/copy/rename remain atomic source-to-destination facts.
- LLM review gets precise boundaries and risks without full session context.
- No permission decision is escalated to the user solely because a compact
  evidence budget was exceeded.
- Repeated local evidence-budget blocks do not downgrade Auto[LLM] to rules.
- Targeted batch summaries retain middle-of-list risky operations.
