# KodaX Eval Guidelines

> **目的**：本文档规定 KodaX 内部 LLM eval 的方法论，强制约束实验成本与可解读性。

> **背景**：FEATURE_107 (v0.7.32) 累计跑了 200+ cells、横跨 5 轮 prompt 迭代 (v1/v2/v3) + boundary suite + long-context suite + Experiment B，实际产出 3 条产品改动 + 1 条架构决定。**真正能下决策的产出占成本的 5% 以下**。本文档总结这次教训。

---

## 核心原则：每一次 LLM 请求都必须有"一次的成果"

**反模式（之前一直在做的）**：

> 给 LLM 一个 user message → 让 KodaX 自由跑完整 task loop（历史 V1 是 Scout → Planner → Generator → Evaluator；当前 V2 是 Worker + Sidecar Verifier）→ 跑完看 OK rate / hit rate。

为什么错：
1. **信号被淹没**。Prompt 微小调整的效果被 N 轮自由决策的累积噪声覆盖。Worker / 历史 Generator 第 5 步的不同决策 ≠ prompt 的效果。
2. **acceptance 不可度量**。OK rate（process exit 0）、hit rate（must-touch 文件命中数）都是端到端弱信号，不能区分"prompt 让模型做对" vs "模型自己做对" vs "模型瞎跑了一下凑巧过了"。
3. **token 成本高**。每个 cell 跑 5-15 min × 多轮 tool calls × 大量 file reads → 单 cell ~$0.5-2，36 cells × 6 prompt 版本就是 $100+。
4. **不可重复**。同 prompt + 同 case 跑两次结果可能差很大（agent loop 随机性 + tool 调用顺序差异），1 cell 不够，必须重复 N 次取统计 → 成本指数升高。

**正确模式**：

> 一次 LLM 请求 = 一次可断言的成果。

每次实验定义为：
- **固定的 input**（system prompt + history 的精确字节）
- **明确的 expected output 形态**（关键工具调用名 / 字符串断言 / JSON shape / 不出现某个反模式 / etc.）
- **单次 LLM call** 就能验证

**多轮场景**：每一轮是**独立设计**的 controlled test，**不是**让 LLM 自由展开后看最终态。

---

## 三层实验金字塔（按成本从低到高）

**永远先尝试上层**，上层不能回答再下沉。

### Layer 1: 代码 reading + unit test（成本 $0）

**何时用**：任何 "X 机制是否生效" / "X 函数是否被调用" / "X env hook 是否实装" 类问题。

**例**：
- "handoff inputFilter 是否真生效？" → 读 [runner.ts](../packages/agent/src/primitives/runner.ts)，确认 handoff transcript 会应用 `inputFilter`。再加一个 unit test "filter 函数 strip 后 history 长度变小"。**0 LLM call**。
- "compaction 75% 阈值是否能从 user config 覆盖？" → 读 compaction-config.ts + 写 unit test 直接断言。
- "FEATURE_107 hooks 是否会污染 production？" → grep `process.env.KODAX_*`，看默认值分支。

**强制要求**：每个 LLM eval 提案必须先列"为什么这个问题不能用 Layer 1 回答"。如果列不出来 → 不批准跑 LLM。

### Layer 2: Single-turn LLM probe（成本 $0.01-0.10/probe）

**何时用**：需要观察**单次 LLM 推理输出**的形态。

**设计模板**：
```
INPUT (固定): system prompt + canned history + user task
EXPECTED: assistant 的下一个响应必须满足 X
                 (可选: 不满足 Y / 不调用 Z 工具)
SAMPLE SIZE: 5-10 次重复（取多数）
```

**例**：
- "v3 discipline 是否减少过早 blocked 终止？"
  → 构造一个 Worker 收到的 history：刚跑了 1 次 vitest 失败。
  → 断言下一个响应**不是**直接给出 blocked 终止。
  → 重复 10 次，看比例。**10 LLM call ≈ $0.5**。
- "两种 history 是否让 Worker 做出不同决策？"
  → 给同一 Worker 系统提示 + 两种 history (full / stripped)。
  → 断言下一个 tool_use 的工具名是否相同。  
  → **2 alias × 2 variant × 5 重复 = 20 LLM call ≈ $1**。
- "Worker 在 200K context 下是否漏掉前文 must-touch 信息？"
  → 构造一个含 must-touch hint 的长 history（接近 contextWindow）。  
  → 断言下一个响应是否引用 hint。**5 LLM call ≈ $1**。

**强制要求**：
- 必须能用一段 mock history 重现要测的场景
- assertion 必须机械化（regex / JSON shape / tool name），**不能**靠人读"看起来对不对"
- 报告必须给出 sample 比例（"8/10 通过"）而不是单次结论
- **若 probe 涉及 tools**：tool descriptions 必须用 production `KodaXToolDefinition.description` 真实字节走 harness `tools` 通道，不是简化 stub（详见反模式 8）

**结果解读注意**：当 prompt 教 multi-step 行为（X→Y）时，single-turn 只断言 Y 会漏掉 healthy "X-first then Y" 表现，呈 floor saturation。判 floor saturation 时按反模式 11 准则做 evidence-driven override。

### Layer 3: Multi-turn but choreographed（成本 $1-10/case）

**何时用**：单轮无法重现的多步交互场景，且**每一步都明确控制**。

**设计模板**：
```
ROUND 1: input=A → assert output matches PATTERN_1
ROUND 2: input=output_1 + injected B → assert PATTERN_2
ROUND 3: ...
```

每一轮的 input 是上一轮的 output **加上 harness 注入的 controlled 内容**，不是让 LLM 自由跑。

**例**：
- "Compaction 触发后 generator 能否继续完成任务？"  
  → R1: 给 generator 一个 90% context 的 history，断言它做下一步 X。  
  → R2: 把 R1 的 history 跑 compaction，断言 compaction 后 generator 仍然识别得出 X 的执行状态。  
  → **2 LLM call/test × 3 case × 3 alias = 18 LLM call ≈ $5**。

**禁用模式**：
- ❌ "跑完整 KodaX agent loop 看最后结果"
- ❌ "让 generator 自己决定何时 emit_handoff"
- ❌ "跑 30 个 turn 看 OK rate"

如果一定要做端到端，标记为 Layer 3.5（smoke test），**N 控制在 3 以内**，**禁止用于 prompt 比较**。

---

## 实验前必填 checklist（写在 PR / 设计文档里）

```
[ ] 这个问题能用 Layer 1 回答吗？为什么不能？
[ ] 设计落在 Layer 2 还是 Layer 3？
[ ] 固定 input 是什么？(贴上 system prompt + history 的精确字节)
[ ] expected output 的机械化 assertion 是什么？
[ ] sample size 多少？为什么是这个数（不能是"看心情"）？
[ ] pre-registered 决策阈值：什么样的结果让我做什么决定？
[ ] 总成本 budget：估计 $X。能换什么决定？($X 不值就放弃)
[ ] raw output dump 路径？(强制条款，见 §Raw output preservation)
[ ] LLM-judge 抽样审计计划？disagree 阈值多少触发 redo？(见反模式 7)
[ ] 若 ship 决策依据包含历史 eval-driven DROP 数据：DROP-commit→HEAD 之间 substrate 是否有改动？需 re-pilot 吗？(见反模式 10)
[ ] 若是 behavioral-neutral hygiene refactor：走 2-alias pilot 即可 SHIP，不进 5-alias panel？(见反模式 9)
```

**特别强调**：第 6 条（pre-registered 阈值）必须在跑实验前定下来。否则跑完只会陷入"再多跑 N 个看看"的无限增量。第 8、9 条是 2026-05-10 FEATURE_151 Slice I 验证教训新增 — 没有 raw dump + LLM-judge 抽查，regex 假阴假阳会让你基于错误数据做错误决策（详见反模式 7 真实案例）。第 10、11 条是 2026-05-24 FEATURE_189 release-window 教训新增 —— DROP 数据 substrate-drift 失效 + behavioral-neutral refactor 5-alias panel 过度投资（详见反模式 9、10 真实案例）。

**Pre-register 阈值的唯一 override**：floor saturation 场景下 strict per-alias gate 可 evidence-driven override（见反模式 11），但**只 hygiene / behavioral-neutral refactor 可，lift / harm 类不可**。

---

## 反模式清单（绝对不要做的事）

### 反模式 1：把 OK / FAIL 当主指标

OK = process exit 0 是个**极其弱的信号**：
- 模型 emit_handoff 早退 → OK，但任务没做
- 模型 timeout → FAIL，但可能做了 90% 的事
- 模型乱改 12 个不相关文件 → OK 也 hit，但显然是 attention drift

**取代方案**：每个 eval 必须定义具体的 acceptance criteria，且**机械化可验证**：
- 工具调用断言：assistant 的下一个 tool_use 的 name 是 X
- 内容断言：assistant 文本包含 / 不包含某个 phrase（**negative-case "不包含" 方向有 regex 陷阱，详见反模式 7**）
- JSON shape 断言：emit_handoff 的 payload 必须含 X 字段
- 副作用断言：跑完 vitest 某个特定 test 必须 pass

### 反模式 2：让 LLM "自由跑然后我们解读"

这是上一节核心原则反复说的。一旦 LLM 跑了 5+ tool calls 自由决策，prompt 微调的效果就被淹没了。**永远不要把 prompt 比较实验设计成端到端跑**。

### 反模式 3：同 provider 并发

每个 coding plan provider（kimi / glm / mmx / mimo / ark）都有共享 quota。并发 >1 跑同一 alias 必触发 429。429 隐藏在 600s timeout 之后看起来像模型失败，污染数据。**强制 concurrency = 1 per alias**，跨 alias 自然并发。

### 反模式 4：探索期就开多 alias

探索期（不知道实验设计是否可行）= 1 alias（用便宜的，如 `ark/v4flash`）。验证期（信号清楚要看泛化）= 多 alias。次序不可反。

**例外**：behavioral-neutral hygiene refactor 走 2-alias pilot（见反模式 9），不进 5-alias panel。

### 反模式 5：prompt 迭代用大规模实验

`prompt v1` → 跑 36 cells → "v1 不够好" → `prompt v2` → 跑 36 cells → … 每轮都是 36 个 cell 是错的。

**正确做法**：prompt 调试用 N=1 single-turn probe（成本 $0.01），收敛到候选 v3 → 再做一次 36 cell 验证。manual prompt review > 大规模 grid search。

### 反模式 6：跑完才想"什么算 signal"

如果跑完看着 17pp delta 在思考"是 signal 还是 noise"，说明决策阈值没事先定。**跑前必须 pre-register**：例如 "delta < 10pp 视为 0 差异，跨 alias 一致才算 real signal"。

**唯一允许的 override**：pre-registered strict per-alias gate 在 floor saturation 场景下可 evidence-driven override（详见反模式 11 三项准则 + override rationale 必须显式落 commit / memory）。**只 hygiene refactor / behavioral-neutral refactor 可 override，lift / harm 类 metric 不可** —— 否则等于跑完才挑阈值。

### 反模式 7：用 regex 实现 "不应出现" 类否定断言

反模式 1 推荐的"内容断言：assistant 文本包含 / 不包含某个 phrase"在**不包含**方向上有结构性陷阱：

- **现象**：负面 case（如"trivial 任务上不应调用 todo_update"）的 regex 形如 `output 不出现 'todo_update'`。
- **失败模式**：verbose / chain-of-thought 模型会写 `I should NOT call todo_update` 或在 `<antThinking>` 块里分析 `trivial 任务，不需要 todo_update`。模型的实际行为正确（确实没调用），但 regex 看不懂否定语义，把字面量出现判 fail。
- **真实案例**（2026-05-10, FEATURE_151 Slice I 验证）：kimi 在 `single_lookup` / `single_grep` 4 个负面 case 里，5 次有 2-3 次 regex FAIL，干净 context 下 LLM-judge 全部 PASS。"kimi 上引入了过触发回归"是 regex 假阴性，根本不存在的 regression，差点让我们把没有 bug 的 v2 prompt 改回去。

**强制规则**：

1. **Negative-case judges 不能只用 regex**。要么改成"绝对结构断言"（例如：第一个 tool_call 的 name ≠ X — 需 harness 暴露 toolCalls），要么必须 pair LLM-judge 兜底。
2. **所有 eval run 必须落盘 raw output**（见下节 §Raw output preservation）。每跑必 dump，不 dump 等于把数据丢了。
3. **跑完后强制抽查**：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge（干净 context）独立判一次，对比 regex；如果 disagreement >10%，整个 eval 数据作废重跑。Positive case 也建议抽 1 条 regex-pass 防止假阳性。
4. **Positive-case 工具调用判定不能用 `tool_name\s*\(` 单一 syntax**。生产 panel 里 zhipu/glm51 等模型实测会用 `<tool_name>(args)` / `<tool_name>...</tool_name>` / `<tool_call>{"name":"tool_name", ...}</tool_call>` 等多种 syntax；要求 `name` 后紧跟 `(` 的 regex 会把 syntax 漂移误判成 FN。规则：tool-name detection 至少覆盖 4 种 syntax —— `tool_name(`、`"name":"tool_name"`、`<tool_name>`、`name=tool_name`/`name: tool_name`。参考实现见 `benchmark/datasets/feature-120-child-steering/cases.ts` `buildToolNamePatterns`。
5. **真实案例 2026-05-12 (FEATURE_120 Phase 5b)**：第一版 `task_stop\s*\(` regex 让 zhipu/glm51 在 task_stop 触发 case 上误判 0/5；rejudge 后实际 5/5（regex 全部 false negative，zhipu 输出形式如 `<task_stop>(...)`、`<tool_call[]>{"name":"task_stop"...}</tool_call[]>`、XML 嵌套 + YAML 内嵌等）。整体 50 个 run disagreement 14%，超 §3 的 10% 阈值。是 FEATURE_151 Slice I 反模式 7 教训之后的第二次同类事故。

### 反模式 8：Synthetic eval 用简化版 tool descriptions（2026-05-24 补充）

很多 prompt-eval driver 在 system prompt 里只放 brief stub TOOL_DOCS（10-20 行）描述工具签名，而不是 production 实际下发给 LLM 的完整 description（每个 tool 1-10 KB）。

**问题**：
- Eval 测出的"prompt 改动效果"实际是 brief stub 环境的效果，不能 transfer 到 production
- 工具 description 本身就是 LLM-facing prompt，重组 / 加长 / 改 layered structure 会影响模型决策
- FEATURE_189 batch4 + todo desc refactor 2026-05-24 真实案例：原 batch2 eval driver 用 ~120 char brief desc，跑出来 zhipu/glm51 dispatch_intent rate 实际是"模型在 brief context 下的默认行为"，不是 production 的真实行为

**强制规则**：
1. 测试 worker-role-prompt 章节改动时，eval driver 必须包含 production 实际 `KodaXToolDefinition.description` 字节（不是简化版）。harness 的 `tools: readonly KodaXToolDefinition[]` 参数把它们走 LLM API tools 通道下发，与 production 一致
2. 测试 tool description 本身改动时，**v_baseline 用 pre-change description bytes**、**v_proposed 用 post-change description bytes**，二者必须 byte-aligned，schema (`input_schema`) 不变只动 description
3. 测试 prompt 章节 X 改动时，driver 必须包含**所有与 X 交互的章节 Y/Z**（PLAN-FIRST 改动测试要带 SCOPE COMMITMENT + PLAN-LIST HYGIENE + DISPATCH，不能只 mock PLAN-FIRST）

**参考实现**：`tests/feature-189-todo-desc-refactor-pilot.eval.ts`（4 个 todo_* desc 通过 tools param 下发 baseline vs proposed）。

### 反模式 9：Behavioral-neutral hygiene refactor 直接跑 5-alias panel（2026-05-24 补充）

Content-equivalent refactor（语义保留 byte 重排：例如 monolithic prose → layered "When to Use / When NOT to Use" sections / 同样信息换叙述形式）的 expected behavior 是**行为中性**（no regression no lift），不需要花 ~$4-6 跑 5-alias panel。

**正确成本曲线**：
1. **Layer 1**（$0）：先做内容等价性 diff —— 是否 strictly preserves semantic content？如果是，behavioral neutrality is expected by construction
2. **Layer 2 pilot 2-alias × 2 case × 3 runs**（~$1）：
   - 至少 1 case 在两个 variant 都达到 saturation（floor 或 ceiling）→ 该 dimension 无信号 → behaviorally identical
   - 至少 1 case 在两个 variant 都达 perfect parity（100/100% / 0/0%）→ regression 路径已封死
3. **如果以上两条满足 → SHIP，不跑 panel**
4. **如果 pilot 出现 cross-variant divergence**（即使 1-2 cell）→ 进 5-alias panel + 3-judge audit

**为什么这样**：
- Behavioral-neutral refactor 的 null hypothesis 是 "v_baseline == v_proposed"
- Pilot 已经 12-24 cells 全 same → null 没被拒
- Panel 多花 $4 也只能再次证明 null（每 cell 都 same）
- Panel 的实际价值在 "lift / harm" detection，对 behavioral-neutral 价值很低

**真实案例 2026-05-24**：F189 todo_* description claudecode-style layered refactor。Pilot 2 alias (ark/v4flash + zhipu/glm51) × 2 case × 3 runs = 24 cells：
- C1 multi-step plan-first：4/4 cells (both alias × both variant) 0/3 PASS — saturation floor（model 选择 recon-then-plan，single-turn cutoff）
- C2 trivial exemption：4/4 cells 3/3 PASS — perfect parity（"When NOT to Use" 没造成 false negative）
- SHIP gate met 不跑 panel，省 ~$4-6 + 2 小时

### 反模式 10：Eval-driven DROP 不 re-check substrate 变化就 stale（2026-05-24 补充）

某个 prompt 改动 P 被 eval-driven DROP 后，后续 prompt 体（worker-role-prompt / tool descriptions / other sections）继续演进。**P 的 DROP rationale 只在 DROP-commit-time 的 substrate state 下成立**。如果 substrate 后续 ship 了 N 个 prompt 改动，P 的 DROP 数据**失效**。

**真实案例 2026-05-22 → 2026-05-24**：
- F189 B.4 (RULE A/B/C labels removal) 于 2026-05-22 eval-driven DROP（ark/v4flash 5/5 textLen < 220 systematic regression）
- F189 B.5 (FEATURE_xxx version markers removal) 同日 DROP
- 2026-05-22 → 2026-05-24 期间又 ship 了：F189 Batch 1 (✗ + WHY) + Batch 4 (quant→qual) + F190 (TERMINATION 改写) + F191 (SPECIALIST ROUTING + custom agents)。worker-role-prompt 已重组
- Re-check 验证两个 DROP 在新 substrate 下仍然成立（ark/v4flash 仍 hit per-alias gate），DROP holds —— 但**如果不 re-check 就引用旧数据**，可能漏掉新 substrate 已经"修复"DROP 原因的情况

**强制规则**：
1. 引用历史 eval-driven DROP 作 ship 决策依据前，先 grep DROP-commit 到当前 HEAD 之间是否有 substrate 改动（同一文件、同一段落、interacting section）
2. 有改动 → re-pilot 1 alias × 同 cases × 同 variants 验证 DROP 仍成立。Pilot 不成立则 escalate panel
3. DROP 数据 archival 时在 commit message / project memory 标注"基于 substrate state @ <commit-sha>"，方便后续判断
4. v0.7.X 版本 release 时，本版内 eval-driven DROP 的引用窗口截止到下一个 minor release —— 跨版本必须 re-check

### 反模式 11：Floor saturation × strict per-alias gate 误判 refactor harm（2026-05-24 补充）

Pre-registered strict gate (per `feedback_pre_registered_gate_saturation`) 用"任一 alias × case 退化 ≥1 cell = SHIP fail"类型时，floor-saturation 数据可被误判为 regression。

**Floor saturation 的辨识标准**：
- v_baseline 在该 cell 已达 metric 自然 floor / ceiling（plan-first metric baseline 0/5 / 5/5；trivial exemption baseline 5/5）
- v_proposed 与 v_baseline 在该 cell 同号同幅（baseline 0/5 → proposed 0/5；baseline 5/5 → proposed 5/5）
- 同一 alias × 同一 case 在 cross-alias pilot 复现（i.e. 至少 2 alias 都 floor saturate）

**Evidence-driven override 准则**：
1. 满足以上 3 条 + refactor 是 content-equivalent → SHIP gate per-alias strict failure 可被 override
2. Override rationale 必须在 commit message / project memory 显式记录：包括 "saturation reason" + "cross-alias 复现证据" + "metric 局限性"（例如 single-turn 测不到 multi-turn recon-then-plan）
3. Override 不能滥用：行为 lift / harm 类 metric 不可 override，只 hygiene refactor / behavioral-neutral refactor 可

**真实案例 2026-05-24**：F189 todo desc refactor C1 multi_step ark/v4flash + zhipu/glm51 双 alias 4/4 cells 0/3 PASS。Per `feedback_eval_strict_criterion_under_counts_taught_behavior`：model 实际行为是 "I'll start by reading the existing files... then commit the plan"（healthy multi-turn recon-then-plan），single-turn metric 漏掉。Override 准则 1+2+3 全满足 → SHIP without panel。

### Judge 模型选择约束（2026-05-12 补充）

**禁止用 anthropic claude / openai gpt 等"外来 strong model"做内部 eval 的 LLM-judge**：

- KodaX 的生产 panel 主体是中国 coding plan 模型（zhipu, kimi, deepseek, minimax, mimo, ark, qwen），eval 决策的实际生产分布对齐它们；用 claude-sonnet/opus 当 judge 会把外来 model 的 "强语义理解 + 严格 instruction following" 偏置带进判定，掩盖 panel-internal 同质化失败模式。
- 实操是 anthropic 当 judge 会 **过于宽容**（看懂 zhipu 的怪 syntax 也判 PASS），反而和 enhanced regex 出现不必要的 disagreement；或者 **过于严格**（要求 syntax 标准）让 enhanced regex 看起来 over-permissive。两种偏置都让 ship 决策失真。

**允许的 judge 来源**（按优先级）：

1. **Self-judge by the orchestrating Claude session**（主线程的 Claude 模型读 raw dump 直接判定）。零额外 API 调用、可解释、独立于 panel。**前提**：判定文本 + 理由必须落盘 audit JSON，不能只是 in-conversation 结论。适合 ≤50 cells / 一次性 sanity check。
2. **Panel-internal multi-judge majority vote** —— 用 KodaX 生产 panel 的 3 家（推荐：`zhipu/glm51` + `ark/v4pro` + `kimi`，覆盖 3 个独立 family，全 coding-plan）独立判定，2/3 majority 算 PASS。适合 ship-gate 复核 / 跨版本可重复。
3. 自定义同源模型（按 case 设计），但**永远不要用 anthropic/openai**。

**反模式**：
- ❌ "用 claude-sonnet 当 judge 因为它最强" —— 强不等于对齐 panel 分布。
- ❌ 单一 judge model —— 单一 judge 自身可能有同类 bias（例如 zhipu 当 judge 时对其它 zhipu-family 输出过松）。majority vote 是必要的去 bias 步骤。
- ❌ Judge 跑完不落盘 —— 和反模式 7 §2 一样，judge 输出本身也是 source of truth，必须 dump。

---

## Raw output preservation（强制条款）

每次 eval run 必须把 `runsRaw[].text` + `toolCalls` + 每个 judge 的 pass/reason 落到磁盘 JSON。

**理由**（同反模式 7）：
- regex / 机械判子可能假阴假阳，**唯一的 ground truth 是模型的原始文本输出**。
- 只有原始输出落盘，事后 LLM-judge 才能跑（不然每次跑 + judge = 重跑成本）。
- pass-rate aggregate 是 derived，dump 是 source of truth — 没 dump 等于扔了源数据，留下的是 lossy summary。

**落盘路径约定**：`os.tmpdir() / kodax-eval-dumps / <feature-id> / <case>.json`（即 Linux/macOS `/tmp/kodax-eval-dumps/...`，Windows `%LOCALAPPDATA%/Temp/kodax-eval-dumps/...`）。**必须用 OS tmpdir，不能放 repo 工作树内**（哪怕 gitignore 兜底也不行 — dump 是 transient runtime 产物，由 OS 回收，结构上和源代码必须分离）。

Schema：

```json
{
  "case": "<case_id>",
  "stage": "<phase / variant>",
  "userMessage": "<exact user message>",
  "aliases": [
    {
      "alias": "<provider/model>",
      "passRate": "<regex pass-rate>",
      "runs": [
        {
          "runIndex": 0,
          "text": "<raw model output>",
          "toolCalls": ["<harness-captured tool calls>"],
          "durationMs": 1234,
          "regexPassed": true,
          "regexJudges": [{ "name": "...", "passed": true, "reason": "..." }]
        }
      ]
    }
  ]
}
```

**参考实现**：`tests/feature-151-fan-out-plan-granularity.eval.ts` 在 driver 末尾用 `os.tmpdir()` + `node:fs.writeFileSync` 落盘，并 `console.log` 绝对路径供 operator 追溯。

---

## 实验成本预算（强制条款）

每个 eval 提案必须包含以下成本估算：

```
Layer 1 (unit test): $0 — 永远先做
Layer 2 (single-turn probe): $X (probe 数 × $0.01-0.10/probe)
Layer 3 (multi-turn choreographed): $Y (cell 数 × $0.5-2/cell)
Total: $Z

能产出的决策：
- (a) ____ (worth $A?)
- (b) ____ (worth $B?)

如果 Z > A+B：放弃 / 缩减实验。
```

**判断标杆**：
- ✅ $5 实验换一条 production prompt 改动：值
- ✅ $50 实验换一个 v0.7.16 设计决定（实装 vs 不实装）：值
- ❌ $50 实验微调一个 prompt 字段："retry blindly" → "blindly retry"：不值
- ❌ $20 实验确认一个能用 unit test 5 分钟回答的问题：不值

---

## Canonical alias panel（2026-05-19 锁定 / 2026-05-21 升级为 coding-plan-only）

新 prompt-eval 的 Layer 2 / Layer 3 跑面默认就这 **5 个 coding-plan alias**：

| Alias short id | Provider · model | Family | 档位 |
|---|---|---|---|
| `zhipu/glm51` | zhipu-coding · glm-5.1 | Zhipu | high-end |
| `kimi`        | kimi-code · kimi-for-coding | Moonshot | high-end |
| `mmx/m27`     | minimax-coding · MiniMax-M2.7 | MiniMax | high-end |
| `ark/v4pro`   | ark-coding · deepseek-v4-pro | DeepSeek (via Ark) | high-end |
| `ark/v4flash` | ark-coding · deepseek-v4-flash | DeepSeek (via Ark) | floor |

**为什么是这 5 个**：
- 覆盖 4 个独立 provider family（Zhipu / Moonshot / MiniMax / DeepSeek），跨家族盲区互补
- DeepSeek 双档（flash floor + pro high-end）能在同 family 内捕到"模型档位是否吃 prompt 改动"
- **2026-05-21 升级**：DeepSeek 双档从官方 API `ds/v4{pro,flash}` 切到 `ark-coding` 路线 `ark/v4{pro,flash}`。理由：用户验证 ark-coding gateway routes DeepSeek-V4 正常，**走 coding-plan 订阅成本可控**，不再混入 token-bill 路径。`zhipu-coding/glm-5.1` 留在 panel；`ark-coding/glm-5.1`（`ark/glm51`）退出 default panel — 同 zhipu family 重复采样收益低于跨 family
- 排除 `mimo/v25(pro)` / `ark/glm51` / `ds/v4{pro,flash}` —— 不是禁止用，是不在 default panel；有跨 panel 验证或与历史 `ds/*` 数据对照时再显式 opt-in

**Pilot 阶段（探索 trigger 是否成立）**：仍按 anti-pattern 4 用 1 alias × 1 case × 1 run，**alias 选 `ark/v4flash`**（最便宜 floor model on coding-plan provider）。Pilot 触发后 Layer 2 才放量到 5 alias。

**所有 canonical alias 必须 coding-plan provider** —— 新增 alias 时先 verify provider 类型。Never add 一次性 token-bill alias 到 default panel，否则后续 eval 成本预算会失真。

**例外**：
- 某 feature 只影响特定 provider（例如 zhipu-only quirk）时 panel 收窄到 `zhipu/glm51` 单 alias，需在 eval docstring 显式说明
- 需要跨 panel 泛化验证（ship 决策已下、做 sanity check）时 panel 扩到 7-8 alias 含 mimo 全档位 + `ark/glm51`（cross-gateway 同模型对照）+ 历史 `ds/v4*` 数据保留时纳入对比。**注**：`ark/v4*`（coding-plan, default panel）与 `ds/v4*`（deepseek 官方 API, 已退出 default panel）跑同样 deepseek-v4 模型但走不同 gateway，扩展验证时**不**默认同时纳入两条路 — 选择性 opt-in 避免成本翻倍。
- **behavioral-neutral hygiene refactor**（content-equivalent byte 重排）走 2-alias × 2 case × 3 runs pilot 即可 SHIP，**不进 5-alias panel**（详见反模式 9）。pilot 必须满足：≥1 case 双 variant 同时 floor / ceiling saturation + ≥1 case 双 variant perfect parity。

**Alias 失败兜底**：当 ark hard rate-limit 整个 panel 时不重试，用 `aliasFallback: { 'ark/v4pro': 'ds/v4pro', 'ark/v4flash': 'ds/v4flash' }` 自动降级 deepseek 官方 API（per `feedback_harness_alias_fallback`）。Cell.alias 保留 primary 不变（panel structure consistency），`fallbackUsed` 字段记录降级。Canonical panel 不放 `ds/v4*`，只做 fallback。

---

## 现成的 eval 工具（KodaX 现状）

KodaX [benchmark/harness/](harness/) 已直接支持 Layer 2 single-turn probe + Layer 3 multi-turn choreographed，关键能力：

- `OneShotInput.tools: readonly KodaXToolDefinition[]` —— 把 production tool 定义走 LLM API tools 通道下发，**测 prompt 教学时强制用 production 真实 description bytes 不用 stub**（per 反模式 8）
- `BenchmarkRunInput.aliasFallback: Partial<Record<ModelAlias, ModelAlias>>` —— 整 alias rate-limit 时自动降级到等价 fallback，不污染 primary alias 数据（per `feedback_harness_alias_fallback`）
- Raw dump 落 `os.tmpdir() / kodax-eval-dumps / <feature-id> / <case>.json`（per §Raw output preservation；**不入 repo 工作树**）

**跑 Layer 2 probe 前强制完成 Layer 1 检查清单 + checklist 中 substrate-recheck（反模式 10） + behavioral-neutral 判断（反模式 9）**。

---

## 总结：方法论核心

> 每一次 LLM 请求都必须能用机械化 assertion 验证一个 pre-registered 假设。**raw output 必须落盘**（反模式 7），跑完每个 cell 至少抽 1 条 fail 让干净-context 的 LLM-judge 独立复核 — 不复核就不能信 regex 数据。如果做不到机械 assertion，先用代码 reading 或 unit test 替代；替代不了的实验本身就是设计错的。
>
> **配套约束**：production tool 真实字节（反模式 8）、behavioral-neutral 走 2-alias pilot 不进 panel（反模式 9）、引用历史 DROP 数据前 re-check substrate（反模式 10）、floor saturation 可 evidence-driven override 但必须落 rationale（反模式 11）。
