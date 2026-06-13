# KodaX Detailed Design

> Last updated: 2026-06-13
>
> Current release baseline: `@kodax-ai/kodax@0.7.49`
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

The root package is `@kodax-ai/kodax@0.7.49`.

`package.json` exposes:

| Export | Build artifact | Source intent |
|---|---|---|
| `.` | `dist/index.js` | Root SDK and CLI-facing helpers. |
| `./agent` | `dist/sdk-agent.js` | Generic agent framework. |
| `./llm` | `dist/sdk-llm.js` | Provider abstraction. |
| `./coding` | `dist/sdk-coding.js` | Coding agent SDK. |
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
zhipu-coding, minimax-coding, mimo-coding, mimo, ark-coding,
gemini-cli, codex-cli
```

Custom provider design must remain data-driven: protocol, base URL, API key env
var, default model, reasoning replay, multimodal support, forced tool support,
and session semantics belong in provider config/capabilities.

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

Public session APIs should preserve id-based usage while allowing storage layout
to evolve. New storage features must be backward-compatible with old JSONL
records whenever practical.

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
  concurrency/cap accounting, abort, and backend injection.
- `packages/coding/src/workflows`: coding backend, built-ins, durable run graph,
  saved workflow discovery, and `/workflow` command integration.

FEATURE_217 remains the v0.7.49 Dynamic Workflow product feature. The current
implementation provides the substrate; the same feature owns script generation,
restricted script execution, background manager behavior, pause/resume/stop/save,
workflow-level worktree wiring, hard budget checks, and advanced workflow
patterns before completion.

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
