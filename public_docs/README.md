# KodaX Documentation

Public documentation for KodaX users and SDK integrators.

The current release is `v0.7.88`. Its SDK guidance adds the GLM-5.3 Coding Plan
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
remaining Worker owner-lease boundary remains open after v0.7.88; this release
assigns no replacement target.

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
