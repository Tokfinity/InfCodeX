# KodaX Documentation

Public documentation for KodaX users and SDK integrators.

The current release is `v0.7.92`. Its SDK guidance carries the filesystem-effect
operation-token coordinator, recorded-release owners, managed Session-before-
completion ordering, canonical-first resume reconstruction, `sandboxRuntime:4`,
and `crashOutcomeModel:2`. Issue 256's
lost-ancestor descendant-closure boundary remains open. The same guidance still
covers the v0.7.89 Issue 293
topology-transparent conversation projection, FEATURE_293 zero-service web
search fallback, and FEATURE_294 run-scoped Host Tools. The host-tool surface is
leased to one Run, registry-first, revocation-safe, and absent from unrelated
CLI runs. Its custom web-search endpoint remains isolated. The v0.7.88 SDK
guidance adds the GLM-5.3 Coding Plan
routes with verbatim model IDs, keeps GLM-5.2 selectable, defaults
`zhipu-coding`, `zai-coding`, and `ark-coding` to 5.3, and documents the GLM-5.3
always-thinking effort mapping. It also covers atomic Runtime owner
recovery, process-start identity locks, Windows sandbox termination attestation,
durable ACL owner markers, and Windows workspace Shell PATH/executable scoping
with quoted `cmd.exe` argument preservation. POSIX workspace sessions initialize
fresh-home policy roots, settle workspace-local warm-up within the Shell
abort/deadline, retire invalid sessions after lease-cleanup failure, and fail closed when process-tree cleanup is unconfirmed,
in addition to the v0.7.85 Session-scoped
Runtime Event Journals, the `sessionEventJournal:1` daemon contract,
conversation-first Memory management, the additive experimental Memory
management facade, and the startup/Worker lifecycle boundaries. Issue 256's
remaining Worker owner-lease boundary remains open after v0.7.89; this release
assigns no replacement target.

The v0.7.90 SDK guidance also documents orderly retirement for timed-out
workspace sessions, actionable daemon Error/aggregate/cause diagnostics, direct
clone-predecessor lineage and topology-correct archive markers, and provider-
valid object schemas for run-scoped tools. npm publication remains a manual
operator step.

The v0.7.91 SDK guidance adds the crash-resumable
`settleKodaXRuntimeExit()` transaction and `runtimeExitSettlement:1` capability,
effective live output segments (`responseId` + `providerRequestId`), and
standalone lazy provider dependency bundling. It also documents bounded
AskUser/permission deadlines, owner AbortSignal propagation,
`handleRuntimePermissionRequest()`, validated default answers, and stale
prepared-Session-tail recovery after a `data_changed` race.

The v0.7.92 SDK guidance adds `sandboxRuntime:4` and `crashOutcomeModel:2` as
pre-start facts. Auto-start replaces an idle older daemon and fails closed
while it is busy. Managed `onComplete` is not terminal authority. Hosts must
not delete ProgramData lock files to recover a stuck coordinator. Resume
reconstruction uses canonical Session `messages` as the transcript; `uiHistory`
may overlay tool cards and display-only entries but cannot hide ordinary
conversation. Presentation-only `agent-completed` / `task-completed` events
stay host-owned when a non-empty CLI `uiHistory` exists.

## Getting Started

- [Overview](./getting-started/overview.md) — What KodaX is and how it compares
- [Installation](./getting-started/installation.md) — npm, single binary, build from source
- [Quickstart](./getting-started/quickstart.md) — Your first session

## Configuration

- [Providers & API Keys](./configuration/providers.md) — 16 built-in provider aliases
- [Custom Providers](./configuration/custom-providers.md) — OpenAI/Anthropic-compatible endpoints
- [Configuration Files](./configuration/config-files.md) — config.json, split files, env vars
- [Permission Modes](./configuration/permissions.md) — Plan / Edits / Auto + Shell Execution Contract
- [Sandbox](./configuration/sandbox.md) — Optional OS-level containment (ASRT)

## SDK

- [Embedder Guide](./sdk/embedder-guide.md) — Full SDK integration guide for host applications

## Guides

*(More guides coming soon: CLI reference, REPL commands, sessions, multi-agent, skills, extensions, MCP, A2A, repo intelligence, memory, workflows, compaction, doctor, tools reference.)*

## Reference

*(Coming soon: troubleshooting, FAQ, comparison, license.)*
