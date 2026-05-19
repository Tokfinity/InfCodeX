# KodaX 高层设计（HLD）

> Last updated: 2026-04-12
>
> 这份文档描述 `FEATURE_061/062` 之后的高层架构：
> KodaX 现在是一个 Scout-first、以 `task` 为中心、强调”极简且智能”的执行引擎。

## 中文导读

阅读这份 HLD 时，可以先抓住 6 个核心判断：

1. `SA` 与 `AMA` 是用户可见的执行模式，但不是两套完全独立的产品。
2. `SA` 完全不走 AMA；它是单 agent 直接执行路径。
3. `AMA` 只保留 `H0 / H1 / H2` 三层；`H3` 已移除。
4. `Scout` 是 AMA 的唯一入口（FEATURE_061）：H0 时直接完成，H1/H2 时升级并保留上下文。Scout 不属于 H2 主 graph。
5. `H2` 的核心骨架固定为 `Planner -> Generator <-> Evaluator`。
6. `Work` 是用户可见的主预算语义；budget 模型已简化为 `{ cap, used }` + 4 纯函数（FEATURE_062）。
7. `Project` 与 `SA / AMA` 是正交维度；`Project + SA` 是一等路径，但只写 lightweight run record，不写 managed task。
8. 每个 AMA 角色（Scout/Planner/Generator/Evaluator）可通过 `runOrchestration` 拉 subagent 并行执行。

---

## 1. 产品主张

KodaX 不应再被理解为：

- 一个要求用户先切 mode 再提问的 CLI
- 一个把多智能体默认做成“角色越多越稳”的系统
- 一个把 `Project Mode` 当作唯一长流程入口的产品

当前更准确的理解应该是：

- 一个 single-agent first 的 `task engine`
- 一个在必要时才升级到 coordinated harness 的执行系统
- 一个以 `evidence`、`contract`、`verdict` 为核心真相面的 runtime
- 一个能跨 CLI / REPL / ACP 复用的 headless substrate

对应的用户体验目标是：

- 简单问题要像单 agent 一样直接完成
- 复杂问题才逐步增加 planning / verification ceremony
- 用户默认只感知结果与必要进度，不需要先理解内部角色图

---

## 2. 设计目标与非目标

### 2.1 核心目标

1. 默认把复杂度判断隐藏在系统内部，不要求用户先选 mode。
2. 让简单任务保持直接、快速、低 ceremony。
3. 让复杂任务在升级后有清晰的 contract / evidence / verdict 结构。
4. 让 skill 能进入 AMA，但不污染所有角色。
5. 让 tool / budget / verification 的关键过程对用户可见，但不喧宾夺主。

### 2.2 非目标

1. 不再保留 `H3_MULTI_WORKER` 这种默认并行层级。
2. 不再把 `Lead / Admission / Contract Reviewer` 当作主骨架。
3. 不把 skill 做成独立于 task engine 的第二套 orchestrator。
4. 不把内部 worker iter 暴露成用户可见的主进度语义。

---

## 3. 系统概览

```text
Surfaces
  -> Intent Gate / Direct Path
    -> Scout (pre-harness only)
      -> AMA Control Plane
        -> Coding Runtime and Capability Substrate
          -> Provider / Tool / Skill Adapters
            -> Durable Task State and Evidence Store
```

### 3.1 Surfaces

用户或宿主的入口包括：

- CLI one-shot
- interactive REPL
- ACP server
- future IDE / desktop / web surfaces

这些表面只负责收集输入、显示状态、触发审批、展示结果，不拥有任务逻辑。

### 3.2 Intent Gate 与 Direct Path

每个请求都会先经过极轻的 intent gate：

- `conversation`
- `lookup`
- 明显轻量解释/导航问答

命中的请求直接走 `H0_DIRECT` 或 `SA` direct path，不读 dirty repo，不起 managed ceremony。

### 3.3 Scout（FEATURE_061 更新）

`Scout` 是 AMA 的唯一入口和 pre-harness 执行者。

它的职责是：

- 作为所有 AMA 请求的第一站（无预路由 LLM 调用）
- 判断任务是否 actionable 和是否值得进入 `H1 / H2`
- H0 时直接完成任务（Scout-complete H0）
- 升级到 H1/H2 时保留已有上下文（context continuation，不再冷启动）
- 收集 `scope facts`，最多少量补 `overview evidence`
- 如果 skill 被激活，则读取完整 expanded skill 并生成 `skill-map`
- 可通过 `runOrchestration` 拉 subagent 做并行子任务

它**不是** H2 内的长期角色。

### 3.4 AMA Control Plane

AMA 当前只保留 3 个执行层级：

| Profile | Typical task | Shape |
|---|---|---|
| `H0_DIRECT` | 对话、lookup、极轻说明 | direct |
| `H1_EXECUTE_EVAL` | 中低风险但值得独立检查的任务 | checked-direct |
| `H2_PLAN_EXECUTE_EVAL` | 需要 contract、deep evidence、独立验收的复杂任务 | coordinated |

`H3_MULTI_WORKER` 已被移除。

### 3.5 Coding Runtime and Capability Substrate

这层提供：

- prompt building
- tool execution
- skill invocation
- session handling
- checkpoint / artifact plumbing
- verification and evidence capture

它保持 headless，供多个 surface 复用。

#### 3.5.1 AMA Runner-driven 路径模块化（FEATURE_171, v0.7.41）

AMA Runner-driven 路径主入口 `packages/coding/src/task-engine/runner-driven.ts` 按职责拆为 11 个聚焦模块（`_internal/managed-task/` 目录），主文件从 6406 行压缩到 ~1897 行（**-70.4%**）。详见 [ADR-026](ADR.md#adr-026-runner-drivents-模块化拆分--6406-行单文件--12-个聚焦模块-feature_171-v0741)。

> **v0.7.42 update**：FEATURE_171 R1 抽出的 `write-turn-cap.ts`（P2b RST-prone provider cap helper）在 v0.7.42 被 retired——2026-04 bench 证明 RST 是 zhipu-coding 时间触发的（308s server kill window），不是 payload-size 触发的，正确防御层是 `streamMaxDurationMs` watchdog + non-streaming fallback（在 `registry.ts` 层），不是 `max_output_tokens` 收窄。模块表少一行。

| 模块 | 行数 | 职责 |
|---|---|---|
| `runner-driven.ts` | 1897 | 主循环 + 顶部 re-export（公共导入面） |
| `_internal/managed-task/types.ts` | 180 | 共享类型（`VerdictRecorder` / `ObserverBridge` / `AmaRole` / `RolePromptContextFactory` / `RunnerChainPromptContext`），打破 verdict-recorder ↔ observer-bridge 循环依赖 |
| `_internal/managed-task/role-prompts.ts` | 297 | 5 个 `*_INSTRUCTIONS_FALLBACK` + `resolveRoleInstructions` + `buildCompletionContractStatus` |
| `_internal/managed-task/role-exclude.ts` | 142 | FEATURE_168 per-role exclude sets + `getAmaRoleEffectiveExclude` / `getAmaRoleExpectedToolNames` |
| `_internal/managed-task/status-derivation.ts` | 97 | `extractUserFacingText` / `deriveFinalStatus` / `buildManagedProtocolPayload` |
| `_internal/managed-task/tool-wrappers.ts` | 312 | `wrapCodingToolAsRunnable` + 3 个 mutation-guard wrappers |
| `_internal/managed-task/dispatch-child.ts` | 119 | `wrapDispatchChildTaskForRole`（per-role child-task wrapper） |
| `_internal/managed-task/observer-bridge.ts` | 541 | `buildObserverBridge` / `buildRunnerRoutingNote` / `applyScoutDecisionToPlanRunner` + budget cap 常量 |
| `_internal/managed-task/verdict-recorder.ts` | 532 | `wrapEmitterWithRecorder` + `H1_MAX_SAME_HARNESS_REVISES` + FEATURE_165 handoff pending-children gate |
| `_internal/managed-task/agent-chain.ts` | 1010 | `buildCodingToolBundle` + `buildAgentToolsFromRegistry` + `buildRunnerAgentChain` + `buildRunnerScoutAgent` |
| `_internal/managed-task/llm-adapter.ts` | 954 | `buildRunnerLlmAdapter`（含 FEATURE_085 max_tokens L1-L5 escalation + FEATURE_167 Evaluator terminal-verdict fallback retry hook） |
| `_internal/managed-task/payload-builder.ts` | 444 | `buildManagedTaskPayload` + `deriveQualityAssuranceMode` + `buildScoutDecisionRuntime` + `buildSkillMapRuntime` |
| `_internal/managed-task/checkpoint-flow.ts` | 350 | `handlePreRunCheckpoint` + `buildResumePreamble` + `buildStructuralResumeSeed` + `writeCurrentCheckpoint` |

**外部导入面零变更**：`runner-driven.ts` 顶部 re-export 块保留 3 个调用方（`task-engine.ts`、2 个 test 文件）需要的所有公共符号（`buildRunnerAgentChain` / `buildRunnerScoutAgent` / `buildRunnerLlmAdapter` / `getAmaRoleEffectiveExclude` / `getAmaRoleExpectedToolNames` + 7 个 type）。v0.7.42 retire `maybeApplyP2bWriteTurnCap` 后从 6 个公共符号降到 5 个。

**依赖拓扑无循环**：`types.ts` 是共享类型顶点，所有 12 个模块单向依赖它；`verdict-recorder.ts → observer-bridge.ts` 是单向依赖（共享类型上沉到 `types.ts`）。

### 3.6 Durable Task State

所有非平凡 managed task 都有持久化事实面，例如：

- `managed-task.json`
- `contract.json`
- `round-history.json`
- `budget.json`
- `runtime-contract.json`
- `scorecard.json`
- `skill-execution.md`
- `skill-map.json`
- `skill-map.md`

---

## 4. 执行形态

### 4.1 SA

`SA` = 单 agent 直接执行。

关键约束：

- 完全脱离 AMA
- 不走 Scout
- 不创建 managed worker graph
- 不暴露 AMA breadcrumb / round / budget ceremony

如果 skill 被触发，`SA` 直接消费完整 expanded skill。

### 4.2 AMA H0

`AMA-H0` 用于：

- conversation
- lookup
- 明显轻量问答
- Scout 调研后确认可直接收口的任务

它仍是 direct path，不做独立 evaluator。

### 4.3 AMA H1

`AMA-H1` 是 checked-direct：

- 一个主执行者完成任务
- 结尾允许一个轻量 `Evaluator` 做 post-hoc 检查
- evaluator 只做 accept / revise / blocked
- 最多一次同层 revise，再决定是否升级 H2

### 4.4 AMA H2

`AMA-H2` 是唯一完整 harness：

```text
Planner -> Generator <-> Evaluator
```

关键原则：

- `Planner` 负责 contract、风险、evidence checklist、slice plan
- `Generator` 负责 deep evidence 与实际执行
- `Evaluator` 负责 targeted spot-check 和最终 verdict
- `Planner` 缺 contract 时，必须先打回 `Planner`，不能让 `Generator` 静默全仓兜底

---

## 5. 角色模型

### 5.1 Scout

职责：

- 判断是否进入 harness
- 提供 pre-harness summary
- 生成 `skill-map`

输入层级：

- `scope facts`
- 少量 `overview evidence`
- 完整 raw skill（若 skill 被激活）

### 5.2 Planner

职责：

- 生成 `kodax-task-contract`
- 定义成功标准
- 列出 required evidence / constraints

输入层级：

- `scope facts`
- `overview evidence`
- `skill-map`

默认**不**读取 raw skill，也不线性翻大 diff。

### 5.3 Generator

职责：

- 执行任务
- 深挖证据
- 交付 `kodax-task-handoff`

输入层级：

- `deep evidence`
- 完整 raw skill
- `skill-map`
- planner contract

### 5.4 Evaluator

职责：

- 检查 handoff 是否满足 contract
- 做 targeted spot-check
- 输出 `kodax-task-verdict`

输入层级：

- contract
- generator handoff
- `skill-map`
- 定点 `deep evidence`

它默认不读取 raw skill；只有 `projectionConfidence=low` 或 claim 冲突时才 fallback。

### 5.5 Same-role summary continuity

`Scout`、`Planner`、`Evaluator` 继续默认使用 `reset-handoff`，但跨轮不再完全依赖隐式 artifact continuity。

当前语义：
- 每轮结束时，为非-generator 角色写入 compact same-role summary
- 下一轮同角色运行时，显式注入上一轮摘要
- 不恢复这些角色的完整私有对话历史
- `Generator` 仍是主要深度上下文消费者

---

## 6. Skill 集成

skill 不再作为“整段 prompt 平铺给所有角色”的全局上下文。

当前采用：

```text
skill invocation
  -> Scout reads full expanded skill
    -> emits skill-map
      -> Planner consumes skill-map
      -> Generator consumes full skill + skill-map
      -> Evaluator consumes skill-map (+ raw fallback only when needed)
```

`skill-map` 至少包含：

- `skillSummary`
- `executionObligations`
- `verificationObligations`
- `requiredEvidence`
- `ambiguities`
- `projectionConfidence`
- `allowedTools / hooks / model / context`

这保证了：

- `Planner` 不被完整 workflow 污染
- `Generator` 仍能按 skill 执行
- `Evaluator` 保持独立性

---

## 7. 证据分层

AMA 现在显式区分三层证据：

### 7.1 Scope facts

- changed files / lines / modules
- task family / risk / reviewScale
- repo spread and scope hints

### 7.2 Overview evidence

- `changed_diff_bundle`
- 高优先文件概览
- 关键类型 / 入口 / 测试变化摘要

### 7.3 Deep evidence

- `changed_diff`
- `read`
- 逐条 claim 验证
- 必要测试 / 检查

角色消费规则：

- `Scout`: scope facts + 少量 overview
- `Planner`: scope facts + overview
- `Generator`: deep evidence
- `Evaluator`: contract/handoff + targeted deep evidence

### 7.4 Project surface 与执行拓扑

`Project` 描述任务语境；`SA / AMA` 描述执行拓扑。

合法组合包括：
- `repl + sa`
- `repl + ama`
- `project + sa`
- `project + ama`

其中：
- `Project + AMA` = project-aware managed execution
- `Project + SA` = project-aware direct execution

`Project + SA` 不进入 managed-task graph，也不伪装成 mini-AMA；但会写一份 lightweight run record，用于：
- `/project status`
- latest execution summary
- 推荐下一步

---

## 8. 用户可见语义

### 8.1 Budget

用户默认看到的主预算语义是：

- `Work used/total`

初始预算：

- AMA 默认从 `Work x/200` 开始

当使用量达到 90% 且系统判断仍值得继续时：

- 请求用户审批
- 每次批准 `+200`
- 可多次追加

### 8.2 Round

`Round` 不再表示预分配的容量。

它只在真实额外 pass 已被分配/进入时才显示，例如：

- evaluator request revise
- H1 -> H2 upgrade 后继续
- 获批预算后继续 refinement

任务刚开始时，不应显示 `Round 1/2`。

### 8.3 Tool disclosure

工具摘要必须优先显示：

- `bash`: `cmd=<exact command>`
- `changed_diff`: path + range
- `changed_diff_bundle`: file count + representative path
- `read`: path + offset/limit
- `glob/grep`: pattern + scope/path

不应只剩裸工具名。

### 8.4 Evaluator public answer

Evaluator 的内部职责保留在 verdict / artifact 中。

用户最终答案：

- 应直接面向用户交付结果
- 不应说“我验证了 Generator 的结论”
- 不应把 Generator / Planner 当作用户面对的对象

---

## 9. Transitional Product Surface

### 9.1 `/project`

`/project` 继续存在，但它是 managed task 的 control surface：

- inspection
- resume / pause / verify
- artifact browsing

它不再是唯一的长流程产品抽象。

### 9.2 `--team`

`--team` 已退出主产品语义。

如果仍保留兼容入口，也只应视为 deprecated plumbing，而不是未来主故事。

---

## 10. 参考 Feature

- `FEATURE_019`: session tree、checkpoints、rewindable runs
- `FEATURE_022`: adaptive task engine + AMA/SA 执行骨架
- `FEATURE_025`: intent-first routing and harness selection
- `FEATURE_027`: SA / AMA 模式切换
- `FEATURE_028`: retrieval / evidence tooling
- `FEATURE_029`: provider-aware harness policy
- `FEATURE_034`: extension / capability runtime
- `FEATURE_061`: Scout-first AMA — Scout 成为唯一入口，H0 直接完成，context continuation，subagent 并行
- `FEATURE_062`: Budget simplification — `{ cap, used }` + 4 纯函数替代 10 字段 + 14 函数

---

## 11. Routing Ceiling Update

This routing update keeps KodaX lightweight by default:

- `read-only` work stays on the direct path unless the user explicitly asks for a stronger second pass.
- `docs-only` work stays on the direct path unless the user explicitly asks for a stronger second pass.
- `read-only` and `docs-only` tasks must never enter `H2_PLAN_EXECUTE_EVAL`.
- `reviewScale`, repo size, changed file count, and changed line count now affect evidence strategy only.
- `H2_PLAN_EXECUTE_EVAL` is reserved for long-running mutation work that changes code or system state and benefits from contract plus executable verification.
- H2 now defaults to one main pass; extra passes require a structured evaluator failure rather than default ceremony.

---

## 12. npm Distribution Architecture (FEATURE_150, v0.7.37; ADR-024 v0.7.39)

> 决策依据见 [ADR-022](ADR.md#adr-022-npm-distribution--single-bundle-not-multi-package-feature_149-v0737) + [ADR-024](ADR.md#adr-024-npm-发布物正名-kodax-ainkodax--sdk-subpath-exports-形式化-v0739)。
>
> **历史 npm 包名**：v0.7.37/v0.7.38 首发为 `@kodax-ai/cli`；v0.7.38 dual-publish 中间形态为 `@kodax-ai/kodax-cli`；v0.7.39 起正名为 **`@kodax-ai/kodax`**（ADR-024）。

源码层是分层 monorepo（ADR-001），npm 发布层是**单 bundle 包 `@kodax-ai/kodax`**。这两个层是**正交**的：源码读起来是 9 个独立可用的子包；npm 装起来是一个自包含的 CLI + 5 个 SDK subpath。

### 12.1 发布物布局

`@kodax-ai/kodax@<version>` tarball 内部：

```text
@kodax-ai/kodax/
├── package.json
│   ├── name: @kodax-ai/kodax
│   ├── bin: { "kodax": "scripts/kodax-bin.cjs" }
│   ├── main: "dist/index.js"                  ← SDK root 入口
│   ├── exports:
│   │   ├── "."        → ./dist/index.js       ← SDK root（汇总）
│   │   ├── "./agent"  → ./dist/sdk-agent.js   ← @kodax-ai/kodax/agent
│   │   ├── "./llm"    → ./dist/sdk-llm.js     ← @kodax-ai/kodax/llm
│   │   ├── "./coding" → ./dist/sdk-coding.js  ← @kodax-ai/kodax/coding
│   │   ├── "./repl"   → ./dist/sdk-repl.js    ← @kodax-ai/kodax/repl
│   │   └── "./skills" → ./dist/sdk-skills.js  ← @kodax-ai/kodax/skills
│   └── dependencies: <仅第三方包>             ← 不再有任何 @kodax-ai/*
├── dist/
│   ├── kodax_cli.js                   ← CLI entry（bin 命令运行；self-contained）
│   ├── index.js                       ← SDK root entry（builtin helper + 路径 C root import）
│   ├── sdk-agent.js                   ← SDK subpath @kodax-ai/kodax/agent
│   ├── sdk-llm.js                     ← SDK subpath @kodax-ai/kodax/llm
│   ├── sdk-coding.js                  ← SDK subpath @kodax-ai/kodax/coding
│   ├── sdk-repl.js                    ← SDK subpath @kodax-ai/kodax/repl
│   ├── sdk-skills.js                  ← SDK subpath @kodax-ai/kodax/skills
│   ├── chunks/*.js                    ← 6 个 SDK entry 共享代码（esbuild splitting:true）
│   ├── *.js.map                       ← source map（opt-in，--with-sourcemap，默认不发）
│   └── builtin/<skill>/               ← LLM 通过 skill 触发的资源（含 helper scripts）
├── scripts/
│   ├── kodax-bin.cjs                  ← bin shim（NODE_ENV=production preload）
│   └── production-env.cjs
└── README.md / README_CN.md / LICENSE / CHANGELOG.md
```

CLI 单 entry self-contained（最快 bin 启动）；6 个 SDK entry（root + 5 subpath）通过 esbuild `splitting: true` 共享 `dist/chunks/*.js`，避免 re-export 同一组内部包导致 6× tarball 膨胀。实测 v0.7.39 tarball ~1.1 MB packed / ~3.5 MB unpacked。

### 12.2 三种集成路径

| 路径 | 谁会走 | 实现方式 |
|---|---|---|
| **A. CLI 终端用户** | 90% 用户 | `npm install -g @kodax-ai/kodax` → 用 `kodax` 命令 |
| **B. 源码 SDK 集成方** | 想做基于 KodaX 的产品的开发者 | `git clone + npm link/file: + 自己 esbuild bundle` |
| **C. SDK 消费者** | 想直接装 npm 包 import 用 SDK API | `npm install @kodax-ai/kodax` → `import { Runner } from '@kodax-ai/kodax/agent'`（或 `runKodaX` 从 root / coding subpath） |

路径 A / C 都从 `dist/` 解析；路径 B 从 `packages/*/src/` 解析（不依赖 npm registry）。

**路径 C subpath 选择建议**：

- 只用 LLM 抽象 → `@kodax-ai/kodax/llm`（最薄表面，~3 kB entry + 共享 chunk）
- 写 agent runtime → `@kodax-ai/kodax/agent`
- 想要 KodaX 完整 coding capability（含 `runKodaX`） → `@kodax-ai/kodax/coding` 或 root `@kodax-ai/kodax`
- 写 skill loader → `@kodax-ai/kodax/skills`（zero-dep，最便宜的 subpath）
- 嵌入 REPL UI → `@kodax-ai/kodax/repl`（带 Ink + React 间接依赖）

### 12.3 Bundle 边界 — 哪些 inline、哪些 external

**Inline 进 bundle（esbuild 自动 inline）**：
- `packages/{ai,agent,coding,mcp,repl,repointel-protocol,session-lineage,skills,tracing}/src/**`：所有 9 个内部子包源码

**Standalone external（保留 import 让 npm 在用户机器上装）**：
- 真第三方运行时包：`chalk` `commander` `glob` `iconv-lite` `js-tiktoken` `fflate` `yaml` `clipboardy` `string-width` `ink` `ink-spinner` `ink-text-input` `react` `@agentclientprotocol/sdk`
- vendored Ink fork 的 transitive deps（26 个）：`yoga-layout` `react-reconciler` `ws` `scheduler` `cli-cursor` `stack-utils` `code-excerpt` `es-toolkit` `ansi-escapes` `is-in-ci` `auto-bind` `signal-exit` `patch-console` `wrap-ansi` `terminal-size` `react-devtools-core` `widest-line` `slice-ansi` `@alcalzone/ansi-tokenize` `cli-boxes` `indent-string` `cli-truncate` `yoga-layout-prebuilt` `prop-types` `arrify` `string-length`
- 运行时 import 的工具：`typescript`（运行时 AST 分析）、`tsx`（用户 .ts 扩展加载）

### 12.4 五个已知风险与应对

发布架构脆弱面 + 应对方案。维护时定期重审。

#### 风险 1 — `tsx` ESM API 必须 external

**场景**：KodaX extensions 系统让用户写自己的 `.ts` 扩展文件，运行时通过 `tsx/esm/api` 的 `tsImport` 动态加载。`tsx` 内部依赖 Node.js ESM loader hook 机制，必须在进程早期注册。

**风险**：esbuild 默认会把 `tsx` 也 inline 进 bundle，bundled 后的 `tsx` 失去 loader hook 注册时机，用户 `.ts` 扩展加载失败。

**应对**：
- `scripts/build-bundle.mjs` 中显式 `external: ['tsx']`
- root `package.json#dependencies` 保留 `"tsx": "^4.21.0"`
- 严重度：低；维护成本：一次配置，无后续

#### 风险 2 — Vendored Ink fork 的 transitive deps 必须 external（且必须显式声明）

**场景**：`packages/repl/src/tui/` 是 Ink 库的 vendored fork（fork 自上游 Ink 的源码并修改）。Vendored 模式下 KodaX 不再 `import 'ink'`，所以 npm 不会替我们装 Ink 的 26 个 transitive deps。

**风险**：bundle 不进去（多个包含 native binding，如 `yoga-layout` 的 `.wasm`），但又必须在用户机器上安装到，否则运行时 `ERR_MODULE_NOT_FOUND`。这正是 v0.7.37 首次 multi-package 发布触发的实证 bug。

**应对**：
- 全部 26 个包列入 root `package.json#dependencies`（清单见 §12.3）
- `scripts/build-bundle.mjs` 中 `external` 包含这 26 个
- 严重度：低；维护成本：一次复制粘贴，新加 vendored 文件时检查 import

#### 风险 3 — Skills builtin helper script 路径硬编码

**场景**：`dist/builtin/skill-creator/scripts/run-eval.js` 这类 helper script 是 KodaX 自带的、由 LLM 通过 skill 触发执行的脚本。它们需要 import 到 `dist/index.js` 中的 SDK API（`runKodaX` / `estimateTokens`）。

```javascript
const here = path.dirname(fileURLToPath(import.meta.url));
const sdkPath = path.resolve(here, '../../../index.js');
const sdk = await import(pathToFileURL(sdkPath).href);
```

`'../../../index.js'` 这串相对路径**硬编码了 dist 布局**。

**风险**：将来重构 dist 布局（比如把 `builtin-skills/` 改成 `assets/skills/builtin/` 多套一层），所有 helper script 路径会断 —— 而且断的是运行时，编译期看不出。

**应对**：
- `scripts/build-bundle.mjs` 中把 dist 布局**契约化**：注释 + 常量 `HELPER_SCRIPT_DEPTH_TO_DIST = 3` + build 结束前的 sanity check（`existsSync` + 实际 depth 计数对照常量，违反则 `process.exit(1)` 阻塞 release）
- helper script 内运行时 `fs.existsSync(sdkPath)` sanity check
- e2e 测试覆盖 `npm pack && install + 跑一次 skill helper`，build-time gate 而非 publish-time
- 严重度：中；维护成本：长期警觉，重构 dist 布局必须同步改 helper script

#### 风险 4 — Source map 必须包含原 KodaX 源码映射

**场景**：路径 B 集成方在生产中遇到 KodaX 内部错误，看到栈指向 `/app/dist/index.js:14523` 这种巨大行号，无法定位。

**风险**：没有 source map → 集成方调试是黑盒。

**应对**：
- `scripts/build-bundle.mjs` 默认 **sourcemap 关闭**，需 `--with-sourcemap` 显式启用（实测 source map 加 ~13 MB unpacked / ~3 MB gzipped 到 tarball；路径 B 集成方比例少 + KodaX 是开源的，需要时可从 GitHub source 重 build）
- `--with-sourcemap` 启用后 `dist/*.js.map` 含原始 `packages/*/src/**` 路径映射；publish 时仍走 root `package.json#files` 白名单（默认 `dist/` 整目录包括 .map）
- 后续如果 path B 反馈量大可改为默认 on（trade-off 见 ADR-022）
- 严重度：低；维护成本：一次配置

#### 风险 5 — Bundle size 不应膨胀

**场景**：用户 `npm install -g @kodax-ai/kodax` 下载 tarball。当前 9 子包 dist 总和 ~1.5 MB；bundle + chunk splitting 后实测 ~1.1 MB packed / ~3.5 MB unpacked（v0.7.39）。

**风险**：esbuild 配置不当（如未做 module dedup）可能导致 bundle 反而比 multi-package 更大。

**应对**：
- `scripts/build-bundle.mjs` 中 `metafile: true` 输出 build 分析 → CI 中跑 `esbuild-visualizer`，每个 release 检查
- 加 `--minify` 压缩（节省 30-50%）
- 设阈值：bundle size > 2 MB 触发 release gate
- 严重度：低；维护成本：每次 release 检查一次

### 12.5 与 ADR-001 / ADR-021 的关系

源码层（ADR-001 / ADR-021）的"layered monorepo + 9 子包独立可用"承诺**不变**。Bundle 是发布层的聚合操作，不消除源码层的边界。

| 不变量 | 在源码层 | 在发布层 |
|---|---|---|
| 9 个子包独立可用 | ✅（git clone 路径 A） | ❌（只发 1 个 cli） |
| Layer independence | ✅（review 必须守） | N/A（bundle 后变成实现细节） |
| 独立 release cadence | N/A（dev 不需要） | ❌（10 个版本号合 1 个） |
| 独立 npm visibility | N/A | ❌（仅 cli 出现在 npmjs.com） |
