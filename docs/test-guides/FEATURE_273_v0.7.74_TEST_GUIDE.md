# FEATURE_273 v0.7.74 - 人工测试指南

## 功能概览

**功能名称**: Mailbox-Driven Agent Wait 与遥测/控制面分离
**版本**: v0.7.74
**测试日期**: 2026-07-23
**测试人员**: [待填写]

`wait_agent` 现在只等待调用者邮箱、根用户输入、中断或超时。Actor
progress 继续提供给 UI、SDK 与诊断日志，但不会唤醒父模型。工具只返回小型
wake acknowledgement；实际 Agent 消息或完成结果在下一安全边界作为 synthetic
mailbox evidence 注入。

---

## 测试环境

### 前置条件

- Node.js 20+，在 KodaX 仓库完成 `npm install` 和 `npm run build`。
- 准备一个能启动 2-3 个并行 Agent、持续至少 2 分钟的代码审查任务。
- 可以查看 Session 日志、模型调用次数/token usage、Actor event stream 和最终 transcript。
- SDK 场景需能调用 Actor `events`/`wait` API。

### 记录要求

- 保存 Session ID、每次 `wait_agent` 的开始/结束时间与返回状态。
- 记录父模型调用次数、总 token、Actor progress 数量和 mailbox delivery 数量。
- 失败时保存完整日志，不以终端截图代替原始 Session 记录。

---

## 测试用例

### TC-001: progress 风暴不唤醒父模型

**优先级**: 高
**类型**: 回归/性能测试

1. 启动 3 个会持续报告 progress 的并行 Agent。
2. 让根 Worker 在没有其他可做工作时调用一次 `wait_agent({timeout_ms:120000})`。
3. 在 60 秒内产生至少 100 条 `turn_progress` 或等价活动事件，并排队一条 Runtime `system-reminder`，但不发送 Agent 消息，也不结束子任务。
4. 对比 progress 数量、`wait_agent` 返回次数与父模型调用次数。

**预期结果**:

- [ ] UI/SDK 能连续观察 progress。
- [ ] progress 不会结束 `wait_agent`，也不会产生父模型重采样。
- [ ] `system-reminder` 不会独立结束 `wait_agent`。
- [ ] 日志中不再出现数毫秒一次的 `wait_agent`/Thinking 循环。

### TC-002: 20 秒与 90 秒长等待不消耗额外模型 token

**优先级**: 高
**类型**: 性能测试

1. 分别安排子 Agent 在约 20 秒和约 90 秒后发送完成结果。
2. 根 Worker 各调用一次足够长的 `wait_agent`。
3. 记录等待期间父模型调用次数和 token usage。

**预期结果**:

- [ ] 单次工具调用可以真实挂起约 20 秒或 90 秒。
- [ ] 等待期间没有父模型调用或 token 增量；只有唤醒后的下一轮产生 token。
- [ ] 工具耗时长不被误判为 token 浪费或忙轮询。

### TC-003: Agent 消息通过 mailbox 唤醒并保持 synthetic 身份

**优先级**: 高
**类型**: 正向/数据完整性测试

1. 根 Worker 调用 `wait_agent`。
2. 运行中的直接子 Agent 调用 `send_message` 发回一个带唯一标记的消息。
3. 检查工具结果与下一轮 transcript。

**预期结果**:

- [ ] `wait_agent` 返回 `status:"mailbox"`，不内嵌 Actor events。
- [ ] 下一轮出现带唯一标记的 `<agent-message>` evidence。
- [ ] 该消息标记为 synthetic，而不是用户亲自发送的 prompt。
- [ ] 消息只交付一次。

### TC-004: Agent 完成结果与结构化元数据交付

**优先级**: 高
**类型**: 正向/一致性测试

1. 启动一个会返回摘要和 artifact metadata 的子 Agent。
2. 根 Worker 调用 `wait_agent`，让子 Agent 正常完成。
3. 检查下一轮 transcript、Todo checkpoint 和完成回执。

**预期结果**:

- [ ] 工具仅返回 wake acknowledgement。
- [ ] `<agent-completed>` 正文和 `_taskResult`/`_taskResults` 元数据一起进入 synthetic context。
- [ ] Todo 提醒由结构化完成元数据触发，不解析 wait ack 猜测完成状态。
- [ ] 同一 turn 的完成正文不会因 `agent_output` 或 idle-yield 再次重复注入。

### TC-005: 排队用户输入优先唤醒且不被消费

**优先级**: 高
**类型**: 交互/会话隔离测试

1. 根 Worker 处于 `wait_agent` 等待中。
2. 从 REPL 发送一条带唯一标记的用户 follow-up。
3. 同时让子 Agent 产生 progress；可在相近时间发送 Agent 消息。

**预期结果**:

- [ ] `wait_agent` 返回 `status:"user_input_pending"`。
- [ ] 用户 prompt 在下一安全边界作为真实 user turn 交付，内容不丢失。
- [ ] 同时到达的 Agent evidence 仍为 synthetic。
- [ ] 其他 Session 或子 Actor 的队列不会被错误消费。

### TC-006: timeout、边界与中断

**优先级**: 高
**类型**: 边界/负向测试

1. 在无 mailbox 活动时调用 `wait_agent({timeout_ms:10000})`。
2. 分别尝试 9999、3600001、小数和字符串 timeout。
3. 再调用一次长等待，并通过 Esc/Abort 中断当前 run。

**预期结果**:

- [ ] 10 秒后返回 `status:"wait_expired"`。
- [ ] 非整数或 10,000-3,600,000 之外的值返回明确参数错误。
- [ ] 中断及时返回 `status:"interrupted"`，订阅与 timer 均被清理。

### TC-007: SDK raw event 能力无回退

**优先级**: 高
**类型**: SDK 兼容性测试

1. 使用 SDK 的 Actor event snapshot/replay API 读取已有 progress。
2. 使用 SDK long-poll `wait` 从指定 sequence 等待下一事件。
3. 同时确认模型可见的 `wait_agent` schema。

**预期结果**:

- [ ] SDK 仍可读取 progress、terminal event、sequence 和 replay history。
- [ ] SDK long-poll 行为与 capability/version 声明没有变化。
- [ ] 模型工具 schema 只有 `timeout_ms`，不再暴露 `return_on`、`after_sequence` 或 `max_events`。

### TC-008: 旧 transcript 参数不能重新启用 event wake

**优先级**: 中
**类型**: 升级兼容测试

1. 从旧 Session transcript 重放一个包含 `return_on:"event"` 和 `after_sequence` 的历史 `wait_agent` 调用。
2. 在等待期间只产生 progress，再发送一条 mailbox 消息。

**预期结果**:

- [ ] Runtime 不崩溃，旧的额外字段不会重新启用 progress wake。
- [ ] 只有 mailbox 消息、用户输入、中断或 timeout 能结束等待。
- [ ] 新模型无法从当前 schema 生成已删除的 event selector。

### TC-009: 未确认完成通知在 Runtime 恢复后可继续交付

**优先级**: 高
**类型**: 恢复/幂等性测试

1. 启动一个子 Agent，让其完成并持久化 Actor snapshot，但在父 transcript 提交该完成通知前终止进程。
2. 使用相同 Session ID 恢复 Runtime，调用 `wait_agent` 或进入下一安全边界。
3. 再模拟同一进程内 Runtime Registry 软重建，同时保留进程级 MessageQueue。
4. 提交恢复出的 synthetic 完成通知后，再次重启相同 Session。

**预期结果**:

- [ ] 硬重启后，未确认 `<agent-completed>` 与结构化 `task_result` 重新进入正确的 session/Actor 队列。
- [ ] 软重建不会为同一 `turnId` 生成第二份排队通知。
- [ ] transcript 提交并确认后，后续恢复不再重放该完成通知。
- [ ] 缺少新 pending-delivery 字段的旧快照不会把历史 completion 误判为待交付。
- [ ] 其他 Session 的通知数量与内容不受影响。

---

## 自动化预检

```powershell
npm run build
npm run test:unit
npm run test:contract
npm run test:system
npx vitest run packages/agent/src/actors/controller.test.ts packages/agent/src/messaging/drain.test.ts packages/agent/src/orchestration/idle-yield.test.ts packages/agent/src/primitives/runner.test.ts packages/coding/src/agent-runtime/actor-runtime.test.ts packages/coding/src/tools/agent-collaboration.test.ts packages/coding/src/task-engine/runner-driven.test.ts packages/coding/src/task-engine/todo-drift-reminder.test.ts
```

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 9 | - | - | - |

**测试结论**: [待填写]
**发现的问题**: [待填写]

---

*测试指南生成时间: 2026-07-23*
*Feature ID: FEATURE_273*
