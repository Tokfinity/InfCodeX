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
| `@kodax/ai` | LLM 抽象 + provider 适配 | retry-after / cache markers / capability |
| `@kodax/tracing` | Trace / Span / Processor | 独立可替换 OpenTelemetry / Langfuse |
| `@kodax/session-lineage` | Session 持久化 + Lineage + Compaction 实现 | 承接 v0.7.35.1 从 `@kodax/agent` 回流的 session 实体 |
| `@kodax/agent` | **通用 Agent 框架（智能体底座）** | Agent / Runner / Handoff / Guardrail / Admission / Messaging / Orchestration / Memory / Team / Scratchpad / Construction / Runtime middleware；不绑定 coding |
| `@kodax/skills` | Zero-dep skill packs | — |
| `@kodax/mcp` | MCP integration | progressive disclosure 5 模式 |
| `@kodax/coding` | **Coding agent 实例 + coding-specific 资产** | Coding tools / role prompts / H2 task-engine / coding-preset / repo-intelligence |
| `@kodax/repl` | Ink TUI | — |
| `@kodax/repointel-protocol` | Repo intel 协议包 | 跨仓库共享协议 |

Reasoning:

- 包名 = 内容承诺：`@kodax/agent` 是通用 agent 平台，`@kodax/coding` 是 coding-specific 实例
- `@kodax/agent` 不依赖 `@kodax/coding`、不依赖 `@kodax/repl` 就能跑一个 agent
- 未来 `@kodax/data-analysis-agent` / `@kodax/ops-agent` 等按 `@kodax/coding` 模式独立成包，统一依赖 `@kodax/agent`
- task engine 的增强应建立在现有层次之上，而不是把层全部揉平
- 详细包归属规则见 ADR-021

**v0.7.35.1 之前（FEATURE_082 设计）**：曾包含 `@kodax/core`（含 Layer A primitives + 后续漂入的 runtime）和**设计但从未创建**的 `@kodax/capabilities`。v0.7.35.1 (FEATURE_142) 把 `@kodax/core` 30 文件全部并入 `@kodax/agent`，并撤销 `@kodax/capabilities` 死设计，理由见 [v0.7.35.1 设计稿](features/v0.7.35.1.md) §FEATURE_142。

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

## ADR-021: Agent Framework Boundary（@kodax/agent vs @kodax/coding）

**Status**: Accepted (FEATURE_142 v0.7.35.1)

KodaX 包结构按"包名 = 内容承诺"原则严格执行。`@kodax/agent` 是**通用 Agent 框架（智能体底座）**，`@kodax/coding` 是 **coding-specific** 实例。两者不可互相侵入，下面是判断规则。

### 落 `@kodax/agent` 的内容（通用 agent 平台原语）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Agent primitives | `primitives/` | Agent / Runner / Handoff / Guardrail / Session interface |
| Admission contract | `admission/` | Admission pipeline + 7 quality invariants（FEATURE_101） |
| Messaging | `messaging/` | 2-tier priority queue + agentId routing（FEATURE_115） |
| Orchestration | `orchestration/` | Pattern B dispatch / SendMessage router / TaskStop / Peer router（FEATURE_119/120/123/128） |
| Scratchpad | `scratchpad/` | 去耦合大输出通道（FEATURE_121） |
| Memory | `memory/` | 4-type taxonomy + scope resolver（FEATURE_124） |
| Team | `team/` | Multi-instance state broadcast + system-prompt injection（FEATURE_125） |
| Construction | `construction/` | Self-Construction runtime / agent-resolver / sandbox-runner（FEATURE_087/088/089/090/101） |
| Runtime middleware | `runtime-middleware/` | 通用 substrate middleware（compaction-trigger / max-tokens-continuation / permission-gate 接口层） |
| Tokenizer | `tokenizer.ts` | js-tiktoken 适配 |

**判定规则**：任何"非 coding agent 也需要"的 agent 平台能力 → `@kodax/agent`。

### 落 `@kodax/coding` 的内容（coding-specific）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Coding tools | `tools/` | Read / Write / Edit / MultiEdit / Bash / Grep / Glob / WebFetch / WebSearch / SemanticLookup / RepoOverview |
| Tool wrappers for agent platform tools | `tools/` | dispatch_child_task / send_message / task_stop / write_scratchpad / read_scratchpad / list_agents / todo_update（**工具壳留 coding，调 agent 端原语**；tool 描述文本含 coding-specific prompt） |
| Coding role prompts | `prompts/` / `agents/*-role-prompt.ts` | Worker / Scout / Planner / Generator / Evaluator role prompts |
| H2 task-engine 状态机 | `task-engine/` | managed-task / runner-driven / role-prompt builder（coding AMA-specific） |
| Coding agent 实例 | `agents/` | defaultCodingAgent / scoutAgent / generatorAgent / evaluatorAgent |
| Coding-specific middleware | `agent-runtime/` | tool-dispatch / prompt-content / assistant-message-builder / per-turn-reasoning |
| Coding preset | `coding-preset.ts` | DEFAULT_CODING_INSTRUCTIONS + tool slice 装配 |
| Repo intelligence | `repo-intelligence/` | Coding-specific 仓库结构理解 |
| Coding-side provider wiring | `providers/` | Coding 端的 wire-level provider 配置 |
| File-mutation safety net | `multi-instance/` | content-hash-cache / active-file-warning（绑 Edit / Read tool 实现） |

**判定规则**：任何"只对 coding agent 有意义"的内容 → `@kodax/coding`。

### Tool wrapper 的双层模式

通用 agent 平台工具（dispatch_child_task / send_message / task_stop / write_scratchpad / read_scratchpad / list_agents 等）使用**双层模式**：

- **底层 primitive** 在 `@kodax/agent/<domain>/`：路由 / 队列 / 注册表 / 协议（不含 prompt）
- **工具壳** 在 `@kodax/coding/tools/`：tool schema + handler 调底层 primitive；tool description 含 coding-specific prompt（如 "use this when reviewing a coding PR"）

理由：tool description 是 prompt 工程的一部分，含 coding 偏置；底层路由 / 队列等机制对所有 agent 通用。未来真有 ≥3 个非 coding agent 包后，可以再抽 `@kodax/agent/tools/` 通用工具壳层。当前 1 个 consumer，按 KodaX 哲学不预先抽。

### 何时考虑再开 `@kodax/core`（types-only 子包）

撤销 `@kodax/core`（v0.7.35.1）后，未来 **当且仅当**下面三条**至少一条**成立时，才考虑从 `@kodax/agent` 拆出 `@kodax/core` types-only 子包：

1. 出现 ≥3 个 type-only declaration 消费者（例如 IDE 插件 typecheck 用户的 agent manifest 但不跑）
2. 出现真实跨包横切设施需求（例如 errors 类被 `@kodax/ai` / `@kodax/agent` / `@kodax/coding` 都需要统一 shape）
3. 出现 ≥3 个非 coding agent 包（`@kodax/data-analysis-agent` / `@kodax/ops-agent` / 等），它们之间需要共享 Layer A types 但不互相依赖

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
3. **`@kodax-ai/skills` 6 个 helper script 残留旧 scope 引用 `@kodax/coding`**。即使改成 `@kodax-ai/coding`，bundle 模式下该包不再发布到 npm，仍然解析不到。

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

---

