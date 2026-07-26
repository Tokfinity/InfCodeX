# KodaX Detailed Design

> Last updated: 2026-07-26
>
> Current release baseline: `v0.7.77` release candidate
> (`@kodax-ai/kodax@0.7.77`)
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

The root workspace package is `@kodax-ai/kodax@0.7.77`. The release candidate
adds pattern-aware adaptive AMA and governed event-triggered memory
intervention, closes active-run interrupt finalization races, and adds public
Kimi K3 without changing the Kimi Code `k3-256k` default established in
v0.7.76.

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
| `./a2a` | `dist/sdk-a2a.js` | Bidirectional A2A 1.0 client/server integration edge. |
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
| CLI bootstrap | `src/kodax_bootstrap.ts`, `src/kodax_resume.ts`, `src/kodax_cli.ts` | The bootstrap handles bare `-r` with a lightweight picker, then loads the full CLI only after selection. |
| Coding SDK | `packages/coding/src/agent.ts` | `runKodaX(options, prompt)` delegates through `Runner.run`. |
| Coding preset | `packages/coding/src/coding-preset.ts` | Declares the default coding agent and substrate executor. |
| Continuous SDK | `packages/coding/src/client.ts`, `running-session.ts` | `KodaXClient` and non-blocking session handle. |
| Runtime SDK | `src/sdk-runtime.ts` | One service facade for inline, Worker-hosted, and daemon ownership. |
| Runtime daemon | `src/runtime-daemon/` | Versioned protocol/schema, socket transport, owner state/lock, host, client, and process launcher. |
| Runtime Worker | `src/runtime-worker/` | MessagePort host that reuses the daemon dispatcher/client and supports hard termination. |
| Generic agent | `packages/agent/src/primitives/runner.ts`, `agent.ts` | Layer-A Runner and Agent primitives. |
| REPL | `packages/repl/src/index.ts` | `runInkInteractiveMode`, classic mode, config/session exports. |
| First-run setup | `packages/repl/src/common/provider-setup.ts`, `packages/repl/src/interactive/provider-setup.ts`, `src/provider-setup-cli.ts` | Catalog-backed readiness inspection + revision-checked non-secret persistence, standalone pre-Runtime terminal flow, and CLI eligibility gate. |
| LLM providers | `packages/llm/src/providers/registry.ts` | Built-in aliases and custom provider registration. |

### 3.1 Runtime Host Facade

`createKodaXRuntime()` defaults to `{ mode: 'embedded', isolation: 'inline' }`.
`isolation: 'worker'` starts `dist/runtime-worker.js`, initializes the normal
runtime protocol over `MessagePort`, and always calls `Worker.terminate()` after
the shutdown grace period. `mode: 'daemon'` starts or attaches to a detached
`kodax daemon serve` owner at the profile-default endpoint. Custom daemon
endpoints are attach-only.

When the host is packaged Electron, daemon auto-start launches through an
internal Node bootstrap and scrubs `ELECTRON_RUN_AS_NODE` before loading the
daemon entry. Ordinary user children inherit the scrubbed environment. The
path requires Electron's `RunAsNode` fuse; disabling it requires an ordinary
Node/CLI-started daemon and attach-only SDK mode.

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

`RuntimeSessionSettings` carries `permissionMode`, `executionCwd`,
`autoModeEngine`, `autoModeClassifierModel`, and `autoModeTimeoutMs` alongside
the provider/model/reasoning fields. The Runtime validates a positive timeout,
persists these settings, advertises them through daemon capability negotiation,
and uses them to build a session-owned auto guardrail. Changing classifier
model or timeout invalidates the cached guardrail; an automatic LLM-to-rules
fallback updates `autoModeEngine` for the next run.

`createReplRuntimeAutoModeControl()` serializes `syncSettings()` and
`setEngine()` writes per Session. Ink renders the configured engine immediately
when Auto is selected and reconciles with `getAutoModeStats()` or settings
events; a missing observation never produces a transient fourth/bare Auto state.

For Auto permission mode, an omitted engine is normalized to `llm` for both
preflight and guardrail ownership. Missing/blank/malformed classifier identity
raises `RuntimeAutoModeConfigurationError` before provider or permission work.
`packages/coding/src/guardrails/auto-mode/classify.ts` owns transcript
sanitization and request ceilings: 2 KiB per historical tool result, 8 KiB
serialized transcript, 16 KiB action, 32 KiB prompt, and 256 output tokens.
The 20-second deadline remains a bounded end-to-end side-query deadline.

`resolveAutoModeSettings()` is the pure authority for config/environment/default
precedence; `loadAutoModeSettings()` performs I/O then delegates. Runtime
persists `autoModeSpeculativeWindowMs` as a non-negative safe integer and
propagates it through effective settings, active/queued records, cache identity,
and guardrail bootstrap. `0` is preserved rather than treated as absent.

Daemon and embedded capability metadata advertise
`runtimeAutoModeGuardrail.version = 3`, retaining the effective 20-second
timeout, 500 ms default speculative window, bounded-input flag, and diagnostics
version while adding Runtime-issued opaque exact permission-grant suggestions
and concrete matchers. Capability checks accept `advertised >= required`;
auto-start can safely fence and replace an idle v1 or v2 daemon, but
attach-only/busy paths return a recoverable error without mutation.

`sideQuery()` owns a fixed-field `SideQueryDiagnostics` envelope: provider,
model, effective timeout, elapsed time, retry count/wait, optional first-output
and stream durations, and a coarse terminal phase. It copies no prompt or
response content and does not invent connect/queue timings unavailable from
provider adapters. Guardrail tracing creates a pending child span before the
callback and finalizes its verdict/error after the await.

On a bare TTY launch, `src/kodax_cli.ts` runs provider readiness after normal
environment/config preparation but before Runtime/extension/session creation.
Only `needs-provider` enters the setup interaction; selected providers missing
credentials preserve their existing error path, and malformed config is never
overwritten. `kodax setup` invokes the same interaction explicitly. The writer
uses a SHA-256 content revision, same-directory temp file, restrictive mode,
and atomic rename while preserving unrelated keys.

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
contract. `interruptInput:1` routes input into the current active Actor Run's
process-local queue. A tool boundary drains accumulated interrupt inputs FIFO,
preserves their separate user-message boundaries, and emits one ordered
`run.input.delivered` batch before the next LLM request. When a managed Runner
or ordinary coding loop recognizes a terminal candidate, it synchronously
closes admission before any asynchronous finalization, drains every input
accepted before that line, and continues the same Run when the batch is
non-empty. If that batch arrives at the configured iteration ceiling, the loop
reserves exactly one additional generation turn so delivery cannot be recorded
without model consumption. Admission reopens only after the batch is committed,
or while idle-yield is waiting on a wake path that guarantees another model
turn. Both the managed Runner and ordinary coding substrate permit only a fixed
internal number of lifecycle-reserved iterations beyond the configured ceiling
and close admission before the final absolute generation starts. An admitted
manifest's `maxIterations` remains a non-expandable governance cap. Failure,
cancellation, and terminal cleanup close admission before asynchronous teardown.
Ordinary coding rotates live-turn attribution for the queued prompt and commits
the preceding assistant response before continuing a COMPLETE signal. The
mechanism creates no continuation Run.
Run status exposes queued/delivered/terminal input state; terminal cleanup
removes undelivered queue entries. Runs without a same-Run safe Actor boundary
return `unsupported_capability`, while queued or terminal targets return
`stale_run`. Submissions after the atomic terminal boundary return
`interrupt_window_closed`; clients must restore the unsent input for retry
rather than silently converting it to `after_turn`. External aborts and
terminal errors also close the window. Non-terminal observer diagnostics do not
close a still-consumable window. AskUser and permission
registries expose pending lists and first-winner responses over transport;
persistent permission grants have one daemon-owned revisioned store. A concrete
permission request may expose opaque
Runtime-issued Session and persistent grant suggestions. Clients can select a
suggestion id but cannot submit or widen its hidden matcher. Command matchers
bind the normalized shell command fingerprint, effective cwd, shell family,
background mode, executable, and argv fingerprint; quoting or wrapper changes
remain distinct. Path matchers are limited to known built-in file tools and
bind one tool to one normalized absolute path, not to one Write/Edit body.
Extension, MCP, and other unknown tool shapes use an exact-call matcher even
when their input happens to contain a field named `path`, and are eligible only
for an in-memory Session grant. High-risk, absolute-deny,
dangerous-pattern, and dynamically expanded shell calls never receive a
persistent suggestion. New grants are revisioned and audited; legacy
`toolName`/`sessionId` grants remain listable, matchable, and revocable but are
never created by the new flow.

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
- AMA strategy is selected stage by stage from the shared pattern catalog.
  Actor turns store validated opaque metadata; coding derives a bounded,
  fact-only `PatternTrace` for the existing Sidecar rather than adding a
  scheduler or quality gate.

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

For `kimi`, `providers/provider-capabilities.json`, `cost-rates.ts`, and the
OpenAI-compatible request serializer jointly define the public K2.7
Code/HighSpeed and K2.6/K2.5 contract. K2.7 rejects thinking-disable requests;
K2.6 emits the required wire toggle. Optional live-key tests are gated and do
not run during the default offline suite.

For `kimi-code`, the default is the direct upstream `k3-256k` Model ID.
`kimi-for-coding` remains available for K2.7 Code beside the 1,048,576-token
`k3` tier and `kimi-for-coding-highspeed`. The Anthropic- and OpenAI-compatible
serializers carry K3 reasoning through `thinking.effort`, default omitted
effort to `high`, and preserve explicit disable semantics. Media capability
metadata keeps `k3-256k` image-capable and video-unsupported. Public Kimi and
Kimi For Coding credentials remain separate.

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
- an auto session uses its Runtime-owned guardrail before the generic permission
  hook; only a guardrail `escalate` creates a shared broker request;
- shell commands and other classifier-eligible tools are classified before
  execution, while safe allow verdicts do not become pending permissions;
- trusted-local workflow scripts require explicit confirmation;
- verifier and stop-hook failures fail open where blocking would trap the user.

`gitRoot` constrains the session repository boundary. `executionCwd` is the
working directory used to resolve relative operands and is independently
validated to remain inside that boundary. Path extraction must not treat quoted
Python, JavaScript, or regular-expression source inside a shell command as a
path. Permission `inputPreview` is a bounded, credential-redacted JSON object
that remains parseable even for a large write input and records the effective
execution directory. Tool exposure removes `exit_plan_mode` unless an
`events.exitPlanMode` approval bridge exists for the active run.

The default terminal bindings keep Shift-Tab for the three permission modes and
Shift+Enter for newline input. Rapid Shift-Tab changes enter the per-Session
Runtime settings queue in input order, so the final visible mode is also the
final persisted mode. `Auto[RULES]` remains a valid sticky fallback state;
`/auto-engine llm` changes it explicitly.

Do not add a new permission bypass path for convenience. Route effects through
the tool layer or an existing capability API.

## 8. Child Task Coordination

Child Agents are controlled through one Runtime-owned Actor/Turn tree:

- `spawn_agent`, `send_message`, and `followup_task` start or steer work;
- `wait_agent` yields for scoped mailbox activity; `list_agents` observes the
  current tree; `agent_output` reads a known Actor/Turn result;
- `interrupt_agent` requests active-turn cancellation;
- one scheduler, mailbox, event stream, and root-owned work budget cover native,
  constructed, Workflow-owned, and external turns.

The model-visible `wait_agent` schema contains only `timeout_ms` (10 seconds to
1 hour, default 2 minutes). The handler subscribes to the caller's MessageQueue
with read-register-recheck, does not consume the wake message, and returns one
of `mailbox`, `user_input_pending`, `wait_expired`, or `interrupted`. The
Runner's next-turn hook drains background priority only when the previous tool
set included `wait_agent`. Ordinary tools drain user-priority traffic: real
user prompts remain real turns, while urgent Actor follow-ups remain synthetic.

Message mode determines transcript authorship. `prompt` becomes a real user
turn. `agent-message`, `task-notification`, and `system-reminder` become
synthetic Runtime context; completion metadata is preserved for deterministic
Todo/receipt handling. Actor event snapshots and long-poll remain separate SDK
and daemon APIs, so removing raw-event selectors from the model tool does not
remove SDK telemetry capability or require a control-plane version bump.

Completion delivery is crash-recoverable. Actor snapshots persist completion
messages, acknowledgement IDs, and an explicit pending-root-delivery set;
initialization republishes only completions in that set. Legacy snapshots lack
the set and do not infer replayability from historical mail. The Coding
projection deduplicates by scoped child-task
`turnId`, so a hard restart restores a missing process queue while a same-process
Runtime rebuild does not duplicate an entry that is already pending.

Actor identity outlives an individual Turn. Capability ceilings are inherited,
concurrency and budget admission are atomic, and stale mutations conflict on
the Actor revision instead of silently joining newer work. The main Worker uses
children for bounded parallel investigation or specialist work. Children do
not own final response. When pending children remain and the
main Worker has no useful work, idle-yield is the wait mechanism.

`packages/coding/src/orchestration/pattern-catalog.ts` is the shared semantic
source for the six AMA/Workflow pattern names.
`pattern-strategy.ts` validates optional `quality_strategy` metadata at the
coding boundary, while `pattern-trace.ts` derives delegated-stage facts from
trusted Actor Turn metadata and result envelopes. The agent controller stores
the metadata opaquely and prevents a running Turn from switching strategy.
Root-only work creates no synthetic stage; old or unsupported paths carry no
fabricated trace.

The queue routing key for user follow-ups is derived from the session and root
Actor. MessageQueue, idle-yield wake subscriptions, StreamingContext, and the
Ink queued-input view all filter by that same key; a process-global
`agentId: undefined` bucket is not a REPL session contract.

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
- when that gate fires, the Sidecar packet may include a bounded
  `PatternTrace` and quality signals as context, never as proof; a `revise` or
  `blocked` verdict may carry one focused optional strategy recommendation.

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

`FileSessionStorage.loadFullLineage()` is the storage-owned merge of the main
JSONL and island sidecar. Sidecar entries win for the same stable physical ID
because they carry the exact pre-eviction payload. Public transcript projection,
Runtime search, and model-facing history recovery all consume this one merged
lineage rather than independently guessing from `[compacted]` placeholders.
One shared evidence predicate excludes system/control entries, hidden-only
content, current and legacy synthetic history checkpoints, and compacted-body
placeholders from both search and direct read. Metadata ID ranking activates
only for a sufficiently specific direct identifier query, avoiding accidental
matches from short terms embedded in random IDs.

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

## 13. MCP And A2A

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

A2A lives under `src/a2a` and is published through `@kodax-ai/kodax/a2a`:

- `config.ts` reads version 1 compatibility input and writes version 2; a
  non-empty legacy file needs an explicit stopped-daemon migration.
- `client-auth.ts`, `security.ts`, and `client-executor.ts` select one complete
  advertised security alternative, resolve fixed Bearer or OAuth 2.0 Client
  Credentials just in time, and keep Card/RPC/token origins separate.
- `server-auth.ts` validates external-issuer RFC 9068 JWT access tokens/JWKS;
  the compatibility Bearer profile and custom authentication adapters expose a
  stable `securityRealm` for task ownership.
- `task-migration.ts` provides an explicit offline exact-owner rekey for
  retained pre-realm tasks. Normal serving never dual-reads the legacy key.
- `runtime-config.ts` applies disables/removals before discovery and mutates
  only source-owned registrations with revision/owner preconditions.
- `server.ts` authenticates before body/task lookup, reserves global capacity
  synchronously before slow preparation, replays after subscription, drains
  admitted handlers on close, and enforces fixed per-task/per-server/per-stream
  SSE limits.

The external-Agent plane persists an internal immutable registration snapshot
for each admitted route. It is not part of the public task DTO and contains no
resolved credential; it keeps input/cancel/reconcile routing stable across
registration replacement/removal and Runtime restart. `closeTimeoutMs` is a
positive finite owner-plane override with a 30-second default shared by admitted
work and executor disposal. Obsolete executor cleanup happens after the
serialized persistence/publication lane, while daemon auto-start waits on and
terminates abandoned child process trees. CLI and SDK callers share that exact
candidate lifecycle; detachment occurs only after the candidate PID is healthy.
The repository test harness may additionally bind a daemon to its Vitest worker
for abnormal worker-loss cleanup, but production daemon lifetime remains
explicitly administered rather than client- or idle-owned.

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

Routine exact recall remains synchronous and renders only into the dynamic
prompt suffix. FEATURE_275 adds `MemorySession.intervene()` for three sparse
events: tool failure, verification failure, and committed context compaction.
The coding loop projects current objective/open todos, then combines them with
recent prompt-safe observations and a fresh governed pack. Deterministic exact
pins run first; an optional host `memoryRecallRunner` may add only exact offered
IDs. Selection is awaited before the Action-LLM request, capped at three
candidates and three calls per Session, and discarded if the observation
sequence changes.

The central prompt-safe claim gate runs before selection and again before the
evidence envelope. Private/sensitive observations are excluded; suspicious
tool text becomes a neutral source reference. The daemon DTO explicitly rejects
the function-valued runner. Deliberate query appends a normal tool call/result
tail. None of these paths writes memory. Episode promotion first consults existing
claims, then emits at most a governed proposal or a deferred inbox record; the
existing preview/fingerprint/apply controller is the only durable write path.
`MemoryDecisionReceipt` stores candidate IDs, selected candidate IDs, exposed
evidence refs, event triggers, and policy facts in tracing, not hidden reasoning
or a second event database.

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

The bare resume path follows the same separation: `src/kodax_bootstrap.ts`
starts the picker without importing the complete CLI, pauses/references stdin
only for a selected-session handoff, and pauses/unreferences it on Esc. Session
replay uses the persisted event timestamp for each message/tool record instead
of one `Date.now()` value at render time.

`findMostRecentResumableSession()` is the shared REPL/CLI selector. It requests
up to 1000 newest summaries and returns the first `msgCount > 0` record. The
coding-layer CAP-043 middleware mirrors that rule without depending on REPL.
Classic startup now restores the same messages, UI history, lineage, artifact
ledger, extension state, title, tag, Session ID, and normalized runtime/workspace
identity as Ink. Explicit IDs short-circuit discovery in both layers.

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

## 20. v0.7.74 Large Compaction Chain

The agent layer owns one normalized policy:

```text
percent = clamp(triggerPercent ?? 75, 15, 90)
effective = min(contextWindow * percent, positive(triggerTokens), physicalCapacity)
protectedTail = floor(effective * 0.20)
```

Automatic triggering is request-bound and cannot be disabled. One major wave
partitions atomic tool groups into the complete eligible prefix and protected
raw tail. It summarizes the full eligible prefix once, using map/reduce only
when that request cannot physically fit. Temporary summaries never mutate
canonical history. The committed synthetic user checkpoint combines the
structured semantic summary with an exact JSONL ledger of genuine user queries.
Emergency fallback returns the original array when mandatory content cannot be
reduced. Its gate accepts a candidate only when token count strictly decreases
and the full request fits physical capacity; only then may success stats fire.

Coding owns per-context anti-thrash and stable root/child attribution. The
canonical post-commit callback increments `contextRevision`; Runtime projects it
as `context.compaction.finished`. KodaX Space updates its Session meter only for
root facts.

Runtime observations carry a bounded `RuntimeTranscriptSlice`. Older pages use
opaque revision-bound cursors; a single oversized entry uses bounded
`base64-json` chunks. The legacy daemon full-transcript method is capped at 512
KiB and points callers to page/chunk recovery before the transport's 8 MiB
frame can be approached.

The compaction update carries `preCompactionMessages` only to the in-process
host callback. It never enters the replacement provider input or a serialized
live event. The root host first reconciles those messages into lineage, then
adds the compaction island. `applySessionCompaction()` no longer performs
payload eviction itself. After `appendSessionDelta()`/`save()` acknowledges the
exact snapshot, the host may call `evictOldIslandMessageContent()` on the live
lineage. `onCompactedMessages` is awaitable: the next provider request and
`context.compaction.finished` both wait for that acknowledgement. Failure keeps
the exact live payload, emits a diagnostic, and rejects the compact commit.
Headless core Runs write through their injected storage; Runtime overrides a
client-carried `persistedByHost` flag because the Runtime is the canonical
Session owner on both embedded and daemon paths. Runtime-backed Ink/classic
hosts update only their live projection after acknowledgement and never become
a second writer. A first-run compact seeds a missing Session from explicit Run
metadata before persistence; a rejected async compact callback restores the
tentative context revision as well as leaving the exact payload intact.

Full rewrites run the same archive-first transaction as maintenance: reconcile
legacy placeholders against exact persisted entries, append and `sync()` new
sidecar records, atomically replace the slim main file, then update storage
state. A main-write failure after sidecar success is safe duplication. Storage
maintenance resets only its rewrite counter; it retains the live caller's
lineage append watermark until restart so delta slicing cannot reappend an old
placeholder range.

The agent-layer transcript retrieval primitive computes a content revision over
the merged lineage. `searchSessionHistory()` excludes system/control entries by
default, searches compacted entries with exact phrase, logical-ID, Unicode term
coverage, and inverse-document-frequency signals, and returns bounded snippets.
`readSessionHistoryEntry()` requires a stable entry ID, optionally fences the
revision, and returns a fixed character chunk plus `nextOffset`. Coding exposes
the `session_history_search` / `session_history_read` pair when the current Run
owns full-lineage-capable storage. Root Runs bind the root Session. Persistent
child Runs bind a separately minted hidden `managed-task-worker` Session, so a
child can recover its own compacted detail without reading or mutating root
lineage. Storage-less Runs and partial visibility of the pair expose neither
tool. The embedded Runtime/daemon projects the same search hits; bulk and
oversized exact reads continue through transcript page/chunk APIs.

## 21. v0.7.75 Stabilization Boundaries

Every Runtime Worker-reachable non-interactive `child_process` call must either
request `windowsHide: true` or be an explicit reviewed exception. The covered
surface includes memory and Git metadata probes, provider CLI/ACP execution,
LSP acquisition and servers, clipboard helpers, worktrees, review commands,
extension commands, managed-task checkpoints, and sandbox helpers.

Interactive external editors, explicit terminal commands, PTY sessions, and
POSIX-only process-management branches remain exceptions because hiding or
changing their process contract would alter user-visible behavior. The bundle
build inspects the Runtime Worker esbuild metafile and fails when a statically
identifiable reachable call lacks the required option or a named exception.
The packaged Electron smoke separately executes 20 ordinary queries and checks
Win32 console visibility at the actual SDK/daemon boundary.

The release candidate also retains the Sidecar/Runtime completion boundary:

- optional follow-up offered after the request is complete is an accepted
  completion, while clarification required to finish the request is blocked;
- the budget bridge publishes approval state only immediately before an
  eligible `revise` request;
- live results and persisted/daemon projections retain the blocked code and
  reason, including after restart recovery;
- the release script audits those prompt and budget guards in the exact
  tarball it can publish.

## 22. Related Documents

- Product requirements: [PRD.md](PRD.md)
- High-level design: [HLD.md](HLD.md)
- Architecture decisions: [ADR.md](ADR.md)
- SDK embedder guide: [SDK_EMBEDDER_GUIDE.md](SDK_EMBEDDER_GUIDE.md)
- Release process: [release.md](release.md)
