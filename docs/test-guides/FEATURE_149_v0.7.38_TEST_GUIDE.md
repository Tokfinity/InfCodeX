# FEATURE_149 v0.7.38 — Queued Prompt Injection Latency & Mid-Turn UX Parity 人测指引

> **目的**：验证 (1) 排队 prompt 注入延迟降到 < 5ms（消除 50ms `setTimeout` floor）；(2) interruptible-tool fast-abort 在 bash / await_child_task 工具中工作；(3) 多条排队批量 drain 进单轮（N 条 ≠ N agent invocation）；(4) up-arrow 把队列 pop 回输入框可编辑。
>
> **前置**：
> - 任意可用 provider API key（推荐 Anthropic / kimi-code / zhipu-coding）
> - KodaX v0.7.38 已构建（`npm run build`）
> - 本指引在 Ink TUI 下做（`./bin/kodax.mjs` 默认入口）

---

## Test 1 — 延迟消除（Slice A）

### 步骤

1. 启 KodaX，发任意问题，等响应进入流式输出阶段。
2. **快速连发** 3 条排队 prompt（每条 Enter 后立刻打下一条）：
   - `继续`
   - `再继续`
   - `再继续`
3. 观察 spinner 区域和 transcript：每条排队 prompt 应**几乎瞬间**进入"queued" 视觉队列（无肉眼可察的 50ms 延迟）。
4. 上一轮结束后，观察 N+1 轮启动时机：

### 期望结果

- 排队 prompt 在 spinner 上显示为多行 `[i/N]` 编号（详见 Test 4）。
- 上一轮 `runRound` resolve 到 N+1 轮 `runRound` 触发的 wall-clock 间隔 < 5ms（无肉眼"卡顿"）。
- micro-bench `packages/repl/src/ui/utils/queued-prompt-sequence-latency.test.ts` CI 自动跑过。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 排队 prompt 视觉延迟明显（> 100ms 才进入队列） | 检查 `InkREPL.tsx` 中 `stageQueuedPrompt` 是否还有遗留 `setTimeout(50)` |
| micro-bench 测出 handoff > 5ms | scheduler 抖动正常波动，单次失败可重跑；持续超标说明回归 |

---

## Test 2 — Interruptible-tool fast-abort（Slice B1，infrastructure-only）

> **重要**：v0.7.38 没有任何 builtin tool 标 `interruptBehavior: 'cancel'`——与 CC 的保守默认一致（[`c:/Works/claudecode/src/`](c:/Works/claudecode/src/) `grep -rn "interruptBehavior"` 显示 CC 也没有 tool 实际 opt-in）。本 Test 验证的是**接口齐了 + fast-abort 路径就位**，不是 bash 真的中断。

### 步骤（infrastructure 验证）

1. 启 KodaX，发：`运行 bash: sleep 30 && echo done`。
2. 等 1-2s 看到 `[bash]` 工具启动后，**立即输入新 prompt** 并 Enter：`列文件`。
3. 观察：

### 期望结果

- bash 跑完整 30s（**不**中断——因为 bash 默认 `'wait'`）。
- 新 prompt 进入队列上方显示 `[1/1]` 编号。
- bash 自然结束后，新 prompt 立即进下一轮起步（< 5ms 延迟，由 Slice A 保证）。

### 为什么不中断 bash

bash 中断 = SIGTERM 杀子进程；子进程可能：
- 写了一半文件
- 改了一半数据库  
- 推了一半 git

让用户等 30s ≪ 留半完成状态危险得多。这是 CC 的设计判断，KodaX v0.7.38 沿用。

### 接口对未来的钩子

如果将来引入纯无副作用的"等待型"工具（如 `sleep` / `wait_until_time` / `schedule`），可在 `tools/registry.ts` 给它们标 `interruptBehavior: 'cancel'`，[`InkREPL.tsx`](../../packages/repl/src/ui/InkREPL.tsx) 的 fast-abort 路径会自动接通。

### Esc 仍是显式 abort 入口

如果用户**明确想中断** bash 跑，按 ESC：当前轮立即 abort + 队列清空（默认行为）；想中断且保留排队则用 fast-abort 路径（目前没工具触发）。

---

## Test 3 — 批量 drain（Slice B3）

### 步骤

1. 启 KodaX，发：`列出 packages/ 下所有目录`。
2. 在 agent 还在响应时，**快速** 连发 3 条排队 prompt：
   - `第二条：列出 src/ 下所有文件`
   - `第三条：告诉我 README.md 第一行`
   - `第四条：今天日期`
3. 等所有响应结束后，看 transcript / `/cost` 中的 agent invocation 计数。

### 期望结果

- 上一轮（"列出 packages"）结束后**仅一次**新 agent invocation 处理这 3 条排队（不是 3 次独立 invocation）。
- 在该单次 invocation 的 user message 中，3 条 prompt 用 `\n\n---\n\n` 分隔串接。
- LLM 在响应中**逐条**回应这 3 个问题（不是只回第一个或最后一个）。
- `/cost` 显示的 invocation count 增量为 **1**（不是 3）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 3 条 prompt 触发 3 次独立 agent invocation | `queued-prompt-sequence.ts` 的 batched drain loop 没生效，看 `BATCHED_PROMPT_SEPARATOR` 是否还在使用 |
| LLM 只回应最后一条 | dataset prompt eval `feature-149-batched-drain` 退化，跑 `npm run test:eval -- feature-149-batched-drain` 验证 |

### Eval 命令（CI 自动跑）

```bash
npm run test:eval -- feature-149-batched-drain
```

5 alias × 4 case = 20 cell。Stage-1 acceptance gate：5 alias mean ≥ 75% pass per case；max-min spread ≤ 20pp。

---

## Test 4 — Queue UX surface（Slice C1 + C2）

### 步骤

1. 启 KodaX，发：`列出文件`。
2. 在响应过程中连发 3 条排队 prompt（同 Test 3）。
3. **观察 spinner 上方的 queue 区**：
4. **空输入框时按 Up arrow ↑**：

### 期望结果

#### 多行队列渲染（C2）

队列区应显示为多行 `[i/N]` 格式，而**不是**单行摘要：
```
[1/3] 第二条：列出 src/ 下所有文件
[2/3] 第三条：告诉我 README.md 第一行
[3/3] 第四条：今天日期
↑ pull all into editor · Esc drops latest
```

#### Up-arrow popAllEditable（C1）

按 ↑（输入框为空时）：
- 队列**全部 pop 回输入框**，按原顺序用空行分隔（保留可编辑结构）。
- 队列变空（spinner 上的 queue 区消失）。
- 用户可任意编辑 / 删除 / 重排，再 Enter 重新提交。

#### Esc 砍最新

按 Esc（队列非空时）：
- 队列尾部一条被删除（`[3/3]` 消失，剩 2 条）。
- 状态栏简短提示。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 队列只显示一行摘要不分行 | `QueuedCommandsSurface.tsx` 渲染漂移，看 `formatPendingInputsLines` 调用 |
| ↑ 触发历史回查（不是 pop queue） | `prompt-input-controller.ts` 的 up-arrow handler 没接 `onPopPendingInputs` 或 `text.length === 0` 判定漂移 |
| pop 后队列没清空 | `consumePendingInputs` 没返回完整列表或没调 `clearPendingInputs` |

---

## Test 5 — Line-buffered streaming（Slice C3，CC parity）

### 步骤

1. 启 KodaX，发一个会让 LLM 写较长答复的问题，例如：`详细解释 Promise.all 和 Promise.allSettled 的区别，给出代码示例`。
2. 仔细观察响应过程中 transcript 流式渲染：

### 期望结果

- **完整行成块出现**：每行文字一旦完整（碰到 `\n`）才下落到 transcript，而**不是**字符级跳动
- 当前正在被 LLM 写的最后一行（还没 `\n`）**不显示**——直到该行完整
- spinner 仍然在底部转动，告知用户"还在工作"
- 响应完整结束时，最后一行（哪怕没尾随 `\n`）也会进 transcript history（不丢内容）

### 失败排查

| 现象 | 诊断 |
|------|------|
| 字符级跳动还在 | `transcript-layout.ts:streamingResponse` 块没接 `lastIndexOf('\n')` 切片，line-buffered 改动未生效 |
| 响应结束后丢了最后一段 | transcript history 提交路径异常——这是 streaming-rendering vs history-commit 两条路径，line-buffered 只动前者，后者应该照旧拿到完整 final response |

### 对照

CC 同样行为，[`REPL.tsx:1473`](c:/Works/claudecode/src/screens/REPL.tsx#L1473) `streamingText.substring(0, streamingText.lastIndexOf('\n') + 1)`。这也是为什么 CC 的"打字感"看起来稳定——不是字符流动而是行节奏。

---

## Test 6 — activeForm-driven spinner（Slice C4，CC parity）

### 步骤

1. 启 KodaX，发一个会触发 Scout 的中等复杂任务（≥ 2 obligations），例如：`分析 packages/coding/src/tools/bash.ts，找出可能的安全风险并给出 3 个改进建议`。
2. 观察响应过程中的 spinner status 行：

### 期望结果

- Scout 探查阶段：spinner 行如 `[Tool] grep ...` / `[Thinking] processing...`（旧行为）
- Worker 进入执行阶段、调 `todo_update({status:'in_progress', activeForm:'Analyzing bash.ts safety'})` 后：
  - spinner 立即切到 `[Plan] Analyzing bash.ts safety...`
  - **不**等任何工具结束
  - 切到下一个 todo 时，spinner 跟着切（`[Plan] Drafting recommendations...`）

### 失败排查

| 现象 | 诊断 |
|------|------|
| spinner 一直是 `[Thinking] processing` 或 `[Tool] xxx` | LLM 调 todo_update 没传 activeForm；可能 role-prompt 改动未生效，或 LLM 忽略了引导 |
| 调 todo_update 报 `Invalid activeForm` | 类型校验失败——传了非 string；看 todo-update.ts |
| 切了 in_progress 但 spinner 不跟 | InkREPL.tsx 的 `currentTodoActiveForm` useMemo 没接 / 没传给 transcript model；看 transcript-layout.ts spinner 级联 |

### 对照

CC [`Spinner.tsx:169`](c:/Works/claudecode/src/components/Spinner.tsx#L169) 同样读 `currentTodo?.activeForm` 实时切 spinner，是 CC "看起来 agent 在认真做事"的核心——比 "Working..." 信息量大得多。

---

## Test 7 — Bash live progress（Slice C5，CC parity）

### 步骤

1. 启 KodaX，发：`运行 bash 跑 5 行有间隔的输出` 或更实战的：`npm test --workspace packages/coding`。
2. 观察 bash 工具调用过程中的 spinner / tool-call display：

### 期望结果

- bash 启动后**立即**进度条 / spinner status 显示 stdout/stderr 的最近几行
- 命令输出每来一行（throttle 100ms），progress 行更新一次
- 30s 长跑期间用户看到**实时进度**（不是 30s 静默等待）
- 命令完成后 transcript 显示完整 output（live progress 与 final output 是两条路径，互不干扰）

### 失败排查

| 现象 | 诊断 |
|------|------|
| bash 跑期间无任何进度 | `ctx.reportToolProgress` 没传到 bash，看 tool-execution-context.ts wiring |
| progress 显示乱码 | UTF-8 chunk 边界切到多字节字符——预期可接受（live tail 是 best-effort）；最终 output decode 仍正确 |
| 30s 跑期间频繁刷屏（> 20fps） | throttle 没生效，看 `LIVE_PROGRESS_THROTTLE_MS` |

### 对照

CC [`BashTool.tsx`](c:/Works/claudecode/src/tools/BashTool/BashTool.tsx) 实现 `renderToolUseProgressMessage()` + [`BashModeProgress.tsx`](c:/Works/claudecode/src/components/BashModeProgress.tsx) 渲染 `<UserBashInputMessage>` + `<ShellProgressMessage>` 实时滚动。KodaX 走 `reportToolProgress` 通道（轻量，spinner-line-only，不专门为 bash 渲染独立组件），是较轻量的等价。

---

## 回归 checklist（每次 ship 必跑）

- [ ] Test 1 latency：排队 prompt 视觉延迟 < 100ms（micro-bench < 5ms）
- [ ] Test 2 fast-abort infra：bash sleep 30s 中按 Enter 新 prompt 排队不中断（bash 默认 'wait'），bash 完成后新 prompt < 5ms 起轮
- [ ] Test 3 batched drain：3 条排队 = 1 次 agent invocation，LLM 全部回应
- [ ] Test 4 queue surface：多行渲染 + ↑ pop + Esc 砍尾全部工作
- [ ] Test 5 line-buffered streaming：完整行成块出现，无字符级跳动；响应结束后无内容丢失
- [ ] Test 6 activeForm spinner：Worker 调 `todo_update({status:'in_progress', activeForm:'…'})` 后 spinner 立刻切到 `[Plan] …`
- [ ] Test 7 bash live progress：长 bash 期间 spinner / tool-display 实时显示 stdout/stderr tail
- [ ] `npm run test`（含 `queue-mirror.test.ts` + `queued-prompt-sequence.test.ts` + `queued-prompt-sequence-latency.test.ts` + `transcript-layout.test.ts` + `todo-store.test.ts` + `bash.test.ts`）全绿
- [ ] `npm run test:eval -- feature-149-batched-drain` 通过 stage-1 gate

---

## 已知限制 / 不在本版本

- **不**做 mid-tool-call prompt 注入（即工具运行中实时把 user message 推给 LLM）——这与 cancel-then-reissue 边界冲突，需要更深的 protocol 改造，留 v0.7.43+
- **不**做 soft-pause 状态机（FEATURE_111 v0.7.43 范围）
- **不**改 ESC 双击退出 / `MAX_PENDING_INPUTS=5` 上限 / FEATURE_115 priority 字段
- **不**做 input-as-async-generator 架构（state-setter 即可，与 Claude Code 同模型）
- **不**做 council / multi-advisor consult（FEATURE_105 v0.7.46 范围）
