# KodaX Detailed Design

> Last updated: 2026-07-07
>
> Current release baseline: `@kodax-ai/kodax@0.7.63`
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

The root package is `@kodax-ai/kodax@0.7.63`.

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

The build path is:

```text
npm run build
  -> tsc -b tsconfig.build.json
  -> copy built-in skills and provider capabilities
  -> scripts/build-bundle.mjs
  -> scripts/build-dts.mjs
```

Only `llm`, `agent`, `coding`, and `repl` are workspace package build roots.

## 3. Main Entry Points

| Area | Current file(s) | Notes |
|---|---|---|
| CLI bootstrap | `src/kodax_cli.ts` | Thin product entry for CLI and binary use. |
| Coding SDK | `packages/coding/src/agent.ts` | `runKodaX(options, prompt)` delegates through `Runner.run`. |
| Coding preset | `packages/coding/src/coding-preset.ts` | Declares the default coding agent and substrate executor. |
| Continuous SDK | `packages/coding/src/client.ts`, `running-session.ts` | `KodaXClient` and non-blocking session handle. |
| Generic agent | `packages/agent/src/primitives/runner.ts`, `agent.ts` | Layer-A Runner and Agent primitives. |
| REPL | `packages/repl/src/index.ts` | `runInkInteractiveMode`, classic mode, config/session exports. |
| LLM providers | `packages/llm/src/providers/registry.ts` | Built-in aliases and custom provider registration. |

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

## 11. Media Input Artifacts

Media/input artifacts are agent-layer primitives under `packages/agent/src/media`.
The public `@kodax-ai/kodax/media` SDK entry and the legacy
`@kodax-ai/coding/media` source-side path both re-export that implementation.
Coding consumes validation/enqueue helpers from this layer; file and video
artifact contracts remain stable even when a provider route is not wired for
send.

## 12. MCP

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

## 13. Workflow Runtime

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

## 14. REPL Detail

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

## 15. Construction And Self-Modification

Construction tools allow staged creation and admission of tools and agents.
Self-modification tools stage proposed changes through explicit runtime paths.

Design constraints:

- staged artifacts must be validated before activation;
- admission invariants live in `packages/agent/src/admission`;
- construction runtime lives under `packages/coding/src/construction`;
- user approval remains required for irreversible or high-risk changes;
- generated capabilities should not bypass normal tool permissions.

## 16. Observability And Eval

Behavior-affecting prompt changes must follow
`benchmark/EVAL_GUIDELINES.md`. Runtime changes should add focused Vitest
coverage near the source file. Eval outputs belong under benchmark result
locations, not in active docs.

Tracing lives under `packages/agent/src/tracing` and is inline after package
consolidation. It is reusable infrastructure, not a separate workspace package.

## 17. Current Anti-Patterns

Do not introduce:

- V1 role names as current runtime concepts;
- prompt-only permission rules without runtime checks;
- provider-specific prompt prose;
- SDK exports not backed by `package.json`, bundle entries, and dts output;
- new workspace packages for code that is only used by one package;
- REPL-only state as a dependency of headless SDK operation.

## 18. Related Documents

- Product requirements: [PRD.md](PRD.md)
- High-level design: [HLD.md](HLD.md)
- Architecture decisions: [ADR.md](ADR.md)
- SDK embedder guide: [SDK_EMBEDDER_GUIDE.md](SDK_EMBEDDER_GUIDE.md)
- Release process: [release.md](release.md)
