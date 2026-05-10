# KodaX Eval Guidelines

> **目的**：本文档规定 KodaX 内部 LLM eval 的方法论，强制约束实验成本与可解读性。

> **背景**：FEATURE_107 (v0.7.32) 累计跑了 200+ cells、横跨 5 轮 prompt 迭代 (v1/v2/v3) + boundary suite + long-context suite + Experiment B，实际产出 3 条产品改动 + 1 条架构决定。**真正能下决策的产出占成本的 5% 以下**。本文档总结这次教训。

---

## 核心原则：每一次 LLM 请求都必须有"一次的成果"

**反模式（之前一直在做的）**：

> 给 LLM 一个 user message → 让 KodaX 从 Scout → Planner → Generator → Evaluator 自由跑多轮 → 跑完看 OK rate / hit rate。

为什么错：
1. **信号被淹没**。Prompt 微小调整的效果被 N 轮自由决策的累积噪声覆盖。Generator 第 5 步的不同决策 ≠ prompt 的效果。
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
- "H2-B inputFilter 是否真生效？" → 读 [runner.ts:778-788](../packages/core/src/runner.ts#L778-L788)，2 分钟得出"会调用 filter"。再加一个 unit test "filter 函数 strip 后 history 长度变小"。**0 LLM call**。
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
- "v3 discipline 是否减少 emit_handoff 早退？"  
  → 构造一个 generator 收到的 history：刚跑了 1 次 vitest 失败。  
  → 断言下一个响应**不是** `emit_handoff status="blocked"`。  
  → 重复 10 次，看比例。**10 LLM call ≈ $0.5**。
- "H2-A 和 H2-B 是否让 Generator 做出不同决策？"  
  → 给同一 generator 系统提示 + 两种 history (full / stripped)。  
  → 断言下一个 tool_use 的工具名是否相同。  
  → **2 alias × 2 variant × 5 重复 = 20 LLM call ≈ $1**。
- "Generator 在 200K context 下是否漏掉前文 must-touch 信息？"  
  → 构造一个含 must-touch hint 的长 history（接近 contextWindow）。  
  → 断言下一个响应是否引用 hint。**5 LLM call ≈ $1**。

**强制要求**：
- 必须能用一段 mock history 重现要测的场景
- assertion 必须机械化（regex / JSON shape / tool name），**不能**靠人读"看起来对不对"
- 报告必须给出 sample 比例（"8/10 通过"）而不是单次结论

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
```

**特别强调**：第 6 条（pre-registered 阈值）必须在跑实验前定下来。否则跑完只会陷入"再多跑 N 个看看"的无限增量。第 8、9 条是 2026-05-10 FEATURE_151 Slice I 验证教训新增 — 没有 raw dump + LLM-judge 抽查，regex 假阴假阳会让你基于错误数据做错误决策（详见反模式 7 真实案例）。

---

## 反模式清单（绝对不要做的事）

### 反模式 1：把 OK / FAIL 当主指标

OK = process exit 0 是个**极其弱的信号**：
- 模型 emit_handoff 早退 → OK，但任务没做
- 模型 timeout → FAIL，但可能做了 90% 的事
- 模型乱改 12 个不相关文件 → OK 也 hit，但显然是 attention drift

**取代方案**：每个 eval 必须定义具体的 acceptance criteria，且**机械化可验证**：
- 工具调用断言：assistant 的下一个 tool_use 的 name 是 X
- 内容断言：assistant 文本包含 / 不包含某个 phrase
- JSON shape 断言：emit_handoff 的 payload 必须含 X 字段
- 副作用断言：跑完 vitest 某个特定 test 必须 pass

### 反模式 2：让 LLM "自由跑然后我们解读"

这是上一节核心原则反复说的。一旦 LLM 跑了 5+ tool calls 自由决策，prompt 微调的效果就被淹没了。**永远不要把 prompt 比较实验设计成端到端跑**。

### 反模式 3：同 provider 并发

每个 coding plan provider（kimi / glm / mmx / mimo / ark）都有共享 quota。并发 >1 跑同一 alias 必触发 429。429 隐藏在 600s timeout 之后看起来像模型失败，污染数据。**强制 concurrency = 1 per alias**，跨 alias 自然并发。

### 反模式 4：探索期就开多 alias

探索期（不知道实验设计是否可行）= 1 alias（用便宜的，如 ds/v4flash）。验证期（信号清楚要看泛化）= 多 alias。次序不可反。

### 反模式 5：prompt 迭代用大规模实验

`prompt v1` → 跑 36 cells → "v1 不够好" → `prompt v2` → 跑 36 cells → … 每轮都是 36 个 cell 是错的。

**正确做法**：prompt 调试用 N=1 single-turn probe（成本 $0.01），收敛到候选 v3 → 再做一次 36 cell 验证。manual prompt review > 大规模 grid search。

### 反模式 6：跑完才想"什么算 signal"

如果跑完看着 17pp delta 在思考"是 signal 还是 noise"，说明决策阈值没事先定。**跑前必须 pre-register**：例如 "delta < 10pp 视为 0 差异，跨 alias 一致才算 real signal"。

### 反模式 7：用 regex 实现 "不应出现" 类否定断言

反模式 1 推荐的"内容断言：assistant 文本包含 / 不包含某个 phrase"在**不包含**方向上有结构性陷阱：

- **现象**：负面 case（如"trivial 任务上不应调用 todo_update"）的 regex 形如 `output 不出现 'todo_update'`。
- **失败模式**：verbose / chain-of-thought 模型会写 `I should NOT call todo_update` 或在 `<antThinking>` 块里分析 `trivial 任务，不需要 todo_update`。模型的实际行为正确（确实没调用），但 regex 看不懂否定语义，把字面量出现判 fail。
- **真实案例**（2026-05-10, FEATURE_151 Slice I 验证）：kimi 在 `single_lookup` / `single_grep` 4 个负面 case 里，5 次有 2-3 次 regex FAIL，干净 context 下 LLM-judge 全部 PASS。"kimi 上引入了过触发回归"是 regex 假阴性，根本不存在的 regression，差点让我们把没有 bug 的 v2 prompt 改回去。

**强制规则**：

1. **Negative-case judges 不能只用 regex**。要么改成"绝对结构断言"（例如：第一个 tool_call 的 name ≠ X — 需 harness 暴露 toolCalls），要么必须 pair LLM-judge 兜底。
2. **所有 eval run 必须落盘 raw output**（见下节 §Raw output preservation）。每跑必 dump，不 dump 等于把数据丢了。
3. **跑完后强制抽查**：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge（干净 context）独立判一次，对比 regex；如果 disagreement >10%，整个 eval 数据作废重跑。Positive case 也建议抽 1 条 regex-pass 防止假阳性。

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

## 现成的 eval 工具（KodaX 现状）

KodaX 已有 [benchmark/harness/](harness/) 但**主要支持 Layer 3.5**（端到端跑），不直接支持 Layer 2 single-turn probe。

**未来扩展方向**（不要本次做，等下次真有 Layer 2 需求再写）：
- `singleTurnProbe(systemPrompt, history, alias)` → 一次 LLM call 返回 raw response
- `assertToolCall(response, expectedName)` / `assertText(response, regex)` → 机械化 assertion
- 多 sample 自动收集成 ratio（例如 8/10 pass）

写这套 helper 之前，**强制完成 Layer 1 检查清单**。

---

## 总结：一句话方法论

> 每一次 LLM 请求都必须能用机械化 assertion 验证一个 pre-registered 假设。**raw output 必须落盘**（反模式 7 教训），跑完每个 cell 至少抽 1 条 fail 让干净-context 的 LLM-judge 独立复核 — 不复核就不能信 regex 数据。如果做不到机械 assertion，先用代码 reading 或 unit test 替代；替代不了的实验本身就是设计错的。
