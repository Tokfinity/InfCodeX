# ISSUE 302 A2A 空答复回归测试指导

## 功能概述

**功能名称**：A2A Server 完整返回已完成 Agent 的答复内容
**版本**：Unreleased
**测试日期**：2026-08-23
**测试人员**：待填写

验证 `kodax a2a serve` 不会在 coding result 完成收尾前提前发布空的
`completed` Task。成功请求必须携带 Agent message 或等价 artifact，且内容与
Runtime Session 中的最终 assistant 消息一致。

## 测试环境

### 前置条件

- Node.js 20 或更高版本，已完成项目构建或安装待测 KodaX 包。
- 已配置可稳定返回短文本的 provider/model。
- 已按 FEATURE_267 指南执行 `kodax a2a expose`，并设置对应 token 环境变量。
- 使用 A2A 1.0 JSON-RPC/SSE 客户端；服务仅监听 loopback。

## 测试用例

### TC-001：正常请求返回非空 Agent 答复

**优先级**：高
**类型**：正向测试

**前置条件**：A2A Server 已通过 `kodax a2a serve --port 8765` 启动。

**测试步骤**：

1. 发送内容为“只回复 ISSUE302_OK”的 A2A message/send 请求。
2. 等待 Task 进入 `completed`。
3. 读取 Task history、Agent message 和 artifacts。

**预期效果**：

- [ ] Task 为 `completed`，不存在失败或 unknown 终态。
- [ ] Agent message 或 artifact 中包含 `ISSUE302_OK`，内容不为空。
- [ ] Session 最终 assistant 消息与 A2A 返回内容一致。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-002：Provider 失败不伪装成空成功

**优先级**：高
**类型**：负向测试

**前置条件**：准备一个无效 provider 凭据或确定性失败的测试 provider。

**测试步骤**：

1. 使用失败配置启动独立的 loopback A2A Server。
2. 发送普通文本请求并等待终态。
3. 查询 Task 与 Runtime Run 诊断。

**预期效果**：

- [ ] Task 不以“completed 且无 message/artifact”的形式结束。
- [ ] 客户端获得明确失败状态或可诊断错误。
- [ ] 服务进程可继续处理后续有效请求。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-003：空文本与 Unicode 输入边界

**优先级**：中
**类型**：边界测试

**前置条件**：Server 使用正常 provider 配置。

**测试步骤**：

1. 分别发送空白文本、中文、emoji 与包含换行的请求。
2. 对每个被协议接受的请求等待终态。
3. 检查返回 part 的 UTF-8 内容和 Task history。

**预期效果**：

- [ ] 无效空白输入得到协议级校验结果，不产生虚假的空成功。
- [ ] 中文、emoji 与换行不乱码、不截断。
- [ ] 每个成功 Task 都含非空 Agent message 或 artifact。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-004：客户端终态显示完整

**优先级**：中
**类型**：UI 测试

**前置条件**：使用团队常用的 A2A 调试客户端或调用界面。

**测试步骤**：

1. 发送会返回两行文本的请求。
2. 观察运行中、完成和历史详情界面。
3. 刷新或重新打开同一 Task。

**预期效果**：

- [ ] 完成状态与文本同时出现，不闪现“完成但无内容”。
- [ ] 两行文本顺序、换行和字符完整。
- [ ] 重新打开后仍显示同一内容，无重复 Agent message。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-005：连续请求的完成时序

**优先级**：中
**类型**：性能测试

**前置条件**：Server 与 provider 均处于稳定状态。

**测试步骤**：

1. 顺序发送 20 个带唯一编号的短请求。
2. 记录每个 Task 的终态、耗时和返回编号。
3. 再并发发送 5 个短请求并重复记录。

**预期效果**：

- [ ] 25 个成功 Task 均返回对应的非空编号。
- [ ] 不出现 completed 先于 Agent message/artifact 可见的 Task。
- [ ] 无串答、重复答复或明显的完成回调堆积。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-006：未授权请求不会创建可查询答复

**优先级**：高
**类型**：安全测试

**前置条件**：Server 配置 Bearer token 或 RFC 9068 JWT 校验。

**测试步骤**：

1. 分别使用缺失、错误和过期凭据发送请求。
2. 使用有效凭据发送控制请求。
3. 查询服务端 Task 列表与日志诊断。

**预期效果**：

- [ ] 三个未授权请求均被拒绝，且不创建可访问的 Task/Session 内容。
- [ ] 响应和日志不泄露 token、provider 凭据或 assistant 内容。
- [ ] 有效控制请求正常返回非空答复。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

### TC-007：受影响版本升级兼容

**优先级**：高
**类型**：兼容性测试

**前置条件**：保留 v0.7.82 或 v0.7.94 的复现配置，并准备当前构建。

**测试步骤**：

1. 在旧版本复现“completed 但无 Agent message/artifact”，保存请求字节。
2. 不修改 A2A 配置和请求，切换到当前构建并重启 Server。
3. 在 Windows PowerShell 与一个 Linux/macOS shell 环境各执行一次（可用 CI 代替）。

**预期效果**：

- [ ] 相同请求在当前构建返回非空答复。
- [ ] 既有 Agent Card、认证和 Task 查询流程无需迁移。
- [ ] Windows 与 POSIX 环境的终态内容一致。

**实际结果**：待填写
**是否通过**：[ ] Pass / [ ] Fail

## 自动化回归

```powershell
node node_modules/vitest/vitest.mjs run packages/coding/src/agent-runtime/__contract-tests__/cap-005-events-complete.contract.test.ts
node node_modules/vitest/vitest.mjs run src/sdk-runtime.test.ts -t "asynchronously finalized coding payload|completion signal"
node node_modules/vitest/vitest.mjs run src/a2a/a2a.test.ts
```

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 7 | - | - | - |

**测试结论**：待填写
**发现的问题**：待填写

---

*测试指导生成时间：2026-08-23*
*Issue ID：302*
