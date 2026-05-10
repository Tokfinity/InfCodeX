# FEATURE_114 v0.7.36 — AMA Harness V2 (Worker + Evaluator) 人测指引

> **v0.7.38 Slice 7 更新**：V2 已成为默认路径。`KODAX_HARNESS_V2` 环境变量
> 现在是 **opt-out** 语义——不设、设为空、设为 `'true'` / `'1'` / `'yes'` 都
> 走 V2；只有显式设为 `'false'`（case-insensitive）才退回 V1。决策依据见
> [docs/features/v0.7.36.md](../features/v0.7.36.md) §"迁移策略" 中 v0.7.38
> 段，eval 数据见 commit `2acbf9d0` 与 `tests/feature-114-v1-baseline-comparison.eval.ts`。
>
> **目的**：验证 (1) 默认入口 agent 是 Worker（不再是 Scout）；(2) Worker
> plan-first 契约（≥2 步任务 todo_update 必须先于 mutation）；(3) Evaluator 仍
> 是结构性 gate（Worker → emit_handoff → Evaluator → accept/revise/blocked）；
> (4) revise 路径回 Worker（不是 Generator）；(5) Worker 可以 mid-task
> replan（insert / cancel / adjust）；(6) `evaluator: 'build' \| 'test' \|
> 'lint'` hint 在 `pending → completed` 时触发对应 npm 命令并把 stderr 反馈给
> Worker；(7) cancelled 状态在 UI 显示删除线；(8) `KODAX_HARNESS_V2=false`
> 退出时 V1 路径完全不变（Scout/Planner/Generator/Evaluator）。
>
> **设计文档**：[docs/features/v0.7.36.md](../features/v0.7.36.md) §FEATURE_114
>
> **前置**：
> - 任意可用 provider API key（推荐 ds/v4pro 或 zhipu/glm51——eval 实测在
>   "edit + build verify" 多步任务上 plan-list 可见性最稳定 80% / 40%；
>   weak-model 路径如 kimi 在该任务上 V1 V2 都是 0% 模型上限，不影响 V2
>   ship 决定）
> - KodaX v0.7.38 已构建（`npm run build`）
> - 本指引在 Ink TUI 下做（`./bin/kodax.mjs` 默认入口）
> - **不再需要主动设置 `KODAX_HARNESS_V2=true`**——v0.7.38+ 默认就走 V2。
>   只有想测 V1 baseline 时才需要 `KODAX_HARNESS_V2=false`（见 Test 6）。

---

## Test 1 — V2 入口 agent 切到 Worker（Slice 3b）

### 步骤

1. 启 KodaX（v0.7.38+ 默认即 V2，无需设置 env；如要强制也可显式 `KODAX_HARNESS_V2=true`）。
2. 发一个 trivial 任务（单步、不需要计划）：
   ```
   1+1=
   ```
3. 观察响应 + transcript。

### 期望结果

- LLM 直接答 `2`，**不**调 `todo_update`（trivial 任务无计划）。
- 计划列表 surface 不出现（store 空时 `shouldRender:false`）。
- 一轮 turn 结束 → Worker 调 `emit_handoff` → Evaluator → `accept` → 终止。

### 失败排查

| 现象 | 诊断 |
|------|------|
| Worker 调了 `todo_update` | LLM 误判 trivial → 多余开销但不算 bug；可在 prompt 里强调 "single-question lookup → answer directly" |
| Evaluator 没跑（Worker 直接返回最终文本）| V2 必经 Evaluator——检查 `wrapEmitterWithRecorder` 是否漏了 verdict-slot 处理 |
| 仍走 Scout（看到 `[Scout]` 字样）| 检查启动 shell 里有没有遗留的 `KODAX_HARNESS_V2=false` opt-out（unset 后再启动）；v0.7.38+ 默认 V2，只有显式 `'false'`（case-insensitive）才走 V1 |

---

## Test 2 — Plan-first 契约（≥2 步任务 todo_update 先行）

### 步骤

1. 启 KodaX（v0.7.38+ 默认即 V2，无需设置 env；如要强制也可显式 `KODAX_HARNESS_V2=true`）。
2. 发一个明显 ≥ 2 步的任务：
   ```
   写一个 hello.ts 打印 hello world，然后写一个 README.md 解释怎么跑
   ```
3. 观察 Worker 第一个 tool call 是否是 `todo_update`（`op:'init'`）。

### 期望结果

- Worker **第一个**非 trivial tool call 是 `todo_update({op:'init', items:[…]})`。
- 列表至少 2 项（write hello.ts、write README.md）。
- 列表出现在 spinner 下方（`⎿` 连接器 + 行）。
- Worker 然后按列表逐项 execute：每步开始时 `todo_update({id, status:'in_progress', activeForm:'…'})`，完成时 `status:'completed'`。
- 最后 `emit_handoff` → Evaluator → `accept`。

### 失败排查

| 现象 | 诊断 |
|------|------|
| Worker 直接 `write` 没先 `todo_update` | Worker prompt 的 PLAN-FIRST CONTRACT 没生效；检查 `worker-role-prompt.ts:48-56` 是否还在 system prompt 里 |
| `todo_update` 调了但 surface 没显示 | TodoListSurface 可能因 `MIN_ITEMS_TO_RENDER` 或 `shouldRender:false` 隐藏；用 ≥ 2 项任务避开 single-item 路径 |
| `activeForm` 字段没传 | Worker prompt 没要求；这是 FEATURE_149 的 spinner verb 来源，缺了不会崩但 spinner 显示退化为静态文本 |

---

## Test 3 — Evaluator 结构性 gate（revise 路径回 Worker）

### 步骤

1. 启 KodaX（v0.7.38+ 默认即 V2，无需设置 env；如要强制也可显式 `KODAX_HARNESS_V2=true`）。
2. 发一个故意有 bug 的任务：
   ```
   写一个 src/calc.ts 实现加法，注意把 + 写成 -（故意制造 bug 让 Evaluator 抓）
   ```
3. 观察 Evaluator turn 是否标记 `revise` + Worker 是否再来一轮。

### 期望结果

- Worker 写出有 bug 的 `calc.ts`。
- Evaluator 读文件 → 发现 `+` 写成 `-` → emit_verdict status='revise'。
- runner 把 handoffTarget rewrite 为 `kodax/role/worker`（Slice 3b 的 verdict-slot 后处理）。
- Worker 再次 invoke：todo plan 上的失败项闪一下 `✗` 然后 reset 回 `☐`（pending）。
- Worker 修复 bug → 重新 emit_handoff → Evaluator accept → 终止。

### 失败排查

| 现象 | 诊断 |
|------|------|
| revise 后没回 Worker（流程卡死）| 检查 `chain.evaluator.handoffs` 在 `KODAX_HARNESS_V2=true` 下是否含 worker target；运行 `npx vitest run packages/coding/src/task-engine/runner-driven.test.ts -t "Slice 3b"` 验证 |
| revise 后回到 Generator | verdict-slot post-pass rewrite 没生效；grep `WORKER_AGENT_NAME` 在 `runner-driven.ts` 是否在 verdict 块尾部 |
| 失败项没闪 `✗` 就直接 reset | `pendingFailedResetRef` 消费时机；Worker `instructions` closure 应该先 build prompt（contextFactory 看到 armed ref）再 reset |

---

## Test 4 — Mid-task replan（cancelled 显示删除线）

### 步骤

1. 启 KodaX（v0.7.38+ 默认即 V2，无需设置 env；如要强制也可显式 `KODAX_HARNESS_V2=true`）。
2. 发：
   ```
   计划三步：A、B、C；做完 A 后告诉我应该 cancel B 直接做 C
   ```
3. 观察 Worker 是否在做 A 之后调 `todo_update({id:'todo_2', status:'cancelled'})`。

### 期望结果

- 列表初始化为 3 项（A pending、B pending、C pending）。
- Worker 完成 A：`✓ A`。
- Worker 决定取消 B：`☒ B`（删除线 + dim text）。
- Worker 做 C：`● C` → `✓ C`。
- 最终 plan 全终止（completed + cancelled 都算 terminal），surface 仍可见。

### 期望 UI 显示

```
⎿  ✓ A
   ☒ B    ← 删除线，dim
   ✓ C
```

### 失败排查

| 现象 | 诊断 |
|------|------|
| `B` 没删除线，只是 `☒` 符号 | `TodoListRow` 的 `<Text strikethrough={row.isStrikethrough}>` 没生效；查 `view-models/todo-plan.ts::buildItemRow` 是否在 `cancelled` 时设 `isStrikethrough:true` |
| `B` 状态变了但符号还是 `☐` | `symbolForStatus` 缺 cancelled case；查 todo-plan.ts SYMBOL_CANCELLED |
| Worker cancel 后 surface 隐藏了 | `isPlanFullyClosed` 可能错把 cancelled 不算 terminal；查 `isTerminal` 函数 |

---

## Test 5 — Per-step 决定性 evaluator（build/test/lint hint）

### 步骤

1. **必须**在一个真有 `package.json` 的项目目录里跑（KodaX 仓库本身就 OK）。
2. 启 KodaX（v0.7.38+ 默认即 V2，无需设置 env）。
3. 发：
   ```
   修改 packages/coding/src/task-engine/todo-store.ts 加一行 console.log("test")，
   然后跑 build 验证。在 todo plan 里给这一步标 evaluator: 'build'。
   ```
4. 观察 Worker 的 `todo_update({op:'init'})` 是否带 `evaluator:'build'`，以及 `pending → completed` 时 build 是否真的跑。

### 期望结果

- 列表项带 `[build]` badge（dim text，行尾）。
- Worker 完成该项 `status:'completed'` 后，runner 自动执行 `npm run build`。
- 如果 build 通过，下个 tool result 含 `[evaluator:<id>] [deterministic-evaluator:build] pass …`。
- 如果 build 失败（譬如 Worker 在源码里加了 syntax error），下个 tool result 含 stderr 尾巴（4 KiB cap），Worker 自动读 stderr 修复并重跑。

### 期望 UI 显示

```
⎿  ● Modify todo-store.ts [build]
   ☐ ...
```

### 失败排查

| 现象 | 诊断 |
|------|------|
| `[build]` badge 没出现 | `evaluatorBadge` 字段没 populate；查 `view-models/todo-plan.ts::buildItemRow` 是否在 item.evaluator 存在时设值 |
| build 没自动跑 | `runtimeCwd` 没传给 `buildRunnerAgentChain`；检查 `runManagedTaskViaRunnerInner` 调用处是否传 `managedWorkspace.executionCwd` |
| build 跑了但 stderr 没回到 Worker | wrapper 的 `formatDeterministicEvaluatorResult` 输出可能没 append；查 `runner-driven.ts` Slice 3c wrapper 区段 |
| 卡住 90s | Worker 写了死循环；`runDeterministicEvaluator` 的 90s 超时会 SIGTERM 子进程并把 `[deterministic-evaluator:build] error — TIMEOUT` 喂回 |

---

## Test 6 — V1 opt-out 路径完全不变（regression gate）

### 步骤

1. **显式设置** `KODAX_HARNESS_V2=false` 退到 V1 路径（v0.7.38 Slice 7
   默认翻转后，unset 等于 V2 active；要测 V1 必须显式 `false`）：
   ```bash
   # POSIX
   export KODAX_HARNESS_V2=false

   # PowerShell
   $env:KODAX_HARNESS_V2 = 'false'

   # Windows cmd
   set KODAX_HARNESS_V2=false
   ```
2. 启 KodaX。
3. 跑 Test 2 同样的任务（写两个文件）。

### 期望结果

- 入口 agent 是 **Scout**（spinner / transcript 显示 `[Scout]`）。
- Scout 决定 H0/H1/H2，escalate 到 Generator 或 Planner。
- Evaluator 的 revise handoff 回 **Generator**（不是 Worker）。
- 行为与 v0.7.34 完全等价（既有 e2e 测试 / Scout H0 测试等都过）。

### 关键回归检查

```bash
# 显式 V1 opt-out
export KODAX_HARNESS_V2=false
npx vitest run packages/coding packages/repl
# 应当 3410 tests passed
```

### 失败排查

| 现象 | 诊断 |
|------|------|
| `unset KODAX_HARNESS_V2` 仍走 Worker | **预期**——v0.7.38 Slice 7 翻了默认；要 V1 必须显式 `KODAX_HARNESS_V2=false` |
| `KODAX_HARNESS_V2=false` 仍走 Worker | `isHarnessV2Enabled()` 实现错；env 必须是 `'false'`（case-insensitive），其他值（包括 `'0'` / `'no'`）都返 true 走 V2 |
| Evaluator handoffs 含 Worker | `evaluatorHandoffs` 字面量逻辑被破坏；查 `runner-driven.ts` 的 `v2ActiveAtChainBuild` 三元表达式 |
| 既有 V1 测试挂了 | 跑 `git diff a3ff28c..HEAD -- packages/coding/src/task-engine/runner-driven.ts` 看是否动了 V1 字面量；V1 路径在 Slice 3b 应当 bit-for-bit 保留 |

---

## 自动化覆盖速览

| 测试范围 | 文件 | 测试数 |
|----------|------|--------|
| Schema (cancelled status + evaluator hint) | `packages/coding/src/tools/todo-update.test.ts` | 5 (Slice 1) |
| View-model (cancelled symbol + isStrikethrough + evaluatorBadge) | `packages/repl/src/ui/view-models/todo-plan.test.ts` | 5 (Slice 1 + Slice 4) |
| Worker prompt builder | `packages/coding/src/task-engine/_internal/managed-task/role-prompt.test.ts` | 6 (Slice 2) |
| Chain topology — Worker slot exists | `packages/coding/src/task-engine/runner-driven.test.ts` (FEATURE_114 Slice 3a) | 4 |
| V2 flag-gated handoffs | `packages/coding/src/task-engine/runner-driven.test.ts` (FEATURE_114 Slice 3b) | 3 |
| Deterministic evaluator wrapper | `packages/coding/src/task-engine/runner-driven.test.ts` (FEATURE_114 Slice 3c) | 5 |
| Deterministic evaluator helper | `packages/coding/src/task-engine/deterministic-evaluator.test.ts` | 7 |
| Cancelled strikethrough + badge rendering | `packages/repl/src/ui/components/TodoListSurface.test.tsx` | 3 (Slice 4) |

> 全部跑：`npx vitest run packages/coding packages/repl`（约 2 分钟）

---

## 已知不在本版本验证

- **V2 结构性 resume**：v0.7.38 不支持从 checkpoint 恢复 V2 状态机（checkpoint schema 还是 scout/contract/handoff 槽位）。`structuralResumeSeed` 在 V2 路径上不进 worker 入口；后续版本扩展。
- **`planBeforeMutate` invariant**：v0.7.36 设计第 4 项保护措施。本版本以 prompt 强约束为主，invariant 层面的 warn 日志后续版本接入（FEATURE_101 第 8 项 `harnessSelectionTiming` 的替换工作）。
- **PLANNED harness 完全替换 H0/H1/H2**：v0.7.45 完成；v0.7.38 是双轨阶段。
- **跨 family 验证（FEATURE_109 AHE）**：Layer 2 prompt eval 在 Slice 6 跑，本指引仅人测。

---

## 紧急 rollback

如果 V2 默认开启暴露严重 bug，立即：

```bash
# 单用户 / 单个 shell 强制回 V1
export KODAX_HARNESS_V2=false      # POSIX
$env:KODAX_HARNESS_V2 = 'false'    # PowerShell
set KODAX_HARNESS_V2=false         # Windows cmd
```

如果是全局回退（影响所有用户），翻 [packages/coding/src/agents/worker-role-prompt.ts](../../packages/coding/src/agents/worker-role-prompt.ts) 中
`isHarnessV2Enabled()` 一行——把默认 return 从 `true` 改回 `false`，发个
v0.7.38.x 补丁版本即可。

V2 路径完全在 flag 内；显式关闭 = 100% 回到 v0.7.34/35 已 ship 行为。
