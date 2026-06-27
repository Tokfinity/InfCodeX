# 设计稿:路由/harness 预判 → 静态分层指引 + LLM 自主判断 + Verifier 度量门控激活

> 状态:**设计已定稿(含 GPT review 8+2 条裁决),待开工 H2**。这是 reasoning 单轨化(**核心运行时单轨化完成,public compat 尾巴仍在**——CLI/REPL/ACP 里 `reasoningMode` 还很多,见 [[project_reasoning_single_track_migration]])之后的**新的、更大的架构改造**,与 effort 单轨化正交。
> 目标:把"启发式关键词路由 → 按预判 harness 级别注入不同提示 + 门控"改成"静态分层指引(对所有任务注入)+ 工具常驻 + LLM 自主判断",Sidecar Verifier 改由**客观执行度量(规则触发)**控制激活——**不**用 Worker LLM 自报信号(LLM 完成后偏向声称做完,自报不可靠)。

---

## 0. 动机

KodaX 现在每个用户请求先用关键词匹配(`inferIntentGate`/`inferTaskSignal`,纯正则)分类出 `harnessProfile`(H0/H1/H2),再按分类往 Worker 系统提示注入不同的分层指引文本。

**业界双重对照(实地核实)**:
- **Claude Code**:无路由/复杂度预分类器;"何时做计划/派子agent/用 TodoWrite"全部静态写在工具描述的 when-to-use 里,LLM 自主判断;系统提示对所有任务静态(动态部分只随会话配置变);reasoning effort 用户设定,harness 从不自动调。
- **Codex**:同样无预分类器;全局静态 base instructions;Plan 模式是用户手动切换;reasoning effort 用户设定 + 模型默认,harness 从不按任务自动调。

KodaX 的关键词路由预分类是**两家都没有**的外层逻辑,且违背 KodaX 自己 ADR-033("LLM 是做判断的同事,不是查表的程序")。

---

## 1. 现状钉死(调研结论,防止改造不完整)

### 1.1 Verifier 激活:不靠 harness,靠 FEATURE_196 内容 gate
- `qualityAssuranceMode`('required'/'optional',deriveQualityAssuranceMode)**是纯 UI 字段**(payload-builder.ts:325 写入 runtime,只被 REPL 展示),**不参与任何 gate**。
- 真实激活链(全 AND,runner-sidecar-verifier-adapter.ts):
  1. `role==='worker'`
  2. `!isIdleYieldTurn`(无 pending child / background notification)
  3. `composeGateDecision`(gate.ts:216):env escape → 任何 tool_use 则 fire(Layer 1)→ 问候且无命令动词则 skip(Layer 2)→ 默认 fire。
- 所以现在:**Worker 有动作就验,纯闲聊跳过,默认验**。

### 1.2 静态分层指引:Worker 提示里已有大半
- planFirstContract(worker-role-prompt.ts:58-75)已静态含 H0(trivial 直做)/H2/PLANNED(非 trivial 先 todo_create)。
- **冗余**:HARNESS_PROFILE_OVERLAYS 的 H0/H2/PLANNED ≈ 现有静态条款。
- **非冗余、需搬成静态**:H1(执行后自检)+ EXECUTION_MODE_OVERLAYS 7 种模式(conversation/lookup/pr-review/strict-audit/implementation/planning/investigation)——后者描述"如何定向分析",Worker 提示里无静态对等物。

### 1.3 fanout 门控:Layer 1 是建议,Layer 2/3 才是安全
- Layer 1(`buildAmaControllerDecision` → `[AMA Controller] fanoutAdmissible` 文本 + fanout-scheduler admissible 检查):**纯建议/调度入口,可拆**,不阻止 LLM 实际调用。
- Layer 2(child-executor.ts CHILD_EXCLUDE_TOOLS_BASE,删子 agent 的 dispatch 工具防递归):**安全约束,不可拆,不依赖路由**。
- Layer 3(child-executor.ts validateWriteBundles,parentRole==='worker' && parentHarness==='tool-dispatch' 才允许写扇出):**安全约束,不可拆,但不依赖路由 decision**(parentHarness 来自工具调用上下文,非 decision.harnessProfile)。

### 1.4 路由字段去掉后要保全的
| 字段 | 现消费 | 处理 |
|---|---|---|
| recommendedMode | EXECUTION_MODE_OVERLAYS 7 模式文本(高价值) | 搬成静态分层指引,LLM 自判属哪种 |
| requiresBrainstorm | brainstormGuidance 文本 + AMA profile | 搬成静态"歧义先框选项"原则 |
| primaryTask/complexity/riskLevel/workIntent | roleAck 上下文确认(worker-role-prompt:244-251) | 可删 roleAck,或改为 LLM 自述 |
| mutationSurface | fanout class gate + readOnlyLike | 随 Layer 1 拆;Layer 3 写安全不依赖它 |
| repoIntelligence 注入 | 独立 config 驱动(repo-intelligence.ts) | 已解耦,不动 |

---

## 2. 目标架构

```
现在:  用户请求 → 关键词路由 → decision{harness,mode,...} → 按 harness 注入不同提示 + 建议门控
                                                        ↓
                                            Worker(看定制提示)→ 终止 → FEATURE_196 内容 gate → Verifier

目标:  用户请求 ─────────────────────────────────────────→ Worker(看统一静态分层指引,自己判断
                                                              简单直答/复杂先计划/可派子Agent)
                                                        ↓ 终止
                                  度量 gate(读 mutationTracker/roundRef/todoStore 客观度量,
                                            规则判定 fire/skip)→ Verifier
```

三块改动:

### 2.1 静态分层指引(替代 HARNESS_PROFILE_OVERLAYS + EXECUTION_MODE_OVERLAYS)
- 落点:`worker-role-prompt.ts buildWorkerInstructions`(现有静态指引密度最高、每次必经的纯 builder)。
- **原则(用户拍板):删的是冗余投递 + 分类表干扰,绝不删有效提示。** buildPromptOverlay 路由注入层逐条分三类——A 删、B 搬静态、C 删:

**A 类 — 冗余投递(有效指令已静态保留在 planFirstContract,删 overlay 零内容损失)**
| 提示 | 为何冗余 |
|---|---|
| HARNESS.**PLANNED**「non-trivial MUST commit a plan first」 | 字面重复 `worker-role-prompt.ts:61`「Non-trivial → FIRST tool calls MUST be todo_create batch」(更详细)。删 overlay 后该指令仍由 planFirstContract 无条件注入,**"留下"已满足**。若 eval 显示 Todolist 生成率掉→强化 planFirstContract 那条措辞,不复活路由 echo。 |
| HARNESS.**H0_DIRECT**「single direct pass」 | 重复 planFirstContract trivial 条 |
| HARNESS.**H2** plan 部分「plan before changes」 | 重复 planFirstContract plan-first |
| MODE.**conversation/lookup**「直接答别升级」 | 重复 planFirstContract trivial 条 |

**B 类 — 有效且无静态对等(必须搬成静态,绝不删;H3 eval 专门验它们不退化)**
| 提示 | 内容 |
|---|---|
| HARNESS.**H1_EXECUTE_EVAL** | 执行后对照请求自检再收尾,evidence-backed(planFirstContract 无对等) |
| MODE.**pr-review** | 只报高置信可执行项 / 不算 nits / Must-fix≤5 / 每条说后果 |
| MODE.**strict-audit** | 跨正确性/安全/性能广审,confirmed 与 risk 分开 |
| MODE.**investigation** | 先定位根因/验证假设/repro 再大改 |
| MODE.**planning** | 先架构/排序/风险/验证再写码(中等价值) |
| **brainstormGuidance**(reasoning.ts:1606) | 歧义先框选项,不可逆编辑前明确路径 |

**C 类 — 噪声/干扰(分类表 dump,ADR-033 反模式,删)**
| 提示 | 为何是干扰 |
|---|---|
| **[Task Routing]** 行(reasoning.ts:1617)`primary=…;topologyCeiling=…;confidence=…` | 喂 LLM 分类表,违 ADR-033「同事做判断不是查表」 |
| **[Task Routing Signals/Reason]** | 路由元数据,无行为指引 |
| **roleAck**(worker-role-prompt.ts:244-251) 分类摘要 | 同样的分类表 dump |
| `topologyCeiling=`/`upgradeCeiling=` 串 | A2b 死字段残留,本就 vestige |

- 中等/边界:MODE.**implementation**(concise/progress)、**[Work Intent]**(append/overwrite/new)可精简后搬静态或保留。

### 2.2 fanout 常驻 + LLM 自判
- **🔴 GPT#5 更正:Layer 1 不是"纯建议",拆它是行为变更**。两处:
  - `buildAmaControllerOverlay` 注入的 `[AMA Controller] fanoutAdmissible…` 文本是 **LLM-facing**(prompt 内容)。
  - `createFanoutSchedulerInput`(fanout-scheduler.ts:45)在 `!fanout.admissible` 时 return undefined → **门控调度计划生成**(不只是建议)。
- 故归入 **H1b**(需 targeted test,必要时跟 H3 eval 一起看),不进 H1a 安全清理。
- 保留 Layer 2/3 安全约束(不依赖路由,不动)。
- dispatch_child_task 的工具 description 补足 when-to-use(参考 Claude Code AgentTool),让 Worker 自判何时派。

### 2.3 Sidecar Verifier:客观度量规则激活(本设计核心,KodaX 原创)
保留 Verifier(原创结构性净网),但**不在过简任务上激活**浪费 token。

**✅ 已定(用户拍板):规则触发,不用 LLM 自报信号。**
否决"Worker 终止前自报 verification_hint"——理由:**任何 LLM 做完后都不会偏向声称"我没干完/需人审"**,自报被完成 bias 污染。改为读 Worker **实际做了什么**的客观度量(可观测、不被 bias 污染),用规则决定 fire/skip。

**业界对照(已实地核实)**:claudecode/codex **都没有**"改动行数/写操作→触发验证"的度量 gate(行数只做展示/归因)。但"度量驱动 gating"本身是业界成熟模式:claudecode 用轮数软规则(每 5/10 轮注 reminder)+ token 阈值 auto-compact;codex 用 Guardian per-action verifier + 计数 circuit breaker(连拒 3 次/窗口 10-in-50 中止 turn)。所以**度量触发 verifier 是 KodaX 原创点,但有业界模式背书**。

**最终规则**(GPT review 后修订:度量只**精化** `detectActionSurface`「Worker 确实动手了」的分支,**保留** conversational floor + default-fire,不丢 F184 intent-vs-action floor):
```
composeGateDecision 顺序(纯代码,在 mutationTracker + roundRef + todoStore 上算):
  1. env KODAX_VERIFIER_ALWAYS=1 ─────────────────────────────→ 验  (逃生开关)
  2. 度量精化(仅当 Worker 有可观测工具动作 hasAnyToolAction):
       高风险 bash(riskyShellOps>0:git push/rm/迁移/install)─→ 验  (危险且 bash 改哪文件/几行是盲区,保守判)
       有 Todolist(todoStore 非空)─────────────────────────→ 验  ★Worker 自列计划=自判非琐碎(客观产物,非自报)
       轮数 > ROUNDS_VERIFY_THRESHOLD(默认 10)────────────→ 验  ★长任务可能结果不完备/计划没做完
       改动文件 ≥ 2 ────────────────────────────────────────→ 验  (多文件改动)
       单文件 estimatedChangedLines > TRIVIAL_LINES(默认 20)→ 验  (大改;估算行数,非精确 diff)
       否则(只读且短且无计划,或单文件≤20行无计划短轮)────→ 不验  ★新省 token,只作用于"确实动手的琐碎工作"
     ── Worker 无任何工具动作 → 不在本层决定,落下一层 ──
  3. conversational-intent(短问候且无祈使动词,detectConversationalIntent)→ 不验  (原样保留)
  4. default ─────────────────────────────────────────────────→ 验  (原样:无动作+非问候=声称没证据,F184 floor 不丢)
```
设计理由:① 第 4 层 default-fire 保留 → "让查 README 却没调任何工具" 仍 fire(F184 floor 不丢,gate.ts:216 当前正是 default-fire 兜住此例);② 第 3 层问候 skip 不动;③ 度量 skip **只精化第 2 层「确实动手」的琐碎工作**(小改/只读调查),正是要省的 token,不碰无动作场景。常量 `ROUNDS_VERIFY_THRESHOLD=10`/`TRIVIAL_LINES=20` 做成可调常量+测试边界,后续按真实触发率 tune。

**🟡 已知 tradeoff(用户认可)**:此方案下"短的只读调查任务"(有 read 证据但结论可能错)会 skip。可接受——它有工具证据(不同于无动作空声称),且本就要在简单只读任务省 token;真复杂的(>10 轮或有计划)仍 fire。

**接入点(调研已验,Verifier 侧零改动,纯运行时逻辑 → 非 LLM-facing → 不用 eval,只单测)**:
1. `mutationTracker` **已是 verifier adapter 的 dep**(runner-driven.ts:1499)→ 写操作数/`estimatedChangedLines`(`mutationTracker.files` Map,精确度=估算)/文件数现成可读。
2. **GPT#4:高风险 bash 加窄字段** `riskyShellOps`(或 `riskyShellCommands`)到 `ManagedMutationTracker`——`recordMutationForTool`(tool-wrappers.ts:56)已有 `SHELL_MUTATION_EXTENSIONS` 正则识别,顺手 record,**不再靠 `totalOps` 猜**。
3. `roundRef`(runner-driven.ts:858)、`todoStore`(runner-driven.ts:712,已在 onVerdict 闭包)在作用域内 → 照现有 `getChildTaskRegistrySize`/`getSessionId` getter 模式,给 adapter deps 加 `getRoundCount`/`getHasPlan`(各一行)。
4. `composeGateDecision`(gate.ts:216)签名扩展接受这些度量,把第 2 层度量精化插在 `detectActionSurface` 位置;`detectConversationalIntent` + default-fire **保持不动**。

**🔴 GPT#2:本变更不叫"零回退"**——它**有意改变 verifier 触发率**(部分现在 fire 的琐碎工作改 skip)。定性=**非 LLM-facing、可单测、低风险**,但需 **gate snapshot 测试覆盖 fire/skip 全部迁移**(构造各种 mutationTracker/round/todo/riskyShell/无动作 状态断言)。

**🔴 与 A3 的耦合不变量(H2/H3 之间必守)**:
- 本 gate 的 `hasPlan` = todoStore 非空 = **Todolist 生成行为的产物**。若 A3 让 Todolist 生成率退化 → hasPlan 触发率掉 → 漏验。
- 缓解①:**A3 的 5-alias eval 把"Todolist 生成率"做成显式一等指标**(不只隐含检查),hasPlan 可靠性由该 eval 硬守。
- 缓解②:**排序天然隔离**——H2(本 gate,非 LLM-facing)先落地时 HARNESS_PROFILE_OVERLAYS 还在,hasPlan 正常;H3(A3)删 overlay 时 eval 先守 plan-first。两者不同时变动。
- 查实依据:Todolist 真正驱动 = 静态无条件注入的 planFirstContract(worker-role-prompt.ts:256,不被任何 router/harness gate);A3 删的 PLANNED 只是其字面冗余 echo(见 §2.1 A 类)。

---

## 3. 分阶段计划(非 prompt 先行、prompt 后行走 eval)

**Phase H1a — 真正非 LLM-facing 清理(可单测,安全先做)**
- 删 qualityAssuranceMode 死字段(纯 UI/展示,可保留显示或一并清)。
- 删 deriveTopologyCeiling + topologyCeiling/upgradeCeiling 字段(A2b 非 prompt 部分)+ verdict-recorder 死 gate + 陈旧注释。
- gate:build + 全套件。

**Phase H1b — fanout 策略改造(GPT#5:LLM-facing + 调度行为,非纯清理)**
- 拆 `buildAmaControllerOverlay` 注入文本(LLM-facing)+ `createFanoutSchedulerInput` admissible 门(fanout-scheduler.ts:45,门控调度);保留 Layer 2/3 安全约束。
- 需 targeted test 覆盖调度行为变化;dispatch description 补 when-to-use。**必要时跟 H3 eval 一起看**(overlay 文本属 LLM-facing)。

**Phase H2 — Verifier 度量门控激活(非 LLM-facing、可单测、低风险,可独立先落地)**
- adapter deps 加 `getRoundCount` + `getHasPlan` getter(mutationTracker 已是 dep);`ManagedMutationTracker` 加窄字段 `riskyShellOps`(GPT#4)。
- `composeGateDecision` 按 §2.3 新顺序:度量精化 `detectActionSurface`,**保留** `detectConversationalIntent` + default-fire;加常量 `ROUNDS_VERIFY_THRESHOLD=10` / `TRIVIAL_LINES=20`。
- **GPT#2:不叫零回退**——有意改 verifier 触发率。**gate snapshot 单测**覆盖 fire/skip 全迁移:0写/单文件小改/单文件大改/多文件 × round × todoStore × riskyShell × **无动作(F184 floor 必 fire)** × 问候(必 skip)。
- 不碰 Worker 提示 → 不用 eval。gate:build + 全套件。

**Phase H3 — 静态分层指引(LLM-facing,走 5-alias eval)**
- 按 §2.1 A/B/C 表:**A 类删**(冗余投递,有效版静态保留)、**C 类删**(分类表噪声)、**B 类搬静态**(H1 自检 + pr-review/strict-audit/investigation/planning + brainstorm,搬入 worker-role-prompt 静态段);删 HARNESS_PROFILE_OVERLAYS + EXECUTION_MODE_OVERLAYS + buildPromptOverlay 的 harness/mode/分类表注入。
- **🔴 必走 eval**(CLAUDE.md FEATURE_104)。**GPT#6 eval 一等指标(都要硬看)**:① 简单任务**不建 todo / 不 dispatch / 低 token**;② **Todolist 生成率**(守 H2 hasPlan 耦合不变量);③ review 只报高信号问题;④ investigation 先定位/repro;⑤ 复杂多模块任务仍**合理 dispatch**;⑥ **延迟/token 不回退**。eval RUN 需 API key=用户跑。
- ⚠️ 误删防护:实施时对照 §2.1 B 类清单,逐条确认已搬入静态,不得随 overlay 一起删。

**Phase H4 — 路由瘦身/退役**
- **GPT#8 硬前置**:repo-intel 仍看 `decision.harnessProfile !== 'H0_DIRECT'`(repo-intelligence.ts:228)→ **先设计非-harness 的 repo-context gate** 再动 harnessProfile,不能裸删。
- **GPT#7 名字债逐名裁决(已定,保守)**:
  - **删(dead cluster,零 rename,~300+ LoC)**:`routeTaskWithLLM` + `buildRepositoryRoutingSummary` + `summarizeRoutingEvidence` + `retryStructuredDecision` + `parseRoutingDecision` + `ROUTER_SYSTEM_PROMPT` + `routingSource` 的 `'model'`/`'retried-model'` 枚举值(F193 后零生产 caller)。⚠️ **B1 memory 曾标此簇"live 救回"与本轮 fresh 调研"零 caller"矛盾 → 删前必对 HEAD 重跑零-caller 核验(正则含 `import\(`),不盲删**。
  - **改名(唯一 live 改名)**:`shouldUseModelRouter` → `requiresHeuristicExpansion` 类(全在 reasoning.ts,低 churn;名字承诺 model router 但 F193 后纯启发式)。
  - **顺手清**:`inferIntentGate` 3 处 "Scout will finalize/decide" 字符串(Scout 已退役;注入点随 H3 删 overlay 消失,源串清理 H4 顺手)。
  - **保留(高 churn 或名字尚可)**:`harnessProfile`(237 引用,benchmark 有 `workerChain` 专项改名提案,不在本次)、`KodaXTaskRoutingDecision`(93 引用 breaking)、`recommendedMode`(准确)、`routingDecision`(KodaXResult 字段,描述性)、`looksLikeActionableRuntimeEvidence`(准确)、`createReasoningPlan`(加注释说明主产出是 routing decision)、`recommendedThinkingDepth`(已注释遗留桥接,随 effort 迁移废)。
- 评估 createReasoningPlan 剩余消费(provider policy needsReliableEvidence、KodaXResult.routingDecision 导出);保住有价值的最小信号(或改 LLM 自述),其余退役。
- ADR 记录最终架构。

**收尾**:ADR + 全套件 + eval 绿后合并。

---

## 4. 风险与边界
- Phase H1a/H2 非 LLM-facing,可单测兜底;H2 **有意改 verifier 触发率**(非零回退),gate snapshot 测试把关。
- Phase H1b(fanout)+ H3(静态指引)是 LLM-facing 段,eval/ targeted test 把关;eval 红则保留对应内容(不强删)。
- 🔴 **H2↔H3 耦合不变量**:H2 度量 gate 的 `hasPlan` 依赖 Todolist 生成,H3 删 overlay 不得让其退化 → H3 eval 把 Todolist 生成率列为显式一等指标(详 §2.3 末)。排序上 H2 先落地(overlay 还在,hasPlan 正常),H3 由 eval 守,二者不同时变动。
- 不可拆的安全约束(防递归 Layer 2、写隔离 Layer 3)全程不动。
- Phase 0 不变量:decision.harnessProfile 字段若仍被 repo-intel gate(repo-intelligence.ts:228 `!== 'H0_DIRECT'`)消费,需在 H4 一并处理(改成非 harness 的判断或保留最小路由)。
