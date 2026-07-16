# FEATURE_120 v0.7.39 — Async Child Steering 人测指引

> **目的**：验证 (1) `send_message(to, content)` 让 Worker 把追加指令送到在跑 child 的队列；(2) `task_stop(task_id, reason?)` 让 Worker 优雅终止单个在跑 child，当前 tool 跑完后退出（不强行 kill）；(3) `dispatch_child_task.model_hint` schema 字段被接受但**当前 routing 是 no-op**（每个 child 仍走父 model）；(4) `send_message` / `task_stop` 是 coordinator-only（child agent 不能调用，已加入 `CHILD_EXCLUDE_TOOLS_BASE`）；(5) sync-mode dispatch 下两个工具均返 `[Tool Error]` 而非崩溃。
>
> **前置**：
> - 任意可用 provider API key（推荐 Anthropic claude-sonnet 系列，工具调用稳定）
> - KodaX v0.7.39 已构建（`npm run build`）
> - 默认 async dispatch 已启（`KODAX_ASYNC_DISPATCH` 未设置或非 `0`）
> - 默认 V2 Worker 链已启（`KODAX_HARNESS_V2` 未设置或非 `false`）
>
> **重要约定**：
> - 本指引验证 **API 表面 + 工具 wiring**，不验证 LLM 是否在真实场景中**主动**用这些工具——后者由 Phase 5b 的 `tests/child-steering.eval.ts` Layer 2 行为评估覆盖（v0.7.39 release 后单独跑）。
> - 所有"观察 child queue"步骤需要 verbose / debug log，或直接看 transcript 里 `<task-completed>` / `<coordinator-instruction>` / `<coordinator-stop-request>` 三个 tag 的出现时机。

---

## Test 1 — `send_message` 路由到在跑 child

### 设置

普通工作目录，`AGENTS.md` 可选（不影响本测试）。

### 步骤

1. 启 KodaX。
2. 发一个**触发 fan-out 的 read-only 任务**，让 Worker 派 ≥1 个 long-running child（≥30 秒）：
   ```
   并行审计这两个目录：packages/llm/src 和 packages/coding/src。
   对每个目录单独派 dispatch_child_task，逐文件读取识别 5 个最高风险的代码模式，
   每个 child 用唯一 task_id（例如 audit-ai 和 audit-coding）。
   ```
3. **等到 Worker 完成派发并 idle-yield**（transcript 显示 `task_id:audit-ai` / `task_id:audit-coding` banner 后 Worker 短摘 + 无更多 tool calls 结束当前 turn）。
4. 在 child 跑期间，给 Worker 发追加指令，**显式触发 `send_message`**（直接告知 Worker 哪个 task_id 要追加）：
   ```
   对 audit-ai 这个 child 追加要求：请重点关注 retry 逻辑里的 race condition。
   用 send_message 工具发给它。
   ```
5. 观察 Worker 的下一轮：应该看到一次 `send_message(to="audit-ai", content="...")` 工具调用，工具返回类似 `Message sent to audit-ai. It will be processed at the child's next LLM turn boundary as a <coordinator-instruction> block.`
6. 等 `audit-ai` 完成（`<task-completed task_id="audit-ai">…</task-completed>` block 出现）。在 child 的 final summary 里应该能看到对 retry race condition 这条追加要求的回应。

### 期望结果

- `send_message` 工具调用成功，返回 `Message sent to audit-ai. …` 字串。
- 不影响兄弟 child（`audit-coding`）——它继续按原 objective 跑。
- `audit-ai` 的最终 summary 内容包含对追加要求的处理（具体话术由 LLM 决定，但能看出 child 收到了 `<coordinator-instruction>` 信号——例如 final report 明确提到 race condition 章节）。
- 如果 child 在 `send_message` 之前已经完成并被自动清理：Worker 应收到 `[Tool Error] send_message: Unknown task_id "audit-ai". …` 而不是崩溃。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `send_message` 返 `[Tool Error] … Async dispatch is disabled` | `ctx.childTaskRegistry === undefined`。检查 `KODAX_ASYNC_DISPATCH` 是否被显式设为 `0`；或 `tool-execution-context.ts` provision 路径 |
| `send_message` 调用但 child 的 final summary 完全没体现追加要求 | (1) `routeMessage` 没成功 enqueue，验 `<coordinator-instruction>` 是否在 child 的 user message 里出现；(2) child 已经 mid-drain 错过窗口（典型情况，正常） |
| Worker 在 idle-yield 期间不响应用户追加输入 | 这不是 FEATURE_120 问题，是 FEATURE_155 的 chat-while-waiting 路径——优先查 `composeIdleYieldUserMessage` 和 mid-turn drain |

---

## Test 2 — `task_stop` 优雅终止跑中 child

### 设置

同 Test 1。需要至少一个**仍在跑**的 child。

### 步骤

1. 沿用 Test 1 的 fan-out 状态（`audit-ai` + `audit-coding` 仍在跑），或重新派发：
   ```
   再次派两个 read-only child：lint-ai 跑 packages/llm/src 的所有 .ts 文件
   全 lint pattern 探查，lint-coding 跑 packages/coding/src 的同样任务。
   每个 child 跑慢一点，详尽探查。
   ```
2. Worker idle-yield 之后，发停掉其中一个的指令：
   ```
   决定不再需要 lint-coding 的结果了，用 task_stop 优雅终止它，
   reason 写 "user no longer needs coding-side audit"。
   ```
3. 观察 Worker 的下一轮：
   - 应该看到 `task_stop(task_id="lint-coding", reason="...")` 工具调用。
   - 工具返回类似 `task_stop signal sent to lint-coding. Child will exit at its next abort check …`
4. **观察 `lint-coding` 在 transcript 中的退出时机**：当前正在跑的 tool（例如某个 read / grep）应该**跑完后**才退出，不是立刻被切断。
5. 在 `lint-coding` 的 final result（出现在 `<task-completed task_id="lint-coding">` block 里）中，应该看到 child 提到收到了 `<coordinator-stop-request>` 信号 + 给出了截至目前的简短 summary。
6. **`lint-ai` 不受影响，继续跑完。**

### 期望结果

- `task_stop` 返回成功字串。
- `lint-coding` 当前 tool 跑完后**主动**结束，不留半完成的 state。
- `lint-coding` 的 final summary 包含 `coordinator-stop-request` 的处理（具体话术由 LLM 决定）。
- `lint-ai` 完全独立完成。
- `<coordinator-stop-request>` block 应该比 abort signal **先**到 child（设计如此——让 child 知道 _为什么_ 被停）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `task_stop` 返 `[Tool Error] … already aborted` | child 已经在另一处被 abort 或自然结束。signal.reason 是首次 abort cause（debug 用） |
| `task_stop` 后 `lint-coding` 没退出，继续跑完 | child 没有 abort check 路径——检查 `childOptions.abortSignal` 是不是 per-child 信号（应该是，而不是 parent 的）；或 child 的 LLM 调用没观察 signal |
| `lint-ai` 也被一起停了 | 信号链路混了——应该是**只有** per-child controller 被 abort，parent signal 没被触发 |
| 没有 `<coordinator-stop-request>` block 出现 | (1) reason 没传；(2) `routeMessage` 在 `requestTaskStop` 成功**之后**才跑（设计如此——abort-first ordering 见 `20c06d38`），如果跑前 child 已不在 registry 则不 enqueue |

---

## Test 3 — `model_hint` schema 接受但 routing no-op

### 设置

普通工作目录。`process.env` 不需要任何额外设置。

### 步骤

1. 启 KodaX。
2. 发一个**显式让 Worker 用 `model_hint` 字段**的任务：
   ```
   并行派 3 个 dispatch_child_task：
   - id="hint-fast", objective="读 package.json 列出 dependencies 数量",
     model_hint="fast"
   - id="hint-balanced", objective="审计 packages/llm/src/openai.ts 的 retry 逻辑",
     model_hint="balanced"
   - id="hint-deep", objective="跨 packages/{ai,coding}/src/ 综述 retry 模式的设计权衡",
     model_hint="deep"
   ```
3. 观察 transcript 里 Worker 的 3 个 `dispatch_child_task` 调用，每个的 input 里应该有 `model_hint` 字段。
4. **所有 3 个 child 应该用同一个 model 跑**（与父 Worker 同 provider/model）——routing 当前是 no-op。
5. 等 3 个都完成后，整体响应正常。

### 期望结果

- 每个 `dispatch_child_task` 调用接受 `model_hint` 字段不报错。
- 三个 child 都用父 model 跑（observable 通过 transcript 里 child 的 LLM call provider/model 信息，或通过 cost tracker 看到所有 token 计费给同一个 model）。
- 如果传入未知字串（例如 `model_hint: "ultra-fast"`）：dispatch 仍成功（tolerant parse），未知字串静默 fallback 为 undefined。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `dispatch_child_task` 报 schema 错误说 `model_hint` 字段未知 | tool registry 没更新——检查 `packages/coding/src/tools/registry.ts` 里 dispatch_child_task 的 input_schema 是否含 `model_hint` |
| 不同 `model_hint` 的 child 实际跑了不同 model | 不应该发生——FEATURE_102 (v0.7.45) 才激活 routing。如果发生说明有人偷偷接了 routing 路径 |
| 传 `model_hint: "deep"` 报错 | 应被 enum `['fast', 'balanced', 'deep']` 接受。检查 schema |

---

## Test 4 — Child 无法调用 `send_message` / `task_stop`（coordinator-only 不变量）

### 设置

普通工作目录。需要让一个 child 被派出后**尝试**调用 steering 工具。这通常需要构造一个明确诱导 child 这么做的 prompt——但 child 的 tool list 在 API 层已经被过滤了，工具定义根本看不到。

### 步骤（API 层验证 — 推荐方式）

直接看代码：

```bash
grep -A 12 "CHILD_EXCLUDE_TOOLS_BASE.*readonly string\[\]" packages/coding/src/child-executor.ts
```

期望输出包含至少这两行：

```
  'send_message',           // FEATURE_120: coordinator-only ...
  'task_stop',              // FEATURE_120: coordinator-only ...
```

并且 `CHILD_BLOCKED_TOOLS = new Set<string>(CHILD_EXCLUDE_TOOLS_BASE)` 不变（运行时 defense-in-depth）。

### 步骤（行为验证 — 如果想跑实测）

1. 强制 V1 chain（V1 也调 child-executor，path 一致）：`KODAX_HARNESS_V2=false kodax`。
2. 给 Worker 一个任务，**显式让某个 child 尝试给兄弟发消息**：
   ```
   派一个 child task，objective 是 "试试调用 send_message 给另一个 child"。
   ```
3. 观察 child 的 LLM 在它的工具列表里**根本看不到** `send_message` / `task_stop` 工具定义（API 层过滤生效）。
4. 即使 child 强行 hallucinate 调用 `send_message`，`beforeToolExecute` 也会返回 `[Tool Error] send_message: Not available in child agent context.`（runtime 兜底）。

### 期望结果

- `CHILD_EXCLUDE_TOOLS_BASE` 包含 `send_message` + `task_stop`。
- Child agent 的 LLM 看不到这两个工具的定义。
- 即使绕过工具列表过滤（hallucinated tool call），runtime defense `CHILD_BLOCKED_TOOLS` 也拦截并返回明确 error。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `send_message` / `task_stop` 出现在 child 的工具列表 | 检查 `CHILD_EXCLUDE_TOOLS_BASE` 是否含两个字串 |
| Child hallucinate 调用 `send_message` 居然成功 | `CHILD_BLOCKED_TOOLS` 没继承 BASE——检查它的初始化语句 |

---

## Test 5 — Sync-mode 下两个工具均返 `[Tool Error]`（不崩溃）

### 设置

```bash
export KODAX_ASYNC_DISPATCH=0
```

或 Windows：

```powershell
$env:KODAX_ASYNC_DISPATCH = "0"
```

### 步骤

1. 启 KodaX（带上面的 env）。
2. 发一个尝试 fan-out 的任务：
   ```
   派两个 read-only child 审计 packages/llm/src，然后用 send_message
   给其中一个追加要求。
   ```
3. Worker 应该会发现 dispatch 走 sync path（returns finding text 不 returns task_id banner），然后**没有**机会调 send_message——但如果它强行调用（hallucinated id），应该返 `[Tool Error] send_message: Async dispatch is disabled (no childTaskRegistry on context). …`
4. 同理 `task_stop` 在 sync mode 返 `[Tool Error] task_stop: Async dispatch is disabled (no childAbortControllers on context). …`

### 期望结果

- sync 模式下 dispatch 返 finding text（兼容老 sync 行为）。
- `send_message` / `task_stop` 即使被调用也返 `[Tool Error]` + 解释为什么不可用，不崩溃。

### 失败排查

| 现象 | 诊断 |
|------|------|
| sync mode 下调 send_message 崩溃 / 抛 unhandled error | `toolSendMessage` 里 `ctx.childTaskRegistry === undefined` 路径没 guard——检查 `if (!registry) return '[Tool Error] …'` |

---

## Test 6 — 全量回归（自动化）

每次发布前必跑：

```bash
npm run test
```

期望：≥ 488 个 test files / ≥ 5398 个 tests 全绿（agent + coding + repl + skills + benchmark 合计）。如果有 todo / skipped，确认数量与上版本一致。

> **已知 flake**：`benchmark/harness/h2-boundary-runner.test.ts` 的 2 个 case（`H2-B variant propagates …` / `H1-ref variant propagates …`）在 `npm run test` 重并行负载下偶发 ENOENT；commit `d4a47bc9` 已 bump 过 timeout，仍偶发。**验证方式**：单独跑 `npx vitest run --no-file-parallelism benchmark/harness/h2-boundary-runner.test.ts` 应该 4/4 通过。如果连串行都失败才是真问题。此 flake 与 FEATURE_120 无关。

特别关注：

- `packages/agent/src/orchestration/{send-message-router, task-stop, runner-with-idle-yield, fan-out, task-registry, idle-yield}.test.ts`
- `packages/coding/src/tools/{send-message, task-stop, async-dispatch}.test.ts`
- `packages/coding/src/agents/worker-role-prompt.test.ts`（含 FEATURE_120 Phase 5a 的 6 个 pin tests）
- `packages/coding/src/child-executor.test.ts`（fan-out 委托回归）

### TypeScript 编译

```bash
npx tsc -b packages/agent
npx tsc -b packages/coding
```

期望：两个都 clean，无错误无警告。

---

## 验收 checklist

- [ ] Test 1 — `send_message` 路由到指定 child 成功，兄弟不受影响
- [ ] Test 2 — `task_stop` 优雅终止，当前 tool 跑完后退出，reason 体现在 child final summary
- [ ] Test 3 — `model_hint` 接受三档值不报错，所有 child 仍走父 model（routing no-op）
- [ ] Test 4 — `CHILD_EXCLUDE_TOOLS_BASE` 含 `send_message` + `task_stop`
- [ ] Test 5 — Sync-mode 下 `send_message` / `task_stop` 返 `[Tool Error]` 不崩溃
- [ ] Test 6 — 全量 test + tsc 全绿

---

## 已知限制（v0.7.39）

- **Broadcast `to: '*'`** 不支持——`send_message` 返 `[Tool Error] Broadcast 'to: *' is not yet supported (planned in FEATURE_123 v0.7.44)`。
- **Child→child** 通信不支持（与 broadcast 一起在 FEATURE_123 v0.7.44）。
- **`model_hint` routing** 是 no-op——FEATURE_102 (v0.7.45) capability profile 才激活。
- **`task_stop` 不强行 kill**——当前正在跑的 tool 跑完才退出（与 FEATURE_115 soft-pause "tool 原子性" 原则一致）。`npm test 90s` 不会被中断。
- **Phase 5b Layer 2 行为评估** 在 v0.7.39 release 后跑——结构 pin tests 已覆盖 prompt 表面是否含正确指引，但 LLM 是否在真实场景中主动用这些工具仍需 `tests/child-steering.eval.ts` 验证。

---

## 与其他 feature 的关系

- **FEATURE_115（v0.7.36）— Message Queue**：本 feature 全部消息走 `getMessageQueue()`，priority='user' 视同用户级中断。
- **FEATURE_119（v0.7.36）— Pattern B 异步派发**：FEATURE_120 是它的自然延伸——给现有的 fire-and-forget 模型加上 mid-flight 操控。
- **FEATURE_155（v0.7.38）— Chat-While-Waiting / Idle-Yield**：Step 0 把 idle-yield 状态机提到 `@kodax/agent`，Bug A→G 全部 hotfix 行为不变。同 message queue 既载 user input 又载 `<task-completed>` 也载 `<coordinator-instruction>` / `<coordinator-stop-request>`。
- **FEATURE_102（v0.7.45）— Capability Profile**：`model_hint` schema 字段是它的输入。本 feature 只引入字段，routing 留给 102。
- **FEATURE_123（v0.7.44）— Peer-to-Peer SendMessage**：在 FEATURE_120 之上扩展 child→child。Step 0 把 orchestration 提到 agent 层，123 直接复用同 `routeMessage` 原语。

---

## 参考

- 设计文档：[`docs/features/v0.7.39.md#feature_120-async-child-steering`](../features/v0.7.39.md#feature_120-async-child-steering--sendmessage--taskstop--dispatch-model_hint-field)
- 实现 commit 链：`cce78f67` → `2571e414`（18 commits，详见 v0.7.39.md "Slice landing log"）
- 同包：[`FEATURE_155 v0.7.39 TEST_GUIDE`](FEATURE_155_v0.7.39_TEST_GUIDE.md)（FEATURE_155 实际 ship 在 v0.7.38，文件名保留 v0.7.39 是 cross-link 稳定性）
