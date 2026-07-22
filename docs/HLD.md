# KodaX High-Level Design

> Last updated: 2026-07-22
>
> Current implementation baseline: `v0.7.74`
> (`@kodax-ai/kodax@0.7.74` workspace package)
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

The published package is `@kodax-ai/kodax`. It exposes the root API plus eleven
SDK subpaths: `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`,
`/mcp`, `/session`, `/runtime`, `/a2a`, and `/experimental-memory`.

## 2. Layering

```text
CLI / REPL / Space / IDE / SDK / binary
          |
          v
src/sdk-runtime  - optional stable host facade (inline / Worker / daemon)
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
- `src/sdk-runtime.ts` composes public host services over `coding`; it is a root
  package facade, not a fifth workspace package and not a second agent engine.
- Inline capabilities such as skills, MCP, tracing, session-lineage, memory,
  and workflow are subtrees, not separate workspace packages.

## 3. Runtime Shape

KodaX separates the stable Runtime service contract from deployment ownership:

```text
                         same KodaXRuntime facade
                                  |
             +--------------------+--------------------+
             |                    |                    |
      embedded / inline    embedded / Worker      local daemon
      caller JS process      MessagePort IPC      pipe / Unix socket
      private ownership      private ownership    shared profile owner
             |                    |                    |
             +--------------------+--------------------+
                                  |
                          packages/coding engine
```

Inline is the compatibility and lowest-latency default. Worker isolation keeps
one private Runtime in a disposable V8 Worker and reuses the daemon protocol
dispatcher/client over `MessagePort`. Daemon mode owns the same embedded Runtime
in a detached OS process and allows multiple REPL, Space, IDE, or SDK clients to
share sessions, runs, permissions, events, config, MCP, and catalogs.

Daemon uniqueness is scoped by `homeDir + profile`. An atomic owner lock,
persisted PID/endpoint/token/runtime identity, and health handshake make
concurrent starters converge. Client `close()` detaches; explicit daemon stop
ends the shared owner. Restart marks persisted non-terminal runs interrupted;
clients reconnect explicitly and KodaX does not pretend to resume an unknown
in-flight provider/tool operation.

CLI and SDK auto-start use the same candidate lifecycle: the spawned process
remains referenced until its own PID is healthy, and only that candidate process
tree is reclaimed on exit, timeout, identity mismatch, startup cancellation, or
loss of the owner race. Healthy daemons detach and remain available for later
clients; there is no production zero-client idle reaper.

Packaged Electron daemon auto-start uses the application executable only as a
bootstrap Node host. A preloaded scrub import removes `ELECTRON_RUN_AS_NODE`
before daemon application code loads, so ordinary children do not inherit it.
This requires Electron's default-enabled `RunAsNode` fuse; fuse-disabled hosts
must start an ordinary Node/CLI daemon and attach to it.

Shared Coder daemon control is fact-based rather than connection-owned. One
atomic `sessions.observe` call returns the authoritative transcript/settings/
run/interaction projection and installs the post-snapshot event stream without
a gap. Mutations carry daemon-epoch operation identities, same-session runs
receive stable order, and settings/persistent grants use revision CAS. The
durable control journal never replays an operation whose external effect may
already have started. Runtime restart changes `runtimeId`; queued work becomes
interrupted with no effect, while active external work is explicitly unknown.
The packaged transport authenticates a single local OS-user/profile trust
domain with a random profile token and user-only pipe/socket access. Host-
granted scopes gate RPC families; stable client instance IDs provide
attribution and retry binding, not independent authentication. Per-application
credentials between mutually distrusting same-user processes are not part of
the current local-daemon contract.

Space-only integration stays behind two narrow reverse bridges. A keychain
broker supplies a provider/run-scoped credential directly into an in-memory
provider context; a Host Tool lease injects only the explicitly bound run's
capabilities. Both registrations are authenticated-client/connection owned,
never ambient profile capability. Dispatched Host Tool calls are never blindly
replayed. Daemon and inline Coder share one owner policy fence, including a
sticky inline rollback mode. Partner remains a private inline Runtime with a
distinct product data namespace and does not participate in the Coder fence.

Worker and daemon calls cross a typed DTO boundary. Process-local callbacks,
class instances, `AbortSignal`, cyclic values, and extension runtime objects do
not silently cross or execute in the client. Runtime methods bridge abort,
events, permissions, artifacts, config, and owner-loaded extensions instead.

Auto Mode is likewise an owner-plane concern. For an `auto` session, the
Runtime holds one session-scoped LLM/rules guardrail and runs it before the
generic permission bridge. Only an explicit guardrail escalation reaches a
shared pending-permission request; a rules fallback updates the persisted
engine for later turns. Classifier model/timeout, project boundary, execution
directory, and provider/model are part of the guardrail reuse key, so a setting
change gets a fresh guardrail rather than stale classification state.

The classifier input boundary is owned by `classify`, not by individual
guardrail callers. It projects the current action independently and sanitizes
the accumulated Runner transcript into a UTF-8-byte-bounded factual subset.
This prevents a prior multi-megabyte tool result from consuming the current
permission verdict's transport/inference deadline.

The public Runtime contract mirrors that boundary. REPL and root SDK entries
export one pure Auto settings resolver plus its config-loading wrapper;
Session state owns classifier model, timeout, and speculative window through
the same serialized mutation queue. Auto-started daemon clients require
`runtimeAutoModeGuardrail` v3, whose Runtime-issued opaque exact grant
suggestions and concrete matchers extend the v2 reliability contract; version
negotiation treats requirements as minimums. Side-query diagnostics report only
coarse, observed timing/retry facts, while guardrail spans start before and end
after the awaited callback.

First-run provider setup is a pre-Runtime CLI branch. A REPL-layer readiness
inspection consults the canonical provider catalog, environment, and
core config; a standalone terminal interaction produces a non-secret choice;
and a revision-checked atomic mutation writes only provider metadata. The CLI
then exits for terminal environment refresh. This branch never initializes the
daemon, Runtime, session, extensions, or provider network client.

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

- 16 built-in provider aliases,
- custom provider registration,
- OpenAI- and Anthropic-compatible protocols,
- CLI bridge providers for Gemini CLI and Codex CLI,
- stream normalization,
- effort-first reasoning and request-timeout config normalization,
- capability metadata and provider policy gates,
- side-query support for verifier and other out-of-band LLM calls.

The 2026-07-16 Kimi snapshot makes `kimi-k2.7-code` the public default, keeps
HighSpeed/K2.6/K2.5 as explicit routes, and treats thinking support as a
route-specific wire contract rather than a generic compatible-provider toggle.
The separate `kimi-code` subscription alias keeps `kimi-for-coding` stable and
adds `k3-256k` plus a 1,048,576-token `k3` tier. Both K3 choices address the
upstream `k3` model and use `thinking.effort` for reasoning intent.

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

Generated constructed handlers are a narrower coding-layer isolation case.
Each active handler runs in a persistent Worker, while `ctx.tools.*` calls
return to the host through reverse RPC and still traverse capability,
plan-mode, recursion-depth, permission, tool-registry, truncation, and OS
sandbox checks. Handler Workers are fault boundaries, not security sandboxes.

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
- coordination: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `interrupt_agent`, `list_agents`, `agent_output`;
- product state: goals, todos, sessions, manual lookup;
- extension capabilities: MCP calls, MCP resources, MCP prompts;
- construction: tool generation, agent generation, self-modify staging.

Permission modes and auto-mode guardrails must operate on tool side effects and
runtime context, not on prompt-only convention.

The permission boundary treats `gitRoot` as an allowed repository boundary and
`executionCwd` as the base for relative operands. It never promotes quoted
script or regular-expression source into a filesystem path. Permission events
carry a bounded, credential-redacted JSON summary plus the effective execution
directory. `exit_plan_mode` is part of a tool scope only when a trusted host
has supplied its plan-approval callback.

## 7. Child Tasks

Child work is explicit and tool-driven. The main Worker can dispatch a child,
send it follow-up messages, stop it, and inspect output. Idle-yield is the
canonical waiting behavior when useful main work is exhausted and child tasks
remain in flight.

Children are a coordination primitive, not a replacement for the main Worker.
The main Worker owns final synthesis and user communication.

User follow-ups are routed with the session-root Actor queue id. Queue display,
idle-yield wakeups, and prompt consumption use the same scope, preventing one
session or child actor from draining another session's pending input.

## 8. Sessions

KodaX sessions are local JSONL records with branchable lineage. Session
requirements span both product and SDK:

- CLI and REPL resume/list/fork/rewind flows;
- SDK session APIs via `@kodax-ai/kodax/session`;
- session snapshots and runtime state persistence;
- durable terminal tool-card replay from sanitized `uiHistory`, with canonical
  `messages` / `lineage` remaining the source of truth;
- searchable bare-resume selection that defers the full CLI load until a
  selection, returns Esc directly to the invoking terminal, and hands stdin to
  the resumed REPL only after selection;
- original per-event history timestamps retained through replay rather than a
  render-time timestamp applied to every message;
- tags, filters, archive state, and project-aware storage evolution;
- compatibility with old session records where practical.

Session management is a product feature, not merely a debug log.

Major context compaction is an always-on, request-bound Session transaction.
One normalized policy takes the minimum of a 15-90% trigger (75% default), an
optional positive absolute token threshold, and physical provider capacity.
The protected recent tail is 20% of that effective trigger. Everything older
is one complete eligible prefix: it is summarized once, or map/reduced only
when one summary request cannot physically fit. A synthetic user checkpoint
combines the semantic summary with an exact genuine-user-query ledger.

Compaction never partially replaces canonical history. A successful result
must reduce tokens, fit the complete provider request, and commit before
success callbacks/events fire. Canonical events are keyed by root/child
`contextId` and revision. Runtime observation carries bounded transcript
slices; revision-bound pages and lossless chunks recover data that cannot fit
inside one daemon frame.

Exact transcript persistence has a stricter boundary than semantic context
replacement. The compaction transaction supplies the root host with the exact
pre-compaction messages, including messages created in the active Run. The host
commits those entries to main JSONL or the island sidecar before it may reclaim
old payload from memory. Sidecar flush precedes slim-main publication; stable
entry IDs deduplicate the safe main/sidecar overlap after an interrupted write.
The commit callback is awaitable, so no next provider request or canonical
finished event can overtake durability. Runtime owns this boundary after a
client crosses into embedded or daemon execution. Child compaction cannot
mutate root Session lineage. Runtime-backed REPL projections are not additional
Session writers. A compact that occurs before the first routine snapshot creates
the Session from explicit Run metadata, while a failed durability callback
restores the tentative context revision and retains the exact payload.

Persisted transcript recovery is a read plane, not long-term semantic memory.
Runs backed by full-lineage storage receive the bounded
`session_history_search` and `session_history_read` pair. Root Runs bind their
root Session; persistent child Runs bind separately minted hidden worker
Sessions and cannot read root lineage. Search uses deterministic Unicode
lexical/metadata ranking and returns revision-bound entry citations; read
returns exact fixed-size chunks. Runtime and daemon hosts use the same evidence
identity through transcript search plus existing page/chunk transport. No
vector store, background extractor, or automatic old-instruction reinjection
is added. The evidence plane excludes system/control content, hidden-only
bodies, synthetic current/legacy compaction checkpoints, and raw payload
placeholders from search and direct read. History discarded by a legacy build
before exact sidecar persistence is not reconstructable.

## 9. Skills, MCP, And A2A

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

A2A remains a root integration edge rather than an agent-layer wire concern.
`src/a2a` composes A2A 1.0 Card discovery, JSON-RPC/SSE execution, inbound
Runtime publication, configuration reconciliation, and the protocol-neutral
external-Agent plane. Version 2 configuration adds per-Agent desired-state
activation, outbound OAuth 2.0 Client Credentials, and inbound RFC 9068 JWT
Resource Server validation while retaining fixed Bearer compatibility.

Trust is split by authority: Card, Agent RPC, and Authorization Server origins
are independently constrained; a stable authentication realm scopes durable
task ownership; registration revisions and management ownership fence hot
reloads; immutable internal route snapshots preserve admitted work after
registration changes. Inbound authentication precedes task/body disclosure,
and synchronous global capacity reservation plus bounded SSE resources prevent
one client from exhausting the server without serializing slow preparation for
other principals. Retained pre-realm tasks stay hidden unless a stopped
operator supplies an exact owner migration. KodaX consumes externally issued
tokens and never owns production signing or issuance. Owner-plane shutdown
uses one 30-second default deadline across admitted work and executor disposal;
obsolete cleanup runs after the serialized registration mutation lane. Daemon
auto-start retains ownership of startup children until readiness and terminates
abandoned children on timeout or cancellation.

## 10. Governed Memory Runtime

FEATURE_260 adds a thin experimental Memory Agent without creating a second
long-term memory plane. `packages/agent/src/experimental-memory` owns the
domain-neutral `MemoryAgent` / `MemorySession` contracts; the existing
`packages/agent/src/memory-control` plane remains the sole governed persistence
authority. `packages/coding` owns coding observations, prompt-safe rendering,
the `memory_recall` tool, Action-LLM integration, and trace correlation.

Passive recall is computed before the run and injected as a bounded dynamic
suffix, so it adds no extra LLM wait. Deliberate `query()` / `memory_recall` is
read-only and initiated by the Action LLM. Episode review may create a governed
proposal or defer it to the scoped inbox; only the existing
proposal/preview/fingerprint/apply path can mutate durable memory. Exact scope,
secret filtering, poisoning checks, and managed-path guards remain
deterministic. Decision receipts are trace-only references and never store
hidden reasoning.

The public opt-in entry is `@kodax-ai/kodax/experimental-memory`; it does not
become an implicit dependency for consumers of the stable root or Runtime SDK.

## 11. Workflow Runtime

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

CAP-099 extends the host transcript contract with clone provenance. Public
transcript entries include stable `logicalId` and optional `sourceEntryId` so
Space-style hosts can fold cloned or forked history precisely, without parsing
message text or relying on timestamp heuristics. The transcript API still
returns raw append-order scrollback.

FEATURE_246 (`v0.7.58`, released) is the largest workflow change since F229: the
Worker authors and runs workflows inline through a model-callable `run_workflow`
tool (scout-then-author), running generated scripts through the same sandbox +
static-validation + postcondition pipeline. It adds structured child output
(`outputSchema`), the no-barrier `wf.pipeline`, same-session resume
(`resumeFromRunId`), and nested workflows; the neutral run-lifecycle manager is
lifted to `@kodax-ai/agent` (ADR-046) and the inline run is async / idle-yield
(ADR-049). See ADR-044/046/047/048/049.

## 12. REPL And CLI

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

## 13. Design Constraints

- Do not reintroduce retired V1 chain abstractions into current docs or prompts.
- Do not add a new workspace package unless there is a real independence need.
- Do not expose source-only subpaths as published root-package subpaths unless
  `package.json`, bundle build, and dts generation all support them.
- Do not make SDK consumers depend on REPL-only APIs for headless use cases.
- Do not make provider-specific behavior leak into generic prompt prose.
- Do not add a generic execution manager when a whole-Runtime ownership form or
  an existing typed tool/workflow service is the real contract.
- Do not describe Worker `resourceLimits` as hostile-code containment.

## 14. Related Documents

- Product requirements: [PRD.md](PRD.md)
- Detailed design: [DD.md](DD.md)
- Architecture decisions: [ADR.md](ADR.md)
- Active roadmap: [FEATURE_LIST.md](FEATURE_LIST.md)
- Feature index: [features/README.md](features/README.md)
