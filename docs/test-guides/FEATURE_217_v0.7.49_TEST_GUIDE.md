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
- Restricted workflow runner 禁止直接 `process` / `require` / dynamic import / runaway sync loop。
- Runtime 事件顺序、maxAgents、maxConcurrency、token budget、abort propagation。
- Coding workflow adapter 的 spawn / wait / output / send / stop 映射。
- Durable run graph：`run.json`、`events.jsonl`、`artifacts`、`script.js`、`manifest.json`。
- Workflow generator 的 generate / decline 解析和 manifest validation。
- Saved workflow capsule discovery、restricted rerun、legacy `.workflow.json` compatibility、trusted-local confirmation。
- Generated JS capability runner 逃逸回归：不能通过 `wf.constructor.constructor('return process')()`、`globalThis.constructor` 等路径拿到宿主 `process`。
- Background run manager：list / show / pause / resume / stop。
- `/workflow` 子命令 parsing、help、approval prompt、saved-list、run-list、rerun、save capsule。
- AMAW invocation policy、`/agent-mode amaw`、状态栏短标签 `AMAW`、`/review --workflow` request builder。
- AMAW 按 AMA-family 预算运行；Alt+M 可从 AMAW 切回 SA。

最近自动化 gate：

```powershell
npm test -- packages/agent/src/workflow packages/coding/src/workflows packages/coding/src/child-executor.test.ts packages/repl/src/commands/workflow-command.test.ts packages/repl/src/commands/review-command.test.ts packages/repl/src/interactive/commands-help.test.ts packages/repl/src/ui/view-models/status-bar.test.ts packages/repl/src/ui/view-models/ama-summary.test.ts packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts packages/coding/src/task-engine/_internal/managed-task/budget.test.ts
npm run build:packages
npm run build:dts
```

最近结果：21 个相关测试文件 / 211 个测试通过；`build:packages` 通过；`build:dts` 通过（保留既有 Rollup session-lineage chunk warning）。

最新验证结果：扩展 workflow gate `20` 个测试文件、`194` 条测试通过；`npm run build:packages` 通过。测试输出末尾出现一条非致命 `Could not access 'HEAD'` stderr，但测试进程退出码为 `0`。

## 人工测试范围

人工测试只关注真实 REPL 交互、真实 provider 输出质量、确认提示 UX、状态栏显示、权限确认、真实 git worktree 副作用。

## 测试用例

### TC-001: `/workflow help` 能说明完整用法

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 启动 KodaX REPL。
2. 运行 `/workflow help`。

**预期结果**:

- [ ] 帮助中包含 `/workflow create <request>`、`list`、`runs`、`show`、`pause`、`resume`、`stop`、`save`。
- [ ] 帮助中说明 generated / `.workflow.json` 走 capability runner。
- [ ] 帮助中说明 local `.ts/.mjs/.js` workflow 是 trusted-local，需要显式确认。

### TC-002: 列出 built-in workflow 和 pattern templates

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 运行 `/workflow list`。

**预期结果**:

- [ ] Built-in workflows 中包含 `parallel-investigation`。
- [ ] Pattern templates 中包含 `adversarial-verification`、`tournament`、`loop-until-done`。
- [ ] 只有 project / personal workflow 目录中存在 saved workflow 文件时，才显示 saved workflows。

### TC-003: 显式生成复杂 workflow

**优先级**: 高
**类型**: 正向测试

**测试步骤**:

1. 运行：

```text
/workflow create 这个测试大约每 50 次会失败 1 次。请建立一个 workflow，提出三个互相独立的竞争假设，分别验证每个假设，最后综合出最可能成立的原因
```

2. 检查 approval prompt。
3. 批准运行。
4. 运行 `/workflow runs` 和 `/workflow show <runId>`。

**预期结果**:

- [ ] Approval prompt 显示 phases、agent / concurrency caps、token budget、write risk、source、sandbox / trust、worktree intent。
- [ ] Approval prompt 提供 raw script 查看方式，不能只依赖 generated summary。
- [ ] Workflow 在后台启动，并打印 run id。
- [ ] `/workflow runs` 能看到该 run。
- [ ] `/workflow show <runId>` 显示 status、event count、agent count、run dir。
- [ ] Run dir 中存在 `run.json`、`events.jsonl`、`script.js`、`manifest.json`。

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
3. 运行 `/agent-mode` 查看当前模式。

**预期结果**:

- [ ] 状态栏显示 `AMAW`。
- [ ] 不出现 `AMA-workflow` 或 `AMA Workflow` 这样的长标签。
- [ ] `/agent-mode` 输出当前模式为 `AMAW`。

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
4. 再运行 `/workflow create` 的复杂请求，确认显式入口仍可用。

**预期结果**:

- [ ] AMA 对自然语言 workflow 候选先询问是否生成并运行 workflow，不静默启动。
- [ ] 拒绝建议后，输入可以继续走普通 agent 路径。
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
- [ ] 系统生成 capability-isolated workflow，并打印 generated summary。
- [ ] 系统启动 workflow 并打印 run id 与 `/workflow show <runId>` 提示。
- [ ] 子 agent 的工具调用仍遵守当前 permission mode 的确认规则。
- [ ] 如果 capability runner 不可用，系统必须 fail closed 或要求显式确认，不能静默执行 host-object VM workflow。

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
3. 如果在 AMA/SA 中，审批 generated workflow；如果在 AMAW 中，观察是否直接启动。
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

**预期结果**:

- [ ] 创建 `.kodax/workflows/generated-audit.workflow.json`。
- [ ] 文件包含 `format:"kodax.workflow"`、`version:1`、`manifest`、`source`、`intent`、`inputs`、`requires`、`provenance`。
- [ ] `source` 是 generated JavaScript harness 原文，不是 template id。
- [ ] `/workflow list` 将该 workflow 显示为 `capability-generated`。
- [ ] 复跑时通过 capability runner 加载，而不是 direct Node import。
- [ ] `.workflow.json` 不出现 trusted-local code execution prompt；但正常 workflow approval 仍会出现。
- [ ] 复跑接受新的 args，不误用旧 request 文本。

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

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 17 | 待填写 | 待填写 | 待填写 |

**测试结论**: 待填写
**发现的问题**: 待填写

生成时间：2026-06-13
Feature ID：FEATURE_217
