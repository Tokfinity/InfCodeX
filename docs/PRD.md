# KodaX Product Requirements

> Last updated: 2026-06-28
>
> Current release baseline: `@kodax-ai/kodax@0.7.57`
>
> This document describes the current product. Historical pre-v0.7.43
> chain/harness designs have been removed from this current PRD because they no
> longer match the code after FEATURE_184, FEATURE_190, and FEATURE_193. Use git
> history and `docs/features/*.md` for historical rationale.

## 1. Product Positioning

KodaX is a lightweight, local-first coding agent that can be used as:

- a terminal REPL for multi-turn engineering work,
- a one-shot CLI for scripted tasks,
- a TypeScript SDK for embedding coding-agent behavior into other products,
- a Node-free single binary for restricted or air-gapped environments.

The product promise is simple: give a developer an LLM-native engineering
assistant that can read, edit, test, reason over a repository, coordinate child
tasks, and preserve useful session context without forcing a heavy IDE or
server product around it.

## 2. Target Users

- Developers who want a terminal-native agent for code changes, debugging,
  research, and documentation.
- SDK embedders who want KodaX's agent loop, tools, providers, sessions, skills,
  MCP, or session APIs inside their own app.
- Teams that need first-class support for Anthropic, OpenAI, China-native
  providers, OpenAI/Anthropic-compatible gateways, Gemini CLI, and Codex CLI.
- Power users who need auditable local files, branchable sessions, permission
  control, and scriptable workflows.

## 3. Product Principles

- Minimal surface first. Add product modes only when they carry real use.
- LLM-friendly structure. Types, docs, prompts, and runtime contracts should be
  easy for an LLM and a human to inspect.
- Local control. File edits, shell commands, sessions, config, and credentials
  stay under the user's local environment and explicit permissions.
- Evidence over theater. User-facing progress should reflect real work,
  completed tools, child task state, verifier decisions, and session records.
- Current docs stay current. Historical architecture belongs in feature docs,
  ADR history, changelog, and git history, not in the active PRD/HLD/DD body.

## 4. Current Product Surfaces

| Surface | Entry | Requirement |
|---|---|---|
| REPL | `kodax` | Streaming terminal UI, sessions, slash commands, permissions, skills, MCP, child task visibility. |
| One-shot CLI | `kodax "task"` | Non-interactive task execution with the same coding runtime and provider configuration. |
| SDK root | `@kodax-ai/kodax` | `runKodaX`, `KodaXClient`, events, session storage helpers. |
| SDK subpaths | `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`, `/mcp`, `/session` | Smaller import surfaces for embedders. |
| Binary release | `bun --compile` output | Runs without Node.js on the target machine. |

## 5. Current Execution Model

KodaX uses a V2 Worker single-loop model with an out-of-band Sidecar Verifier.
The Worker owns normal reasoning, tool use, file edits, and final response
drafting. When the Worker appears to finish by text, the Sidecar Verifier can
accept, request revision, or mark the run blocked without becoming a visible
in-chain role.

The retired V1 chain model is not a product requirement:

- no retired pre-v0.7.43 chain entry,
- no retired multi-role execution chain,
- no retired harness product surface,
- no `emit_handoff` terminal tool,
- no `KODAX_HARNESS_V2` opt-out behavior.

Child work is handled by explicit tools and runtime registries:
`dispatch_child_task`, `send_message`, `task_stop`, and `task_output`.
The main Worker remains responsible for final user-facing synthesis.

## 6. Required Capabilities

### Providers

KodaX must support 15 built-in provider aliases plus user-defined compatible
providers. Provider behavior must be described by capability metadata rather
than scattered prompt prose. Custom providers must support base URL, protocol,
model, API key env var, effort-first reasoning profile/preset, request timeout
normalization, and multimodal capability flags where needed. The current
provider capability snapshot is maintained in
`packages/llm/src/providers/provider-capabilities.json` and includes the
2026-06-14 model refresh for GPT-5.4, Kimi K2.7 Code, GLM-5.2, MiniMax M3/M2.7,
DeepSeek V4, and Doubao Seed 2.0 routes where supported.

### Tools

The coding runtime must expose a rich but explicit tool surface: file read/write
and edit tools, shell, search, repo intelligence, web fetch/search, LSP
navigation, MCP calls, git worktree helpers, child task control, goals, todos,
construction, and self-modification tools. Tool permissions and side effects
must be visible to the runtime.

### Media Inputs

SDK and REPL hosts must be able to construct image/file/video input artifact
metadata without importing REPL internals. The canonical media implementation
lives in the agent layer and is exposed through `@kodax-ai/kodax/media`; coding
uses the same validation and queue helpers before provider send.

### Sessions

Users must be able to resume, list, fork, rewind, tag, archive, and inspect
sessions. Session records are local JSONL data, public session APIs must remain
stable for SDK consumers, and host-facing reads must distinguish active model
context from append-order transcript history. Resumed interactive sessions
should preserve durable terminal tool-card replay where sanitized `uiHistory`
is available, while canonical `messages` / `lineage` remain the source of
truth.

### Skills And MCP

Markdown skills and MCP capability integration are first-class KodaX
capabilities. They are source-code subtrees under `packages/agent`, not separate
workspace packages. Public SDK access is through `@kodax-ai/kodax/skills` and
`@kodax-ai/kodax/mcp`.

### Dynamic Workflow Harness

FEATURE_217 is the v0.7.49 home for the complete Dynamic Workflow product loop.
The shipped surface includes Agent-layer `createWorkflowRuntime`,
`runWorkflow`, `normalizeWorkflowLimits`, workflow capsule helpers, coding
backend integration, one built-in read-only workflow, durable run graph,
saved-workflow discovery, capability-routed generated scripts, `/workflow
create`, background lifecycle management, pause/resume/stop/save/rerun, hard
budget checks, opt-in worktree routing, and richer workflow pattern templates.
Generated workflows can be promoted into lightweight capsules that preserve the
script plus manifest, intent, input examples, requirements, and provenance so
they remain reusable across sessions and understandable to SDK consumers.

### Workflow Process Surface

FEATURE_229 (`v0.7.50`) standardizes workflow execution as an Agent-layer
process contract. SDK hosts must be able to subscribe to
`WorkflowProcessEvent`, poll `WorkflowProcessSnapshot`, and use lifecycle
controls for stop, pause, resume, final result reads, artifact reads, terminal
run delete/prune, identity changes, saved-capsule revision/replace provenance,
and preflight checks. REPL and future UI hosts render the same snapshots; they
must not become the source of truth by parsing terminal text, slash-command
output, or Ink view models. Coding-layer workflow APIs own coding run graphs,
host policy, source/provenance fields, and result summaries while preserving the
Agent-layer package boundary.

FEATURE_234 (`v0.7.51`) adds workflow run host attribution through
`hostMetadata`. SDK hosts can stamp a small string-only ownership map on process
metadata, have it persisted in `run.json`, and read it back through snapshots
after restart without KodaX interpreting host-specific meaning.

### Safety And Control

KodaX must keep permission modes, auto-mode guardrails, bash classification,
content-hash safety checks, session snapshots, verifier fail-open behavior, and
explicit user confirmation for trusted-local workflow scripts.

## 7. Non-Goals

- Reintroducing the V1 multi-role chain as a product mode.
- Building a heavy IDE shell inside the REPL.
- Creating a second engine for non-terminal surfaces.
- Adding broad configuration for hypothetical future use.
- Replacing git, package managers, test runners, or the user's own review
  process.
- Treating generated workflow scripts as trusted local code; generated
  workflows must stay on the capability runner path.

## 8. Success Criteria

- Current docs describe the code that exists today.
- A new SDK consumer can choose the correct import path without reading source.
- A CLI/REPL user can understand providers, sessions, permissions, skills, MCP,
  and child tasks without learning retired V1 terminology.
- Product changes preserve workspace package independence:
  `llm -> agent -> coding -> repl`, with no reverse dependency from agent to
  coding.
- Prompt or behavior changes that affect the agent loop follow
  `benchmark/EVAL_GUIDELINES.md`.

## 9. Current Roadmap Links

- Active feature index: [FEATURE_LIST.md](FEATURE_LIST.md)
- Architecture decisions: [ADR.md](ADR.md)
- Current high-level design: [HLD.md](HLD.md)
- Current detailed design: [DD.md](DD.md)
- Feature design index: [features/README.md](features/README.md)
