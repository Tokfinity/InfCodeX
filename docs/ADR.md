# KodaX Architecture Decision Records

> Last updated: 2026-05-06
>
> 这组 ADR 反映当前 `FEATURE_061/062` 之后的执行模型：
> Scout-first、按证据升级 harness、skill-aware AMA。
> v0.7.35.1 (FEATURE_142) 修正 v0.7.24 FEATURE_082 包结构漂移，详见 ADR-001 / ADR-021。

---

## ADR-001: Keep the Layered Monorepo

**Status**: Accepted (updated 2026-05-06 after FEATURE_142 v0.7.35.1)

KodaX 保持分层 monorepo，包结构经 v0.7.35.1 修正后为 **8 包**：

| 包 | 角色 | 说明 |
|---|---|---|
| `@kodax-ai/llm` | LLM 抽象 + provider 适配 | retry-after / cache markers / capability |
| `@kodax-ai/tracing` | Trace / Span / Processor | 独立可替换 OpenTelemetry / Langfuse |
| `@kodax-ai/session-lineage` | Session 持久化 + Lineage + Compaction 实现 | 承接 v0.7.35.1 从 `@kodax-ai/agent` 回流的 session 实体 |
| `@kodax-ai/agent` | **通用 Agent 框架（智能体底座）** | Agent / Runner / Handoff / Guardrail / Admission / Messaging / Orchestration / Memory / Team / Scratchpad / Construction / Runtime middleware；不绑定 coding |
| `@kodax-ai/skills` | Zero-dep skill packs | — |
| `@kodax-ai/mcp` | MCP integration | progressive disclosure 5 模式 |
| `@kodax-ai/coding` | **Coding agent 实例 + coding-specific 资产** | Coding tools / role prompts / H2 task-engine / coding-preset / repo-intelligence |
| `@kodax-ai/repl` | Ink TUI | — |
| `@kodax-ai/repointel-protocol` | Repo intel 协议包 | 跨仓库共享协议 |

Reasoning:

- 包名 = 内容承诺：`@kodax-ai/agent` 是通用 agent 平台，`@kodax-ai/coding` 是 coding-specific 实例
- `@kodax-ai/agent` 不依赖 `@kodax-ai/coding`、不依赖 `@kodax-ai/repl` 就能跑一个 agent
- 未来 `@kodax-ai/data-analysis-agent` / `@kodax-ai/ops-agent` 等按 `@kodax-ai/coding` 模式独立成包，统一依赖 `@kodax-ai/agent`
- task engine 的增强应建立在现有层次之上，而不是把层全部揉平
- 详细包归属规则见 ADR-021

**v0.7.35.1 之前（FEATURE_082 设计）**：曾包含 `@kodax/core`（含 Layer A primitives + 后续漂入的 runtime）和**设计但从未创建**的 `@kodax/capabilities`。v0.7.35.1 (FEATURE_142) 把 `@kodax/core` 30 文件全部并入 `@kodax-ai/agent`，并撤销 `@kodax/capabilities` 死设计，理由见 [v0.7.35.1 设计稿](features/v0.7.35.1.md) §FEATURE_142。

---

## ADR-002: KodaX Becomes a Task Engine

**Status**: Accepted

KodaX 的一等抽象是 `task`，不是旧的 `Project Mode`。

Consequence:

- `/project` 变成 control surface
- task contract / evidence / verdict 成为统一事实面

---

## ADR-003: Single-Agent First, Harness On Demand

**Status**: Accepted

系统默认从单 agent 语义出发，仅在证据表明必要时升级到 AMA harness。

核心执行形态：

- `SA`: single-agent direct
- `AMA-H0`: direct
- `AMA-H1`: checked-direct
- `AMA-H2`: coordinated

Reasoning:

- 简单任务不应先经历多角色 ceremony。
- 用户应当感觉系统“先试着直接做，再在需要时变强”。

---

## ADR-004: Remove `H3_MULTI_WORKER` from the Default Runtime

**Status**: Accepted

默认 runtime 不再保留 `H3_MULTI_WORKER`。

Reasoning:

- 缺乏清晰收益边界
- 容易带来角色膨胀、token 浪费、流式展示混乱

Consequence:

- AMA 只保留 `H0 / H1 / H2`
- 如未来重新引入并行执行，应作为新的受控设计，而不是历史残留

---

## ADR-005: `Scout` Is Pre-Harness Entry, Not a Long-Lived H2 Role

**Status**: Accepted (updated after FEATURE_061)

`Scout` 是 AMA 的唯一入口，承担 pre-harness 判断和 H0 直接执行。不进入 H2 主 graph。

FEATURE_061 扩展了 Scout 的能力：

- Scout 是所有 AMA 请求的第一站（无预路由层）
- H0 时 Scout 可直接完成任务（Scout-complete H0）
- Scout 升级到 H1/H2 时保留已有上下文（context continuation）
- 每个角色（含 Scout）可通过 `runOrchestration` 拉 subagent 并行

Reasoning:

- 避免 H2 角色图再次膨胀
- 保持 `Planner -> Generator <-> Evaluator` 作为唯一完整 harness 骨架
- Scout-complete H0 消除 scout-then-handoff 往返

---

## ADR-006: H2 Uses `Planner -> Generator <-> Evaluator`

**Status**: Accepted

H2 的唯一完整骨架是：

```text
Planner -> Generator <-> Evaluator
```

Consequence:

- `Planner` 负责 contract
- `Generator` 负责 deep evidence / execution
- `Evaluator` 负责 targeted spot-check / verdict

`Lead`、默认 `Admission`、`Contract Reviewer` 不再是主骨架角色。

---

## ADR-007: Skills Stay as Invocation Playbooks, Adapted via `skill-map`

**Status**: Accepted

skill 仍然是 invocation/playbook，而不是新的多角色协议。

当 skill 进入 AMA 时：

- `Scout` 读取完整 expanded skill
- `Scout` 生成 `skill-map`
- `Planner / Generator / Evaluator` 各自读取不同层次的 skill 视图

Reasoning:

- 保留 skill 的智能性
- 避免 raw skill workflow 平铺污染所有角色

---

## ADR-008: Evidence, Not Self-Report, Defines Completion

**Status**: Accepted

完成必须由 evidence + verdict 决定，而不是执行者自报完成。

Consequence:

- `Planner` 交 contract
- `Generator` 交 handoff
- `Evaluator` 交 verdict
- 缺 block 不得推进下游

---

## ADR-009: Work Is the Primary User-Visible Budget Signal

**Status**: Accepted

用户可见的主预算语义是 `Work used/total`。

`Round` 仅在真实额外 pass 存在时出现。

Reasoning:

- 用户需要理解成本，但不应暴露底层 worker iter 噪音
- `Iter x/y` 对 AMA 用户不可解释

---

## ADR-010: Evaluator’s Internal Review Must Not Leak into the Public Answer

**Status**: Accepted

Evaluator 可以在内部评估 Generator handoff，但这种元评估不应出现在用户最终答案里。

Consequence:

- 内部判断写入 verdict / transcript
- 用户答案直接面向用户交付结果

---

## ADR-011: `/project` Remains a Transitional Control Surface

**Status**: Accepted

`/project` 继续存在，但不再是主产品抽象。

它负责：

- inspection
- resume / pause / verify
- artifact browsing

---

## ADR-012: `Project` and `SA / AMA` Are Orthogonal Dimensions

**Status**: Accepted

`Project` 描述任务语境，`SA / AMA` 描述执行拓扑；二者可以合法组合。

Consequence:

- `Project + AMA` 继续使用完整 managed-task 语义
- `Project + SA` 是 first-class path，不是降级或非法路径
- `Project + SA` 不进入 managed-task graph，但会写 lightweight direct-run record 以支撑 status / summary / next-step continuity

---

## ADR-013: Non-Generator Roles Share Distilled Same-Role Summaries

**Status**: Accepted

`Scout`、`Planner`、`Evaluator` 保持 `reset-handoff`，但跨轮显式共享 distilled same-role summary。

Reasoning:

- 这些角色需要跨轮连续性，但不应恢复完整私有历史
- summary 注入比隐式依赖 artifacts 更稳定、更可控
- `Generator` 继续作为主要深度上下文消费者

---

## ADR-014: `H0_DIRECT` Means Single-Agent Finish

**Status**: Accepted

`H0` 的核心不是“完全没有判断阶段”，而是“最终没有多 agent handoff”。

Consequence:

- `H0` 允许两种合法形态：
  - `Direct H0`
  - `Scout-complete H0`
- 如果 `Scout` 判定 `H0_DIRECT` 且证据已足够，则由 `Scout` 直接给最终用户答案
- 不允许 `Scout` 判定 `H0` 后再 handoff 给第二个 direct agent

---

## ADR-015: Read-Only and Docs-Only Work Are Capped Below `H2`

**Status**: Accepted

`read-only` 与 `docs-only` 任务永远不进入 `H2`。

Consequence:

- 这类任务默认停留在 `H0`
- 只有用户明确要求 `double-check`、`second pass`、`更强审查` 或等价意图时，才允许进入 `H1`
- `reviewScale`、repo 规模、diff 大小、模块数量只影响 evidence strategy，不得单独抬高 harness

---

## ADR-016: `H1` Is Lightweight Checked-Direct, Not Mini-`H2`

**Status**: Accepted

`H1` 的设计目标是“轻快但有轻度质量保障”，而不是缩小版的 coordinated harness。

Consequence:

- `H1` 固定为 `Generator + 轻量 Evaluator`
- 无 `Planner`
- 无 contract negotiation
- 无默认多轮 refine
- `Scout` 进入 `H1` 后立即停手，只交付中等丰富、严格受限的 cheap-facts handoff
- `Evaluator` 只检查：
  - 是否对题
  - 是否漏项
  - 关键 claim 是否有证据
  - 是否明显过度自信
- `read-only/docs-only` 的 `H1` 最多只允许一次短 revise；失败后返回 `best-effort + limits`，不升级到 `H2`

---

## ADR-017: `--team` Is Not a Product Mode

**Status**: Accepted

`--team` 不再是主产品故事的一部分。

如果保留兼容入口，也只应视为 deprecated plumbing。

---

## ADR-018: Scout-First AMA Entry (FEATURE_061)

**Status**: Accepted

所有 AMA 请求由 Scout 作为唯一入口，不再有预路由 LLM 调用或 harness guardrail 层。

Consequence:

- Intent Gate 直接进 Scout，无 `routeTaskWithLLM` 预判
- `shouldBypassScoutForManagedH0` 已删除
- 预路由 harness floor 已删除（`resolveManagedHarnessGuardrail`）
- 3 个 Tactical Flow 被角色级 subagent 替代

Reasoning:

- 预路由消耗额外 LLM 调用但准确率不高
- Scout 已有足够信息在内部判断 H0/H1/H2
- 减少 ~3200 行代码

---

## ADR-019: Immutable Budget Model (FEATURE_062)

**Status**: Accepted

AMA budget 从 10 字段 + 14 函数简化为 `{ cap, used }` + 4 个纯函数。

Consequence:

- Budget zone、reserve logic、iter limits 全部移除
- convergence signal 内联到 `buildWorkerRunOptions`
- Budget 判断变为 `used/cap` 纯比较

Reasoning:

- 旧模型复杂度远超实际需要
- 新模型更 immutable、更可测试、更 LLM-friendly

---

## ADR-020: Unified Agent Execution Substrate (FEATURE_100, v0.7.29)

**Status**: Accepted

KodaX 的 SA 与 AMA 用户切换是永久产品决策（ADR-003 / ADR-012），但**实现层不再保留两套独立的 agent 执行路径**。所有 agent 调用 —— SA 直达、AMA 的 Scout/Planner/Generator/Evaluator、subagent fan-out —— 都通过同一个 Runner 帧、同一个 executor、同一套 Layer-A primitives 执行。

核心区分：

- **Layer A — substrate（共享）**：provider loop、tool dispatch、history 管理、microcompact、edit recovery、extension runtime、ToolGuardrail runtime、reasoning resolution、trace+span、session snapshot、cost tracking。所有 agent 共享，不绑定 mode。
- **Layer B — Agent declaration（多份）**：role name、system prompt、handoff config、reasoning profile、tool slice、opt-in middleware（如 auto-reroute、mutation reflection）。这是 mode 之间的全部差异。
  - SA topology = `Runner.run(defaultCodingAgent, prompt, ctx)`
  - AMA topology = `Runner.run(scoutAgent, prompt, ctx)`（Scout 自带 handoff 链）
- **dispatcher（薄层）**：`task-engine.ts` 仅按 `agentMode` 选择喂哪份 declaration，body 不分叉。

Reasoning:

- 产品对等不蕴含实现分叉。v0.7.27 commit `5cf161c` "SA and AMA are parallel, not legacy" 描述用户视角的对等；把它误读为"实现必须双轨"是 v0.7.23 Option Y 之后逐版本漂移的结果，不是经过审议的设计。
- 历史漂移：v0.7.23 FEATURE_080 把 SA body 重写到 Runner 的工作显式 punt 给 FEATURE_084；v0.7.26 FEATURE_084 只重写了 Scout/Generator/Evaluator，SA body 未动；之后无 ADR 记录该 punt 失效。本 ADR 关闭这个漂移。
- `runner-driven.ts` 的 13 处 "legacy parity restore" 注释是反向实证：FEATURE_084 当时让 AMA 路径绕开 `runKodaX`，结果陆续发现 `onSessionStart` / repoIntelligence / multimodal / `cleanupIncompleteToolCalls` / `saveSessionSnapshot` / cost tracker 等一批 SA body 已具备的能力在 AMA 缺失，靠补丁回填。统一底座之后这类失踪能力的发生条件消失。
- 路线图依赖：FEATURE_078（v0.7.30）/ FEATURE_089（v0.7.31）/ FEATURE_090（v0.7.32）/ FEATURE_092（v0.7.33）/ FEATURE_094（v0.7.42）都假设 reasoning profile / `Runner.run` 调用 / Runner-level guardrail 在两种 mode 下均可用。沿用双底座会让每个 feature 都重复一次"SA 端再接一遍"。
- 参照项目（pi-mono、openai-agents-python）均为单实现路径；KodaX 没有偏离它们的合理理由。

Consequence:

- `agent.ts` 的 `runKodaX` 不再是独立 SA 入口；其能力按 substrate / declaration 两类拆解到 `agent-runtime/` 与 `defaultCodingAgent`。
- `task-engine.ts` 的 SA / AMA 分支只挑 Agent declaration，不挑 executor。
- v0.7.23 FEATURE_080 引入的 "Option Y" preset dispatcher facade 升级为真实 Runner 帧入口，shim 删除。
- 未来新角色（如 FEATURE_089 生成的 Agent）天然在两种 mode 下都可调用，不需要 mode-specific wiring。
- ADR-003 / ADR-014 的语义不变；ADR-012（Project / SA / AMA 正交）的 SA / AMA 维度从"两种执行路径"重新定义为"两种 Agent topology 选择"。

Migration:

- 实施于 v0.7.29 FEATURE_100，单一 feature 占整版本。
- 直接切换，无 legacy flag。通过 capability inventory + golden-trace test suite + capability contract tests + dispatch eval baseline + reverse audit 五重保险保证零回归，详见 `docs/features/v0.7.29.md`。
- 原计划 v0.7.29 的 FEATURE_078 (Role-Aware Reasoning Profiles) 顺延到 v0.7.30，与 FEATURE_057 Track F 共版（工作面不交叉）。下游版本（089/090/092/094）保持原位。

---

## ADR-021: Agent Framework Boundary（@kodax-ai/agent vs @kodax-ai/coding）

**Status**: Accepted (FEATURE_142 v0.7.35.1)

KodaX 包结构按"包名 = 内容承诺"原则严格执行。`@kodax-ai/agent` 是**通用 Agent 框架（智能体底座）**，`@kodax-ai/coding` 是 **coding-specific** 实例。两者不可互相侵入，下面是判断规则。

### 落 `@kodax-ai/agent` 的内容（通用 agent 平台原语）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Agent primitives | `primitives/` | Agent / Runner / Handoff / Guardrail / Session interface |
| Admission contract | `admission/` | Admission pipeline + 7 quality invariants（FEATURE_101） |
| Messaging | `messaging/` | 2-tier priority queue + agentId routing（FEATURE_115） |
| Orchestration | `orchestration/` | Pattern B dispatch / child-task registry / idle-yield 状态机（detectIdleYield + waitForWakeEvent + composeIdleYieldUserMessage）/ Runner.runWithIdleYield 包装 / SendMessage router / TaskStop / Peer router（FEATURE_119/120/123/128/155 — v0.7.39 FEATURE_120 Step 0 完成包归属迁移） |
| ~~Scratchpad~~ | ~~`scratchpad/`~~ | ~~去耦合大输出通道（FEATURE_121）~~ — **2026-05-12 取消**：FEATURE_121 v0.7.40 rescoped 为 "Envelope Spillover Gap-Fix"（复用 `@kodax-ai/coding/tools/tool-result-policy.ts` 现有 spillover 体系 + `@kodax-ai/agent/orchestration/idle-yield.ts` 加聚合 cap），**不新建 `scratchpad/` 子目录、不引入新工具**。详见 [features/v0.7.40.md](features/v0.7.40.md#feature_121-envelope-spillover-gap-fix--child-task-summary-接入-tool-result-policy) |
| Memory | `memory/` | 4-type taxonomy + scope resolver（FEATURE_124） |
| Team | `team/` | Multi-instance state broadcast + system-prompt injection（FEATURE_125） |
| Construction | `construction/` | Self-Construction runtime / agent-resolver / sandbox-runner（FEATURE_087/088/089/090/101） |
| Runtime middleware | `runtime-middleware/` | 通用 substrate middleware（compaction-trigger / max-tokens-continuation / permission-gate 接口层） |
| Tokenizer | `tokenizer.ts` | js-tiktoken 适配 |

**判定规则**：任何"非 coding agent 也需要"的 agent 平台能力 → `@kodax-ai/agent`。

### 落 `@kodax-ai/coding` 的内容（coding-specific）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Coding tools | `tools/` | Read / Write / Edit / MultiEdit / Bash / Grep / Glob / WebFetch / WebSearch / SemanticLookup / RepoOverview |
| Tool wrappers for agent platform tools | `tools/` | dispatch_child_task / send_message / task_stop / list_agents / todo_update（**工具壳留 coding，调 agent 端原语**；tool 描述文本含 coding-specific prompt）—— FEATURE_121 v0.7.40 rescope 后无 `write_scratchpad` / `read_scratchpad`（envelope spillover 由 framework 自动处理，Worker 直接用 Read 工具读 spill 文件） |
| Coding role prompts | `prompts/` / `agents/*-role-prompt.ts` | Worker / Scout / Planner / Generator / Evaluator role prompts |
| H2 task-engine 状态机 | `task-engine/` | managed-task / runner-driven / role-prompt builder（coding AMA-specific） |
| Coding agent 实例 | `agents/` | defaultCodingAgent / scoutAgent / generatorAgent / evaluatorAgent |
| Coding-specific middleware | `agent-runtime/` | tool-dispatch / prompt-content / assistant-message-builder / per-turn-reasoning |
| Coding preset | `coding-preset.ts` | DEFAULT_CODING_INSTRUCTIONS + tool slice 装配 |
| Repo intelligence | `repo-intelligence/` | Coding-specific 仓库结构理解 |
| Coding-side provider wiring | `providers/` | Coding 端的 wire-level provider 配置 |
| File-mutation safety net | `multi-instance/` | content-hash-cache / active-file-warning（绑 Edit / Read tool 实现） |

**判定规则**：任何"只对 coding agent 有意义"的内容 → `@kodax-ai/coding`。

### Tool wrapper 的双层模式

通用 agent 平台工具（dispatch_child_task / send_message / task_stop / list_agents 等）使用**双层模式**：

- **底层 primitive** 在 `@kodax-ai/agent/<domain>/`：路由 / 队列 / 注册表 / 协议（不含 prompt）
- **工具壳** 在 `@kodax-ai/coding/tools/`：tool schema + handler 调底层 primitive；tool description 含 coding-specific prompt（如 "use this when reviewing a coding PR"）

理由：tool description 是 prompt 工程的一部分，含 coding 偏置；底层路由 / 队列等机制对所有 agent 通用。未来真有 ≥3 个非 coding agent 包后，可以再抽 `@kodax-ai/agent/tools/` 通用工具壳层。当前 1 个 consumer，按 KodaX 哲学不预先抽。

### 何时考虑再开 `@kodax/core`（types-only 子包）

撤销 `@kodax/core`（v0.7.35.1）后，未来 **当且仅当**下面三条**至少一条**成立时，才考虑从 `@kodax-ai/agent` 拆出 `@kodax/core` types-only 子包：

1. 出现 ≥3 个 type-only declaration 消费者（例如 IDE 插件 typecheck 用户的 agent manifest 但不跑）
2. 出现真实跨包横切设施需求（例如 errors 类被 `@kodax-ai/llm` / `@kodax-ai/agent` / `@kodax-ai/coding` 都需要统一 shape）
3. 出现 ≥3 个非 coding agent 包（`@kodax-ai/data-analysis-agent` / `@kodax-ai/ops-agent` / 等），它们之间需要共享 Layer A types 但不互相依赖

**严禁预先开包**。FEATURE_082 v0.7.24 在 1 个 consumer 时强行建立 4 层模型（`ai → core → capabilities → coding`），导致 `@kodax/capabilities` 成为死设计 + `@kodax/core` 名实倒挂——这是 KodaX `NEVER add abstractions until 3+ concrete use cases` 哲学违反的实证后果，本 ADR 写明以避免重蹈。

### 撤销的 `@kodax/capabilities` 死设计

FEATURE_082 v0.7.24 设计稿曾把 `@kodax/capabilities` 作为 Layer B 组合能力包列入新包清单和依赖图，并约定 FEATURE_084 v0.7.26 把 Scout/Evaluator/Generator 落入此包。但：

- `packages/capabilities/` **从未被创建**
- FEATURE_084 真要落 Scout/Evaluator/Generator 时绕开它，直接放 `coding/src/agents/`
- 事后回看：Scout/Evaluator/Generator 是 coding AMA H2 实例，本来就该在 coding——"通用 capabilities"是预先抽象

v0.7.35.1 (FEATURE_142) 正式从 ADR / 文档清理 `@kodax/capabilities`，**永久撤销**。未来如真出现"通用能力包"需求（满足 ADR-021 §"何时考虑再开 core"的 3 条之一），可以新设包，不复用 `capabilities` 名字（避免与历史死设计混淆）。

---

## ADR-022: npm Distribution — Single Bundle, Not Multi-Package (FEATURE_150, v0.7.37)

**Status**: Accepted (2026-05-08)

**TL;DR**：源码层保持 9 子包 + 1 root 的分层 monorepo（ADR-001 不变），npm 发布层从"10 个独立包"切到"**1 个 bundle 包 `@kodax-ai/cli`**"。

### 背景

FEATURE_147 (v0.7.37) 完成了 `@kodax/*` → `@kodax-ai/*` scope 重命名，并首次把 9 个子包 + 1 个 root 共 10 个包发布到 npm 公网 registry。发布后立即暴露三个 P0 类问题：

1. **`@kodax-ai/coding` 漏声明 4 个 runtime deps**（`typescript` / `tsx` / `iconv-lite` / `glob`）。Dev 环境靠 monorepo root hoisting 隐藏；终端用户 `npx @kodax-ai/cli` 第一次 `import 'typescript'` 直接 `ERR_MODULE_NOT_FOUND`。
2. **`@kodax-ai/repl` 漏声明 26 个 vendored Ink fork transitive deps**（`yoga-layout` / `react-reconciler` / `ws` / `scheduler` / 等等）。Vendored fork 模式下原 Ink 包的 transitive deps 没人替我们装。
3. **`@kodax-ai/skills` 6 个 helper script 残留旧 scope 引用 `@kodax-ai/coding`**。即使改成 `@kodax-ai/coding`，bundle 模式下该包不再发布到 npm，仍然解析不到。

### 决策

放弃 multi-package 发布模型，改用 esbuild bundle root entry 成单文件，9 个子包**不再发布到 npm**。

### Reasoning

1. **没有真实 SDK 用户**。CLAUDE.md 写过 "every package is independently usable"，但这是架构愿景，不是用户量验证。真实使用形态是 `kodax` 命令；零证据表明有人 `npm install @kodax-ai/coding` 单独消费。
2. **SDK 集成方有标准替代路径**。想做基于 KodaX 的产品的开发者，`git clone + npm link / file: 协议 + esbuild bundle 自己的产品` 是成熟工程做法（Apache-2.0 license 明确允许 inline 源码到 dist）。这条路径**不依赖** KodaX 在 npm 上发子包。
3. **bug class 整体消除**。Multi-package 模式下"vendored fork transitive deps 漏声明"这类 bug 是发版 9 包都要重新校验一遍的脆弱面。Bundle 模式下 esbuild 自动跟踪 transitive imports，整个 bug class 不再可能触发。
4. **维护成本下降一个量级**。一个 `package.json` 取代 10 个；一个 version 号取代 10 个；一次 `npm publish` 取代 10 次（外加 root 的临时 rewrite 脚本）。
5. **"独立可用"愿景通过源码可读 + license + monorepo 结构保留**。使用方式从"装 npm 包"变成"读源码 + bundle 自己用"，这正是 SDK 集成方实际在做的事。

### Consequences

**保留不变**：
- `packages/{ai,agent,coding,mcp,repl,repointel-protocol,session-lineage,skills,tracing}/` 9 个子包目录、各自 `package.json`、各自 `src/` / `dist/` 编译产物 → 全部不变（源码层"每个包独立可用"承诺）
- ADR-001 / ADR-021 的 layered monorepo 设计不变
- npm workspace 内部 `*` 协议 deps 不变
- dev 命令 `npm run dev` / `npm run build` / `npm run test` 不变

**改变**：
- npm registry 上只有 `@kodax-ai/cli@<version>`（root），9 个 `@kodax-ai/{llm,agent,...}` 不再发布
- root `package.json#dependencies` 合并所有 9 子包的真第三方 deps（约 35 个第三方包），删除所有 internal `@kodax-ai/*` workspace deps
- `scripts/release-npm.mjs` + `scripts/publish-root-cli.mjs` 删除，替换为 `scripts/release.mjs`（单包发布）
- 新增 `scripts/build-bundle.mjs` —— esbuild 三个 entry：
  - `src/kodax_cli.ts` → `dist/kodax_cli.js`（CLI bin 入口）
  - `src/index.ts` → `dist/index.js`（SDK 入口；服务于 KodaX 自己的 builtin helper scripts，顺带开放给路径 B 集成方）
  - 静态复制 `packages/skills/dist/builtin/` → `dist/builtin/`（LLM 通过 skill 触发的资源；目录名必须是 `builtin` 而非 `builtin-skills`，因为 `@kodax-ai/skills` 通过 `path.join(__dirname, 'builtin')` 解析）

**对 SDK 集成方影响**：
- 路径 A（推荐）—— `git clone + npm link + bundle 自己产品`：完全不受影响
- 路径 B（顺带支持）—— `npm install @kodax-ai/cli` 后 `import { runKodaX } from '@kodax-ai/cli'`：可用，但绑定 cli version cadence
- 旧 multi-package install（`npm install @kodax-ai/coding`）—— 不再支持；CHANGELOG / migration notes 注明引导

### 替代方案讨论

**A. 修 deps republish multi-package**：保留 10 包模式，把漏的 30 个 deps 修齐重发。被否：长期看 vendored fork transitive deps 漏声明的 bug class 仍在；维护成本不变；不解决"无 SDK 用户但发 10 包"的根本不对称。

**C. 混合（保留 `@kodax-ai/llm` `@kodax-ai/agent` 独立发，其他 bundle）**：被否：当前没有任何证据这两个包有独立 SDK 价值；混合模式同时承担两套发版工程的复杂度。

### 与 ADR-001 / ADR-021 的关系

源码层分层（ADR-001 / ADR-021）**完全不变**：9 个子包仍然是层次清晰的分层模型，layer independence 仍是 review 必须坚守的不变量。变化只在**发布层**：从"层次直接映射到 npm package 列表"改成"层次保持源码可读但发布物聚合为单包"。

### 触发回退的条件

未来当且仅当下面**同时**两条成立时，才考虑回到 multi-package 发布模式：

1. 出现 ≥3 个真实独立 SDK 消费者（不是 KodaX 自己的 monorepo 内部消费），且他们明确反馈"装单包绑 cli version 不可接受"
2. 至少 2 个子包出现独立的 release cadence 需求（即 cli 不发版的同时这些子包要发新 version）

仅 1 条满足不足以回滚 —— 单 SDK 用户可以通过路径 A（git clone + bundle）解决。

### Addendum (v0.7.39, 2026-05-11) — 包名更正 `@kodax-ai/cli` → `@kodax-ai/kodax-cli`

> **Status (2026-05-12)**: 本 addendum 描述的中间状态 `@kodax-ai/kodax-cli` 已被 **ADR-024** 取代为 `@kodax-ai/kodax`。v0.7.38 在 npm 上确实双发了 `@kodax-ai/kodax-cli@0.7.38`（作为 `@kodax-ai/cli@0.7.38` 同代码 dual-publish），但 v0.7.39 起的正式发布物名称是 `@kodax-ai/kodax`（无 `-cli` 后缀）。保留下文记录决策演变历史。

v0.7.37/v0.7.38 在 npm 上的包名是 `@kodax-ai/cli`。命名时跟随了 SDK 范式（`@org/cli` 形态名），但实践证明这与 KodaX 作为**产品**的定位不匹配——业界主流是把 npm 包名直接对齐产品名（`@anthropic-ai/claude-code`、`aider-chat` 等）。v0.7.38 刚发完正式版本（之前只有 0.0.1 占位包），用户量极小，是改名最佳窗口期。

**决定**：v0.7.39 起改名为 `@kodax-ai/kodax-cli`。
- 保留 `@kodax-ai` scope（未来加 `@kodax-ai/sdk` 等独立子包仍有命名空间）
- 包名第二段直接 = 产品名 `kodax`，对齐业界主流
- 保留 `-cli` 后缀明确这是 CLI 工具的发布形态

**Migration**：
- `scripts/release.mjs` 改 `pkg.name = '@kodax-ai/kodax-cli'`
- 所有 forward-going 文档（HLD、README、ADR-022 本段、release.mjs banner、build-bundle banner、skill-creator/utils.js Strategy 3）一次性更新
- 历史记录（CHANGELOG v0.7.37/v0.7.38 entries、docs/features/v0.7.37.md、docs/FEATURE_LIST.md）保留原 `@kodax-ai/cli` 字样，作为命名历史的真实记录
- v0.7.39 发布后对 `@kodax-ai/cli@*` 执行 `npm deprecate "Package renamed to @kodax-ai/kodax-cli. Run: npm install -g @kodax-ai/kodax-cli"`
- `skill-creator/scripts/utils.js` 保留 `import('@kodax-ai/cli')` 作为 Strategy 4 兜底（向后兼容 v0.7.37/v0.7.38 已安装用户）；deprecation 窗口过后再移除

**不改的部分**：
- `packages/*/package.json` 里 `@kodax-ai/{ai,agent,coding,mcp,repl,...}` 子包名**不动**——它们本来就不发到 npm（bundle 模式），仅作 workspace 内部 alias。这次改名只针对 root 发布物。
- bin 命令 `kodax` 不动（安装后用户跑的命令仍是 `kodax`）。

---

## ADR-023: Bash Command Parsing — Regex → AST Migration (FEATURE_152, v0.7.38)

**Status**: Proposed (2026-05-09)

**TL;DR**：`packages/repl/src/permission/permission.ts` 里 `isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets` 从手写 regex 拼凑迁移到基于 **`shell-quote`（pure JS POSIX shell parser）** 的 AST 解析。**不**引入 tree-sitter（CC 用作 primary path）—— shell-quote 单独覆盖 99% 场景，且 KodaX "极致轻量化" 哲学不接受 WASM 二进制膨胀。Issue 129 (v0.7.38) 临时 strip-then-classify hack 在迁移落地的同一 commit 内一次性删除（**不并行**两套实现）。

### 背景

当前 [permission.ts](../packages/repl/src/permission/permission.ts) 用 4 个 regex 常量加手写字符串切分判定 bash 命令是只读还是写：

- `BASH_REDIRECTION_WRITE_PATTERN = /(^|[^<])>>?(?=\s*\S)/`
- `BASH_WRITE_COMMAND_REGEXES`（按 `BASH_WRITE_COMMANDS` set 动态生成）
- `BASH_WRITE_SUBCOMMAND_PATTERNS`（PowerShell cmdlet 关键字）
- `baseIllegalSyntax = /[<>;`]|\$\(|(?<!&)&(?!&)|\|\|/`（在 `isBashReadCommand` 内）

这套设计在 KodaX 早期（v0.3.x）足够用，但近期暴露了三类系统性问题：

**问题 A — 假阳性导致 LLM 分类器被 short-circuit**（已有 [Issue 129](KNOWN_ISSUES.md#129) 实例）：
- `2>NUL` (Windows) / `2>/dev/null` (POSIX) stderr 丢弃被当成写文件 → [tool-confirmation.ts:94](../packages/repl/src/common/tool-confirmation.ts#L94) 把 Intent 标成 "Modify files"
- 配合 [executor.ts:236-247](../packages/repl/src/permission/executor.ts#L236-L247) 出项目 `cd` 的硬规则，auto 模式下 FEATURE_092 (v0.7.33) 的 LLM 分类器没机会发言

**问题 B — Windows / 复合命令族覆盖不全**：
- `findstr` / `fc` / `where`（Windows 原生工具）原本不在 `BASH_SAFE_READ_COMMANDS`
- 管道 `|` 一票否决（已有 `&&` 拆分，但没扩展到 `|`）
- heredoc / line-continuation / 命令替换嵌套等 attack vector 不受 regex 检查（CC 在 [commands.ts:120-160](C:\Works\claudecode\src\utils\bash\commands.ts#L120-L160) 有大段安全注释专门处理）

**问题 C — 维护成本随场景膨胀**：
- Issue 129 已通过 strip-then-classify pre-pass（`NULL_DEVICE_REDIRECT_PATTERN` 在 regex 之前先擦掉 fd-redirect）解决，但每次发现新的"语法上读、regex 误判写"场景都要再加一个 strip。技术债在累积。

参考实现：Claude Code 在 [`utils/bash/commands.ts`](C:\Works\claudecode\src\utils\bash\commands.ts) (1339 行) 用 **tree-sitter 作为 primary**（精度 + 性能）+ **shell-quote 作为兜底**（覆盖 tree-sitter 不可用环境）。Tree-sitter 路径需要 WASM binary（`tree-sitter-bash.wasm` ~500KB）+ async 初始化；shell-quote 是 pure JS、同步 API、~12KB。

### 决策

KodaX 跳过 tree-sitter，直接用 shell-quote 作为唯一 AST 后端。新增内部模块 [`packages/repl/src/permission/bash-ast.ts`](../packages/repl/src/permission/bash-ast.ts)，对外只暴露既有公开签名（`isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets`），调用方零改动。

### Reasoning

1. **极致轻量化哲学**（[CLAUDE.md](../CLAUDE.md) 核心原则之一）：tree-sitter + WASM ~500KB 进单文件二进制不可接受。shell-quote 12KB pure JS 可接受。
2. **shell-quote 已被 CC 验证覆盖 99% 场景**：CC 把它当 fallback 全功能路径，不是降级路径——任何 tree-sitter 不在的场景，shell-quote 同样产出正确决策。
3. **同步 API 保持**：现有 `isBashReadCommand(command: string): boolean` 是同步签名，调用方包括 [executor.ts:197](../packages/repl/src/permission/executor.ts#L197) 同步执行链。tree-sitter WASM 强制异步会污染 4 个调用文件 + 上游 `executeWithPermission` 链路。shell-quote 同步即可。
4. **fail-closed 是默认安全语义**：shell-quote 在解析失败（malformed shell syntax）时返回 error；新代码视作 "unsafe → 提示用户" 而不是放行。镜像 CC `splitCommandWithOperators` 在 [commands.ts:156-160](C:\Works\claudecode\src\utils\bash\commands.ts#L156-L160) 的 fail-closed 策略。
5. **一次性替换避免新旧并行**（feedback memory: 大重构不引入新旧代码并行）：迁移 land 的同一 commit 内删除所有 regex 常量 + Issue 129 的 `NULL_DEVICE_REDIRECT_PATTERN` strip-then-classify hack。任何瞬间只有一套实现。
6. **PowerShell 不进 AST**：`set-content` / `out-file` / `new-item` 等 PowerShell cmdlet 在 [permission.ts:177-187](../packages/repl/src/permission/permission.ts#L177-L187) 的 `BASH_WRITE_SUBCOMMAND_PATTERNS` 里用关键字匹配，不属于 POSIX shell 语法族；本 ADR 不动。

### Consequences

**保留不变**：
- 4 个公开函数签名（`isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets`）+ 类型 → 调用方 0 改动
- `BASH_SAFE_READ_COMMANDS` set 作为白名单语义保留（仍是命令名匹配的 source of truth）
- `BASH_WRITE_COMMANDS` set 同上
- `BASH_WRITE_SUBCOMMAND_PATTERNS`（PowerShell 关键字）保留
- `getBashOutsideProjectWriteRisk` / `getPlanModeBlockReason` 行为保留
- `tool-confirmation.ts` 的 Intent / Risk 分类逻辑保留（消费 `isBashWriteCommand` 的输出）

**删除**：
- `BASH_REDIRECTION_WRITE_PATTERN` regex 常量
- `BASH_WRITE_COMMAND_REGEXES` 编译数组
- `NULL_DEVICE_REDIRECT_PATTERN`（Issue 129 引入的临时 hack）
- `isBashReadCommand` 内部的 `baseIllegalSyntax` / `subCommands.split(...)` 手写切分逻辑

**新增**：
- `packages/repl/src/permission/bash-ast.ts`：内部 helper 模块，导出 `parseBashCommand(s)`（基于 shell-quote）、`extractRedirections(tokens)`、`splitByControlOps(tokens)` 等
- `package.json` deps 加 `shell-quote@^1.8` + `@types/shell-quote@^1.7`（dev）
- 测试加 ~40 case 覆盖 heredoc / 命令替换嵌套 / fd-redirect 各形态 / line-continuation / ZSH 力覆盖等 attack vector（参考 CC 的 hardening test）

**对 SDK 集成方影响**：无。所有改动在 `@kodax-ai/repl` 包内部。

### 替代方案讨论

**A. 继续用 regex + 每次新场景加 strip-pass**：被否。Issue 129 已经证明 `2>NUL` / `|` / `findstr` 任一个 regex 漏判都需要一次 hotfix；剩余场景（heredoc 写、ZSH `>!` 力覆盖、命令替换内嵌写）每个都要重复一遍。技术债线性增长。

**B. tree-sitter 作为 primary（CC 等价方案）**：被否。+500KB WASM 二进制 + async API 污染 + 4 个调用方需要重构同步链路。CC 也只把 tree-sitter 当性能优化，shell-quote 作 fallback —— 我们直接用 fallback 即可。

**C. 写自己的 lexer**：被否。1500+ 行 hand-rolled parser 等价于在 KodaX 内部重写一个 shell-quote。`shell-quote` 是 substack 维护多年的稳定库（npm 周下载 1500 万+，CC 用作生产 fallback），自己重写不增加价值。

**D. 把 Issue 129 的 strip-then-classify pattern 系统化（每个 false-positive 加一条 strip 规则）**：被否。等价于方案 A 的工程化版本——治标不治本，且 strip-pass 本身改命令字符串，未来如果分类器需要看完整命令 token（比如 LLM prefix extractor / FEATURE_153）会失真。

### 与其他 ADR 的关系

- **不影响 ADR-001 / ADR-021**（包结构、layered monorepo）：所有改动在 `@kodax-ai/repl` 包内部。
- **不影响 ADR-022**（npm bundle 发布）：`shell-quote` 作为 root `package.json` 的 deps 经 esbuild 自动 inline 到 `dist/kodax_cli.js`，不增加发布工程负担。
- **解锁 FEATURE_092 (v0.7.33) 的设计意图**：auto-mode LLM classifier 当前被规则层假阳性 short-circuit；AST 化后误判面收敛，classifier 在所有 non-trivial 命令上拿回主决策权——这是用户感知 auto 模式 "顺/不顺" 的根因。
- **解锁 FEATURE_153**（LLM prefix extractor，参考 CC `BASH_POLICY_SPEC`）：prefix extractor 需要的是命令的 token 化结构（"command name + args"），shell-quote AST 直接产出，FEATURE_153 不再需要自己解析。
- **不影响 FEATURE_154**（universal `--help` fast-path）：`isHelpCommand` 是基于 token 的判定，shell-quote 输出直接喂进去更简洁。

### 触发回退的条件

未来当且仅当下面**任一**条成立时，回滚到 hand-written parser（注意：不会回滚到 v0.7.37 的纯 regex 方案，那个已经被验证不够）：

1. shell-quote 出现无法修复的安全 bug（CC 已经在生产 fallback 路径用了 1+ 年没遇到，概率低）
2. 出现 ≥3 个 KodaX 实测场景 shell-quote 解析正确但产出的 token 流不足以做安全决策，且无法通过补充 token-walker 逻辑解决

### 实施切片（FEATURE_152）

每个切片独立 commit + push，逐步 review：

| Slice | 改动 | LOC | 风险 |
|---|---|---|---|
| 1 | 引入 `bash-ast.ts` + 装 `shell-quote` deps，**不接入** | ~400 | 中（新增模块；既有路径不动） |
| 2 | 切换 `isBashReadCommand` / `isBashWriteCommand` 内部到 AST，**同 commit 删 `NULL_DEVICE_REDIRECT_PATTERN` + 旧 regex 常量** | ~500 | **高**（核心切换；no-parallel 原则） |
| 3 | 切换 `extractPathsFromCommand` / `collectBashWriteTargets` 到 AST | ~300 | 中 |
| 4 | 清理：删除已无引用的 `BASH_*_REGEXES` / `BASH_REDIRECTION_WRITE_PATTERN` 等 dead code，补 hardening test（heredoc / 命令替换 / ZSH 力覆盖） | ~200 | 低 |

每个 slice 完成后跑：`packages/repl/src/permission/` 全测 + `packages/repl/src/common/tool-confirmation.test.ts` + `tests/tracker-consistency.test.ts` + `npm run build`，确认 0 漂移 0 退化再进下一片。

---

## ADR-024: npm 发布物正名 `@kodax-ai/kodax` + SDK Subpath Exports 形式化 (v0.7.39)

**Status**: Accepted (2026-05-12)

**TL;DR**：把 npm 发布物从 `@kodax-ai/kodax-cli`（v0.7.38 中间形态）改为 `@kodax-ai/kodax`（去 `-cli` 后缀），同时通过 ESM subpath exports 把 5 个内部包（agent / llm / coding / repl / skills）显式开放给 SDK 消费者。源码层分包（ADR-001 / ADR-021）**完全不变**；ADR-022 的"单 bundle 发布"决策**仍然成立** —— 本 ADR 只是在 bundle 内部增加 6 个 entry（root + 5 subpath）并共享 chunks。

### 背景

v0.7.37 / v0.7.38 在 npm 上的包名经历了两次决策：

1. v0.7.37/v0.7.38 首发：`@kodax-ai/cli`
2. v0.7.38 dual-publish：`@kodax-ai/kodax-cli`（同代码，ADR-022 Addendum 记录的中间状态）

v0.7.38 发布后的复盘暴露两个问题：

1. **`-cli` 后缀和"产品名 = 包名"业界主流不一致**。`@anthropic-ai/claude-code`、`aider-chat`、`next`、`vite` 等都是产品名直接做包名，没有 `-cli` 后缀。`-cli` 后缀暗示"还有一个非 CLI 的 SDK 包"的二分结构，但 KodaX 实际上是一个 CLI + 内嵌 SDK 表层的整体。
2. **SDK 形态没有显式入口**。装 `@kodax-ai/kodax-cli` 后想 `import { Runner } from '...'` —— 只能从 root 拿到，且 root entry 把所有东西 re-export 到一处，bundler 静态分析不友好，对希望 tree-shake 的 SDK 消费者不够明确。

### 决策

1. **改名**：v0.7.39 起 npm 发布物名称为 `@kodax-ai/kodax`（无 `-cli` 后缀），覆盖 v0.7.38 的 `@kodax-ai/kodax-cli` 中间状态。
2. **SDK Subpath Exports**：在 `package.json#exports` 增加 5 个 subpath：
   - `@kodax-ai/kodax/agent`  → re-exports `@kodax-ai/agent`
   - `@kodax-ai/kodax/llm`    → re-exports `@kodax-ai/llm`
   - `@kodax-ai/kodax/coding` → re-exports `@kodax-ai/coding`
   - `@kodax-ai/kodax/repl`   → re-exports `@kodax-ai/repl`
   - `@kodax-ai/kodax/skills` → re-exports `@kodax-ai/skills`
3. **Bundle 结构**：CLI 仍然单 entry self-contained（最快 bin 启动）；6 个 SDK entry（root + 5 subpath）改用 esbuild `splitting: true` 多 entry 单次构建，共享代码自动落到 `dist/chunks/*.js`，避免 6× tarball 膨胀。

### Reasoning

1. **名字 = 产品**。`kodax` 命令、`kodax` 产品定位、`@kodax-ai/kodax` npm 包 —— 三者一致是最少认知负担的命名。
2. **改名窗口期 v0.7.38 → v0.7.39 最佳**。v0.7.38 是首次真实公网发布（之前只有 0.0.1 占位），用户量极小；v0.7.39 之前再改一次成本极低，v1.0 之后再改成本不可控。
3. **Subpath exports 是 SDK 表面化的标准做法**。ESM 生态（`react-dom/server`、`firebase/firestore`）证明这是 tree-shake 友好的方式；不引入新概念。
4. **共享 chunks 控制 bundle 膨胀**。5 个 subpath 几乎都 re-export 同一组内部代码；不共享会让 tarball 翻 6 倍。`splitting: true` 让每个 SDK entry 自己只剩 1-30 kB，chunks 集中 ~1.4 MB，整体 tarball ~1.1 MB 不变。

### Consequences

**变化**：

- `scripts/release.mjs`：`pkg.name = '@kodax-ai/kodax'`；`rewriteRootPackageJson()` 注入 5 个 subpath `exports`
- `scripts/build-bundle.mjs`：SDK 部分改多 entry + `splitting: true`，输出 `dist/index.js` + `dist/sdk-{agent,llm,coding,repl,skills}.js` + `dist/chunks/*.js`；CLI 路径保持 self-contained
- 新增 `src/sdk-{agent,llm,coding,repl,skills}.ts` —— 各自一行 `export * from '@kodax-ai/<pkg>'`
- `packages/skills/src/builtin/skill-creator/scripts/utils.js` SDK Strategy chain 简化为 3 层（relative / `@kodax-ai/coding` / `@kodax-ai/kodax`），删除 `@kodax-ai/kodax-cli` 和 `@kodax-ai/cli` 兜底

**不变**：

- 源码层 9 子包结构、layer independence、ADR-001 / ADR-021 全部不变
- ADR-022"单 bundle 发布"主决策不变 —— bundle 内部 entry 数目变化，对外仍是一个 npm 包
- bin 命令仍然是 `kodax`
- `packages/*/package.json` 的内部 `@kodax-ai/{ai,agent,coding,...}` workspace 包名不变（仍是 workspace internal alias，不发 npm）

**对 npm 上历史包的处理**：

- `@kodax-ai/cli@0.7.37` / `@kodax-ai/cli@0.7.38`：deprecate 指向 `@kodax-ai/kodax`
- `@kodax-ai/kodax-cli@0.7.38`：在 72h 窗口内 unpublish（仅一个版本，无下游绑定）；过期后 deprecate
- 不做 chain redirect（cli → kodax-cli → kodax）；直接两条 parallel deprecate（cli → kodax；kodax-cli → kodax）

### 替代方案讨论

**A. 保留 `-cli` 后缀，仅做 subpath exports**：被否。后缀 vs 主流不一致的问题不解决；v0.7.39 已是改名窗口最后机会。

**B. 拆 `@kodax-ai/sdk` 单独发包**：被否。引入第二个 npm 发布物违反 ADR-022 单 bundle 决策；当前没有任何独立 SDK 用户证据；subpath exports 已经把 SDK 表面暴露出来，不需要额外的 npm 包。

**C. 直接发 `@kodax-ai/agent` / `@kodax-ai/llm` 等独立子包**：被否。等同于回滚到 ADR-022 之前的 multi-package 发布模型 —— 那个模型的"vendored fork transitive deps 漏声明"bug class 仍未解决。

### 与 ADR-022 的关系

ADR-022 的"npm 发布物 = 单 bundle 包"主决策不变。ADR-024 在它之上做两件事：
1. 修正包名（不改变"单包"事实，只改名字）
2. 在 bundle 内部增加多 entry —— `package.json#exports` 通过 subpath 把同一个 npm 包的不同入口暴露给消费者，**仍然是一个 npm 包，一份 tarball，一个 version 号**

ADR-022 Addendum（"v0.7.39 改名 kodax-cli"）被 ADR-024 取代；保留为决策演变历史。

### 触发回退的条件

仅当 ADR-022 的回退条件成立（≥3 独立 SDK 用户 + ≥2 子包独立 release cadence）时，连带回滚 ADR-024 的 subpath exports 部分 —— 但即便如此，**`@kodax-ai/kodax` 这个包名不再改**（避免再次扰动用户安装命令）。

---

## ADR-025: auto[llm] 信号化分类器 — 决策层级倒置 + Windows-flag 误判结构性修复 (FEATURE_158, v0.7.39)

**Status**: Accepted (2026-05-12)

**TL;DR**：把 `auto` 模式的 REPL 同步硬规则（[`InkREPL.tsx`](../packages/repl/src/ui/InkREPL.tsx) Step 2.5 dangerous-bash + Step 3 protected-path）从**前置 veto** 改为**喂给 LLM 分类器的信号**；同时把 `~/.kodax/` 写、5 条 catastrophic 模式提升为 **Tier 0 绝对禁令**（LLM 不能 override）；引入 **speculative classify** 抹平延迟；保留 engine 降级到 'rules' 后**重新激活原硬规则路径**做兜底。结构性吃掉 [Issue 131](KNOWN_ISSUES.md#131) `looksLikePath` Windows-flag 误判（`findstr /R` / `dir /B` / `where /R` 等被当作 POSIX 绝对路径触发误确认）。对齐 CC `useCanUseTool` 单决策点 + `SAFE_YOLO_ALLOWLISTED_TOOLS` Tier 1 + `yoloClassifier` LLM-final 架构，但保留 KodaX 已有的 denial tracker / circuit breaker / engine 降级三件套。

### 背景

[FEATURE_092 (v0.7.33)](features/v0.7.33.md) 落地了 auto-mode LLM 分类器，但实际运行时 LLM **大概率不被调用**。链路：

```
REPL.beforeToolExecute (同步硬规则，先于 LLM)
  ├─ Step 1   bash-read fast-path → ALLOW
  ├─ Step 2.5 dangerous bash      → CONFIRM（veto）
  ├─ Step 3   protected path      → CONFIRM（veto）
  └─ Step 4   confirmTools (auto=空)
              ↓ (上面都没拦才到这里)
Runner.beforeTool → AutoModeToolGuardrail (LLM 分类器)
```

REPL 层规则一旦命中即 short-circuit，LLM **永远拿不到决策权**。实测：
- 用户报告 `git tag --sort=-creatordate | findstr /R "v[0-9]"` 在 auto 模式被误判为 Protected path。
- 根因：[`looksLikePath` (permission.ts:608)](../packages/repl/src/permission/permission.ts#L608) 把 Windows 风格 `/R` flag 当 POSIX 绝对路径 → `path.resolve('/R')` 解析为 `C:\R` → 不在 project / temp → 触发 `isAlwaysConfirmPath`。
- LLM 看到完整命令本可秒判"纯只读 piped 命令"，但 LLM 没被调用。

对照 Claude Code [`useCanUseTool.tsx`](../../claudecode/src/hooks/useCanUseTool.tsx) + [`classifierDecision.ts:SAFE_YOLO_ALLOWLISTED_TOOLS`](../../claudecode/src/utils/permissions/classifierDecision.ts) + [`yoloClassifier.ts`](../../claudecode/src/utils/permissions/yoloClassifier.ts)：CC 在 auto 模式下**只有一个决策点** `hasPermissionsToUseTool`；CC 的 `dangerousPatterns.ts` / `pathValidation.ts` 是**分类器 prompt 的输入信号**，不是分类器之前的硬否决。这就是 CC auto 模式"无打断"体感的结构性来源。

KodaX 的差距不在 LLM 模型能力，而在**决策架构**。

### 决策

`auto` 模式下，权限决策采用三层金字塔（plan / accept-edits 模式**不变**）：

```
┌─ Tier 1 (零成本直通，REPL 层)          ──────────────────────┐
│   • bash-read 白名单 + `--help` fast-path                    │
│   • Read/Grep/Glob/Todo/Task 等 projection==='' 工具         │
│   不调 LLM、不计费、不打断                                    │
└──────────────────────────────────────────────────────────────┘
                          ↓ (未命中)
┌─ Tier 0 (绝对禁令，Runner 层 LLM 之前)  ─────────────────────┐
│   硬编码 catastrophic patterns:                              │
│     1. rm -rf / 或 ~                                         │
│     2. mkfs.* / fdisk / format C:                            │
│     3. dd if=... of=/dev/sd*                                 │
│     4. :(){ :|:& };: (fork bomb)                             │
│     5. 写入 `~/.kodax/`（credentials 红线，例外见下）        │
│   直接 BLOCK，LLM 不能 override                              │
└──────────────────────────────────────────────────────────────┘
                          ↓ (未命中)
┌─ Tier 2 (LLM 综合裁决)                  ─────────────────────┐
│   1. 同步收集信号 (signals[])：                              │
│      • dangerous_pattern  (原 DEFAULT_DANGEROUS_PATTERNS)    │
│      • protected_path     (.kodax/ / ~/.kodax/ / 外部)       │
│      • outside_project    (路径在 project + temp 之外)       │
│      • shell_redirect_outside / package_install / network    │
│   2. classify(action, signals[], transcript, user_rules)     │
│   3. allow / block / escalate                                │
│   4. escalate 时 UI 用 signals 渲染 Scope / Risk 标签        │
└──────────────────────────────────────────────────────────────┘
                          ↓ (LLM 不可达 / engine='rules' 降级)
┌─ Fallback (重新激活 REPL Step 2.5/3 原硬规则路径)            │
│   denial 3/20 或 breaker 5/10m 后，行为等价今天的 auto       │
└──────────────────────────────────────────────────────────────┘
```

**Tier 0 `~/.kodax/` 写入例外**：仅 `kodax config set` / `kodax provider add` 等本进程自身管理的 IPC 写入路径不算（通过调用方 ID 而非命令字符串识别）。

**speculative classify**：tool call 进入 Tier 2 时立即发起 classify，并发起 350ms 的"安静窗口"（用户已习惯 ~200ms 视觉延迟）。若分类器在窗口内返回 allow，直接放行不弹 confirm；否则正常 escalate 流程。对齐 CC [`bashPermissions.ts:peekSpeculativeClassifierCheck`](../../claudecode/src/tools/BashTool/bashPermissions.ts) 思路，但实现更窄（不引入 BashPermission 框架）。

**Windows-flag 误判结构性修复**（吃掉 [Issue 131](KNOWN_ISSUES.md#131) hotfix）：
1. [`looksLikePath`](../packages/repl/src/permission/permission.ts) 在 `process.platform === 'win32'` 下识别 `/[A-Za-z]` / `/[A-Za-z]:` 形式为 cmd flag，不当路径。
2. `BASH_SAFE_READ_COMMANDS` 加入 `git tag` / `git stash list` / `git config --get` / `git describe`（CC `DEFAULT_SAFE_PATTERNS` 平价）。
3. 但**这两条本身就是 signals 输入路径的副产物**——结构性改完后，`looksLikePath` 即使再有边角误识别，LLM 看到 signal 也能正确决策；不再单点故障。

### Reasoning

1. **LLM 决策权回归**。FEATURE_092 设计目标是"LLM 综合判断"，现实是 30% 的 bash 命令 LLM 才能见到。决策层级倒置让 LLM 在 ≥95% 的非 Tier-1 命令上承担最终决策——这才是 FEATURE_092 当初的承诺。

2. **威胁模型对齐**。KodaX 是**单用户本地 CLI**（不是 SaaS），信任边界在 user ↔ agent，不在 user ↔ KodaX。在这个模型下：
   - 用户故意打 `rm -rf` 不需要系统保护他（Tier 0 只防"LLM 被 prompt 注入劫持"的灾难性场景）。
   - LLM 看 transcript 综合判断比硬规则更准（用户上一句说"清掉 node_modules" → `rm -rf node_modules` 应该 allow，硬规则不区分上下文）。

3. **平价保证**（重构不能削弱功能）。删除硬规则的退化风险通过三条防线兜住：
   - Tier 0 守住灾难性场景（不可 override）
   - LLM 看到所有原规则作为 signals，可主动 block
   - engine 降级路径**重新激活**原 Step 2.5/3，等价今天的 auto-in-project 行为

4. **不引入新旧代码并行**。Step 2.5/3 不加 feature flag、不保留 legacy code path、不做渐进 cutover。改完即生效，按 commit 粒度滚动；如需回退走 git revert。

5. **速度对齐 CC**。speculative classify 同期落地，否则用户感知延迟反而比今天差（今天硬规则同步即裁决，<10ms；改完每条 bash 都过 LLM，2-8s）。

### Consequences

**变化（新行为）**：

| 维度 | 现状 | 改后 |
|---|---|---|
| auto 模式下 LLM 调用率 | bash 命令 ~30% | bash 命令 ~95% (Tier 1 之外) |
| `~/.kodax/` 写保护 | 软规则可被绕过 | Tier 0 硬禁，IPC 例外 |
| Confirm 弹窗 Scope/Risk 标签 | 来自 REPL 层 `_alwaysConfirm` 等 marker | 来自 classifier 携带的 signals[] |
| Engine 降级（denial 3/20 或 breaker 5/10m） | escalate 一切 | 重新激活 Step 2.5/3 全规则路径 |
| `findstr /R` / `dir /B` / `where /R` 等 Windows flag | 误判 Protected path | 正确识别为 cmd flag，bash-read 直放 |
| `git tag` / `git stash list` / `git describe` | 走 LLM | Tier 1 fast-path 直放 |
| 平均延迟（非 Tier 1 bash） | <10ms (规则同步) | ~350ms (speculative 窗口) 或 ~2-8s (escalate) |
| Token 成本（每会话 auto bash 调用） | ~30% 触发 classifier | ~95%；用 prompt-cache 抹平 ~70% |

**不变（明确保留）**：

- `plan` 模式：所有硬规则、write/edit 阻止、`getPlanModeBlockReason` 完全不变。
- `accept-edits` 模式：alwaysAllowTools / prefix extractor (FEATURE_153) / outside-project file edit 确认完全不变。
- Tier 1：`isBashReadCommand` / `isHelpCommand` / Read/Grep/Glob 工具直放。
- FEATURE_092 已有基建：[denial-tracker](../packages/coding/src/guardrails/auto-mode/denial-tracker.ts) / [circuit-breaker](../packages/coding/src/guardrails/auto-mode/circuit-breaker.ts) / [model-resolver](../packages/coding/src/guardrails/auto-mode/model-resolver.ts) 全部保留。
- 子代理 `AutoModeSharedState` 共享 engine 状态。
- SDK 消费者（`executor.ts` 路径）：当 PermissionContext **没有** guardrail 接线时，Step 2.5/3 仍执行（fail-safe，等价 SDK 用户主动选 "auto + 自实现 onConfirm"）。
- ADR-023 (bash AST 解析) / ADR-021 (agent ↔ coding 边界) 不动。

**测试 churn**：
- [`permission.test.ts`](../packages/repl/src/permission/permission.test.ts) (109 用例) 中 ~20 用例需更新断言（Step 2.5/3 在 auto 模式下不再 veto）。
- [`tool-confirmation.test.ts`](../packages/repl/src/common/tool-confirmation.test.ts) (8 用例) 改为消费 signals。
- [`auto-mode-classifier.eval.ts`](../tests/auto-mode-classifier.eval.ts) (FEATURE_092 dataset) 复跑 + 加 5-10 个 Windows-flag 回归用例。
- 新增子代理 boundary 回归测试（劫持场景下 Tier 0 兜底）。

### 替代方案讨论

**A. 只做 hotfix (`looksLikePath` Windows-flag + `git tag` 白名单)，不动结构**：被否。
- 治标不治本——下一个 Windows flag（`xcopy /Y` / `robocopy /MIR`）还会复现。
- 真正的设计 bug 是**LLM 没被调用**，hotfix 不改决策层级，相当于继续给规则打补丁。
- 用户明确要求 0.7.39 必修，且不接受 issue + feature 拆分。

**B. v1 原方案"删除 REPL 硬规则，只剩 LLM + 极窄 Tier 0"**：被否。
- 自查暴露 5 处重大退化：dangerous 9 类规则丢、`~/.kodax/` 写裸奔、engine 降级失去规则兜底、子代理硬规则消失、SDK 消费者裸奔。
- v2（本 ADR）通过"信号化 + Tier 0 + 降级 fallback"三件套补回所有平价。

**C. 完全照搬 CC 单决策点架构（`hasPermissionsToUseTool` 收编 REPL beforeToolExecute）**：被否。
- KodaX 的两层（REPL `beforeToolExecute` + Runner `beforeTool` guardrail）来自 [ADR-021 agent ↔ coding 边界](#adr-021)，REPL 不应该承载 LLM 调用职责。
- 强行合并需要把 guardrail 上拉到 REPL 层或把 REPL 检查下沉到 guardrail，两者都违反 ADR-021。
- 本方案保留两层结构，只改"REPL 层从 veto 改为 signal-pass-through"，是最小侵入对齐。

**D. 加 feature flag 让用户选择"strict / signal" 模式**：被否。
- 违反用户记忆"大重构不引入新旧代码并行"。
- 两条代码路径常驻 = 长期维护负担 + 配置组合爆炸。
- 改完即生效，回退走 git revert。

**E. Tier 0 清单完全交给 LLM 自洽（无硬编码）**：被否。
- 防御纵深需要"LLM prompt 注入劫持"场景下的兜底；硬编码 5 条是已知 catastrophic 上限。
- 清单进 ADR-025 评审通过后**严禁扩张**——每加一条要走新的 ADR addendum。

### 与其他 ADR 的关系

| ADR | 关系 |
|---|---|
| ADR-021 (agent ↔ coding 边界) | 保留两层架构，REPL 层只改语义不改职责 |
| ADR-023 (bash regex → AST) | AST 解析仍是信号收集的输入；`extractPathsFromCommand` 输出喂给 signals.protected_path |
| FEATURE_092 (auto-mode classifier) | 本 ADR 是 FEATURE_092 的**真正激活**——分类器从"理论存在 30% 命中"变成"实际承担 95% 决策" |
| FEATURE_153 (LLM prefix extractor) | accept-edits 模式专用，不在本 ADR scope |
| FEATURE_154 (`--help` fast-path) | Tier 1 一部分，保留 |
| FEATURE_074 (subagent boundary) | 共享 SharedState 不变；Tier 0 + engine 降级路径在子代理同样生效 |

### 落地节奏（FEATURE_158, v0.7.39）

| Commit | 内容 | Review 锚点 |
|---|---|---|
| 1 | ADR-025 Accepted + Tier 0 清单评审通过 + FEATURE_LIST 登记 | 设计 review |
| 2 | `packages/coding/src/guardrails/auto-mode/signals.ts` 类型 + 收集器 + 单测（无消费方） | 类型/逻辑 review |
| 3 | `absolute-denylist.ts` (Tier 0) + 单测 | 安全 review (清单 freeze) |
| 4 | `classify.ts` 接受 `signals[]` + prompt 更新 + speculative classify 基建 | prompt/eval review |
| 5 | `looksLikePath` Windows-flag 修正 + `git tag` 等加入 `BASH_SAFE_READ_COMMANDS` + 回归测试（结构性修复 [Issue 131](KNOWN_ISSUES.md#131)） | bug parity review |
| 6 | `AutoModeToolGuardrail.beforeTool` 接 Tier 0 + signals + speculative classify | guardrail review |
| 7 | `onEngineChange` 通知 REPL + REPL 层在 `mode==='auto' && engine==='llm'` 时跳过 Step 2.5/3；其他组合走原路径 | **cutover commit**（最关键）|
| 8 | UI 接 signals → Scope/Risk 渲染；移除 `_alwaysConfirm` / `_dangerousCommand` / `_outsideProject` marker（在 auto 路径） | UX parity review |
| 9 | Eval：FEATURE_092 dataset 全量复跑 + Windows-flag 回归 + 子代理 boundary 回归 + 降级路径回归 | **release gate** |
| 10 | KNOWN_ISSUES 加 Issue 131 Resolved + v0.7.39 follow-up notes（如 speculative 窗口需调） + CHANGELOG + test guide | docs review |

**纪律**：
- 每个 commit 后主动 review 三件事（无新漏洞 / 无 scope 漂移 / 无功能退化）。
- 不引入新旧并行路径；REPL Step 2.5/3 在 auto 路径删除即删除，不留 feature flag。
- 前 6 个 commit 可独立 merge / 推迟；commit 7 是 cutover，必须配 commit 8/9 同 release。

### 触发回退的条件

回退（git revert commit 7+）触发条件，任一成立即立项 patch：

1. **安全回退**：上线 4 周内出现 ≥1 例 LLM 误放过原本应该 veto 的命令（用户报告 + git log 复现）。
2. **延迟回退**：speculative classify p95 > 1500ms（连续 3 天监控）；用户体感"等待感增加"反馈 ≥3 起。
3. **成本回退**：单会话平均 classifier token 消费 ≥ baseline × 4（prompt-cache 失效或 prompt 膨胀失控）。
4. **engine 降级误激活**：denial tracker / circuit breaker 在正常使用中误触 ≥1 次 / 周。

**保留兜底**：commit 5 的 Windows-flag 修复 + `git tag` 白名单是**纯加强**，不在回退范围；即使整体 cutover 回滚，这两条仍生效。

### Resolved Decisions (2026-05-12 self-review)

1. **`~/.kodax/` 写"IPC 例外"的实际结论：不需要例外**。 KodaX 内部配置写（`kodax config set` / `kodax provider add`）走 TypeScript `fs.writeFile` 直接调用，**不经过 bash tool**，不命中权限门。Tier 0 第 5 条只在 LLM 通过 bash 工具发出 `echo ... > ~/.kodax/foo` / `cp x ~/.kodax/y` 这类直接 shell 写入时触发——这些场景应当**无条件阻止**：合法配置编辑就该走 slash command 而非 LLM 拼 shell。
2. **speculative classify 窗口：初始 500ms，环境变量可调**。 Commit 4 落 `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env，默认 500ms（CC 同量级），实施期 micro-bench 三家 classifier p50/p95 后在 FEATURE_158 设计稿固化最终值。
3. **`/auto-signals` debug 命令推到 v0.7.40 follow-up**。 不阻塞本次 cutover；release 后用户反馈再立。

---

