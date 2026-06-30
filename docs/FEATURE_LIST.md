# Feature 总表

> 这是活跃 roadmap 索引，只保留仍需要计划、实现或验证的 feature。
> 已发布、取消、吸收、搁置的历史项见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.58` |
| Current package version | `@kodax-ai/kodax@0.7.58` (pending npm publish, 2026-06-29) |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `30` |
| InProgress | `0` |
| Planned | `14` |
| Completed | `16` |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 224, 225, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| Completed | 16 | `246, 245, 243, 242, 241, 233, 240, 239, 224, 174, 211, 237, 229, 230, 234, 236` | `245, 246` v0.7.58 (pending release); `233, 241, 242, 243` released v0.7.57; `239, 240` released v0.7.56; `224` released v0.7.54; `174, 211, 237` v0.7.53; `229` v0.7.50; `230, 234, 236` v0.7.51 |
| InProgress | 0 | `-` | No active implementation slot after v0.7.57 release sync |
| Planned, near-term | 9 | `228, 244, 231, 235, 238, 232, 105, 108, 225` | `v0.7.60` -> `v0.7.81` |
| Planned, v0.8.x | 5 | `007, 030, 093, 113, 139` | `v0.8.5+` |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, conservative retention, and durable source/provenance/resultSummary persistence; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.54` | `1` |
| `v0.7.55` | `0` |
| `v0.7.56` | `0` |
| `v0.7.57` | `0` |
| `v0.7.60` | `2` |
| `v0.7.63` | `1` |
| `v0.7.66` | `1` |
| `v0.7.69` | `1` |
| `v0.7.72` | `1` |
| `v0.7.75` | `1` |
| `v0.7.78` | `1` |
| `v0.7.81` | `1` |
| `v0.8.5` | `3` |
| `v0.8.7` | `1` |
| `v0.8.25` | `1` |

> Release cadence rule: every `v0.7.x` feature-bearing release normally leaves
> the next two patch versions for debug/patch releases. `v0.7.55` is intentionally
> left without a planned feature so it can be used for the temporary emergency
> release. `FEATURE_239` and `FEATURE_240` both moved to `v0.7.56`.
> `FEATURE_233`, `FEATURE_241`, `FEATURE_242`, and `FEATURE_243` shipped in
> `v0.7.57`; `v0.7.58` and `v0.7.59` remain patch/debug slots before the next
> feature-bearing slot at `v0.7.60`.

---

## 进行中的 Feature

No active feature is currently in implementation after the `v0.7.57` release sync.

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `228` | Unified Memory Control Plane + Memory Governance | Core / Memory + Governance | High | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_228-unified-memory-control-plane--memory-governance) |
| `244` | Repo Intelligence Graph-Only Index for Cold Module Queries | Core / Repo Intelligence + Performance | Medium | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_244-repo-intelligence-graph-only-index-for-cold-module-queries) |
| `235` | Draft Workflow — Generate-without-Run / Review-before-Start | Core / Workflow Lifecycle | Medium | `v0.7.66` | [v0.7.66](features/v0.7.66.md#feature_235-draft-workflow--generate-without-run--review-before-start) |
| `238` | Workflow Learning Carrier + Workflow Handoff Inbox | Core / Workflow + Self-Improvement | Medium | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_238-workflow-learning-carrier--workflow-handoff-inbox) |
| `105` | Verifiable Advisor Consult Primitive | Internal / Core | High | `v0.7.75` | [v0.7.75](features/v0.7.75.md#feature_105-verifiable-advisor-consult-primitive) |
| `108` | Session-Driven Reflective Prompt Patcher | Internal / Test Infrastructure | Medium | `v0.7.78` | [v0.7.78](features/v0.7.78.md#feature_108-session-driven-reflective-prompt-patcher) |
| `225` | REPL Dead / Legacy Code Cleanup | Internal / Refactor + Tech Debt | Medium | `v0.7.81` | [v0.7.81](features/v0.7.81.md#feature_225-repl-dead--legacy-code-cleanup) |
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
- 已完成、取消、吸收、搁置的历史项归档到 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)，避免它们继续污染待办统计。
- 新 feature 进入本表前，应先确认是否已有相同目标、是否可被现有 feature 吸收、是否需要单独设计文档。
- 发布后把对应行移出本表，并把发布事实写入 [CHANGELOG.md](../CHANGELOG.md) 或归档。
- Emergency patch absorption: Session Scratch Directory / `KODAX_SESSION_TMP` is tracked as a `FEATURE_071` workspace-discipline extension, not as a new active feature ID. The patch gives each session a repo-local `.agent/tmp/sessions/<session-id>/` scratch path and keeps temporary helper files out of shared roots.

---

## 已完成 Feature

| ID | Title | Released | Design | Notes |
|---|---|---|---|---|
| `246` | Claude-Code-Parity Workflow (inline authoring + structured output + streaming pipeline + same-session resume; absorbs `232`, parity subset of `231`) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_246-claude-code-parity-workflow--inline-authoring--structured-output--streaming-pipeline--same-session-resume) | Landed 2026-06-29 (pending release in `v0.7.58`). Model-callable `run_workflow` inline authoring (scout-then-author; `sideQuery` generator demoted to headless/SA fallback), structured child output via `outputSchema`, no-barrier `wf.pipeline`, same-session resume via `resumeFromRunId` (content-addressed result cache; `Date.now`/`Math.random` now throw in-sandbox), nested `wf.workflow`, per-agent phase + per-child effort, `/workflow` command intelligence, and mode-distinct SA/AMA/AMAW activation. ADR-044/046/047/048. Neutral run-lifecycle manager lifted to `@kodax-ai/agent`. |
| `245` | Workflow Generation Robustness + Runtime Partial-Result Salvage | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_245-workflow-generation-robustness--runtime-partial-result-salvage) | Landed 2026-06-29 (pending release in `v0.7.58`). Generation-time: static literal-taskId rejection, smoke now asserts taskId/evidenceRefs identity, multi-scenario adversarial smoke, taskId randomization, prompt/repair hardening. Runtime: mid-run failures surface completed children's outputs instead of a bare failure. Eval per ADR-033 is deterministic Layer-1 unit tests (generator prompt is not a FEATURE_104 trigger). Runtime self-repair (replay completed agents) is explicitly deferred to `FEATURE_231`. |
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
