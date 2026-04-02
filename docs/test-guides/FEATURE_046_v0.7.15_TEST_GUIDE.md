# FEATURE_046 AAMP SDK Transport Surface - 人工测试指导

## 功能概述

**功能名称**: `FEATURE_046: AAMP SDK Transport Surface`
**版本**: `v0.7.15`
**测试日期**: `2026-04-02`
**测试人员**: `[待填写]`

**功能描述**:
`FEATURE_046` 为 KodaX 增加一个基于 `AAMP SDK` 的正式异步传输面，使外部 agent、workflow、mailbox network 可以把 KodaX 作为一个可寻址的异步执行节点来使用。当前阶段目标是验证最小闭环：`task.dispatch -> task.ack -> task.result`，并确认 task/session 绑定、状态持久化、失败回执和重复任务幂等行为符合设计预期。

---

## 测试环境

### 前置条件
- 已安装项目依赖，并可正常运行 `kodax` CLI
- 已准备可用的 AAMP mailbox 环境
- 已配置可用的模型 provider，使 `runKodaX(...)` 能实际执行
- 测试机具备查看本地状态文件的权限
- 已确认目标仓库目录存在且可读写

### 环境变量
- `KODAX_AAMP_EMAIL`
- `KODAX_AAMP_JMAP_TOKEN`
- `KODAX_AAMP_JMAP_URL`
- `KODAX_AAMP_SMTP_HOST`
- `KODAX_AAMP_SMTP_PASSWORD`

### 观察点
- 终端输出
- AAMP mailbox 中的 `task.ack` / `task.result`
- 本地状态文件 `~/.kodax/aamp/tasks.json`
- 被执行仓库中的实际任务效果

---

## 完备性判定标准

当以下条件全部满足时，可认为 `FEATURE_046` 达到当前阶段的完备性要求：

- `kodax aamp serve` 可稳定启动
- 首次收到 `task.dispatch` 时会创建 task record
- 能完成 `ACK -> 执行 -> result` 最小闭环
- task 状态会持久化为 `received -> acknowledged -> running -> completed/failed`
- 同一已完成 task 的重复 dispatch 不会重复执行
- 失败场景能回发失败结果并持久化 `failed`
- task 与本地 session 的绑定稳定可观察

以下能力不属于当前阶段未完成项，不应作为本次完备性否定条件：

- `task.help_needed`
- 附件 relay
- structured result schema enforcement
- sender policy / dispatch context policy

---

## 测试用例

### TC-001: CLI 启动入口可用

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- `kodax` 可执行

**测试步骤**:
1. 执行 `kodax -h aamp`
2. 检查帮助信息是否包含 `serve` 子命令和 AAMP 相关参数
3. 执行 `kodax aamp serve`
4. 观察缺少配置时的错误提示
5. 使用完整参数或环境变量重新启动服务

**预期效果**:
- [ ] 帮助信息展示 `AAMP async task worker`
- [ ] 帮助信息包含 `--email`、`--jmap-token`、`--jmap-url`、`--smtp-host`、`--smtp-password`
- [ ] 缺少配置时，错误提示明确指出缺失项
- [ ] 配置完整时服务可正常启动

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: 首次 dispatch 跑通最小闭环

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- AAMP worker 已启动
- 可从外部向该 mailbox 发送 `task.dispatch`

**测试步骤**:
1. 向 worker 发送一个简单任务，例如“请用一句话总结当前仓库用途”
2. 记录该任务的 `taskId`
3. 观察是否收到 `task.ack`
4. 观察是否收到最终 `task.result`

**预期效果**:
- [ ] 首次 dispatch 后收到 ACK
- [ ] ACK 的 `taskId` 与入站任务一致
- [ ] 最终收到 `task.result`
- [ ] `task.result` 的 `inReplyTo` 对应原始消息
- [ ] 返回结果文本非空

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: 本地状态持久化正确

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已完成至少一个 AAMP 任务

**测试步骤**:
1. 打开 `~/.kodax/aamp/tasks.json`
2. 查找对应 `taskId` 的 record
3. 检查 record 中的关键字段
4. 验证成功场景是否写为 `completed`
5. 验证失败场景是否写为 `failed`

**预期效果**:
- [ ] 存在对应 `taskId` 的 record
- [ ] record 包含 `aampTaskId`、`sessionId`、`status`、`senderEmail`、`inboundMessageId`、`createdAt`、`updatedAt`
- [ ] 若 dispatch 带有上下文，则 `dispatchContext` 被保存
- [ ] 成功任务有 `resultSummary`
- [ ] 状态流转最终落为 `completed` 或 `failed`

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: dispatchContext 能进入执行上下文

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 可发送带 `dispatchContext` 的 AAMP 任务

**测试步骤**:
1. 发送一个带 `dispatchContext` 的任务，例如 `project_key=proj_123`、`user_key=alice`
2. 任务内容要求模型在结果中复述收到的上下文
3. 观察最终 `task.result`
4. 检查 `tasks.json` 中该 task 的持久化内容

**预期效果**:
- [ ] 结果中能体现 dispatch context 已进入执行上下文
- [ ] `tasks.json` 中存在对应的 `dispatchContext`
- [ ] 没有因 `dispatchContext` 导致任务失败

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: 已完成 task 的重复 dispatch 不会重复执行

**优先级**: 高
**类型**: 边界测试

**前置条件**:
- 已有一个完成状态的 task

**测试步骤**:
1. 发送一个任务并等待完成
2. 使用相同 `taskId` 再次发送相同 `task.dispatch`
3. 观察 worker 是否再次执行任务
4. 观察 ACK / result 是否再次发送
5. 检查状态文件是否产生新的 session 绑定

**预期效果**:
- [ ] 不会重复执行已完成任务
- [ ] 不会新建新的 `sessionId`
- [ ] 不会重复发送新的结果
- [ ] 状态文件仍只有同一条 task 记录

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: 执行失败时回发失败结果

**优先级**: 高
**类型**: 负向测试

**前置条件**:
- AAMP worker 已启动

**测试步骤**:
1. 构造一个必然失败的任务，例如引用不存在的路径或不可执行的仓库上下文
2. 发送任务
3. 观察是否收到失败结果
4. 检查 `tasks.json` 中的 task 状态

**预期效果**:
- [ ] 收到失败的 `task.result`
- [ ] 失败结果文本非空
- [ ] 持久化状态写为 `failed`
- [ ] `resultSummary` 记录了错误摘要

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: task 与 session 绑定稳定

**优先级**: 高
**类型**: 边界测试

**前置条件**:
- 至少处理过一个 task

**测试步骤**:
1. 发送任务并等待完成
2. 在 `tasks.json` 中记录该 task 对应的 `sessionId`
3. 再次发送同一 `taskId` 的重复 dispatch
4. 检查 `sessionId` 是否变化

**预期效果**:
- [ ] 首次处理时生成 `sessionId`
- [ ] 同一 `taskId` 的后续处理不会改写该 `sessionId`
- [ ] 已完成 task 的重复 dispatch 不会创建新的 session 绑定

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: result 输出回填逻辑合理

**优先级**: 中
**类型**: 边界测试

**前置条件**:
- 可发送不同类型的任务

**测试步骤**:
1. 发送一个能正常产出明确文本结果的任务
2. 发送一个可能没有明显最终文本的任务
3. 观察 `task.result.output`

**预期效果**:
- [ ] 正常任务输出最终文本
- [ ] 无明显最终文本时会有 fallback 文案，而不是空字符串
- [ ] 不会出现空白 result

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: worker 重启后状态仍可读

**优先级**: 中
**类型**: 可恢复性测试

**前置条件**:
- 已有已完成 task 被持久化

**测试步骤**:
1. 完成一个任务
2. 停止 worker
3. 重新启动 worker
4. 查看 `tasks.json`
5. 再发送一个新任务

**预期效果**:
- [ ] 重启后旧任务记录仍存在
- [ ] 状态文件未损坏
- [ ] 新任务仍可正常执行
- [ ] 新旧记录可共存

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: CLI 参数与环境变量都可驱动启动

**优先级**: 中
**类型**: 兼容性测试

**前置条件**:
- 可同时使用 CLI 参数和环境变量

**测试步骤**:
1. 仅使用 CLI 参数启动一次 worker
2. 仅使用环境变量启动一次 worker
3. 参数和环境变量混用启动一次 worker
4. 每次都发送一个简单任务做验证

**预期效果**:
- [ ] 三种启动方式都可用
- [ ] 环境变量命名与 README 保持一致
- [ ] CLI 参数覆盖同名环境变量

**实际结果**: `[待填写]`
**是否通过**: [ ] Pass / [ ] Fail

---

## 额外确认项

### EC-001: ACK 语义与真实 SDK 行为一致
- [ ] 真实环境中能收到 ACK
- [ ] 不会出现重复 ACK
- [ ] `aamp-sdk` 自动 ACK 行为与当前抽象层一致

### EC-002: 失败状态对外映射符合接收方预期
- [ ] 外部系统能正确理解失败结果
- [ ] `failed` 在 SDK 层映射为 `rejected` 不会造成协议歧义

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 10 | - | - | - |

**测试结论**: `[待填写]`

**发现的问题**:
- `[待填写]`

---

*测试指导生成时间: 2026-04-02*
*Feature ID: 046*
