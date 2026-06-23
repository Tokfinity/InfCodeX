# Feature 总表

> 这是活跃 roadmap 索引，只保留仍需要计划、实现或验证的 feature。
> 已发布、取消、吸收、搁置的历史项见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.54` |
| Current package version | `@kodax-ai/kodax@0.7.54` (released 2026-06-23) |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `23` |
| InProgress | `0` |
| Planned | `15` |
| Completed | `8` |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 224, 225, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| Completed | 8 | `224, 174, 211, 237, 229, 230, 234, 236` | `224` released v0.7.54; `174, 211, 237` v0.7.53; `229` v0.7.50; `230, 234, 236` v0.7.51 |
| InProgress | 0 | `—` | no feature in active implementation |
| Planned, near-term | 10 | `239, 233, 228, 231, 235, 238, 232, 105, 108, 225` | `v0.7.55` -> `v0.7.81` |
| Planned, v0.8.x | 5 | `007, 030, 093, 113, 139` | `v0.8.5+` |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, conservative retention, and durable source/provenance/resultSummary persistence; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.54` | `1` |
| `v0.7.55` | `1` |
| `v0.7.57` | `1` |
| `v0.7.60` | `1` |
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
> the next two patch versions for debug/patch releases. `FEATURE_239` is an
> explicit exception for the Space-blocking SDK multimodal input gap and takes
> the `v0.7.55` slot; `v0.7.56` remains the immediate patch window before the
> next planned feature slot at `v0.7.57`.

---

## 进行中的 Feature

> 当前无进行中的 feature（`224` 已随 `v0.7.54` 发布，移入「已完成 Feature」）。本段按 tracker 约定常驻，空表即可。

| ID | Title | Planned | Design |
|---|---|---|---|

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `239` | SDK Multimodal Input + Clipboard Image Public API | SDK / Media + Provider Capability | High | `v0.7.55` | [v0.7.55](features/v0.7.55.md#feature_239-sdk-multimodal-input--clipboard-image-public-api) |
| `233` | Effort-First Reasoning Control System | LLM / Provider Capability + Runtime UX | High | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_233-effort-first-reasoning-control-system) |
| `228` | Unified Memory Control Plane + Memory Governance | Core / Memory + Governance | High | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_228-unified-memory-control-plane--memory-governance) |
| `231` | Durable Workflow Replay Resume | Core / Workflow Persistence | High | `v0.7.63` | [v0.7.63](features/v0.7.63.md#feature_231-durable-workflow-replay-resume) |
| `235` | Draft Workflow — Generate-without-Run / Review-before-Start | Core / Workflow Lifecycle | Medium | `v0.7.66` | [v0.7.66](features/v0.7.66.md#feature_235-draft-workflow--generate-without-run--review-before-start) |
| `238` | Workflow Learning Carrier + Workflow Handoff Inbox | Core / Workflow + Self-Improvement | Medium | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_238-workflow-learning-carrier--workflow-handoff-inbox) |
| `232` | Replay-Aware Workflow Pipeline Primitive | Core / Workflow Scheduling | Medium | `v0.7.72` | [v0.7.72](features/v0.7.72.md#feature_232-replay-aware-workflow-pipeline-primitive) |
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

---

## 已完成 Feature

| ID | Title | Released | Design | Notes |
|---|---|---|---|---|
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
