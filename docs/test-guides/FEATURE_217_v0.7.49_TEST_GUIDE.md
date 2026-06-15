# FEATURE_217 v0.7.49 - 人工测试指导

## 功能概述

**功能名称**: Dynamic Workflow Harness Runtime + AMAW invocation integration
**版本**: v0.7.49
**测试日期**: 2026-06-13
**测试人员**: 待填写

FEATURE_217 让 KodaX 支持动态多 agent workflow：LLM 可为复杂任务生成 JavaScript harness，runtime 负责并发、预算、取消、事件和 run graph，REPL 提供 `/workflow` 显式入口。v0.7.49 额外补齐 `SA / AMA / AMAW` 三种 agent mode：AMA 可显式使用 `/workflow` 并在复杂自然语言任务上建议 workflow；AMAW 可对显式/复杂候选静默启动 capability-isolated generated workflow，但不绕过权限 gate、本地代码确认或预算限制。workflow script 负责调度，真实文件、shell、MCP、web 等副作用仍由 child agents 通过既有工具权限执行。生成的 workflow 可以保存为 workflow capsule：脚本仍保存，但会附带 manifest、意图、输入示例、环境/skill/MCP/tool 依赖和 provenance，便于复用前判断是否适合当前机器和项目。

## 测试环境

- 使用当前仓库构建出的 KodaX。
- 至少配置一个可用于 `/workflow create` 的 LLM provider。
- 用于 worktree isolation 的 workspace 必须是 git 仓库。
- 人工测试前先运行自动化 gate，并确认通过。

## 自动化已覆盖范围

以下内容已经由单元/集成测试覆盖，人工测试只需要在真实 REPL 中抽查体验和 provider 质量：

- Workflow manifest 校验、pattern id 校验、generated source gate。
- Generated workflow result contract：拒绝非 existent `.output` 读取、未 `await wf.artifact(...)`、只写 artifact 不返回结果、空返回、phase 内局部 return；外层 `run()` 必须返回可展示的最终文本。
- Generated workflow budget hygiene：模型生成的隐式 `tokenBudget` 会被移除，只有用户明确要求 token budget 时才保留并交给 runtime cap 执行。
- Restricted workflow runner 禁止直接 `process` / `require` / dynamic import / runaway sync loop。
- Runtime 事件顺序、maxAgents、maxConcurrency、token budget、abort propagation。
- Coding workflow adapter 的 spawn / wait / output / send / stop 映射。
- Durable run graph：`run.json`、`events.jsonl`、`artifacts`、`script.js`、`manifest.json`。
- Workflow generator 的 generate / decline 解析和 manifest validation。
- Saved workflow capsule discovery、restricted rerun、legacy `.workflow.json` compatibility、trusted-local confirmation。
- Generated JS capability runner 逃逸回归：不能通过 `wf.constructor.constructor('return process')()`、`globalThis.constructor` 等路径拿到宿主 `process`。
- Background run manager：list / show / pause / resume / stop。
- `/workflow` 子命令 parsing、help、approval prompt、saved-list、run-list limit、delete/prune option parsing、run-id rerun、saved-name rerun、save capsule。
- `/workflow` 参数补全：`/workflow ` 后 Tab/补全候选包含 `runs/show/stop/delete/prune` 等子命令，`/workflow rerun ` 同时提示 recent run id 与 saved workflow name，选择参数时不会把 `/workflow ` 前缀替换掉。
- AMAW invocation policy、`/agent-mode amaw`、状态栏短标签 `AMAW`、`/review --workflow` request builder。
- AMAW 按 AMA-family 预算运行；Alt+M 可从 AMAW 切回 SA。
- Workflow builder lifecycle：生成期间 prompt 显示 `Workflow - generating harness` / `Workflow - validating harness`，失败时显示 builder failure。
- Agent mode 三态切换：Alt+M 与 `/agent-mode toggle` 都按 `AMA -> AMAW -> SA -> AMA` 循环。
- Workflow generation timeout：默认 120 秒，可用 `KODAX_WORKFLOW_GENERATION_TIMEOUT_MS` 覆盖，错误信息包含 `timeout after <n>ms`。
- Workflow run UX：运行中有 spinner + 类 TodoList live surface；`/workflow show [runId]` 默认查看最近 run 的预览与 recent events；`/workflow show --full [runId]` 能从持久化 artifact 读取完整最终结果。
- Workflow 结束摘要：成功时 Assistant 直接显示完整最终结果；失败显示 run id、错误、show/rerun 提示。
- Workflow live surface 进度：显示阶段序号、运行中智能体、`finished/spawned`、cap、failed/stopped 详情、show/stop hint、elapsed 时间和已完成 child 的 token 用量，并支持中文标签。
- Workflow 长任务控制：默认不再设置 workflow 总墙钟超时；保留同步 JS watchdog，显式 `timeoutMs` 仍可 opt-in，实际长任务靠 per-step `wf.wait(...,{timeoutMs})`、caps/budget、progress 和 `/workflow stop` 控制。
- Natural-language / AMAW agentic transcript：启动说明、每个子 Agent 的有界完成摘要和完整最终综合使用 assistant-style；workflow 子 Agent 完成后会追加一次同会话、无工具、单轮的自蒸馏摘要，缺失或失败时才以“摘录摘要”做 deterministic fallback，不折叠摘要本身。子 Agent 摘要必须尽量包含具体发现、判断、风险、证据指针、未决问题或下一步；不能只说“已完成、报告较长”。
- 彩色 workflow transcript 选择/复制：app-managed transcript/fullscreen selection 会在命中测试和复制前剥离 ANSI escape sequences，复制结果不应包含 `\u001b[` / `ESC[` 这类颜色控制字符。
- Restricted workflow runner 对空 taskId 等非法 task command 做 sandbox 侧校验，失败时保持为 workflow 错误，不让 REPL 崩溃。
- Workflow manager crash hardening：run graph / startup persistence 异常会 settle 为 failed run，不会让 background `done` promise 以未处理 rejection 形式冒出；REPL observer 也会把 rejected `done` promise 渲染成可见 workflow 错误。
- Workflow builder crash hardening：`createKodaXOptions()` 等 option 构造异常会显示 builder failed，不会抛出 slash command / AMAW 路径。
- AMAW invocation policy：日常提及 `workflow`、单个 `verify` / `sort` 等弱信号不会静默启动 workflow；显式执行请求和强/多信号复杂任务仍会触发。
- Workflow negation：`do not use a workflow`、`without using a workflow`、`avoid workflows` 等否定形式会阻止 AMA/AMAW workflow routing。
- Coding adapter `wait(timeoutMs)`：`wf.wait(taskId, {timeoutMs})` 会按时失败并 abort 子 Agent；runtime abort 对 `runAgent` 和裸 `spawnAgent + wait` 都会 stop child；workflow 成功或失败结束时都会停止未显式 wait/stop 的 child，避免后台遗留。
- Pattern templates / capsule preflight：只读模板 manifest 不再误报写风险；`.workflow.json` capsule 的 `minKodaxVersion` 会在 preflight 阶段校验。
- 运行中 `Esc` 与 `Ctrl+C` 都可中断；显式 workflow 请求被拒绝后取消本轮，不继续普通 AMA。

最近自动化 gate：

```powershell
npm test -- packages/agent/src/workflow packages/coding/src/workflows packages/coding/src/child-executor.test.ts packages/repl/src/commands/workflow-command.test.ts packages/repl/src/commands/review-command.test.ts packages/repl/src/interactive/commands-help.test.ts packages/repl/src/ui/view-models/status-bar.test.ts packages/repl/src/ui/view-models/ama-summary.test.ts packages/repl/src/ui/view-models/surface-liveness.test.ts packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts packages/repl/src/ui/constants/layout.test.ts packages/coding/src/task-engine/_internal/managed-task/budget.test.ts src/cli_option_helpers.test.ts
npm test -- packages/repl/src/commands/workflow-command.test.ts packages/repl/src/ui/view-models/workflow-live.test.ts packages/repl/src/ui/components/WorkflowRunSurface.test.tsx packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts packages/coding/src/workflows/run-manager.test.ts
npm test -- packages/agent/src/workflow/script-runner.test.ts packages/repl/src/commands/workflow-command.test.ts packages/repl/src/ui/view-models/workflow-live.test.ts packages/repl/src/ui/components/WorkflowRunSurface.test.tsx
npm test -- packages/repl/src/ui/components/SharedSpinnerClock.test.tsx packages/repl/src/ui/components/SpinnerStatsTail.test.ts packages/repl/src/ui/components/SpinnerStatsTail.render.test.tsx packages/agent/src/workflow/script-runner.test.ts packages/agent/src/workflow/runtime.test.ts packages/repl/src/commands/workflow-command.test.ts packages/repl/src/ui/view-models/workflow-live.test.ts packages/repl/src/ui/components/WorkflowRunSurface.test.tsx
npm test -- packages/repl/src/ui/utils/queued-prompt-sequence.test.ts packages/repl/src/ui/view-models/surface-liveness.test.ts packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts
npm test -- packages/repl/src/ui/utils/autocomplete-replacement.test.ts packages/repl/src/interactive/autocomplete.test.ts packages/repl/src/interactive/completers/argument-completer.test.ts packages/repl/src/interactive/autocomplete-provider.test.ts packages/repl/src/tui/core/screen.test.ts packages/repl/src/tui/core/selection.test.ts packages/repl/src/ui/utils/transcript-text-selection.test.ts packages/repl/src/ui/utils/transcript-layout.test.ts packages/repl/src/commands/workflow-command.test.ts packages/repl/src/ui/view-models/workflow-live.test.ts packages/repl/src/ui/components/WorkflowRunSurface.test.tsx packages/repl/src/ui/view-models/surface-liveness.test.ts packages/repl/src/ui/utils/transcript-input-policy.test.ts packages/repl/src/ui/utils/queued-prompt-sequence.test.ts packages/agent/src/workflow/script-runner.test.ts packages/agent/src/workflow/runtime.test.ts packages/coding/src/workflows/invocation-policy.test.ts packages/coding/src/workflows/run-manager.test.ts packages/coding/src/workflows/agent-adapter.test.ts
npm run build:packages
npm run build:dts
```

最新结果：2026-06-14 本轮 workflow UI/UX + reliability + 补全/选择扩展 gate 19 个测试文件 / 374 条测试通过；`npm run build:packages` 通过；`npm run build:dts` 通过（保留既有 Rollup `CompactionUpdate` / session-lineage chunk warning）；`git diff --check` 通过。此前补充 lifecycle cleanup 与 crash hardening 后 workflow/repl 扩展 gate 19 个测试文件 / 196 条测试通过，Phase P focused gate 7 个测试文件 / 92 条测试通过。

本次新增的 saved-workflow named reuse 验收（`/workflow rerun <runId|savedName>`、help 说明、rerun 补全）已在 v0.7.49 补齐自动化 gate；人工验收仍需执行本指南 TC-001 / TC-002A / TC-013，确认真实 REPL 文案和补全体验符合预期。

## 人工测试范围

人工测试只关注真实 REPL 交互、真实 provider 输出质量、确认提示 UX、状态栏显示、权限确认、真实 git worktree 副作用。

v0.7.49 UI/UX sign-off 还必须覆盖 workflow 的 agentic presentation：自然语言 / AMAW 触发时，运行过程应像普通 Agent 工作一样持续给出启动说明、子任务结论摘要和最终综合，而不是只显示 `info` 事件；显式 `/workflow create`、`/workflow rerun` 和 `/workflow <savedName>` 的审批/启动可以是命令式，但子任务摘要和最终结果也必须是 Assistant 消息；live surface 必须有最大高度、阶段序号、运行中智能体说明、总量感和明确的完成/失败状态；中文请求的解释性文案必须使用中文。

## 测试用例

### TC-001: `/workflow help` 能说明完整用法

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 启动 KodaX REPL。
2. 运行 `/workflow help`。

**预期结果**:

- [ ] 帮助中包含 `/workflow create <request>`、`list`、`runs [--all|--limit N]`、`show [runId]`、`pause`、`resume`、`stop`、`delete`、`prune`、`save`。
- [ ] 帮助中说明 generated / `.workflow.json` 走 capability runner。
- [ ] 帮助中说明 local `.ts/.mjs/.js` workflow 是 trusted-local，需要显式确认。
- [ ] 帮助中说明 `/workflow <savedName>` 是运行 saved capsule 的短入口，`/workflow rerun <runId>` 是重跑历史 run，`/workflow rerun <savedName>` 等价于运行该 saved capsule 当前版本。

### TC-002: 列出 built-in workflow 和 pattern templates

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 运行 `/workflow list`。

**预期结果**:

- [ ] Built-in workflows 中包含 `parallel-investigation`。
- [ ] Pattern templates 中包含 `adversarial-verification`、`tournament`、`loop-until-done`。
- [ ] 只有 project / personal workflow 目录中存在 saved workflow 文件时，才显示 saved workflows。

### TC-002A: `/workflow` 子命令补全不会替换命令前缀

**优先级**: 高
**类型**: UI / 输入体验测试

**测试步骤**:

1. 在 REPL 输入 `/workflow `，保留光标在末尾。
2. 触发补全或按 Tab。
3. 选择 `runs`、`show` 或 `stop` 等候选项。

**预期结果**:

- [ ] 补全候选包含 `runs`、`show`、`stop`、`delete`、`prune` 等 workflow 子命令。
- [ ] 接受 `runs` 后输入框变成 `/workflow runs`，不会变成单独的 `runs`。
- [ ] 对 `/workflow show ` 或 `/workflow stop `，补全应优先提示可用 run id；没有 run id 时仍能正常输入，不报错。
- [ ] 对 `/workflow rerun `，补全候选同时包含 recent run id 与 saved workflow name，并用说明区分 `recent run` / `saved workflow`。

### TC-003: Plan 模式显式生成复杂 workflow 并检查 raw script

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 将 permission mode 切到 `plan`。
2. 运行：

```text
/workflow create 当前kodax项目很大，测试需要很长时间，我希望加快。请建立一个 workflow，提出三个互相独立的竞争假设来优化，分别验证每个假设，最后综合出最可能成立的原因
```

3. 检查 approval prompt。
4. 批准运行。
5. 运行 `/workflow runs`、`/workflow show` 和 `/workflow show <runId>`。

**预期结果**:

- [ ] Approval prompt 显示 phases、agent / concurrency caps、token budget、write risk、source、sandbox / trust、worktree intent。
- [ ] Approval prompt 提供 raw script 查看方式，不能只依赖 generated summary。
- [ ] Workflow 在后台启动，并打印 run id。
- [ ] `/workflow runs` 能看到该 run。
- [ ] `/workflow show` 在不传 run id 时默认显示最近的 active run 或最近持久化 run。
- [ ] `/workflow show <runId>` 显示 status、event count、agent count、run dir、recent events；失败时显示 error。长结果只显示明确标注的预览，不出现裸 `[truncated]`。
- [ ] `/workflow show --full <runId>` 能显示完整最终结果或 artifact 内容；如果默认预览被截断，提示中应明确给出 `--full` 查看方式。
- [ ] Run dir 中存在 `run.json`、`events.jsonl`、`script.js`、`manifest.json`。

### TC-003A: 非 Plan 模式生成 workflow 不被审批打断但过程可见

**优先级**: 高
**类型**: 交互测试

**测试步骤**:

1. 将 permission mode 切到 `accept-edits` 或 `auto`。
2. 运行：

```text
/workflow create 当前 KodaX 项目很大，测试需要很长时间，请建立一个 workflow，提出三个互相独立的竞争假设来优化，分别验证每个假设，最后综合出最可能成立的原因
```

**预期结果**:

- [ ] 输入提交后，prompt 忙碌状态显示 `Workflow - generating harness`，不是只有静态 `Thinking...`。
- [ ] 生成返回后，状态能进入 `Workflow - validating harness` / `Workflow - harness ready` 或清晰失败。
- [ ] 非 Plan 模式不弹出 raw script 审批确认。
- [ ] 系统打印 generated summary、sandbox / trust、caps、worktree intent 和 run id。
- [ ] workflow 真正运行后，底部 activity bar 有 spinner；输入框上方或 inline surface 有类 TodoList 列表，至少包含 workflow/run id、当前 phase、active agents、done/failed 计数和 `/workflow show ...` / `/workflow stop ...` 提示。
- [ ] 如果 provider 超时，错误中包含类似 `workflow generation failed (timeout after 120000ms)`，REPL 可继续输入。

### TC-004: 简单请求应 decline 或可安全取消

**优先级**: 中
**类型**: 负向测试

**测试步骤**:

1. 运行：

```text
/workflow create 只把一个文件里的一个局部变量改名
```

**预期结果**:

- [ ] Generator 可以在 workflow 不合理时给出清晰 decline reason。
- [ ] 如果 generation 被 decline，不创建 workflow run。
- [ ] 如果 provider 仍生成 workflow，approval summary 应展示额外成本/风险，测试人员可安全取消。

### TC-005: AMAW 状态栏只显示短标签

**优先级**: 高
**类型**: UI 测试

**测试步骤**:

1. 运行 `/agent-mode amaw`。
2. 查看状态栏或 Ink 顶部模式显示。
3. 按 Alt+M，观察模式从 `AMAW` 变为 `SA`。
4. 再按 Alt+M 两次，观察模式依次变为 `AMA`、`AMAW`。
5. 运行 `/agent-mode` 查看当前模式。

**预期结果**:

- [ ] 状态栏显示 `AMAW`。
- [ ] 不出现 `AMA-workflow` 或 `AMA Workflow` 这样的长标签。
- [ ] `/agent-mode` 输出当前模式为 `AMAW`。
- [ ] Alt+M 可以进入 AMAW，不再只在 AMA / SA 两态之间切换。

### TC-006: AMA 支持显式 `/workflow`，但自然语言只建议

**优先级**: 高
**类型**: 交互测试

**测试步骤**:

1. 运行 `/agent-mode ama`。
2. 运行：

```text
用 workflow 分析这个 flaky test，提出三个互相独立的竞争假设并验证
```

3. 在建议确认提示中选择拒绝。
4. 重新输入一个没有显式 `workflow` 字样、但仍很复杂的请求，例如“请提出三个互相独立的竞争假设并验证”，在建议确认提示中选择拒绝。
5. 再运行 `/workflow create` 的复杂请求，确认显式入口仍可用。

**预期结果**:

- [ ] AMA 对自然语言 workflow 候选先询问是否生成并运行 workflow，不静默启动。
- [ ] 对显式 workflow 请求，拒绝后显示“Workflow request cancelled”，本轮不继续普通 AMA。
- [ ] 对仅因复杂度触发的 workflow 建议，拒绝后才继续普通 AMA。
- [ ] 如果要取消整个任务，运行中按 `Esc` 或 `Ctrl+C` 应立即中断。
- [ ] 显式 `/workflow create ...` 仍能进入 generated workflow approval prompt。

### TC-007: AMAW 对复杂自然语言任务静默启动 capability-isolated workflow

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 运行 `/agent-mode amaw`。
2. 直接输入：

```text
这个测试大约每 50 次会失败 1 次，请提出多个竞争假设，分别验证每个假设，并综合出最可能成立的根因
```

**预期结果**:

- [ ] 不出现额外的“是否使用 workflow?”确认提示。
- [ ] 系统生成 capability-isolated workflow；自然语言 / AMAW 路径显示 assistant-style 启动说明，不把 `Generated workflow`、`Run workflow ...`、`AMAW auto-start` 当普通 `info` 刷屏。
- [ ] 系统启动 workflow；run id 和 `/workflow show <runId>` / `/workflow stop [runId]` 通过启动说明或 live surface 可见。
- [ ] 运行中有 workflow spinner 和类 TodoList live surface；如果 agent 数量增加，阶段序号、进度行、show/stop 提示仍可见。
- [ ] 子 agent 的工具调用仍遵守当前 permission mode 的确认规则。
- [ ] 如果 capability runner 不可用，系统必须 fail closed 或要求显式确认，不能静默执行 host-object VM workflow。

### TC-007A: AMAW 不因普通 workflow 提及或单弱信号误触发

**优先级**: 高
**类型**: 行为边界 / 资源保护测试

**测试步骤**:

1. 运行 `/agent-mode amaw`。
2. 直接输入 `what does the workflow option do?`。
3. 再输入 `please verify this one file` 或 `sort this short list alphabetically`。
4. 观察是否出现 assistant-style workflow 启动说明、run id、workflow live surface。

**预期结果**:

- [ ] 这些输入不会静默启动 workflow。
- [ ] 系统按普通 AMA/AMAW 对话处理问题或请求，不创建 workflow run。
- [ ] 显式复杂请求（例如 `please create a workflow to compare three independent hypotheses and verify each one`）仍能启动 workflow。

### TC-008: AMAW 尊重否定指令

**优先级**: 高
**类型**: 负向测试

**测试步骤**:

1. 确认当前是 `/agent-mode amaw`。
2. 输入：

```text
不要用 workflow，也不要多 agent，直接告诉我这个函数做什么
```

**预期结果**:

- [ ] 不启动 workflow。
- [ ] 不打印 run id。
- [ ] 请求走普通对话/任务路径。

### TC-009: `/review --workflow` 走 workflow invocation path

**优先级**: 高
**类型**: 集成测试

**测试步骤**:

1. 准备一个有未提交 diff 的 git workspace。
2. 运行 `/review --workflow`。
3. 如果当前是 `plan` permission mode，检查并批准 generated workflow；如果是 `accept-edits` 或 `auto`，观察是否直接启动。
4. 对比运行普通 `/review`。

**预期结果**:

- [ ] `/review --workflow` 创建面向 code review 的 generated workflow request。
- [ ] workflow 启动后可用 `/workflow show <runId>` 查看。
- [ ] 普通 `/review` 仍返回普通 review prompt 路径，不启动 workflow。
- [ ] review workflow 的结果按 finding 优先，包含文件/diff 证据。

### TC-010: Trusted-local workflow 仍需显式确认

**优先级**: 高
**类型**: 安全测试

**测试步骤**:

1. 创建 `.kodax/workflows/local-demo.mjs`，导出合法 `{ meta, run }` workflow。
2. 在 AMAW 模式下运行 `/workflow local-demo`。

**预期结果**:

- [ ] KodaX 提示 local workflow 会执行本地代码。
- [ ] 拒绝确认时 run 被取消。
- [ ] 批准本地代码确认后，才继续进入正常 workflow approval prompt。
- [ ] AMAW 不会静默执行 trusted-local code。

### TC-011: Pause / Resume / Stop 活跃 workflow

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 启动一个会 launch 多个 child 的 generated 或 saved workflow。
2. 运行 `/workflow pause <runId>`。
3. 运行 `/workflow show <runId>`。
4. 运行 `/workflow resume <runId>`。
5. 再启动一个较长 run，并运行 `/workflow stop <runId>`。

**预期结果**:

- [ ] Pause 后 active status 变为 `paused`，并阻止后续 child launch。
- [ ] Resume 后 run 可以继续，不丢失已完成 child results。
- [ ] Stop 后 run 被 abort，最终状态变为 `stopped` 或失败信息明确指出已停止。
- [ ] 对已经 `failed` / `completed` / `stopped` 的 run 执行 `/workflow stop <runId>` 时，提示“already <status>”，并引导 `/workflow show <runId>` 或 `/workflow rerun <runId>`，而不是说 active run 不存在。
- [ ] `/workflow show` 不带 run id 时可显示最近 run；`/workflow show <runId>` 能显示 recent events、error 和 result 预览；`/workflow show --full <runId>` 能显示完整 artifact-backed 结果。
- [ ] pause / resume / stop 期间 REPL 仍保持可交互。

### TC-012: 从历史 run 复跑 generated workflow

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 完成或启动一个已在 run dir 中写出 `script.js` 和 `manifest.json` 的 generated workflow。
2. 运行：

```text
/workflow rerun <runId> {"request":"请用同样的 workflow 重新检查 packages/repl，只列出新问题"}
```

3. 运行 `/workflow runs` 和 `/workflow show <newRunId>`。

**预期结果**:

- [ ] 未执行 `/workflow save` 也能从 run history 加载原 generated script。
- [ ] 新 run 使用新的中文 request，不误用旧目标路径。
- [ ] 复跑仍通过 capability runner，不走 trusted-local direct import。
- [ ] 复跑期间历史区为每个已完成子 Agent 显示 assistant-style 有界完成摘要，而不是只有 live surface。
- [ ] 复跑完成后 Assistant 直接给出最终综合或明确失败原因，不能只提示用户去 `/workflow show <newRunId>`。
- [ ] 若 run id 不存在或格式非法，错误信息清晰，不能访问其他路径。

### TC-013: 保存 generated workflow capsule 并复跑

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 完成或启动一个已在 run dir 中写出 `script.js` 和 `manifest.json` 的 generated workflow。
2. 运行 `/workflow save <runId> generated-audit`。
3. 打开 `.kodax/workflows/generated-audit.workflow.json`，检查字段。
4. 运行 `/workflow list`。
5. 运行：

```text
/workflow generated-audit {"request":"请对 packages/coding 执行同样的审计，并只报告新增发现"}
```

6. 再运行：

```text
/workflow rerun generated-audit {"request":"请对 packages/repl 执行同样的审计，并只报告新增发现"}
```

**预期结果**:

- [ ] 创建 `.kodax/workflows/generated-audit.workflow.json`。
- [ ] 文件包含 `format:"kodax.workflow"`、`version:1`、`manifest`、`source`、`intent`、`inputs`、`requires`、`provenance`。
- [ ] `source` 是 generated JavaScript harness 原文，不是 template id。
- [ ] `/workflow list` 将该 workflow 显示为 `capability-generated`。
- [ ] 复跑时通过 capability runner 加载，而不是 direct Node import。
- [ ] `.workflow.json` 不出现 trusted-local code execution prompt；但正常 workflow approval 仍会出现。
- [ ] 复跑接受新的 args，不误用旧 request 文本。
- [ ] `/workflow rerun generated-audit ...` 也能解析为 saved workflow 当前版本；输出或审批提示应说明它使用的是 saved workflow name，而不是历史 run id。
- [ ] `/workflow rerun generated-audit ...` 的子 Agent 有界完成摘要和最终综合仍以 Assistant 消息出现，并跟随请求语言。
- [ ] 如果存在同名 run id / saved workflow name 歧义，命令 fail closed，并提示用户使用更明确的标识。

### TC-014: Capsule preflight 能提示环境差异

**优先级**: 中
**类型**: 边界测试

**测试步骤**:

1. 保存一个 manifest 中声明 may use worktree 的 generated workflow capsule。
2. 在非 git 仓库目录启动 KodaX，或临时移动到无法创建 worktree 的目录。
3. 运行 `/workflow generated-audit {"request":"请尝试复用这个 workflow 检查当前目录"}`。

**预期结果**:

- [ ] KodaX 在执行前给出 `git-repo` / `worktree-capable` 相关提示或失败信息。
- [ ] 不会静默忽略 capsule 中声明的环境依赖。
- [ ] 如果用户回到 git 仓库环境，workflow 可以继续正常执行。

### TC-015: Worktree isolation 是 opt-in

**优先级**: 高
**类型**: 集成测试

**测试步骤**:

1. 用 `/workflow create` 发起一个迁移/重构请求，明确要求多个 child 使用隔离 worktree 分别尝试写入方案。
2. 批准一个 manifest 表明 may use worktrees 的 generated workflow。
3. 检查 child output 和 run events。

**预期结果**:

- [ ] 普通 child 默认仍使用 shared cwd。
- [ ] 请求 `isolation:"worktree"` 的 child 运行在 dedicated worktree path 中。
- [ ] Child summary 中包含 workflow worktree path，便于后续 inspection / merge。
- [ ] Child 结束后，创建出的 worktree 仍然可检查。

### TC-016: Generated workflow 不能逃逸到宿主 Node 权限

**优先级**: 高
**类型**: 安全回归测试

**测试步骤**:

1. 使用自动化测试或临时 saved `.workflow.json` 构造包含以下片段的 generated source：
```text
async function run(wf, args) {
  return wf.constructor.constructor('return process')().versions.node;
}
```
2. 再构造一个尝试使用 `globalThis.constructor.constructor('return process')()` 的变体。
3. 运行对应 workflow。

**预期结果**:

- [ ] workflow 失败在 capability runner 内部，不能返回 Node 版本号。
- [ ] 不能读取 `process.env`。
- [ ] 不能直接 `require('child_process')` 或 dynamic import Node 内置模块。
- [ ] 失败信息清晰，不导致主 REPL 崩溃。

### TC-017: Manifest cap 会被系统硬顶钳制

**优先级**: 高
**类型**: 边界测试

**测试步骤**:

1. 生成或保存一个 manifest 声明 `maxAgents: 999999`、`maxConcurrency: 999999` 的 workflow。
2. 执行该 workflow。
3. 查看 approval prompt、run events 和 `/workflow show <runId>`。

**预期结果**:

- [ ] approval prompt 显示实际执行 caps 已被系统硬顶限制。
- [ ] workflow 无法超过系统 hard cap 派生 agent。
- [ ] 裸 `wf.spawnAgent` 与 `wf.runAgent` 一样受 maxConcurrency 约束。

### TC-018: Workflow run 历史不会刷屏，并支持显式清理

**优先级**: 高
**类型**: UX / 运维测试

**测试步骤**:

1. 连续运行多个很快结束的 workflow，或使用已有历史记录，让 persisted runs 数量超过 20 条。
2. 运行 `/workflow runs`。
3. 运行 `/workflow runs --limit 5`。
4. 运行 `/workflow runs --all`。
5. 选择一个已经 `completed` / `failed` / `stopped` 的 run，运行 `/workflow delete <runId>`，然后再运行 `/workflow runs --all`。
6. 运行 `/workflow prune --dry-run`。
7. 运行 `/workflow prune --keep 5 --dry-run`，确认预览结果后再运行 `/workflow prune --keep 5`。
8. 如果当前有 running / paused workflow，确认它不会被 delete/prune 误删。

**预期结果**:

- [ ] `/workflow runs` 默认只显示最近 20 条 persisted runs，并提示可用 `/workflow runs --all` 查看全部。
- [ ] `/workflow runs --limit 5` 只显示 5 条 persisted runs。
- [ ] `/workflow runs --all` 可以显示全部 persisted runs。
- [ ] `/workflow delete <runId>` 删除单条 persisted run；active run 会提示先 stop，不会被删除。
- [ ] `/workflow prune --dry-run` 只预览，不删除任何记录。
- [ ] `/workflow prune --keep 5` 只清理 terminal runs，保留最新 5 条 terminal runs，并保护 running / paused。
- [ ] v0.7.49 不会后台自动删除历史；自动 retention 属于 v0.7.50 / FEATURE_229。

### TC-019: 自然语言 workflow 运行时像 Agent 汇报，而不是 info 日志

**优先级**: 高
**类型**: UX / 本地化测试

**测试步骤**:

1. 运行 `/agent-mode amaw`。
2. 直接输入中文自然语言任务：

```text
请你建 workflow 来非常仔细检查 feature 217 改动后可能引起的 UI 问题，只做问题探查不做修复
```

3. 观察 workflow 启动后的 live surface、历史记录和最终输出。
4. 等至少一个 child agent 完成，再观察历史区是否出现该子任务的结果摘要。
5. 如果 agent 数量超过 live surface 最大行数，继续观察输入栏、状态栏和提示行是否仍可见。
6. workflow 完成后，查看最终回答与 `/workflow show <runId>`。

**预期结果**:

- [ ] Live surface 有最大高度，不因 agent 多或文本长而挤掉输入栏 / 状态栏。
- [ ] Live surface 显示整体进度：如果 workflow 声明了计划智能体数，中文请求显示类似 `0/7 完成（1 个智能体运行中，已启动 1，上限 14）`；如果没有计划数，英文请求显示类似 `1/3 finished (2 active agents, cap 8)`。失败/停止会进入同一进度行，不能只显示 `2 done`。
- [ ] Live surface header 显示运行时长和 workflow token 用量（来自已完成 child 的真实 usage）；计时刷新应与普通 Agent spinner 一样持续更新，不出现卡住或另起一套不同步动画。
- [ ] Live surface 展示当前阶段序号（例如 `2/4 parallel-deep-analysis`）、可见运行中智能体、`已完成 / 计划数` 或 `已完成 / 已启动` 进度、agent 上限和 show/stop hint；`agent 上限` 是安全上限，不应被显示成“总任务数”或百分比进度分母。完成详情通过历史区 child digest 与 `/workflow show <runId>` 查看，不把所有 child chat 倾倒到主历史。
- [ ] 自然语言 / AMAW 路径的启动说明和普通运行进展不使用 `info` 样式刷历史；`info` 主要保留给显式 slash 命令结果、确认/权限提示和错误。
- [ ] 每个完成的 child agent 都在历史区出现中文有界结果摘要，且至少包含一个有效结论：具体发现、判断、风险、证据指针、未决问题或下一步。如果 child 返回长报告或非中文报告，历史区显示 3-4 行左右的中文摘录摘要；不能折叠掉摘要本身，也不能只说“报告较长、稍后汇总”。
- [ ] workflow 子 Agent 完成后，KodaX 会在同一个 child session 中追加一次无工具、单轮的自蒸馏请求，生成 2-4 条给用户看的摘要；runtime 优先把该 `digest` 写进 `agent_completed.summary`，完整 child `finalText` 仍用于 synthesis / artifact / audit。历史区展示摘要中的结论/证据/风险/下一步，并标成“摘要”。如果自蒸馏失败或没有有效内容，fallback 到 deterministic extraction，标成“摘录摘要”，并跳过 `[workflow handoff]` 原始标记、 “I now have...” / “Here is my report” / 报告标题 / markdown 表头 / 断裂片段等低信息内容。
- [ ] 子任务完整输出不会全部刷进历史；需要更多细节时先用 `/workflow show <runId>` 查看事件和 artifacts，完整 child-chat 级别详情属于后续 FEATURE_229/system process surface。
- [ ] workflow 完成后自动在当前对话中显示完整中文最终回答或 artifact 摘要，而不是只显示 `Workflow completed` 与 `/workflow show <runId>` 提示；即使最终结果很长，主历史区也不能截断、不能要求用户通过 `/workflow show --full <runId>` 才能看到完整答案，也不能出现裸 `[truncated]`。
- [ ] 如果 run 只产出 artifact，历史区至少显示 artifact 名称、路径和简短说明；如果没有可显示结果，必须明确提示“已完成但没有可显示结果”，不能假装正常完成。
- [ ] 主历史区展示每个完成 child agent 的有界摘要和完整最终回答，不默认倾倒所有 child chat；`/workflow show <runId>` 用于查看运行事件时间线、状态和 artifacts，完整 child-chat 详情属于后续 FEATURE_229 详情入口。
- [ ] workflow 完成后再输入 `你好`，系统应按新话题正常问候或询问需要什么帮助，不能沿着刚才 workflow 的任务继续读文件、跑工具或规划同一个调查。
- [ ] 如果 workflow 期间确实排队了 follow-up，完成后必须明确显示 queued prompt，并允许取消/编辑；不能在用户输入新话题时静默消费旧 queued prompt。
- [ ] 中文请求下，状态标签、解释、摘要和最终回答使用中文；命令、run id、workflow id、agent id 保持英文稳定标识，live 区使用“智能体”而不是含糊的“代理”。
- [ ] 如果 child 摘要无法安全内联，workflow 不失败；历史区出现可理解的摘要不可用 fallback，并保留 `/workflow show <runId>` 查看运行事件时间线/产物的提示，不能暗示该命令能查看完整 child 原文。
- [ ] 复杂 workflow 不会因为默认 30 分钟总墙钟 timeout 在 synthesis 前后被杀；如果需要中断，用户可用 `/workflow stop [runId]`，脚本死循环仍会被同步 watchdog 拦住。
- [ ] 选择/复制包含彩色 `Workflow runs` 或 live/history 行时，复制出来的是可读纯文本，不含 `ESC[32m`、`ESC[39m`、`\u001b[` 等 ANSI 控制字符；不同颜色的行不会造成明显左右选区偏移。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 20 | 待填写 | 待填写 | 待填写 |

**测试结论**: 待填写
**发现的问题**: 待填写

生成时间：2026-06-13
Feature ID：FEATURE_217

### TC-021: `/workflow rerun` 审批提示不刷屏

**优先级**: 高
**类型**: UX / 回归测试

**测试步骤**:

1. 找一个 generated workflow run，例如 `/workflow runs` 中显示的 `run-...`。
2. 运行：
```text
/workflow rerun <runId>
```
3. 在审批提示中选择拒绝。

**预期结果**:

- [ ] 审批提示展示 workflow 名称、说明、phases、agent cap、concurrency、token budget、write risk、source、sandbox/trust、worktree isolation。
- [ ] 对已有 run snapshot / saved capsule，长脚本只显示 `raw script` 路径，不内联 `raw script preview`，不会把完整脚本刷满整个屏幕。
- [ ] 预览被截断时有明确省略提示，用户知道完整源码在 run snapshot 或 capsule 文件中。
- [ ] 拒绝后只显示简短的 workflow cancelled/cancelled 信息，不继续启动 workflow，也不进入普通 AMA fallback。
