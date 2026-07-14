# KodaX Detailed Design

> Last updated: 2026-07-12
>
> Current release baseline: `@kodax-ai/kodax@0.7.68`
>
> This DD describes current implementation structure. Retired V1 chain details
> were deleted from this active document; use git history and historical feature
> docs when archaeology is needed.

## 1. Scope

This document maps product behavior to current code ownership. It is not an API
reference and does not duplicate every type. It should answer three questions:

- Where does this behavior live?
- Which package owns the contract?
- What must not be coupled across package boundaries?

## 2. Published Package And Build Entries

The root package is `@kodax-ai/kodax@0.7.68`.

`package.json` exposes:

| Export | Build artifact | Source intent |
|---|---|---|
| `.` | `dist/index.js` | Root SDK and CLI-facing helpers. |
| `./agent` | `dist/sdk-agent.js` | Generic agent framework. |
| `./llm` | `dist/sdk-llm.js` | Provider abstraction. |
| `./coding` | `dist/sdk-coding.js` | Coding agent SDK. |
| `./media` | `dist/sdk-media.js` | Agent-layer media/input artifact helpers. |
| `./repl` | `dist/sdk-repl.js` | REPL/config/session helpers. |
| `./skills` | `dist/sdk-skills.js` | Focused skills subset. |
| `./mcp` | `dist/sdk-mcp.js` | Focused MCP subset. |
| `./session` | `dist/sdk-session.js` | Public session-management subset. |
| `./runtime` | `dist/sdk-runtime.js` | Stable host Runtime facade and daemon protocol/schema exports. |
| `./experimental-memory` | `dist/sdk-experimental-memory.js` | Opt-in governed Memory Agent and scoped session contracts. |

The build path is:

```text
npm run build
  -> tsc -b tsconfig.build.json
  -> copy built-in skills and provider capabilities
  -> scripts/build-bundle.mjs
  -> scripts/build-dts.mjs
```

The bundle build also emits `dist/semantic-worker.js`,
`dist/runtime-worker.js`, and `dist/constructed-handler-worker.js`. These are
explicit npm/binary sidecars; CI builds them before tests so clean checkouts do
not depend on source-only Worker fallback resolution.

Only `llm`, `agent`, `coding`, and `repl` are workspace package build roots.

## 3. Main Entry Points

| Area | Current file(s) | Notes |
|---|---|---|
| CLI bootstrap | `src/kodax_cli.ts` | Thin product entry for CLI and binary use. |
| Coding SDK | `packages/coding/src/agent.ts` | `runKodaX(options, prompt)` delegates through `Runner.run`. |
| Coding preset | `packages/coding/src/coding-preset.ts` | Declares the default coding agent and substrate executor. |
| Continuous SDK | `packages/coding/src/client.ts`, `running-session.ts` | `KodaXClient` and non-blocking session handle. |
| Runtime SDK | `src/sdk-runtime.ts` | One service facade for inline, Worker-hosted, and daemon ownership. |
| Runtime daemon | `src/runtime-daemon/` | Versioned protocol/schema, socket transport, owner state/lock, host, client, and process launcher. |
| Runtime Worker | `src/runtime-worker/` | MessagePort host that reuses the daemon dispatcher/client and supports hard termination. |
| Generic agent | `packages/agent/src/primitives/runner.ts`, `agent.ts` | Layer-A Runner and Agent primitives. |
| REPL | `packages/repl/src/index.ts` | `runInkInteractiveMode`, classic mode, config/session exports. |
| LLM providers | `packages/llm/src/providers/registry.ts` | Built-in aliases and custom provider registration. |

### 3.1 Runtime Host Facade

`createKodaXRuntime()` defaults to `{ mode: 'embedded', isolation: 'inline' }`.
`isolation: 'worker'` starts `dist/runtime-worker.js`, initializes the normal
runtime protocol over `MessagePort`, and always calls `Worker.terminate()` after
the shutdown grace period. `mode: 'daemon'` starts or attaches to a detached
`kodax daemon serve` owner at the profile-default endpoint. Custom daemon
endpoints are attach-only.

All forms expose `identity`, `sessions`, `runs`, `events`, `permissions`,
`workflows`, `config`, `catalog`, `mcp`, `artifacts`, `status`, and
`diagnostics`. The deployment-specific close contract is intentional:

| Form | `close()` | Sharing | `hardDispose` |
|---|---|---|---|
| inline embedded | closes private Runtime state cooperatively | no | false |
| Worker embedded | requests shutdown, then terminates Worker | no | true |
| daemon client | closes only that transport | yes | false |

`requirements.hardDispose` is checked for all three forms. Worker-only options
without `isolation: 'worker'`, or any explicit embedded isolation combined with
daemon mode, are rejected rather than ignored.

The Worker and daemon facades reuse `runtime-daemon/server.ts` and
`runtime-daemon/client.ts`; there is no duplicate service implementation.
Protocol methods are schema-validated, run results preserve serialized errors,
and pending event notifications are bounded while a remote subscription id is
being established. Non-terminal persisted runs become `interrupted` after an
owner restart. Reconnection is explicit; automatic replay of an unknown
in-flight operation is forbidden.

#### 3.1.1 Shared Coder daemon consistency (FEATURE_269)

`sessions.observe(sessionId, listener)` installs a server subscription first,
takes a stable snapshot, and returns its `runtimeId` plus cursor. The daemon
client buffers at most 256 handshake notifications; overflow returns
`resync_required`. Consumers replace their derived projection on reconnect or
Runtime change instead of merging two authority epochs.

Daemon mutations require the authenticated client's operation capability and
an `{ journalEpoch, operationId }` envelope. The append/fsync control journal
records accepted/dispatched/applied/rejected facts and binds reuse to principal,
method, resource, and canonical request digest. Accepted work becomes
`interrupted` after restart; dispatched work becomes `unknown`; neither is
automatically executed again. Corrupt control history quarantines all
mutations while read/status operations remain available. Run status and
versioned settings/grants use atomic temp-file + fsync + rename writes.

The packaged daemon has one random token per `homeDir + profile`, protected by
the local OS-user filesystem boundary. Its host grants the advertised scope
set to token-authenticated connections. `clientInfo.instanceId` is stable
attribution used by operation receipts; it is not a per-application secret.
Renderer/model surfaces must therefore remain behind a trusted host such as
Electron Main and never receive the profile token.

Same-session run creation allocates a monotonic `sessionOrder`. `after_turn`
input is a real queued continuation run and accepts the same operation
contract. `interrupt` is not advertised in v0.7.69 and returns an explicit
unsupported result. AskUser and permission registries expose pending lists and
first-winner responses over transport; persistent permission grants have one
daemon-owned revisioned store.

The credential reverse bridge stores only lease metadata. It requests the
secret from the registering connection for a bound provider/session/run and
places it in `AsyncLocalStorage` only for provider execution. An active scoped
credential never falls back to daemon environment on provider mismatch. The
Host Tool bridge creates an extension runtime only for the bound run, bounds
result size/time, memoizes invocation handling client-side, and classifies a
lost dispatched result as `host_outcome_unknown` without replay.

`homeDir + profile` has one Coder owner-policy file and one cross-process fence
shared by daemon and inline ownership. CAS policy changes make rollback to
inline sticky. Partner compatibility depends on the embedder retaining its
existing distinct inline data/sessions root; Partner does not acquire or write
the Coder owner fence.

`runs.start({ options })` is transport-safe data in Worker/daemon forms. The
client rejects functions, symbols, bigint, cycles, non-finite numbers, and
class instances. CLI integration additionally rejects known process-local host
bindings rather than deleting them. Host-specific callbacks/extensions must be
configured in the Runtime owner or use inline mode.

## 4. Coding Run Sequence

```text
runKodaX(options, prompt)
  -> applyFollowupEscalationToOptions
  -> Runner.run(createDefaultCodingAgent(), prompt, presetOptions)
  -> Agent.substrateExecutor
  -> runSubstrate
  -> provider stream + tool loop
  -> sidecar stop hooks as needed
  -> KodaXResult
```

Important contracts:

- `runKodaX` must return the full `KodaXResult` lifted through
  `RunResult.data`.
- `Runner.run` remains generic and cannot depend on coding-specific modules.
- Coding-specific state travels through `presetOptions`, not through global
  Runner configuration.
- Sidecar verifier can ask for revision, but the Worker remains the main task
  owner and final-answer author.

## 5. Provider Design

`packages/llm` owns provider concerns:

- `providers/registry.ts`: built-in alias registry and custom provider loading.
- `providers/provider-capabilities.json`: capability metadata snapshot.
- provider implementations: Anthropic, OpenAI, compatible providers, CLI
  bridges.
- `side-query.ts`: out-of-band provider calls for verifier-style use.
- shared stream/result types and error normalization.

Built-in aliases are:

```text
anthropic, openai, deepseek, kimi, kimi-code, qwen, zhipu,
zhipu-coding, zai-coding, minimax-coding, mimo-coding, mimo, ark-coding,
gemini-cli, codex-cli
```

Custom provider design must remain data-driven: protocol, base URL, API key env
var, default model, reasoning preset/profile, multimodal support, forced tool
support, timeout normalization, and session semantics belong in provider
config/capabilities.

## 6. Tool Registry

Built-in tools are declared in
`packages/coding/src/tools/tool-definitions.ts`.

Each definition carries:

- `name`,
- human-readable LLM description,
- JSON input schema,
- handler function,
- side-effect classification,
- optional classifier projection.

Tool handlers live beside their definitions under `packages/coding/src/tools`.
The registry consumes flat data; avoid hidden factory layers or circular
dependencies.

Current tool families:

- file: read/write/edit/multi-edit/insert/undo;
- shell and search: bash/glob/grep/web/code/semantic/LSP;
- repo intelligence: overview, changed scope/diff, module/symbol/process
  context, impact estimate, cyclic dependency checks;
- MCP: search/describe/call/resource/prompt;
- child tasks: dispatch/send/stop/output;
- product state: goals and todos;
- construction: tool generation, agent generation, self-modify staging.

## 7. Permissions And Guardrails

Permission enforcement is runtime behavior, not just prompt text.

Key concepts:

- permission modes come from REPL/CLI options and config;
- tools declare side-effect class;
- auto-mode uses classifier and guardrail logic before allowing risky tools;
- shell commands are classified before execution;
- trusted-local workflow scripts require explicit confirmation;
- verifier and stop-hook failures fail open where blocking would trap the user.

Do not add a new permission bypass path for convenience. Route effects through
the tool layer or an existing capability API.

## 8. Child Task Coordination

Child tasks are controlled through:

- `dispatch_child_task`,
- `send_message`,
- `task_stop`,
- `task_output`,
- `ChildTaskRegistry`,
- task abort/progress registries,
- idle-yield waiting.

The main Worker uses children for bounded parallel investigation or specialist
work. Children do not own final response. When pending children remain and the
main Worker has no useful work, idle-yield is the wait mechanism.

## 9. Stop Hooks And Sidecar Verifier

Generic stop-hook infrastructure lives in `packages/agent`.
KodaX-specific verifier behavior lives in `packages/coding`.

Design split:

- `packages/agent/src/runtime-middleware/llm-judge.ts`: generic LLM-judged
  stop-hook primitives.
- `packages/coding/src/agent-runtime/middleware/sidecar-verifier`: coding
  verifier prompt, gate, parser, and integration.
- content-aware gate skips trivial conversational turns.
- verifier accept is silent by default in UI but preserved in session/artifacts
  where applicable.

The verifier is not an in-chain Evaluator role. Do not represent it as a second
visible agent in current product docs.

## 10. Sessions And Storage

Session behavior spans agent, coding, and repl:

- `packages/agent/src/session-lineage`: lineage model and compaction helpers.
- `packages/repl/src/session/public-api.ts`: public session SDK.
- `packages/repl/src/interactive/storage.ts`: file-backed storage behavior.
- coding runtime records snapshots, runtime session state, and result metadata.
- `SessionData.uiHistory`: optional bounded replay cache for sanitized terminal
  tool groups. It is a display projection, not the canonical model transcript.

Public session APIs should preserve id-based usage while allowing storage layout
to evolve. New storage features must be backward-compatible with old JSONL
records whenever practical. Host code should treat `loadSession()` as active
model context, `loadFullTranscript()` as append-order scrollback, and
`uiHistory` as an optional replay hint.

Transcript entries expose both physical and logical identity. `entryId`
identifies the persisted lineage node; `logicalId` is stable across cloned or
forked copies; `sourceEntryId` points at the root physical source when an entry
is a clone. Hosts may fold display history by `logicalId`, while
`loadFullTranscript()` continues to return raw append-order scrollback.

Rewind audit markers are stored as `rewind_marker` lineage entries. They are
visible through `loadFullTranscript().transcriptEntries` for host UI/audit, but
they are context-silent: `loadSession()` and `loadFullTranscript().messages`
exclude them. The public `/session` subpath also exposes `compactSession` for
host-triggered imperative compaction.

## 11. Skills

Skills live under `packages/agent/src/capabilities/skills`.

Core modules:

- discovery and plugin paths,
- skill loader and frontmatter parsing,
- skill registry and resolver,
- LLM expansion,
- built-in skills copied during build.

The published `@kodax-ai/kodax/skills` subpath is a focused subset of agent
capabilities. It should not require importing the full coding package.

## 12. Media Input Artifacts

Media/input artifacts are agent-layer primitives under `packages/agent/src/media`.
The public `@kodax-ai/kodax/media` SDK entry and the legacy
`@kodax-ai/coding/media` source-side path both re-export that implementation.
Coding consumes validation/enqueue helpers from this layer; file and video
artifact contracts remain stable even when a provider route is not wired for
send.

## 13. MCP

MCP lives under `packages/agent/src/capabilities/mcp`.

Core modules:

- catalog/search,
- config,
- transport/runtime/manager,
- OAuth and protected-resource discovery,
- reverse capabilities,
- prompt/resource/tool bridging.

The published `@kodax-ai/kodax/mcp` subpath exposes a focused MCP surface.
Coding tools consume MCP through capability providers rather than duplicating
connection logic.

## 14. Governed Memory Runtime

The sole durable memory authority remains `packages/agent/src/memory-control`.
FEATURE_260 adds these focused layers:

- `packages/agent/src/experimental-memory`: public `MemoryAgent`, scoped
  `MemorySession`, policy, passive recall, deliberate query, observations,
  outcomes, and bounded episode close/review.
- `packages/agent/src/memory`: exact identity/applicability and managed memory
  path policy.
- `packages/coding/src/memory-runtime.ts`: coding integration, project identity,
  passive recall preparation, episode lifecycle, and review scheduling.
- `packages/coding/src/memory`: coding context/observation extraction,
  prompt-safe rendering, policy artifact hashes, and trace-only decision links.
- `packages/coding/src/tools/memory-recall.ts`: the session-bound read-only
  `memory_recall` tool; mutation tools share the managed-path guard.

Passive recall is prepared outside the Action-LLM turn and rendered only into
the dynamic prompt suffix. Deliberate query appends a normal tool call/result
tail. Neither path writes memory. Episode promotion first consults existing
claims, then emits at most a governed proposal or a deferred inbox record; the
existing preview/fingerprint/apply controller is the only durable write path.
`MemoryDecisionReceipt` stores identifiers and policy facts in tracing, not
hidden reasoning or a second event database.

## 15. Workflow Runtime

Workflow runtime has a strict boundary:

- `packages/agent/src/workflow`: domain-neutral runtime, event recorder,
  concurrency/cap accounting, abort, limit validation, public SDK types,
  workflow capsule validation/factory helpers, and backend injection.
- `packages/coding/src/workflows`: coding backend, built-ins, durable run graph,
  workflow capsule persistence/preflight, saved workflow discovery, and
  `/workflow` command integration.

FEATURE_217 is the v0.7.49 Dynamic Workflow product feature. The implementation
provides the substrate, JavaScript harness generation, background manager
behavior, pause/resume/stop/save, workflow-level worktree wiring, hard budget
checks, workflow capsule reuse, and advanced workflow pattern templates.

Generated workflows remain dynamic JavaScript, but the runner boundary is a
capability boundary: the script may hold loops, branches, intermediate results,
model routing, and calls to `wf.*`; it must not receive direct host access to
filesystem, shell, process, environment, module import, or network APIs. The
host handles `wf.*` as structured commands and applies existing permission gates
through child agents. `node:vm` with host objects is not a valid trust boundary
for generated workflows.

Saved generated workflows use a small capsule contract rather than a bare script
file. A capsule stores the generated source, validated manifest, task intent,
input examples, lightweight requirements (`git-repo`, `worktree-capable`,
tools, MCPs, skills, model tiers), and provenance. Full JSON Schema is deferred
until KodaX needs third-party generation, marketplace-style distribution, or
complex cross-tool requirement validation; v0.7.49 uses TypeScript contracts and
runtime validation to stay minimal.

FEATURE_229 (`v0.7.50`, released)
adds the process contract without changing the dynamic harness model. The agent
workflow package exposes `WorkflowProcessSnapshot`, `WorkflowProcessEvent`, and
`isFinalWorkflowProcessStatus`; the event model stays intentionally small:
`workflow_started`, `workflow_updated`, and `workflow_finished`, each carrying a
snapshot with phase/agent/item status. `WorkflowRunManager` updates and emits
snapshots after runtime events, while `createWorkflowLifecycleController`
provides host-owned stop/pause/resume, result/artifact reads, terminal-run
delete/prune, identity, and preflight controls. Coding commands and SDK callers
share the same process callbacks/read APIs; REPL inline/fullscreen surfaces
render snapshots only. KodaX Space and other SDK hosts configure invocation
policy, subscribe to process snapshots, and control runs through the SDK
controller instead of replaying slash commands or depending on REPL callback
text. This keeps progress semantics reusable and prevents terminal UI state from
becoming the hidden source of truth. F229 also preserves workflow source and
revision provenance (`source`, `sourceRunId`, `sourceWorkflowName`,
`savedWorkflowName`, `revisionOf`) plus `resultSummary` in the durable run graph.
Workflow child agents inherit or fail closed on parent guardrails, existing SDK
event callbacks, workflow logs, capsule preflight, and provider/model policy.
Durable run graphs remain audit/result records in this slice; they are not
cross-process executable checkpoints.

FEATURE_230 / FEATURE_234 (`v0.7.51`, released) add persistence readback on top
of that process contract. TUI sessions persist sanitized terminal tool groups in
`uiHistory`, with malformed siblings filtered rather than dropping the full
array. Workflow process metadata accepts optional `hostMetadata`, normalizes it
to a small string-only map, persists it in `run.json`, and echoes it through
`WorkflowProcessSnapshot` / process events after restart.

FEATURE_246 (`v0.7.58`, released) adds inline workflow authoring: a
model-callable `run_workflow` tool lets the Worker scout the codebase and author
+ run a workflow script in-chat (`packages/coding/src/workflows/`
author-via-worker / host / invocation-policy), routed through the unchanged
sandbox + static-validation + postcondition pipeline. It carries structured
child output (`outputSchema`), the no-barrier `wf.pipeline`, same-session resume
(`resumeFromRunId`), and nested `wf.workflow(...)`; the neutral run-lifecycle
manager moves to `@kodax-ai/agent` (ADR-046). ADR-044/046/047/048/049.

## 16. REPL Detail

`packages/repl` owns:

- `runInkInteractiveMode`,
- classic `runInteractiveMode`,
- config load/save and custom provider CRUD,
- permission helpers,
- command registry and slash commands,
- transcript rendering,
- session list/resume/fork/rewind/archive/tag flows,
- UI bridge for confirmations and prompts.

The REPL should not become the owner of core agent semantics. Product behavior
belongs in `coding`, reusable primitives in `agent`, and provider behavior in
`llm`.

## 17. Construction And Self-Modification

Construction tools allow staged creation and admission of tools and agents.
Self-modification tools stage proposed changes through explicit runtime paths.

Design constraints:

- staged artifacts must be validated before activation;
- admission invariants live in `packages/agent/src/admission`;
- construction runtime lives under `packages/coding/src/construction`;
- user approval remains required for irreversible or high-risk changes;
- generated capabilities should not bypass normal tool permissions.

Activated JavaScript handlers are materialized as immutable `.mjs` files and
loaded into a persistent per-handler Worker. Calls for one handler are FIFO.
`ctx.tools.*` is reverse RPC: the parent creates `CtxProxy` from the live tool
context and calls `executeTool`, preserving capability, live plan-mode,
constructed-depth, permission, and tool sandbox behavior. The Worker receives
only cloneable informational context plus a bridged `AbortSignal`; host
callbacks and mutable services remain in the parent.

Timeout awaits `Worker.terminate()` before rejecting. Revoke/dispose marks the
handler entry dead before terminating it, so active, queued, and future calls
cannot recreate an untracked Worker. Direct Node imports inside generated code
remain possible at runtime, so admission checks and approval still matter.

## 18. Observability And Eval

Behavior-affecting prompt changes must follow
`benchmark/EVAL_GUIDELINES.md`. Runtime changes should add focused Vitest
coverage near the source file. Eval outputs belong under benchmark result
locations, not in active docs.

Tracing lives under `packages/agent/src/tracing` and is inline after package
consolidation. It is reusable infrastructure, not a separate workspace package.

## 19. Current Anti-Patterns

Do not introduce:

- V1 role names as current runtime concepts;
- prompt-only permission rules without runtime checks;
- provider-specific prompt prose;
- SDK exports not backed by `package.json`, bundle entries, and dts output;
- new workspace packages for code that is only used by one package;
- REPL-only state as a dependency of headless SDK operation.
- ignored Runtime isolation/capability options that silently select a weaker
  ownership form;
- Worker or daemon boundaries described as a security sandbox.

## 20. Related Documents

- Product requirements: [PRD.md](PRD.md)
- High-level design: [HLD.md](HLD.md)
- Architecture decisions: [ADR.md](ADR.md)
- SDK embedder guide: [SDK_EMBEDDER_GUIDE.md](SDK_EMBEDDER_GUIDE.md)
- Release process: [release.md](release.md)
