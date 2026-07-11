# Feature 总表

> 这是活跃 roadmap 与近期完成项索引：保留仍需计划/实现/验证的 feature，
> 并保留 archive cutoff 之后的近期发布项。更早的已发布、取消、吸收、搁置
> 历史见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.66` |
| Current package version | `@kodax-ai/kodax@0.7.66` release commit; GitHub source/binary release included, npm publication pending operator action |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `44` |
| InProgress | `0` |
| Planned | `13` |
| Completed | `31` |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 221, 224, 225, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| Completed | 31 | `259, 258, 253, 254, 255, 256, 257, 228, 251, 252, 250, 248, 249, 247, 246, 245, 243, 242, 241, 233, 240, 239, 224, 221, 174, 211, 237, 229, 230, 234, 236` | `259` and `258` implementations complete for v0.7.67; release pending. `253-257` shipped together in v0.7.66 (2026-07-10); `228` shipped v0.7.62 (2026-07-06); `251, 252` shipped v0.7.61 (2026-07-06); `250` shipped v0.7.60 (2026-07-04); `248, 249` shipped v0.7.59 (2026-07-03); `245, 246, 247, 221` released v0.7.58 (2026-07-02); `233, 241, 242, 243` released v0.7.57; `239, 240` released v0.7.56; `224` released v0.7.54; `174, 211, 237` v0.7.53; `229` v0.7.50; `230, 234, 236` v0.7.51 |
| InProgress | 0 | `—` | `—` |
| Planned, near-term | 8 | `244, 231, 235, 238, 232, 105, 108, 225` | `v0.7.75` -> `v0.7.100` |
| Planned, v0.8.x | 5 | `007, 030, 093, 113, 139` | `v0.8.5+` |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, conservative retention, and durable source/provenance/resultSummary persistence; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.54` | `0` |
| `v0.7.55` | `0` |
| `v0.7.56` | `0` |
| `v0.7.57` | `0` |
| `v0.7.59` | `0` |
| `v0.7.61` | `0` |
| `v0.7.62` | `0` |
| `v0.7.63` | `0` |
| `v0.7.64` | `0` |
| `v0.7.65` | `0` |
| `v0.7.66` | `0` |
| `v0.7.67` | `1` |
| `v0.7.68` | `0` |
| `v0.7.69` | `0` |
| `v0.7.70` | `0` |
| `v0.7.71` | `0` |
| `v0.7.72` | `0` |
| `v0.7.73` | `0` |
| `v0.7.74` | `0` |
| `v0.7.75` | `3` |
| `v0.7.80` | `1` |
| `v0.7.85` | `1` |
| `v0.7.90` | `1` |
| `v0.7.95` | `1` |
| `v0.7.100` | `1` |
| `v0.8.5` | `3` |
| `v0.8.7` | `1` |
| `v0.8.25` | `1` |

> Release cadence rule: every `v0.7.x` feature-bearing release normally leaves
> the next two patch versions for debug/patch releases. `v0.7.55` is intentionally
> left without a planned feature so it can be used for the temporary emergency
> release. `FEATURE_239` and `FEATURE_240` both moved to `v0.7.56`.
> `FEATURE_233`, `FEATURE_241`, `FEATURE_242`, and `FEATURE_243` shipped in
> `v0.7.57`; `v0.7.58` shipped 2026-07-02. `v0.7.59` (2026-07-03) shipped
> `FEATURE_248` (AMAW mode-level orchestration directive) + `FEATURE_249` (AMA
> natural-language workflow activation) as a rollup on top of the Space SDK R1-R6
> hardening and ark-coding lineup refresh.
>
> **Historical 2026-07-04 reschedule, superseded for active targets by the
> 2026-07-08 cadence update below**: at user request, every planned `v0.7.x`
> feature at `v0.7.60` and later was temporarily pushed back 3 minor versions,
> except `FEATURE_250` (stays `v0.7.60`) and `FEATURE_251` (stays `v0.7.61`).
> That temporary mapping is retained only as release-cadence history; use the
> 2026-07-08 cadence update below for every active target.
>
> **2026-07-08 runtime cadence update**: `FEATURE_253`, `FEATURE_254`, and
> `FEATURE_255` reserve `v0.7.64`, `v0.7.65`, and `v0.7.66` for the KodaX
> runtime migration sprint: embedded runtime contract, host migration/control
> plane hardening, and local daemon. `v0.7.67`, `v0.7.68`, `v0.7.69`, and
> `v0.7.70` are reserved as feature-free runtime stabilization / bugfix slots.
> The previous `FEATURE_244` and `FEATURE_231` reschedule remains: `244` +
> `231` + `235` -> `v0.7.75`, `238` -> `v0.7.80`, `232` -> `v0.7.85`,
> `105` -> `v0.7.90`, `108` -> `v0.7.95`, and `225` -> `v0.7.100`. All
> v0.8.x features remain unchanged.
>
> **2026-07-10 runtime release rollup**: the v0.7.64 and v0.7.65 development
> slots were not cut as standalone tags. FEATURE_253, FEATURE_254, and
> FEATURE_255 release together in v0.7.66 after the final context/tool exposure
> eval and release audit. The already implemented FEATURE_256 and FEATURE_257
> isolation follow-ups are also delivered early in v0.7.66; their former
> v0.7.71/v0.7.72 slots return to stabilization capacity.
>
> **2026-07-07 patch release**: `v0.7.63` is a no-planned-feature-slot
> patch/stability release for SDK session boundary hardening, deterministic
> transcript fixtures, `/reload` extension rediscovery, and feature-design index
> cleanup. After the 2026-07-08 cadence update, every slot before `v0.7.75`
> remains available as debug/patch buffer.
>
> **2026-07-09 runtime design addendum**: `FEATURE_254` now explicitly absorbs
> session-scoped runtime settings, stable rich-UI event payload families,
> config-boundary rules, runtime input/artifact parity, session-operation
> parity, daemon-prep permission/replay hardening, and the Hermes-like
> agent-performance/context-budget plane: runtime budget snapshots, tool
> exposure planning, portable `tool_search` / `tool_describe` / `tool_call`
> bridge semantics, skill/MCP metadata budgets, context-aware tool-result
> budgets, compaction anti-thrashing, small-window behavior, and report-only
> guardrails before pruning is enabled. `FEATURE_255` now explicitly absorbs
> daemon config/admin APIs, MCP/custom-provider admin APIs, command/skill
> catalogs, artifact upload/reference APIs, protocol initialization/versioning,
> protocol schemas, client identity/capabilities, session settings/history
> operations over transport, deterministic multi-client permission semantics,
> and daemon transport/diagnostics for the same context-budget/tool-exposure
> plane. No new feature ID or release slot is added.
>
> **2026-07-10 isolation follow-up (delivered early in v0.7.66)**: concrete SDK
> embedder demand added optional Worker-hosted embedded Runtime + hard disposal
> (FEATURE_256) and constructed-handler Worker fault isolation (FEATURE_257).
> Release review proved capability/configuration fail-closed behavior in all
> three Runtime forms and that constructed-handler revoke drains active/queued
> calls without Worker resurrection. Worker isolation remains explicitly not an
> untrusted-code sandbox and adds no generic arbitrary-code execution service.
>
> **2026-07-10 external-agent + build-loop efficiency exception**: two bounded
> features consume the first stabilization slot, `v0.7.67`. `FEATURE_258`
> delivers the protocol-neutral, host-injected executor plane, dispatchable
> catalog, task ledger, Worker child bridge, Workflow target, and
> Embedded/Daemon API. `FEATURE_259` applies a measured cost-discipline pass to
> the same multi-agent surface: truthful/smaller resident prompts, explicit
> tier intent, focused child/review handoffs, consolidated scope review, and
> conditional digest reuse. It adds no orchestration framework, model-price
> router, or protocol adapter. Concrete A2A, MCP Tasks, and governed HTTP
> adapters remain separate follow-ups so core KodaX does not acquire protocol
> SDK dependencies or overstate cancel/recovery semantics. `v0.7.68`-`v0.7.70`
> remain stabilization slots, and no third feature is planned for `v0.7.67`.

---

## 进行中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `—` | No feature currently in progress | — | — | — | — |

Recent completion notes:

`258` implementation is complete for `v0.7.67` (release pending): protocol-neutral
host-injected executors, the policy-filtered catalog, durable task ledger,
Worker/Workflow routing, Embedded/Daemon parity, public in-process Daemon
factory bootstrap, and Reference Executor conformance are all implemented.

`253-257` shipped together in `v0.7.66`: the embedded Runtime contract, host
migration/control plane, local daemon transport, context-budget/tool-exposure
planner + portable bridge, Worker-hosted Runtime, and constructed-handler Worker
fault isolation. The release audit closed the bridge permission eval drift and
fixed GitHub binary archive sidecar omission before tagging.

`251`（Tool-Output 语义压缩）新增 body-only bash 输出过滤、`never_worse` 尺寸兜底、lossiness/recovery 契约、ANSI-only 通用压缩、git/test/lint/JSON 命令专用过滤器，以及内置声明式长尾过滤表；隔离 Layer-1 测量显示高噪声命令 body token 降幅约 66–99%。`252`（Workflow Quality Preflight）当前收窄为纯确定性合约 lint：启动前对未 await 的 workflow-command 真值判断、schema 顶层字段误用、静态 agent fanout 超 manifest/host 上限做硬失败；review/verifier/通用质量启发式刻意不作为模型可见告警发出。二者均为确定性代码，无 prompt 改动、无 LLM eval。`v0.7.61` 同时修复一处 workflow 启动崩溃：`typescript` 提升为 `@kodax-ai/agent` 运行时依赖（quality lint 在热路径使用 TS 编译器 API）。

> `249` shipped 2026-07-03 (Option A): widened `buildWorkflowToolHost`
> (`tool-execution-context.ts`) from `!== 'amaw'` to `!== 'amaw' && !== 'ama'`, so AMA
> and AMAW both host `run_workflow` — AMA activates it on an explicit natural-language
> request (tool available, LLM-native), AMAW additionally on complexity (the FEATURE_248
> `ORCHESTRATION DEFAULT` directive, which stays strictly amaw-only via the independent
> `amawOrchestrationAvailable` gate — verified structurally separate). SA unchanged
> (fails gate + `SA_SOLO_EXCLUDE_TOOLS`). No prompt change (run_workflow's own description
> is the request-driven surface). cap-048 CAP-TOOL-CTX-009/010 updated; FEATURE_248
> role-prompt boundary tests green unchanged. The AMA-turn token cost of the resident
> run_workflow description was found to be a broader gap (the deferred-tool mechanism is
> SA-path-only) → filed as `250`. See docs/features/v0.7.60.md §FEATURE_249.

> `248` narrowed-SHIP 2026-07-03: AMAW-gated, mode-level `ORCHESTRATION DEFAULT`
> standing directive in the Worker system prompt (mirrors the ultracode mechanism),
> leak-closed via a new optional `ManagedRolePromptContext.amawOrchestrationAvailable`
> field. Layer-1 green (role-prompt.test.ts, 28 tests). Eval history: the old
> tool-level lever (A run_workflow desc + B' dispatch nudge) was eval-falsified and
> reverted; the mode-level directive floored 0% on a mid-task real-session replay, but
> a deep multi-agent investigation found that fixture tested the WRONG moment (mid-task
> defection, not the turn-0 decision ultracode actually applies). The turn-0 eval
> (`workflow-activation-turn0.eval.ts`, 4 aliases) then showed a real lift on the same
> a2aDesign task (mid-task 0% -> turn-0 baseline 8% -> proposed 33%, +25%) with models
> causally citing the directive ("按照编排默认原则... 让多个 agent 交叉验证"). A follow-up
> flow-fix (PLAN-TIME COMMITMENT: front-load the orchestrate-vs-solo call to turn-0 +
> make plan items = the agents/stages) then added a causally-confirmed increment on top
> of the ambient directive (turn-0 3-variant: +8~+17% on 3/4 shapes, zero regression;
> pulls review off the floor) and was merged into `orchestrationDefault`. Shipped with
> acceptance NARROWED to task-inception activation; mid-task re-architecture is a
> documented non-goal. Absolute activation is model-ceiling-limited on current
> coding-plan aliases. See docs/features/v0.7.59.md §6/§6.1.

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `244` | Repo Intelligence Graph-Only Index for Cold Module Queries | Core / Repo Intelligence + Performance | Medium | `v0.7.75` | [v0.7.75](features/v0.7.75.md#feature_244-repo-intelligence-graph-only-index-for-cold-module-queries) |
| `231` | Durable Workflow Replay Resume (231b crash-recovery, optional) | Core / Workflow Persistence | Low | `v0.7.75` | [v0.7.75](features/v0.7.75.md#feature_231-durable-workflow-replay-resume) |
| `235` | Draft Workflow — Generate-without-Run / Review-before-Start | Core / Workflow Lifecycle | Medium | `v0.7.75` | [v0.7.75](features/v0.7.75.md#feature_235-draft-workflow--generate-without-run--review-before-start) |
| `238` | Workflow Learning Carrier + Workflow Handoff Inbox | Core / Workflow + Self-Improvement | Medium | `v0.7.80` | [v0.7.80](features/v0.7.80.md#feature_238-workflow-learning-carrier--workflow-handoff-inbox) |
| `232` | Replay-Aware Workflow Pipeline Primitive | Core / Workflow Scheduling | Medium | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_232-replay-aware-workflow-pipeline-primitive) |
| `105` | Verifiable Advisor Consult Primitive | Internal / Core | High | `v0.7.90` | [v0.7.90](features/v0.7.90.md#feature_105-verifiable-advisor-consult-primitive) |
| `108` | Session-Driven Reflective Prompt Patcher | Internal / Test Infrastructure | Medium | `v0.7.95` | [v0.7.95](features/v0.7.95.md#feature_108-session-driven-reflective-prompt-patcher) |
| `225` | REPL Dead / Legacy Code Cleanup | Internal / Refactor + Tech Debt | Medium | `v0.7.100` | [v0.7.100](features/v0.7.100.md#feature_225-repl-dead--legacy-code-cleanup) |
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_007-theme-system-consolidation) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_030-multi-surface-delivery) |
| `093` | Coding and REPL Internal Circular Dependency Decoupling | Internal | Medium | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_093-coding-and-repl-internal-circular-dependency-decoupling) |
| `113` | TodoList JSON / CLI Surface | Enhancement | Medium | `v0.8.7` | [v0.8.7](features/v0.8.7.md#feature_113-todolist-json--cli-surface) |
| `139` | NotebookEdit Tool | Enhancement / Tool | Low | `v0.8.25` | [v0.8.25](features/v0.8.25.md#feature_139-notebookedit-tool--jupyter-cell-level-crud) |

---

## 阅读说明

- `FEATURE_LIST.md` 是活跃索引，不再承载长篇立项正文。
- 每个活跃 feature 在本表只保留：ID、标题、类别、优先级、目标版本、设计入口。
- 活跃项必须有明确版本和设计入口；`TBD` / parking-lot / 用户需求未成熟的项不进主表。
- archive cutoff 之前的已完成、取消、吸收、搁置项归档到 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)；cutoff 之后的近期完成项暂留本表以便发布审计。
- 新 feature 进入本表前，应先确认是否已有相同目标、是否可被现有 feature 吸收、是否需要单独设计文档。
- 发布后把对应行移到“已完成 Feature”，同步 [CHANGELOG.md](../CHANGELOG.md)；越过 archive cutoff 后再归档。
- Emergency patch absorption: Session Scratch Directory / `KODAX_SESSION_TMP` is tracked as a `FEATURE_071` workspace-discipline extension, not as a new active feature ID. The patch gives each session a repo-local `.agent/tmp/sessions/<session-id>/` scratch path and keeps temporary helper files out of shared roots.

---

## 已完成 Feature

| ID | Title | Released | Design | Notes |
|---|---|---|---|---|
| `258` | External Agent Executor Plane + Dispatchable Agent Catalog | `v0.7.67` (pending release) | [v0.7.67](features/v0.7.67.md#feature_258-external-agent-executor-plane--dispatchable-agent-catalog) | Protocol-neutral host-injected executor plane, redacted/policy-filtered catalog, durable task ledger, Worker and Workflow routing, Embedded/Daemon parity, public in-process Daemon factory bootstrap, Reference Executor, and security/recovery conformance. |
| `257` | Constructed Handler Worker Fault Isolation | `v0.7.66` | [v0.7.72](features/v0.7.72.md#feature_257-constructed-handler-worker-fault-isolation) | Delivered ahead of the original v0.7.72 slot. Constructed JavaScript handlers run in persistent per-handler Workers, use reverse host tool RPC, hard-terminate CPU loops, and cannot resurrect active/queued work after revoke. |
| `256` | Worker-Hosted Embedded Runtime + Hard Disposal | `v0.7.66` | [v0.7.71](features/v0.7.71.md#feature_256-worker-hosted-embedded-runtime--hard-disposal) | Delivered ahead of the original v0.7.71 slot. Adds optional embedded Worker ownership, MessagePort protocol reuse, hard-dispose capability negotiation, DTO-only transport, and release sidecar packaging. |
| `255` | KodaX Runtime Daemon + Local Transport | `v0.7.66` | [v0.7.66](features/v0.7.66.md#feature_255-kodax-runtime-daemon--local-transport) | Local named-pipe/Unix-socket daemon, detached ownership, multi-client sessions/runs/events/permissions/config/catalog/artifact/diagnostic services, schema-validated protocol, and CLI/SDK host parity. |
| `254` | Runtime Host Migration + Control Plane Hardening | `v0.7.66` | [v0.7.65](features/v0.7.65.md#feature_254-runtime-host-migration--control-plane-hardening) | Host/runtime consolidation plus context budgets, small-window tool exposure planning, `tool_search` / `tool_describe` / `tool_call` reachability, target-only permission checks, result budgets, compaction pressure, and deterministic 6/6 exposure evals. |
| `253` | KodaX Runtime Contract + Embedded Runtime API | `v0.7.66` | [v0.7.64](features/v0.7.64.md#feature_253-kodax-runtime-contract--embedded-runtime-api) | Embedded Runtime sessions/runs/events/permissions/workflows facade and public `/runtime` subpath, developed in the v0.7.64 slot and released in the combined v0.7.66 cut. |
| `228` | Unified Memory Control Plane + Memory Governance | `v0.7.62` | [v0.7.62](features/v0.7.62.md#feature_228-unified-memory-control-plane--memory-governance) | Released in `v0.7.62` (2026-07-06). Reuses the F224 learning proposal store for memory handoffs, adds agent-layer typed memory refs/snapshots/previews, fingerprint-guarded approval writes, thin `/memory` REPL commands, deterministic task-aware memory packs, bounded prompt memory-index injection, governance/curator reports with a 200-report cap, feedback-triggered review contracts, and host trace metadata for selected memory refs. No vector DB, embeddings, or second memory database. |
| `252` | Workflow Quality Preflight + Review/Audit Verification Lints | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_252-workflow-quality-preflight--reviewaudit-verification-lints) | Released in `v0.7.61` (2026-07-06). Phase A (deterministic contract lint only): `quality-lint.ts` (`lintRestrictedWorkflowSource` / `assertRestrictedWorkflowQuality`) runs in restricted workflow module materialization + the coding host with host `maxAgents`, hard-failing three contract classes before a run starts — unawaited workflow-command variable in a boolean position (no Proxy trap for object truthiness), top-level structured-output field access that belongs under `result.structured`, and literal `[...]`/`.map()` agent fanout above manifest/host caps. Review/verifier/generic quality heuristics intentionally NOT emitted as model-visible warnings (false-positive review narrowed the feature). Layer 2 strengthens review/audit templates to make verifier stages explicit. Layer 3 (gated strong-tier LLM reviewer) deferred behind future policy/eval. Deterministic — no LLM eval. |
| `251` | Tool-Output 语义压缩（rtk-Style Token Killer） | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_251-tool-output-semantic-compression-rtk-style-token-killer) | Released in `v0.7.61` (2026-07-06). Command-aware in-tool output compression in KodaX's own `bash` layer (ADR-050). New `output-filters/` module compresses stdout/stderr **body** at the single `bash.ts` close-handler point (covers SA + AMA): lossless ANSI-strip generic layer, compiled `git-diff`/`git-log`/`git-status`/`test-runner`/`lint`/`json-output` filters, and a declarative long-tail table (package/docker/infra progress). `Command:`/`Exit:` header preserved verbatim (FEATURE_185 ledger); `never_worse` size backstop; content-signature detection over command-name; every lossy filter persists raw body + recovery hint (raw fallback on persist failure). Isolated Layer-1 measurements show ~66–99% body-token reduction. Deterministic — no prompt change, no FEATURE_104 eval. |
| `250` | Progressive Disclosure for the AMA/AMAW Managed Tool Path | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_250-progressive-disclosure-for-the-amaamaw-managed-tool-path) | Released in `v0.7.60` (2026-07-04). Brings deferred-tool progressive disclosure (previously SA-path-only) to the AMA/AMAW managed path: `buildAgentToolsFromRegistry` hint-swaps the 13 non-mcp deferred tools (repo-intel + web/code + goal) to their `DEFERRED_TOOL_HINTS` one-liner with `input_schema` unchanged (stay directly callable; full description via `tool_search`). `mcp_*` stay resident (mutation risk + un-eval'd); `run_workflow` untouched. `tool_search` plus the 3 goal tool receipts are protected in `PRUNE_PROTECTED_TOOLS`. Two eval panels (5-alias): DEFER_SAFE 5/5, 0% read/grep fallback; V_teach 100% adoption after a 2-line `code_search`/`semantic_lookup` teaching block (strictly non-negative, +25pp on the floor alias). |
| `249` | AMA Natural-Language Workflow Activation | `v0.7.59` | [v0.7.60](features/v0.7.60.md#feature_249-ama-natural-language-workflow-activation) | Released in `v0.7.59` (2026-07-03). Widened `buildWorkflowToolHost` so AMA also hosts `run_workflow` on an explicit natural-language request; AMAW additionally self-activates on complexity via the FEATURE_248 directive (independent `amawOrchestrationAvailable` gate, verified structurally separate). SA unchanged. Design doc filed under v0.7.60; shipped early in the v0.7.59 rollup. |
| `248` | AMAW Mode-Level Orchestration Directive | `v0.7.59` | [v0.7.59](features/v0.7.59.md#feature_248-amaw-mode-level-orchestration-directive) | Released in `v0.7.59` (2026-07-03). AMAW-gated mode-level `ORCHESTRATION DEFAULT` standing directive + PLAN-TIME COMMITMENT flow-fix (prompt-only, narrowed-SHIP: task-inception activation; mid-task re-architecture a documented non-goal). Leak-closed via optional `ManagedRolePromptContext.amawOrchestrationAvailable`. See v0.7.59.md §6/§6.1. |
| `247` | SDK Agent-Profile Surface (KodaX-Space Partner) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_247-sdk-agent-profile-surface-kodax-space-partner) | Released in `v0.7.58` (2026-07-02). Profile-gated `KodaXAgentProfile` (R1–R9): identity/instruction injection, tool-visibility policy, Sidecar Verifier binding + verdict attribution, `onEffectiveConfig` snapshot, structured profile/runtime metadata across `fork()`, imperative `compactSession()`, session/profile/toolCall attribution, and a `reads-network` side-effect class. Default Coding Agent byte-identical when no profile is set. Built on the concurrent `feature/partner-sdk-support` branch. |
| `246` | Claude-Code-Parity Workflow (inline authoring + structured output + streaming pipeline + same-session resume; absorbs `232`, parity subset of `231`) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_246-claude-code-parity-workflow--inline-authoring--structured-output--streaming-pipeline--same-session-resume) | Released in `v0.7.58` (2026-07-02). Model-callable `run_workflow` inline authoring (scout-then-author; `sideQuery` generator demoted to headless/SA fallback), structured child output via `outputSchema`, no-barrier `wf.pipeline`, same-session resume via `resumeFromRunId` (content-addressed result cache; `Date.now`/`Math.random` now throw in-sandbox), nested `wf.workflow`, per-agent phase + per-child effort, `/workflow` command intelligence, and mode-distinct SA/AMA/AMAW activation. ADR-044/046/047/048. Neutral run-lifecycle manager lifted to `@kodax-ai/agent`. |
| `245` | Workflow Generation Robustness + Runtime Partial-Result Salvage | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_245-workflow-generation-robustness--runtime-partial-result-salvage) | Released in `v0.7.58` (2026-07-02). Generation-time: static literal-taskId rejection, smoke now asserts taskId/evidenceRefs identity, multi-scenario adversarial smoke, taskId randomization, prompt/repair hardening. Runtime: mid-run failures surface completed children's outputs instead of a bare failure. Eval per ADR-033 is deterministic Layer-1 unit tests (generator prompt is not a FEATURE_104 trigger). Runtime self-repair (replay completed agents) is explicitly deferred to `FEATURE_231`. |
| `221` | White-Labelable Self-Knowledge Manual | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_221-white-labelable-self-knowledge-manual) | Released in `v0.7.58` (2026-07-02). `selfManual.baseTopics` (seed all/none/subset) + `KODAX_UNDERLYING_CAPABILITY_TOPICS` + `MANUAL_REGISTRY` export; `kodax_manual` tool description + self-knowledge routing rule re-branded from `selfManual.productName` (config-path clauses gated to the default product). Extends FEATURE_218; default output byte-identical. |
| `243` | Built-in Repository Intelligence + Codebase Mastery Parity | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_243-built-in-repository-intelligence--codebase-mastery-parity) | Released v0.7.57 (2026-06-28). Replaces external Repointel runtime with built-in full/light repo-intelligence, semantic worker sidecar, `relationship_scan`, repo-explorer agent, and `/repo-intel` controls. |
| `242` | Lean Review + Project Instructions Bootstrap | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_242-lean-review--project-instructions-bootstrap) | Released v0.7.57 (2026-06-28). Adds lean review command path and project instruction bootstrap updates for the current Worker + Sidecar architecture. |
| `241` | SDK Timeout Control Surface | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_241-sdk-timeout-control-surface) | Released v0.7.57 (2026-06-28). Adds seconds-based SDK timeout config; LLM request timeout normalization lives in `@kodax-ai/llm`, with coding adapting it to provider resilience. |
| `233` | Effort-First Reasoning Control System | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_233-effort-first-reasoning-control-system) | Released v0.7.57 (2026-06-28). Makes `effort` the primary reasoning control, keeps legacy `reasoningMode`/`--reasoning` as compatibility input, adds `zai-coding`, and documents LLM-layer passive effort learning semantics with the agent-layer default capability cache. |
| `240` | Cross-Protocol `stopReason` Normalization + Terminal Semantics Dispatch | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_240-cross-protocol-stopreason-normalization--terminal-semantics-dispatch) | Implemented 2026-06-24. Adds provider-neutral stop-reason classifier in `@kodax-ai/llm`, wires max-token and managed-protocol gates through it, and gives `pause_turn`, refusal/content-filter, and unknown values explicit terminal handling. |
| `239` | SDK Multimodal Input + Clipboard Image Public API | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_239-sdk-multimodal-input--clipboard-image-public-api) | Implemented 2026-06-24; expanded 2026-06-25 for Space and relayered in v0.7.57. Adds `@kodax-ai/kodax/media`, canonical `@kodax-ai/agent/media`, `@kodax-ai/coding/media` compatibility re-exports, shared image clipboard/normalization/persistence helpers, stable image/file/video input artifact contracts, model-level input capabilities, runtime artifact validation, GIF boundary docs, and queued follow-up artifacts. |
| `224` | Self-Improvement Skill Loop (procedural learning triage + SkillCurator v1) | `v0.7.54` | [v0.7.54](features/v0.7.54.md#feature_224-self-improvement-skill-loop) | Released v0.7.54 (2026-06-23). Turn-level learning triage → durable proposal store + usage/trust ledgers → governed, snapshot-safe skill apply via `/learn` (`pending`/`diff`/`approve [--ack-impact]`/`reject`). Approve-apply orchestration exposed from `@kodax-ai/agent` as `approveStoredLearningProposal`. Shipped alongside session recovery, extension discovery + runtime composition, ACP capability multiplexing, and a GLM model refresh. |
| `174` | `kodax sessions dedupe` | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_174-kodax-sessions-dedupe) | Released v0.7.53 (npm + tag + GitHub Release, 2026-06-19). Dry-run-first ghost-session cleanup; only uniquely-matched `runner-*` ghosts move to a reversible `.dedupe-archive`. |
| `211` | Interactive-Mode Extension/MCP Session State Cross-Resume Persistence | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_211-interactive-mode-extensionmcp-session-state-cross-resume-persistence) | Released v0.7.53 (2026-06-19). Runtime extension state snapshotted back to the REPL host and restored across `-r` / `-c`; preserves the FEATURE_173 single-writer invariant. |
| `237` | Todo-drift nudge (warn-only unclaimed-work reminder) | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_237-todo-drift-nudge-warn-only-unclaimed-work-reminder) | Released v0.7.53 (2026-06-19). Warn-only observer arms a one-shot `<system-reminder>` + `onTodoDriftWarning` telemetry when work starts with pending-but-unclaimed todos; paired prompt eval. |
| `236` | Workflow Inline Skill Reference Propagation | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_236-workflow-inline-skill-reference-propagation) | Released v0.7.51 (2026-06-17). Workflow generator expands inline `/skill:<name>` and known bare slash skill references before harness generation; child briefings fail closed to the `skill` tool for unexpanded references. |
| `234` | Workflow Run Host Attribution (`hostMetadata`) | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_234-workflow-run-host-attribution-hostmetadata) | Released v0.7.51 (2026-06-17). Additive `hostMetadata?: Record<string,string>` on workflow snapshot/options; eval non-trigger. |
| `230` | Durable TUI Tool Transcript Replay | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_230-durable-tui-tool-transcript-replay) | Released v0.7.51 (2026-06-17). Terminal `tool_group` replay cache + message-derived fallback + SDK transcript contract. |
| `229` | Workflow Process Events + SDK/System Progress Surface | `v0.7.50` | [v0.7.50](features/v0.7.50.md#feature_229-workflow-process-events--sdksystem-progress-surface) | Released v0.7.50 (npm + tag + GitHub Release, 2026-06-17). |

---

## 相关文档入口

- [Product Requirements](PRD.md)
- [Architecture Decision Records](ADR.md)
- [High-Level Design](HLD.md)
- [Detailed Design](DD.md)
- [Archived Features](FEATURES_ARCHIVED.md)
- [Known Issues](KNOWN_ISSUES.md)
