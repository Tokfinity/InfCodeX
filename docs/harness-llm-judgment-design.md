# 设计稿:路由/harness 预判 → 静态分层指引 + LLM 自主判断 + Verifier 信号激活

> 状态:**设计中,待用户确认后再动手**。这是 reasoning 单轨化(已完成,B1-D)之后的**新的、更大的架构改造**,与 effort 单轨化正交。
> 目标:把"启发式关键词路由 → 按预判 harness 级别注入不同提示 + 门控"改成"静态分层指引(对所有任务注入)+ 工具常驻 + LLM 自主判断",Sidecar Verifier 改由 Worker LLM 发出的判别信号控制激活。

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
                                                              简单直答/复杂先计划/可派子Agent/
                                                              需要时发"请验证/跳过验证"信号)
                                                        ↓ 终止 + 携带判别信号
                                            Layer0:读 Worker 信号 → 决定 → (回落 FEATURE_196 内容 gate) → Verifier
```

三块改动:

### 2.1 静态分层指引(替代 HARNESS_PROFILE_OVERLAYS + EXECUTION_MODE_OVERLAYS)
- 落点:`worker-role-prompt.ts buildWorkerInstructions`(现有静态指引密度最高、每次必经的纯 builder)。
- 内容:把"按级别"的指引改写成"按情况自判"的原则,一次性对所有任务注入:
  - 简单/查询 → 直接答/直接做,不建 todo(已有)。
  - 复杂/多步 → 先 todo_create 提交计划再动手(已有)。
  - 执行后 → 对照请求自检(补 H1 这条)。
  - review/audit/调查 → 把 7 种 execution-mode 的定向指引改成静态"当你在做 X 类工作时…"段落。
  - 歧义 → 先框选项再动(brainstorm 原则)。
- HARNESS_PROFILE_OVERLAYS 冗余段删除;EXECUTION_MODE_OVERLAYS 非冗余内容搬入静态。

### 2.2 fanout 常驻 + LLM 自判
- 拆 Layer 1(buildAmaControllerDecision 的 admissible 建议文本 + fanout-scheduler admissible 门;dispatch 对 Worker 本就常驻可见)。
- 保留 Layer 2/3 安全约束(不依赖路由,不动)。
- dispatch_child_task 的工具 description 补足 when-to-use(参考 Claude Code AgentTool),让 Worker 自判何时派。

### 2.3 Sidecar Verifier:LLM 判别信号激活(本设计核心,KodaX 原创)
保留 Verifier(原创结构性净网),但**不在过简任务上激活**。改为 Worker LLM 在终止时给出一个判别信号,作为 gate 的 **Layer 0**(优先于 FEATURE_196 内容检测)。

**接入点(调研已验,3 处改动,Verifier 侧零改动)**:
1. worker-role-prompt:教 Worker 何时发信号。
2. tool-resolution:把信号工具加入 Worker 工具集。
3. runner-sidecar-verifier-adapter `composedStopHook`(或 gate.ts):读 `ctx.transcript` 最后一条 assistant 的 tool_use,作为 Layer 0。

**✅ 已定(用户拍板):方案 C — 三态信号**

Worker 终止时发 `verification_hint('skip' | 'verify' | 'auto')`(工具调用或终止 metadata 字段):
- `'skip'` → Worker 明确判定简单/低风险 → gate Layer 0 直接 skip Verifier。
- `'verify'` → Worker 明确判定重要/有风险 → gate Layer 0 直接 fire Verifier。
- `'auto'` → Worker 不确定 → **回落现有 FEATURE_196 内容 gate**(有动作就验、纯问候跳过)。
- **未发信号(Worker 没调)→ 等同 `'auto'`**(回落内容 gate,默认安全)。

设计理由:给 Worker 表达"我不确定,交给内容 gate 判"的能力;安全默认仍在(auto/忘发都回落到现有的"有动作就验");明确简单时才 skip 省 token。gate 判定顺序变为:env escape → **Layer 0: Worker verification_hint(skip/verify 直接决定;auto/缺省回落)** → Layer 1 内容(有 tool_use 则 fire)→ Layer 2 问候 skip → 默认 fire。

被否决:A(opt-out,默认验不给 Worker 'verify' 主动权)、B(opt-in,默认跳,忘发漏验风险高)。

---

## 3. 分阶段计划(非 prompt 先行、prompt 后行走 eval)

**Phase H1 — 非 LLM-facing 运行时清理(可单测,零回退,先做)**
- 删 Layer 1 fanout 建议门(buildAmaControllerDecision admissible 文本 + fanout-scheduler admissible 检查);保留 Layer 2/3。
- 删 qualityAssuranceMode 死字段(纯 UI,可保留显示或一并清)。
- 删 deriveTopologyCeiling + topologyCeiling/upgradeCeiling 字段(A2b 非 prompt 部分)+ verdict-recorder 死 gate。
- gate:build + 全套件。

**Phase H2 — Verifier 信号激活(非 prompt 逻辑 + prompt 教学)**
- 加信号工具 + gate Layer 0(按定稿的 A/B/C)。
- worker-role-prompt 教学段(LLM-facing → 进入 eval 范围)。
- 单测:gate Layer 0 各分支 + 信号解析。

**Phase H3 — 静态分层指引(LLM-facing,走 5-alias eval)**
- 把 EXECUTION_MODE_OVERLAYS 非冗余内容 + H1 自检搬入 worker-role-prompt 静态段;删 HARNESS_PROFILE_OVERLAYS + EXECUTION_MODE_OVERLAYS + buildPromptOverlay 的 harness/mode 注入。
- **🔴 必走 eval**(CLAUDE.md FEATURE_104):5-alias panel 对照"路由注入分层提示 vs 静态分层指引",确认 Worker 在 简单/复杂/review/调查 各类任务上行为不退化(尤其复杂任务还会不会先计划、review 还会不会聚焦高信号)。eval RUN 需 API key=用户跑。

**Phase H4 — 路由瘦身/退役**
- 评估 createReasoningPlan 剩余消费(provider policy needsReliableEvidence、KodaXResult.routingDecision 导出);把还有价值的最小信号保住(或改 LLM 自述),其余路由逻辑退役。
- ADR 记录最终架构。

**收尾**:ADR + 全套件 + eval 绿后合并。

---

## 4. 风险与边界
- Phase H1/H2 非 prompt,可单测兜底,零回退优先。
- Phase H3 是唯一 LLM-facing 高风险段,eval gate 把关;eval 红则保留对应静态指引(不强删)。
- 不可拆的安全约束(防递归 Layer 2、写隔离 Layer 3)全程不动。
- Phase 0 不变量:decision.harnessProfile 字段若仍被 repo-intel gate(repo-intelligence.ts:228 `!== 'H0_DIRECT'`)消费,需在 H4 一并处理(改成非 harness 的判断或保留最小路由)。
