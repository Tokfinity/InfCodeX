# KodaX Product Requirements

> Last updated: 2026-07-23
>
> Current implementation baseline: `v0.7.74`
> (`@kodax-ai/kodax@0.7.74` workspace package)
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
| Runtime SDK | `@kodax-ai/kodax/runtime` | Stable sessions/runs/events/permissions/workflows/config/catalog/MCP/artifact/diagnostic facade in inline, Worker, or daemon form. |
| Daemon operations | `kodax daemon start/status/logs/stop/restart` | One local owner per `homeDir + profile`, shared by REPL, Space, IDE, and SDK clients. |
| SDK subpaths | `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`, `/mcp`, `/session`, `/runtime`, `/experimental-memory` | Smaller import surfaces for embedders; governed memory remains explicitly experimental. |
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

Child work is handled by one Runtime-owned Actor/Turn tree and the canonical
collaboration tools: `spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `interrupt_agent`, `list_agents`, and `agent_output`. The main
Worker remains responsible for final user-facing synthesis.

Queued user input belongs to the session-root Actor queue rather than a
process-global "main thread" bucket. A waiting Actor can therefore yield at a
safe boundary for its own follow-up without consuming or displaying prompts
from another session.

The model-facing `wait_agent` contract is mailbox-driven. It accepts only a
bounded timeout and returns a small wake acknowledgement; the next safe model
boundary receives the actual scoped Agent message or completion envelope.
Ordinary Actor progress is telemetry for UI and SDK event consumers and must
not wake or resample the parent model. Long waits therefore consume elapsed
time, not model tokens. Raw Actor event replay and long-poll remain available
through the SDK and daemon control-plane APIs.

Runtime hosts may submit real user input to the current active root Run only
through the advertised `interruptInput:1` contract. Input accepted before a
safe Runner boundary must remain FIFO, retain separate user-message authorship,
and enter one next model request without creating a continuation Run. Closed or
terminal Runs must reject or terminalize undelivered input rather than leak it
into later work. `after_turn` remains the explicit continuation mechanism.

## 6. Required Capabilities

### Runtime Host API

SDK and product hosts must use one `KodaXRuntime` service contract without
forking a second coding engine. The supported ownership forms are:

- inline embedded for lowest overhead and process-local integrations;
- Worker-hosted embedded for private state and deterministic V8 termination;
- local daemon for durable multi-client sharing across REPL, Space, IDE, and
  SDK processes.

Runs must serialize within one session and may execute concurrently across
sessions. Pending permissions and runtime events belong to the Runtime owner,
not to one UI. Daemon ownership is unique per `homeDir + profile`; concurrent
starters must converge on the verified owner rather than start competing
servers. Process-local callbacks and service objects must fail closed at
Worker/daemon DTO boundaries. `close()` must terminate private inline/Worker
ownership but only detach a daemon client.

For a session with `permissionMode: 'auto'`, the Runtime is also the owner of
the Auto Mode tool guardrail. It creates and reuses the guardrail across turns,
keys reuse to the effective provider/model, project boundary, execution
directory, classifier model, and timeout, and persists an automatic fallback
from LLM to rules in the session settings. The execution sequence is always
guardrail classification, then the host permission bridge only for an explicit
`escalate` verdict, then tool execution. A static approval hook must not bypass
that decision owner or manufacture requests for an `allow` verdict.

The Auto LLM request must contain only bounded permission-relevant evidence,
not the Runner's raw accumulated session. The current tool action remains
separate from a transcript that removes assistant prose/thinking, images, and
unbounded historical tool output. Missing classifier identity is a recoverable
configuration error before provider/permission work; infrastructure timeout or
an oversized unsafe-to-truncate action may escalate, but must never be
reinterpreted as an automatic allow.

SDK hosts must consume this behavior through one typed Auto settings resolver,
and Runtime Session settings must represent the full public Auto configuration,
including a zero-valued speculative window. Shared daemons advertise a unique
capability version for the bounded-input/defaults/diagnostics contract; a
newer capability satisfies an older minimum, while an older daemon is replaced
only after a safe idle preflight. Timeout diagnostics expose bounded
provider/model/timing/retry/phase metadata without prompt or tool-input text,
and the guardrail trace span covers the actual awaited classification.

Packaged Electron hosts may auto-start the shared daemon only through a bounded
Node bootstrap that cannot relaunch the GUI or leak Electron Node mode into
daemon-owned user processes. Disabling Electron's `RunAsNode` fuse requires an
ordinary Node/CLI-started daemon and attach-only SDK mode; no silent inline
fallback is allowed.

Worker resource limits and termination are fault-isolation features, not an
untrusted-code sandbox. A caller that requires deterministic V8 disposal must
be able to request `hardDispose` and receive an error from inline or daemon
forms rather than a silent downgrade.

### Providers

KodaX must support 16 built-in provider aliases plus user-defined compatible
providers. Provider behavior must be described by capability metadata rather
than scattered prompt prose. Custom providers must support base URL, protocol,
model, API key env var, effort-first reasoning profile/preset, request timeout
normalization, and multimodal capability flags where needed. The current
provider capability snapshot is maintained in
`packages/llm/src/providers/provider-capabilities.json` and includes the
2026-07-16 model refresh for GPT-5.4, Kimi K2.7 Code/HighSpeed/K2.6/K2.5,
GLM-5.2, MiniMax M3/M2.7, DeepSeek V4, and Doubao Seed 2.0 routes where
supported. Public Kimi routes use their exact 262,144-token limits and
route-specific thinking contract. The separate Kimi For Coding subscription
alias keeps `kimi-for-coding` as its stable default and exposes `k3-256k` plus
the upstream `k3` route with a 1,048,576-token local context tier;
`thinking.effort` carries K3 reasoning intent without mixing public and
subscription credentials.

A bare interactive first launch with no valid provider selection and no
supported credential must offer a provider/model setup flow before Runtime or
REPL creation. This flow stores no key value: it persists only provider/model
and validated public custom-provider metadata, names the required environment
variable, asks the user to restart the terminal, and exits. Scripted, resumed,
JSON, SDK, daemon, subcommand, and non-TTY paths remain non-interactive.

### Tools

The coding runtime must expose a rich but explicit tool surface: file read/write
and edit tools, shell, search, repo intelligence, web fetch/search, LSP
navigation, MCP calls, git worktree helpers, child task control, goals, todos,
construction, and self-modification tools. Tool permissions and side effects
must be visible to the runtime.

`gitRoot` is a repository safety boundary, while relative file operands resolve
from the effective `executionCwd`. Permission summaries must remain bounded,
redacted, valid JSON and carry that effective directory; they are not raw tool
input logs. A plan-exit tool is exposed only when the active REPL or host has
provided an approval callback.

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

Large context compaction is always enabled and is shared by the CLI, REPL,
Runtime SDK, and embedded products such as KodaX Space. Its percentage trigger
defaults to 75 and is clamped to 15..90. A missing or zero absolute-token
trigger is inactive; otherwise the effective trigger is the smallest of the
percentage threshold, absolute threshold, and physical request capacity. Each
large compaction protects the newest 20% of that effective trigger, preserves
user queries through an exactly-once ledger, and summarizes the complete
eligible prefix in one cache-stable wave. A compaction is reported as
successful only after the replacement transcript is committed, strictly
smaller, and physically sendable. Manual `/compact` and the Runtime imperative
API force the same large-compaction path; microcompaction and tool-result
shaping remain separate mechanisms.

Before the active context discards any exact pre-compaction message, the root
Session host must durably preserve it in the canonical JSONL/main-plus-sidecar
transcript. This includes messages produced during the active Run. Persistence
failure may retain more live memory but must not leave a summary or
`[compacted]` placeholder as the only copy. Child-context compaction must not
mutate root Session history.

When a later query depends on a detail omitted from the active checkpoint, an
Agent backed by durable Session storage must be able to search its own
compacted history and read a cited exact entry in bounded revision-bound
chunks. Root Agents bind the root Session; persistent child Agents bind a
separately minted hidden worker Session and must never gain root-history
access. SDK and daemon hosts require the same search identity alongside
existing transcript pagination. Historical results are evidence, not current
instructions. This feature must not introduce a vector database, background
extraction loop, or a second long-term memory owner.

Bare `kodax -r` must show the searchable picker without loading the full CLI
until a selection is made. Esc restores terminal ownership immediately; a
selection transfers input ownership to the resumed REPL. Replayed history keeps
the timestamp of each persisted event rather than assigning the current render
time to all entries.

### Skills, MCP, And A2A

Markdown skills and MCP capability integration are first-class KodaX
capabilities. They are source-code subtrees under `packages/agent`, not separate
workspace packages. Public SDK access is through `@kodax-ai/kodax/skills` and
`@kodax-ai/kodax/mcp`.

Bidirectional A2A 1.0 is a root integration edge exposed through
`@kodax-ai/kodax/a2a`. Outbound Agents must fail closed against advertised
Card/Skill security, keep Card/RPC/token origins separate, and support fixed
Bearer plus OAuth 2.0 Client Credentials from an external Authorization
Server. Inbound publication must authenticate before reading task bodies and
supports fixed Bearer plus externally issued RFC 9068 JWT validation; KodaX is
a Resource Server and does not issue production tokens.

User A2A configuration is version 2. Legacy non-empty version 1 files require
an explicit migration while every owning daemon is stopped. Per-Agent
`enabled` state blocks new admission after owner reconciliation without
cancelling in-flight work. Durable task routes, authentication realms,
registration ownership/revisions, metadata limits, and SSE resource ceilings
must remain fail-closed across reload, daemon restart, and shutdown.
Retained pre-realm task owners require an explicit stopped-server identity
mapping; normal A2A requests must neither guess nor dual-read legacy ownership.
Cross-principal capacity reservation must not hold a global lock across
workspace, session, or Runtime preparation. External-Agent owner-plane close
must use one bounded deadline (30 seconds by default), and daemon auto-start
must terminate abandoned startup children instead of leaving them detached.

### Governed Memory

FEATURE_260 (`v0.7.68`) adds a thin experimental Memory Agent over the existing
F228 Memory Control Plane. `@kodax-ai/kodax/experimental-memory` exposes scoped
`MemorySession` lifecycle, zero-wait passive recall, deliberate read-only
`query()`, bounded observations, and episode outcomes. The coding runtime may
offer the same deliberate path through `memory_recall`, but the Action LLM
retains final decision authority and recalled text remains low-authority.

Durable changes must continue through proposal, preview, fingerprint, and apply.
Identity and applicability checks, secret filtering, poisoning defenses, and
managed-path mutation guards are deterministic code boundaries. KodaX must not
add a second memory database, filesystem memory action space, resident Memory
Specialist, hidden-reasoning storage, or runtime self-modification through this
surface.

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

FEATURE_246 (v0.7.58) is the Claude-Code-parity evolution of this surface: the
Worker can now author and run a workflow inline via a model-callable
`run_workflow` tool (scout-then-author, ADR-047) instead of only generating
scripts through `/workflow create`. It adds structured child output
(`outputSchema`), the no-barrier `wf.pipeline` staged primitive, same-session
resume (`resumeFromRunId`), and nested `wf.workflow(...)`, and demotes the
context-blind `sideQuery` generator to a fallback for the explicit `/workflow
create` command and non-interactive / CI hosts. The neutral
run-lifecycle manager moves to `@kodax-ai/agent` (ADR-046) and the inline run is
async / idle-yield (ADR-049).

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
- Treating Worker threads as a security sandbox for malicious code.
- Exposing arbitrary process-local execution objects through the daemon
  protocol instead of typed Runtime services and DTOs.

## 8. Success Criteria

- Current docs describe the code that exists today.
- A new SDK consumer can choose the correct import path without reading source.
- A Runtime SDK consumer can choose inline, Worker, or daemon ownership and
  predict close, crash, restart, serialization, and permission behavior from
  the public guide.
- A CLI/REPL user can understand providers, sessions, permissions, skills, MCP,
  and child tasks without learning retired V1 terminology.
- A CLI, SDK, or embedded-product user can predict the effective compaction
  trigger, protected tail, preserved-query behavior, and success telemetry
  without reverse-engineering a host UI.
- A resumed Session can recover exact old user/assistant/tool details after
  compaction; root and persistent child Agents can search/read only their own
  lineage without loading the whole transcript into active context.
- An experimental-memory consumer can predict scope, read/write authority,
  recall behavior, and promotion boundaries without reading implementation code.
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
