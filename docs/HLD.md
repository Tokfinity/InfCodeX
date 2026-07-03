# KodaX High-Level Design

> Last updated: 2026-07-03
>
> Current release baseline: `@kodax-ai/kodax@0.7.59`
>
> This HLD is intentionally current-state only. The old pre-v0.7.43
> chain/harness model has been removed from this active design document because
> it no longer describes the runtime.

## 1. System Overview

KodaX is a TypeScript monorepo published as one npm package with multiple SDK
subpaths. Source code is organized into four workspace packages:

```text
packages/
  llm/      provider abstraction, streaming, capability metadata
  agent/    generic Agent/Runner, orchestration, skills, MCP, tracing, workflow
  coding/   coding-agent preset, tools, prompts, sessions, workflows
  repl/     Ink terminal UI, config, commands, session management surface
src/        CLI entry point and binary-facing bootstrap
clients/    optional external clients and protocol adapters
benchmark/  eval harness, datasets, and prompt-change rules
```

The published package is `@kodax-ai/kodax`. It exposes the root API plus eight
SDK subpaths: `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`,
`/mcp`, and `/session`.

## 2. Layering

```text
CLI / REPL / SDK / binary
          |
          v
packages/coding  - KodaX coding preset and tool loop
          |
          v
packages/agent   - Runner, fan-out, idle-yield, stop hooks, skills, MCP
          |
          v
packages/llm     - provider registry, streaming, side queries
```

Layer rules:

- `llm` has no dependency on KodaX product logic.
- `agent` can be used without `coding`.
- `coding` builds the coding agent on top of `agent` and `llm`.
- `repl` depends on `coding` for the product runtime and owns terminal UX.
- Inline capabilities such as skills, MCP, tracing, session-lineage, memory,
  and workflow are subtrees, not separate workspace packages.

## 3. Runtime Shape

The main coding path is:

```text
user input
  -> CLI / REPL / SDK adapter
  -> KodaXOptions
  -> Runner.run(createDefaultCodingAgent(), prompt, presetOptions)
  -> coding substrate
  -> provider stream + tool loop
  -> Sidecar Verifier stop hook when Worker text-finishes
  -> KodaXResult + session updates + UI/events
```

The Worker single-loop is the only current main-agent execution shape. The
Worker plans, reads, edits, tests, dispatches children, and writes the final
answer. Sidecar Verifier is out-of-band and only judges termination quality.

## 4. Provider Architecture

`packages/llm` provides:

- 15 built-in provider aliases,
- custom provider registration,
- OpenAI- and Anthropic-compatible protocols,
- CLI bridge providers for Gemini CLI and Codex CLI,
- stream normalization,
- effort-first reasoning and request-timeout config normalization,
- capability metadata and provider policy gates,
- side-query support for verifier and other out-of-band LLM calls.

Provider-specific logic belongs at the provider boundary: request shape,
reasoning parameters, token caps, image support, forced tool choice support,
retry behavior, and stream watchdogs. Prompt prose should not fork by provider
family.

## 5. Coding Runtime

`packages/coding` owns KodaX-specific agent behavior:

- `runKodaX` and `KodaXClient`,
- default coding agent declaration,
- coding substrate and run loop,
- 50+ built-in tools from `tools/tool-definitions.ts`,
- Worker prompts and capability sections,
- permission and auto-mode integration,
- built-in full/light repo-intelligence context and semantic worker wiring,
- sidecar verifier integration,
- session snapshots and runtime state,
- construction and self-modification tools,
- workflow backend integration.

The coding runtime is the only layer that knows about KodaX's coding-product
tool bundle and user-facing task semantics.

## 6. Tool And Control Plane

Tools are data-defined and handler-backed. Each tool declares name, description,
JSON schema, side-effect class, handler, and optional classifier projection.
Major tool families include:

- file operations: `read`, `write`, `edit`, `multi_edit`, `insert_after_anchor`,
  `undo`;
- execution and search: `bash`, `glob`, `grep`, web search/fetch, code search,
  semantic lookup, LSP navigation;
- repo intelligence: overview, changed scope, diff bundles, module/symbol/
  process context, impact estimates, cyclic dependency checks;
- coordination: `dispatch_child_task`, `send_message`, `task_stop`,
  `task_output`;
- product state: goals, todos, sessions, manual lookup;
- extension capabilities: MCP calls, MCP resources, MCP prompts;
- construction: tool generation, agent generation, self-modify staging.

Permission modes and auto-mode guardrails must operate on tool side effects and
runtime context, not on prompt-only convention.

## 7. Child Tasks

Child work is explicit and tool-driven. The main Worker can dispatch a child,
send it follow-up messages, stop it, and inspect output. Idle-yield is the
canonical waiting behavior when useful main work is exhausted and child tasks
remain in flight.

Children are a coordination primitive, not a replacement for the main Worker.
The main Worker owns final synthesis and user communication.

## 8. Sessions

KodaX sessions are local JSONL records with branchable lineage. Session
requirements span both product and SDK:

- CLI and REPL resume/list/fork/rewind flows;
- SDK session APIs via `@kodax-ai/kodax/session`;
- session snapshots and runtime state persistence;
- durable terminal tool-card replay from sanitized `uiHistory`, with canonical
  `messages` / `lineage` remaining the source of truth;
- tags, filters, archive state, and project-aware storage evolution;
- compatibility with old session records where practical.

Session management is a product feature, not merely a debug log.

## 9. Skills And MCP

Skills are Markdown-based capabilities discovered from configured paths and
expanded for the LLM through `packages/agent/src/capabilities/skills`.

MCP integration lives under `packages/agent/src/capabilities/mcp` and includes
catalog/search, transport, runtime connection, OAuth helpers, protected-resource
discovery, prompts, resources, tools, and reverse capabilities.

Media/input artifact helpers live under `packages/agent/src/media`. The
published `/media` SDK subpath and `@kodax-ai/coding/media` compatibility
barrel both point at this agent-layer implementation.

Published SDK subpaths expose focused subsets:

- `@kodax-ai/kodax/media`
- `@kodax-ai/kodax/skills`
- `@kodax-ai/kodax/mcp`

## 10. Workflow Runtime

Workflow has two layers:

- `packages/agent/src/workflow`: domain-neutral runtime, events, types, caps,
  concurrency, abort, backend injection, and the generic workflow capsule
  contract.
- `packages/coding/src/workflows`: coding backend, built-in workflows,
  durable run graph, workflow capsule persistence/preflight, saved-workflow
  discovery, and REPL command integration.

FEATURE_217 is the v0.7.49 Dynamic Workflow feature. It provides the runtime
substrate, coding backend, durable run graph, on-the-fly JavaScript harness
generation, background management, pause/resume/stop/save, opt-in worktree
routing, hard budget checks, workflow capsules for reusable generated runs, and
reusable workflow pattern templates. The domain-neutral SDK surface lives in
`@kodax-ai/agent/workflow`; coding and REPL layers consume it rather than owning
the core runtime.

Generated workflow scripts keep the orchestration plan in JavaScript, matching
Claude-style dynamic workflows. They must not receive raw host authority:
filesystem, shell, process, environment, module import, and network effects stay
behind child agents and KodaX permission gates. Generated scripts run through a
capability runner that exposes only structured `wf.*` calls to the host. Pattern
templates are examples and scaffolds, not a replacement for dynamic harness
generation.

Saved generated workflows are persisted as lightweight workflow capsules:
source, manifest, intent, input examples, environment/tool/skill/MCP
requirements, and provenance. The capsule protocol belongs in `agent`; checks
that depend on the local repository, skills, MCPs, or `.kodax` paths belong in
`coding`; command help and approval text belong in `repl`.

FEATURE_229 (`v0.7.50`, released)
is the process layer on top of FEATURE_217. It standardizes workflow progress as
agent-layer snapshots and events so SDK embedders, coding commands, REPL
inline/fullscreen surfaces, and future system event bridges can subscribe to the
same source of truth. This follows the same boundary rule as the runtime itself:
`agent` owns process state and terminal status semantics; `coding` maps domain
workflow runs, host policy, lifecycle controls, source/provenance fields, final
result summaries, artifacts, and retention into that state; `repl` renders it.
Space-style hosts must consume the F229 snapshot/controller contract rather than
parsing terminal text, slash-command output, or Ink view models. The host
contract also preserves parent guardrails, existing SDK event callbacks,
workflow logs, capsule preflight, and provider/model policy when a workflow
spawns child agents; entering workflow mode must not weaken safety or
observability.

FEATURE_230 and FEATURE_234 (`v0.7.51`, released) close the host-read
persistence loop around sessions and workflow runs. Resumed TUI sessions replay
bounded terminal tool cards from sanitized `uiHistory` while headless hosts can
still reconstruct tool facts from canonical messages. Workflow process snapshots
also carry optional `hostMetadata`, a small string-only map persisted in
`run.json` and echoed after restart so hosts can attribute runs without a side
table.

FEATURE_246 (`v0.7.58`, released) is the largest workflow change since F229: the
Worker authors and runs workflows inline through a model-callable `run_workflow`
tool (scout-then-author), running generated scripts through the same sandbox +
static-validation + postcondition pipeline. It adds structured child output
(`outputSchema`), the no-barrier `wf.pipeline`, same-session resume
(`resumeFromRunId`), and nested workflows; the neutral run-lifecycle manager is
lifted to `@kodax-ai/agent` (ADR-046) and the inline run is async / idle-yield
(ADR-049). See ADR-044/046/047/048/049.

## 11. REPL And CLI

`packages/repl` owns terminal UX:

- Ink interactive mode,
- slash commands,
- config and custom provider CRUD,
- permissions UI,
- session list/resume/fork/rewind/archive surfaces,
- transcript rendering,
- status and progress surfaces,
- MCP and workflow command surfaces.

`src/kodax_cli.ts` is the product entry for command-line execution and binary
bootstrap. The CLI should stay thin and delegate product behavior to package
APIs.

## 12. Design Constraints

- Do not reintroduce retired V1 chain abstractions into current docs or prompts.
- Do not add a new workspace package unless there is a real independence need.
- Do not expose source-only subpaths as published root-package subpaths unless
  `package.json`, bundle build, and dts generation all support them.
- Do not make SDK consumers depend on REPL-only APIs for headless use cases.
- Do not make provider-specific behavior leak into generic prompt prose.

## 13. Related Documents

- Product requirements: [PRD.md](PRD.md)
- Detailed design: [DD.md](DD.md)
- Architecture decisions: [ADR.md](ADR.md)
- Active roadmap: [FEATURE_LIST.md](FEATURE_LIST.md)
- Feature index: [features/README.md](features/README.md)
