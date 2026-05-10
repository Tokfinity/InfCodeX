# FEATURE_155 v0.7.39 — Chat-While-Waiting (Idle-Yield) 人测指引

> **目的**：验证 (1) Worker dispatch child 后 turn 立即结束（不再阻塞 await）；(2) 用户在 idle-wait 期间输入能即时被 Worker 看到；(3) child 完成后 Worker 自动接续；(4) `await_child_task` 工具完全消失（callable / prompt / banner / dataset 均无引用）；(5) `KODAX_HARNESS_V2=false` 旧链路 dispatch 的同步 fallback 行为字节对齐 v0.7.38。
>
> **前置**：
> - 任意可用 provider API key（推荐 Anthropic / kimi-code / zhipu-coding，eval 路径 SHIP gate 都覆盖到）
> - KodaX v0.7.39 已构建（`npm run build`）
> - 测试在任意有少量代码的 git 仓库下做（KodaX 自身仓库即可）

---

## Test 1 — `await_child_task` 工具完全删除（结构性回归保险）

### 步骤

1. 在 KodaX 仓库根 grep 工具实现：
   ```bash
   ls packages/coding/src/tools/await-child-task.ts 2>&1
   ```
2. grep 工具注册：
   ```bash
   grep -n "await_child_task" packages/coding/src/tools/registry.ts
   ```
3. grep prompt / banner：
   ```bash
   grep -n "await_child_task" packages/coding/src/agents/worker-role-prompt.ts \
                              packages/coding/src/tools/dispatch-child-tasks.ts
   ```

### 期望结果

- Test 1.1 `ls` 报 **No such file or directory**（C1 已删源文件）。
- Test 1.2 grep registry **无输出**或仅匹配到说明性注释（无 toolDefinition / register 调用）。
- Test 1.3 grep prompt + banner **无输出**（C3 删完 OFF 分支后 worker prompt 不再提工具名；banner 只 emit idle-yield wording）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `await-child-task.ts` 还在 | C1 没删干净 — 看 `git log packages/coding/src/tools/await-child-task.ts` 找回滚点 |
| grep registry 命中 toolDefinition | registry 漏改，需要 hot-fix |
| grep prompt 命中 IDLE-YIELD 上下文 | C3 prompt cleanup 漏掉某段 — 用 git blame 定位最近一次 prompt 修改 |

---

## Test 2 — Worker dispatch 后 turn 立即结束 + 用户能 idle-wait 期间打字

### 设置

确保默认环境（不要设 `KODAX_HARNESS_V2=false`，让 V2 Worker 路径生效；不要设 `KODAX_IDLE_YIELD=*`，flag 已 retire）。

### 步骤

1. 启 KodaX。
2. 发一个**触发 dispatch_child_task fan-out** 的 review 任务：
   ```
   并行 review packages/ai、packages/agent、packages/coding 三个包的最新 5 次 commit，
   每个包用独立 child task，最后给我合并报告。
   ```
3. 观察 Worker 的第一轮：应当 emit `todo_update({op:'init', items:[3 项]})` + 三个 `dispatch_child_task` tool_use。
4. 等到 Worker 文本结束（无 tool calls、只有一句状态提示，类似 "三个 review 已派出，等结果。"）。**spinner 应进入 idle 状态**，不再显示工具忙碌。
5. **立即**输入 "顺便也看下 packages/repl 吧" 并回车。
6. 观察 Worker 反应。
7. 让 child 自然完成（任务量小的 review 大约 30-60 秒）。

### 期望结果

- Test 2.4 spinner 进 idle，REPL 完全可输入；transcript 上 Worker 的最后一段是状态文本，**没有** `await_child_task` 工具调用。
- Test 2.5 用户文本立即被 Worker 看到（不需要等任何 child 跑完）—— Worker 下一轮回复应包含对 packages/repl 的反应（追加一个 `dispatch_child_task` 或调整 todo_update）。这印证 priority='user' 在同一 dequeue 周期 wins。
- Test 2.7 child 跑完后 transcript 应自动追加一个 `<task-completed task_id="…">…</task-completed>` 同步合成 user message（_synthetic 标记，REPL 默认不渲染该 user bubble，但在下一轮 Worker 输出里能看到 Worker 引用 child 结果）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| Worker 在 dispatch 后还有更多 tool_use（如 await） | C1 删工具不彻底 — 重新跑 Test 1.2 |
| spinner 不进 idle | runner-driven outer loop 没有正确把 idle-yield exit 当作"等待外部事件" — 看 `runner-driven.ts` `runManagedTaskViaRunnerInner` 的 `while(true)` 包裹是否生效 |
| 用户输入卡住等 child | `waitForWakeEvent` 的 queue 拉取走丢了 — 看 `idle-yield.ts:waitForWakeEvent` 的 poll 路径 |
| child 完成后 Worker 不接续 | `composeIdleYieldUserMessage` 没把 `<task-completed>` 拼进合成 user message — 看 `composeIdleYieldUserMessage` 的 fallback 分支 |

---

## Test 3 — child 失败 / 异常退出仍能唤醒 Worker

### 步骤

1. 启 KodaX。
2. 发一个故意会让 child 跑炸的任务（例如 review 一个不存在的路径）：
   ```
   review 一下 packages/does-not-exist 包的 commit 历史，单独派一个 child。
   ```
3. 观察 child 跑完后 Worker 接续行为。

### 期望结果

- child 跑完后（即使是失败 / 找不到路径）Worker 仍然接续——下一轮 Worker 转写中能看到诸如 `<task-completed task_id="…">failed: …</task-completed>` 的合成 user message 内容（_synthetic，UI 不渲染但 Worker 看到）。
- Worker 不会"沉默"等到 IDLE_YIELD_MAX_ITERATIONS=64 兜底超时 —— `dispatch-child-tasks.ts` 的 IIFE 在 `executeChildAgents` 抛错时会 enqueue 一个 background `<task-completed>` 通知。

---

## Test 4 — V1 链 (`KODAX_HARNESS_V2=false`) 字节对齐 v0.7.38 dispatch 的同步 fallback

### 步骤

1. 关闭 KodaX 进程，启 with `KODAX_HARNESS_V2=false kodax`。
2. 发一个简单的 review 任务（让 V1 Scout/Planner 链处理，不走 fan-out）：
   ```
   解释一下 packages/coding/src/tools/dispatch-child-tasks.ts 的 IIFE 是干什么的。
   ```
3. 观察行为：V1 Scout 链应直接走 H0/H1 单 agent 路径，没有 dispatch_child_task。

### 期望结果

- V1 链路完成回答，行为与 v0.7.38 相同（无新 idle-yield 行为，因为 V1 不调 dispatch_child_task）。
- 即使在 V1 链下手动构造一个会调 dispatch 的 prompt（不推荐），dispatch 工具的 sync path（`childTaskRegistry === undefined` 或 `KODAX_ASYNC_DISPATCH=0`）依旧返回 finding 文本——这条 fallback 在 C3 后保留不变。

---

## Test 5 — 自动化回归

```bash
# 关键单元 + e2e 回归（应全绿）
npx vitest run \
  packages/coding/src/agents/worker-role-prompt.test.ts \
  packages/coding/src/task-engine/_internal/managed-task/idle-yield.test.ts \
  packages/coding/src/tools/async-dispatch.test.ts \
  packages/coding/src/task-engine/runner-driven.test.ts \
  packages/agent/src/messaging/drain.test.ts

# Layer 2 idle-yield adoption eval（5 alias × 3 case × 5 rep）
KODAX_EVAL=1 npx vitest run tests/feature-155-idle-yield-adoption.eval.ts
```

### 期望结果

- 单元 + e2e: 全绿（共 ~183 测试）。
- Layer 2 eval: SHIP gate 维持 ≥3/5 alias ≥80% idle-yield 采用率。

---

## 已知限制 / 非目标

- **Layer 2 chat-while-waiting 行为 eval (D2)** 还在 pending；本指引覆盖结构性回归 + 单端到端 happy path，但不验证 ≤300ms perception budget。
- **send_message / task_stop 工具**（FEATURE_120）独立 feature，与本 feature 共享 idle-yield 基础设施但本指引不覆盖。
