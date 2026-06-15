# Feature 总表

> 这是活跃 roadmap 索引，只保留仍需要计划、实现或验证的 feature。
> 已发布、取消、吸收、搁置的历史项见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.49` |
| Current package version | `@kodax-ai/kodax@0.7.49` |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `13` |
| InProgress | `1` |
| Planned | `12` |
| Completed | `0` |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 224, 225, 228, 229` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| InProgress | 1 | `229` | `v0.7.50` |
| Planned, near-term | 7 | `224, 228, 225, 174, 105, 211, 108` | `v0.7.51` -> `v0.7.58` |
| Planned, v0.8.x | 5 | `007, 030, 093, 113, 139` | `v0.8.0+` |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, and conservative retention; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.50` | `1` |
| `v0.7.51` | `1` |
| `v0.7.52` | `1` |
| `v0.7.53` | `1` |
| `v0.7.54` | `1` |
| `v0.7.57` | `2` |
| `v0.7.58` | `1` |
| `v0.8.0` | `3` |
| `v0.8.2` | `1` |
| `v0.8.20` | `1` |

---

## 进行中的 Feature

| ID | Title | Category | Priority | Planned | Started | Design |
|---|---|---|---|---|---|---|
| `229` | Workflow Process Events + SDK/System Progress Surface | Core / Agent Runtime + SDK | High | `v0.7.50` | `2026-06-15` | [v0.7.50](features/v0.7.50.md#feature_229-workflow-process-events--sdksystem-progress-surface) |

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `224` | Self-Improvement Skill Loop | Core / Skills + Self-Improvement | High | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_224-self-improvement-skill-loop--rescheduled-from-v0750) |
| `228` | Unified Memory Control Plane + Memory Governance | Core / Memory + Governance | High | `v0.7.52` | [v0.7.52](features/v0.7.52.md#feature_228-unified-memory-control-plane--memory-governance--rescheduled-from-v0751) |
| `225` | REPL Dead / Legacy Code Cleanup | Internal / Refactor + Tech Debt | Medium | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_225-repl-dead--legacy-code-cleanup--rescheduled-from-v0752) |
| `174` | `kodax sessions dedupe` | Internal / Maintenance + CLI | Low | `v0.7.54` | [v0.7.54](features/v0.7.54.md#feature_174-kodax-sessions-dedupe--rescheduled-from-v0753) |
| `105` | Verifiable Advisor Consult Primitive | Internal / Core | High | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_105-verifiable-advisor-consult-primitive--rescheduled-from-v0756) |
| `211` | Interactive-Mode Extension/MCP Session State Cross-Resume Persistence | Internal / Session Persistence | Medium | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_211-interactive-mode-extensionmcp-session-state-cross-resume-persistence--rescheduled-from-v0756) |
| `108` | Session-Driven Reflective Prompt Patcher | Internal / Test Infrastructure | Medium | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_108-session-driven-reflective-prompt-patcher--rescheduled-from-v0757) |
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_007-theme-system-consolidation) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_030-multi-surface-delivery) |
| `093` | Coding and REPL Internal Circular Dependency Decoupling | Internal | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_093-coding-and-repl-internal-circular-dependency-decoupling) |
| `113` | TodoList JSON / CLI Surface | Enhancement | Medium | `v0.8.2` | [v0.8.2](features/v0.8.2.md#feature_113-todolist-json--cli-surface) |
| `139` | NotebookEdit Tool | Enhancement / Tool | Low | `v0.8.20` | [v0.8.20](features/v0.8.20.md#feature_139-notebookedit-tool--jupyter-cell-level-crud) |

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

当前活跃索引不保留完成项。完成项请查 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md) 和 [CHANGELOG.md](../CHANGELOG.md)。

---

## 相关文档入口

- [Product Requirements](PRD.md)
- [Architecture Decision Records](ADR.md)
- [High-Level Design](HLD.md)
- [Detailed Design](DD.md)
- [Archived Features](FEATURES_ARCHIVED.md)
- [Known Issues](KNOWN_ISSUES.md)
