# Reasoning 单轨化迁移 — Handoff

> 目标:把推理控制彻底单轨化到 `effort` + `reasoningProfile`,删除 V1 残留
> (reasoningMode/depth、机制能力)和已 vestigial 的 harness 推理升级机器。
> 本文件是跨会话交接,**接手前先通读**。来源:上一会话完成调研 + 计划 + A1。

---

## 0. 已落地的地基(上一会话已 DONE,本次迁移建在其上)

effort 体系已经成型,**不要重做**:

- **Ctrl+T 循环 V2 effort 梯**(`packages/repl/src/ui/shortcuts/GlobalShortcuts.tsx`):按当前模型 capability 派生档位;写 `config.effort`;`reasoningMode` 仅作为派生兼容字段(`'off'`/`'auto'`)——**Phase B 会彻底删掉它**。
- **状态栏 effort-first**(`status-bar.ts` view-model + `surface-status.ts` + `InkREPL.tsx` Banner)。`minimal->off` 显示。
- **`capability-cache.json`**: LLM pure ops live in `packages/llm/src/capability-learning.ts`; default persistent store lives in `packages/agent/src/runtime/capability-cache.ts`; `packages/repl/src/common/capability-cache.ts` is only a compatibility barrel. `resolveReasoningProfileForDisplay` consumes the narrowed profile through the agent/LLM APIs.
- **被动学习 + 自愈**:`reasoning-effort-rejection.ts` 分类器(只认真实 400/422 + 命名 effort 参数)+ `base.ts` withRateLimit 的 `suppressReasoningEffort` 自愈重试(剥 effort 重试一次,turn 不中断)+ `onReasoningEffortRejected` 事件 → host/REPL 通过 agent cache 记录 + 切安全档。
- **自定义 provider 友好配置** `reasoning: {efforts,default} | "none"`(`custom-provider.ts`),legacy 字段标 `@deprecated` 加载迁移。
- **registry 未知 model 乐观继承 provider 级**(`registry.ts:580` getModelCapabilities)。
- **effort 持久化 override 重建**(`utils.ts` `resolveInitialEffortOverride`)。
- **命令**:`/provider probe`(capability-probe.ts)+ `/provider forget-capability`。
- 配置模板 `config.example.jsonc` 已重写(effort/reasoning 新 schema,中文注释)。

---

## 1. A1 已完成(本次会话)

**CAP-019 auto-reroute(harness 推理自动升级)整体退役** —— 606 测试绿:

- 删 `run-substrate.ts` 两处 `mode==='auto'` 的 reroute block(pre-answer + post-tool)+ `autoFollowUpCount/Limit`/`autoDepthEscalationCount`/`autoTaskRerouteCount` 状态 + `maybeAdvanceAutoReroute` import + 3 个仅供 reroute 的 judge import。
- 删 `packages/coding/src/agent-runtime/middleware/auto-reroute.ts` 整模块。
- 删 `__contract-tests__/cap-019-auto-reroute.contract.test.ts`。
- **保留(查实是 live,误删会回退)**:`buildReasoningExecutionState`(run-substrate:565,正常每轮构建)、`rebaseContextTokenSnapshot`(465/980/1112/1270)、`summarizeToolEvidence`(CAP-088 独立)。
- **留给 Phase B**:`reasoning.ts` 的 `maybeCreateAutoReroutePlan`/`escalateThinkingDepth`/`ReasoningFollowUpPlan` 现已 dead,但与 depth 纠缠,B 阶段连 depth 一起删。

---

## 2. Spike 关键结论(防改错的不变量)

- **harnessProfile(H0/H1/H2)结构上 vestigial**:`runner-driven.ts:836-840` 把 `initialHarness` 硬编码 `'PLANNED'`,预算/轮次/agent 不再读 `plan.decision.harnessProfile`。**但** `HARNESS_PROFILE_OVERLAYS[decision.harnessProfile]`(reasoning.ts:1641 via `buildPromptOverlay`)+ `buildAmaControllerDecision`(reasoning.ts:1493 H2 fanout)**仍按 harnessProfile 往 Worker 系统提示注不同文本** → **LLM-facing,删除必须走 eval(ADR-033 / EVAL_GUIDELINES)**。
- **reasoning.depth 真实消费点(窄)**:`anthropic.ts:342/524/900`、`openai.ts:76/500`、`reasoning-plan-entry.ts:116/118`。
- **upgradeCeiling/topologyCeiling vestigial**(verdict-recorder 的 H1→H2 升级已注明 production 不再触发)。
- **绝不能删(live)**:`buildReasoningExecutionState`、`rebaseContextTokenSnapshot`、`providerPolicy`(CAP-029 路由策略,与推理独立)、harnessProfile 的 **prompt-overlay 文本**(eval 把关后才动)。
- **业界对照(已实地核实)**:Codex 和 Claude Code **都没有** harness 级推理自动升级(effort 每轮固定,只用户能改)。→ 删 CAP-019 = 向业界极简对齐,有据。

---

## 2.5 Session 2 进展(2026-06-26)

**Phase 0 spike 结论(已钉死,纠正了 §2 一处论断)**
- `createReasoningPlan` 删 mode/depth 后存活面确认:`decision`(harnessProfile/primaryTask/taskFamily/recommendedMode/mutationSurface)、`promptOverlay`、`amaControllerDecision`、`providerPolicy` 全 live,保留。mode/depth → effort 是 Phase B 的事。
- **纠正 §2**:`decision.harnessProfile`(H0/H1/H2)**不是纯 vestigial**。除 prompt-overlay 外还有真·非 prompt 运行时消费:`repo-intelligence.ts:228`(每轮 repo-overview 注入 gate)、`payload-builder.ts:141`(contract.harnessProfile + deriveQualityAssuranceMode)、`checkpoint-flow.ts:211`(resume seed)。§2 的"agent 不再读 plan.decision.harnessProfile"**只对 live-loop 拓扑成立**(主循环恒 Worker→Evaluator,payload-builder 只是末尾记录)。**结论:decision.harnessProfile 字段保留**,A2/A3 都不删字段本身。

**业界对照(claudecode C:\Works\claudecode 实查)**:主循环无默认轮次上限,靠 LLM stop signal;`maxTurns` 按 agent 职责(fork=200/hook=50/...)而非按复杂度分档;**没有 BUDGET_CAP_BY_HARNESS 式分档表**。→ KodaX 分档表是 V1 残留,折成单常量与业界对齐。

**A2a 已交付(commit `9a2f89b1`)**:`BUDGET_CAP_BY_HARNESS`/`MAX_ROUNDS_BY_HARNESS`/`BUDGET_EXTENSION_BY_HARNESS`(observer-bridge)+ 死的 `MANAGED_TASK_BUDGET_BASE`/`createManagedBudgetController`(budget.ts)→ 单常量 `MANAGED_WORK_BUDGET_CAP=200`/`MANAGED_MAX_ROUNDS=8`/`MANAGED_WORK_BUDGET_EXTENSION=200`。唯一行为变化:resume 的 H0/H1 任务现在跟 fresh 一样拿 200/8(预算只增不减)。263 测试绿。**关键认知**:`MAX_ROUNDS` 只是进度条"第 i/N 轮"分母(每次批准扩容 +1),不卡工作;真上限是 200-unit budget controller(可续)+ 20 iter/agent 内循环。

**A2b(ceiling 链)改期到 B 之后**(用户拍板):`upgradeCeiling` 织进 V1 H1→H2 升级机器(verdict-recorder.ts:177-183 注释:生产 dead 但 wrapEmitterWithRecorder 单测在用,"removing breaks tests");`topologyCeiling` 进 buildPromptOverlay(reasoning.ts:1643)是 LLM-facing 该走 A3 eval。ceiling 链与 reasoning effort 正交,等 reasoningMode 删净后连带更多 dead 一次清更干净。

**Phase B 完整删除/迁移面已映射(见下 §3 Phase B 展开 B1–B7)。**

---

## 3. 剩余阶段(按爆炸半径,逐阶段独立 commit + review 三连)

### Phase 0 spike(开工前唯一硬开放项)
确认 `createReasoningPlan`(reasoning.ts:1657)删掉 harnessProfile + depth 后**还剩什么活的**:`promptOverlay` / `primaryTask` / `taskFamily` 仍是 LLM-facing(routing overlay),必须留;providerPolicy 留。产出:钉死 A2/A3 的确切删除边界。

### A2 + A4 — harness 结构 + ceiling(vestigial 删除)
- `KodaXHarnessProfile` 相关:`BUDGET_CAP_BY_HARNESS`/`MAX_ROUNDS_BY_HARNESS` 收成单常量(只 `'PLANNED'` live)。注意类型贯穿 managed-task / observer-bridge / 状态栏 / resume seed,逐处核。
- 删 `upgradeCeiling`/`topologyCeiling`/FEATURE_078 推理天花板(`reasoning.ts` L1-L4 链:`resolveTurnReasoningMode`/`clampReasoningMode`/`compareReasoningModes`/`deriveTopologyCeiling`)。
- gate:build + 全 contract 测试。

### B — reasoningMode/depth → effort 单轨

> **Session 2 映射:50+ 生产文件,按 ripple 拆 B1–B7。** `effort`(`KodaXWireReasoningEffort`)+ `resolveReasoningEffort`(llm/reasoning.ts:450)是目标态,已存在;reasoningMode/depth 是要拆的 V1 双轨。
>
> - **B1(独立 commit,无 ripple)**:删 auto-reroute dead 簇 + `escalateThinkingDepth`(删 auto-reroute 后它变全 dead)。符号:`AutoRerouteDecision`/`AutoRerouteEvidence`/`ReasoningFollowUpPlan`/`AUTO_REROUTE_SYSTEM_PROMPT`/`maybeCreateAutoReroutePlan`/`buildHeuristicAutoRerouteDecision`/`judgeAutoRerouteWithLLM`/`normalizeAutoRerouteDecision`/`REASONING_MODE_TO_DEPTH_CEILING`/`escalateThinkingDepth`(reasoning.ts)。同步删测试:reasoning.test.ts(buildHeuristic/maybeCreateAutoReroute 块)、reasoning-feature-078.test.ts(escalateThinkingDepth 块,**保留** resolveRoleReasoning/clamp 块)、GlobalShortcuts.test.ts:424。coding-preset.ts:207 + llm-adapter.ts:288 只是注释提及,顺手清。
> - **B2(纯增量)**:新建 effort-native `EFFORT_RANK`/`compareEfforts`/`clampEffort`/`escalateEffort`/`resolveRoleEffort`/`applyFollowupEscalationToOptionsV2`(reasoning.ts 或新 reasoning-effort.ts),与旧函数共存。
> - **B3(必须同一 commit:ReasoningPlan 接口跨包 ripple)**:`createReasoningPlan` 写 effort 替代 mode/depth;`llm-adapter.ts:291/299/306`(resolveReasoningMode/resolveRoleReasoning/reasoningModeToDepth → effort 版);`reasoning-plan-entry.ts:71/72/93/116`(providerReasoning.effort);`run-substrate.ts:565/571/682/692/699/712`。
> - **B4(依赖 B3)**:L5 followup 切 effort——删 `escalateUserCeiling`/`applyFollowupEscalation`/`applyFollowupEscalationToOptions`,`agent.ts:32` + `runner-driven.ts:492` 改调 V2。`detectFollowupSignal` 纯文本无 mode 依赖,**保留**。
> - **B5(thinkingLevel→effort,接口+实现两 commit)**:runtime-session-state / per-turn-provider-resolution / provider-hook / extension-queue / runtime-contract / extensions(runtime+types) / running-session / child-executor / orchestration / provider-policy / tool-execution-context / runner-driven:1316。
> - **B6(必须同一 commit:llm 类型删除)**:删 `KodaXReasoningMode`/`KodaXThinkingDepth`/`KODAX_REASONING_MODE_SEQUENCE`/`mapLegacyReasoningModeToEffortIntent`/`effortToLegacyReasoningMode`/`getDefaultThinkingDepthForMode`(llm/types.ts+reasoning.ts)+ `normalizeReasoningRequest` 简化 effort-only + `KodaXReasoningRequest.mode/.depth` + `KodaXResolveReasoningEffortInput.legacyReasoningMode` + coding/index.ts re-export(58/677/678)。
> - **B7(最后,用户可见 — 需用户确认 compat 行为)**:`/reasoning` 命令、CLI `--reasoning`、`CurrentConfig.reasoningMode`/`setReasoningMode`、ACP server `this.reasoningMode`、Ctrl+T 派生写、状态栏 fallback。**加载期 old→effort shim**(`off→none`/`auto→clear`/`quick→low`/`balanced→medium`/`deep→high`)。⚠️ 决策点:`/reasoning`+`--reasoning` 是保留为 compat alias 还是删?config 自动迁移还是带 deprecation warning?ACP `reasoningMode` 字段对外契约要不要改名。
>
> 原始要点(保留):
- `normalizeReasoningRequest` 简化为 effort-only(删 mode/depth 字段)。
- 删 `reasoning.ts`(coding)dead helpers:`maybeCreateAutoReroutePlan`/`escalateThinkingDepth`/`ReasoningFollowUpPlan`/L1-L4 链(若 A2 没删净)。
- UI/CLI:`/reasoning` 命令 + `setReasoningMode` + `CurrentConfig.reasoningMode` + CLI `--reasoning` + 状态栏 reasoningMode fallback → 删;**加载期一次性映射 old→effort shim**(`off→none`/`auto→clear`/`quick→low`/`balanced→medium`/`deep→high`)做 back-compat。
- Ctrl+T 顺势去掉 reasoningMode 维护(只设 effort + 派生 thinking)。
- 跨 llm + coding + repl 三包,牵动面广,**逐文件 grep `reasoningMode`/`KodaXThinkingDepth` 改完**。
- gate:build + 全套件。

### C — provider 预算 depth → effort(wire 改动,最险)
- `anthropic.ts:334` `resolveV2ThinkingBudget`:删 `?? resolveThinkingBudget(depth)` fallback;adaptive 预设直接发原生 adaptive(无 budget);budget 预设(anthropic-budget/qwen)用 `budgetByEffort`。
- 给缺 `budgetByEffort` 的预设补齐(`claude-adaptive-xhigh/max` 改走 adaptive 就不需 budget)。
- `openai.ts:76/500`:`mapDepthToOpenAIReasoningEffort(depth)` → 直接用 effort;`resolveThinkingBudget(depth)` → effort 派生。
- `KODAX_DEFAULT_THINKING_BUDGETS` depth-keyed → effort-keyed。
- **🔴 必做 gate:per-provider × per-effort wire 快照对比**——改造前后断言每个 provider 每个 effort 档发出的 `reasoning_effort` / `thinking.budget_tokens` 完全一致;adaptive 模型断言发原生 `{type:'adaptive'}`。这是"删 depth 不改实际请求"的硬证据。

### D — providerReasoningOverrides / V1 机制 → reasoningProfile.effortStrategy(等价迁移)
- `KodaXReasoningCapability`(toggle/effort/budget/adaptive 机制)统一到 `reasoningProfile.effortStrategy`。
- 删 `providerReasoningOverrides` 配置字段 + `packages/llm/src/reasoning-overrides.ts` + `base.ts:366/378/393`(`loadReasoningOverride`/`saveReasoningOverride`/`persistReasoningCapabilityOverride`)。
- **🔴 不是裸删,是等价迁移**:必须接替 (a) budget→toggle 的运行时机制自愈(openai.ts:774/1028、anthropic.ts:586/935 的 `persistReasoningCapabilityOverride`),(b) `provider-policy.ts:106` 的 V1 capability 输入。配 per-provider 单测。

### A3 — harness 提示变体(LLM-facing,放最后,单独 eval)
- 删 `HARNESS_PROFILE_OVERLAYS` 的 H0/H1/H2 文本变体 + `buildAmaControllerDecision` 的 harnessProfile 分支。
- **🔴 必走 eval**:按 EVAL_GUIDELINES,canonical 5-alias panel 对照,确认删 H0/H1 提示差异后 Worker 行为不退化。

### 收尾
ADR(记单轨化决策 + CAP-019/harness 升级 retired,引业界对照)+ feature 稿 + 全套件 sweep。

---

## 4. 纪律(必守)
- 每阶段独立 commit + review 三连(无新问题 / 无漂移 / 无回退)。
- C 必做 wire 快照对比;A3 必走 eval;D 必有机制自愈/policy 的接替 + per-provider 测试。
- `npm run build:packages` + 发版前跑**全套件**(不只触达区)。一次性跑全部 vitest 可能 worker 池 IPC 崩,**分批跑**。
- 谨慎防回退是第一优先;查实 live/dead 再删(A1 就靠逐符号核才没误删 buildReasoningExecutionState)。
