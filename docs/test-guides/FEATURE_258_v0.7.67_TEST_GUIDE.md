# FEATURE_258 v0.7.67 人工测试指南

## 功能概述

**功能名称**：External Agent Executor Plane + Dispatchable Agent Catalog

**目标版本**：v0.7.67

**Feature ID**：FEATURE_258

**测试日期**：2026-07-10

**测试人员**：待填写

本指南验证外部 Agent 注册、策略过滤、统一发现、Worker/Workflow 派发、
持久任务账本、取消/恢复，以及 Embedded/Daemon SDK 行为一致性。v0.7.67
不包含真实 A2A、MCP Tasks 或私有 HTTP 网络适配器；使用确定性的 Reference
Executor 验证中立适配器契约。

## 测试环境

### 前置条件

- Node.js 20 或更高版本。
- 在 KodaX 仓库根目录执行 `npm install`。
- 工作区可创建临时目录和本地 named pipe/Unix socket。
- 测试用 credential 必须是假的；不要把真实密钥写入 registration。

### 自动化基线

```powershell
npx vitest run packages/agent/src/external-agents/executor-plane.test.ts packages/agent/src/external-agents/reference-executor.test.ts packages/coding/src/external-agents/local-catalog.test.ts packages/coding/src/tools/external-agent-tools.test.ts packages/coding/src/workflows/external-agent-adapter.test.ts src/runtime-agent-store.test.ts src/sdk-runtime.external-agents.test.ts src/runtime-daemon/protocol.test.ts src/runtime-daemon/schema.test.ts src/runtime-daemon/server.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/host.test.ts src/runtime-daemon/manager.test.ts
npx tsc -b tsconfig.build.json
npx tsc -p tsconfig.json --noEmit
```

预期：所有测试和两次类型检查通过，无残留 Daemon 状态、socket 或 named pipe。

## 测试用例

### TC-001：Embedded Runtime 完整任务链

**优先级**：高

**类型**：正向 / API

**步骤**：

1. 打开 `docs/features/v0.7.67.md` 的 “Complete SDK example”。
2. 将 Runtime 的 `mode` 临时改为 `embedded`，保留 Reference Executor、policy、
   registration 和 `requirements.externalAgents`。
3. 执行 register → list → preflight → start → sendInput → wait → events →
   reconcile → cancel。
4. 关闭 Runtime 后，以同一 `homeDir` 重建 Runtime 并读取已完成任务。

**预期结果**：

- [ ] `listDispatchable()` 同时包含 `native:kodax-child` 和注册的 External ID。
- [ ] Preflight 返回 `ok: true`，Start 使用同一 canonical ID 和 revision。
- [ ] 输入前状态为 `input-required`；输入后同一 task ID 完成。
- [ ] snapshot、event 和重启后的任务输出一致。
- [ ] cancel 只有在 executor 确认后才是 `confirmed/canceled`。

### TC-002：公开 Daemon 启动期 Factory 注入

**优先级**：高

**类型**：集成 / 兼容

**步骤**：

1. 按完整 SDK 示例使用 `mode: 'daemon'`、唯一 profile、
   `capabilities.configAdmin: true` 和 `externalAgents`。
2. 确认 Runtime identity 为 `mode: 'daemon'`。
3. 完成一次注册、发现和任务派发。
4. 调用 `runtime.close()`，检查 profile 对应的 Daemon 状态已清理。
5. 再尝试通过已有 `daemonTransport` 同时传入 `externalAgents`。
6. 保持第一个 host 运行，用同一 profile 再次传入一组 factory。

**预期结果**：

- [ ] Factory 在宿主进程内可用，未经过 RPC 序列化。
- [ ] Daemon client 与 Embedded 返回相同的 Agent/Task 数据结构。
- [ ] 关闭拥有者会停止进程内 host，不遗留后台服务。
- [ ] 已有 transport + function injection 被明确拒绝。
- [ ] 已运行 profile 不接受新的 factory，不会静默附着。

### TC-003：Worker 发现和派发使用同一个 ID

**优先级**：高

**类型**：正向 / 工具

**步骤**：

1. 运行：

   ```powershell
   npx vitest run packages/coding/src/tools/external-agent-tools.test.ts
   ```

2. 检查用例覆盖 `list_dispatchable_agents`、
   `dispatch_child_task(agent_id)`、`task_output`、`send_message` 和
   `task_stop`。
3. 检查没有绑定 executor plane 时的工具可见性用例。

**预期结果**：

- [ ] 列出的 External ID 可原样用于派发。
- [ ] `agent_id` 与 `subagent_type` 同时出现时返回可纠正 Tool Error。
- [ ] 没有 plane 时不向模型暴露发现工具或无关 prompt。
- [ ] 远端 artifact URI 不会被伪装成本地 `artifactPaths`。

### TC-004：Workflow Target 与 Worker 共用执行平面

**优先级**：高

**类型**：集成

**步骤**：

1. 运行：

   ```powershell
   npx vitest run packages/coding/src/workflows/external-agent-adapter.test.ts packages/coding/src/workflows/agent-adapter.test.ts packages/agent/src/workflow/runtime.test.ts
   ```

2. 检查 `target.agentId`、`expectedConfigurationRevision`、输入继续、停止和
   无 target 的旧路径。

**预期结果**：

- [ ] External target 不调用本地 child executor。
- [ ] canonical Native/Constructed target 继续调用既有本地 backend。
- [ ] Workflow correlation 写入同一任务账本。
- [ ] `target` 与 `subagentType` 冲突时明确失败。
- [ ] 无 target 的既有 Workflow 行为保持不变。

### TC-005：策略、凭据、Admin 与 Artifact 安全边界

**优先级**：高

**类型**：负向 / 安全

**步骤**：

1. 运行 Agent plane 和 Daemon server 专项测试。
2. 分别验证 policy deny、credential broker 缺失、unhealthy、read-only
   不匹配、capability 不匹配、预算不足、数据分类不允许和并发上限。
3. 使用包含假 secret 的 credential broker 触发上游错误。
4. 在 standalone dispatcher 中只声明 `configAdmin: true`，但不授予宿主
   `allowAgentRegistrationAdmin`。
5. 请求 artifact materialization，但不配置 artifact policy。

**预期结果**：

- [ ] 所有不合资格情况在 remote Start 前失败。
- [ ] registration summary、task、event 和 error 中没有 secret 或 raw config。
- [ ] Admin 写权限同时要求宿主授权和 client capability negotiation。
- [ ] 未配置 Artifact Policy 时默认拒绝；远端 metadata 仍可留在 ledger。
- [ ] artifact metadata 自动带 producing agent 和 remote task provenance。

### TC-006：不确定启动、持久恢复和路径安全

**优先级**：高

**类型**：恢复 / 安全 / 边界

**步骤**：

1. 运行：

   ```powershell
   npx vitest run packages/agent/src/external-agents/executor-plane.test.ts src/runtime-agent-store.test.ts
   ```

2. 检查 remote Start 响应丢失、重建 Plane、缺少旧 factory 和调用 reconcile。
3. 检查 remote handle 在第一次 `get()` 前已持久化。
4. 检查含 `../`、斜杠和冒号的 task ID。

**预期结果**：

- [ ] ambiguous Start 只调用一次 Start，重启后以同一 idempotency key reconcile。
- [ ] factory 缺失时 Runtime 仍可启动，任务保守标记为 `unknown`。
- [ ] accepted remote handle 不会因首次状态刷新失败而丢失。
- [ ] 任务目录使用 SHA-256 key，任何 task ID 都不能逃出 `tasks/`。

### TC-007：向后兼容和全仓回归

**优先级**：高

**类型**：回归

**步骤**：

1. 运行完整测试：`npm test`。
   如果高并发 Windows 主机只报告
   `[vitest-worker]: Timeout calling "onTaskUpdate"` 且没有断言失败，按
   `npx vitest run packages`、Runtime/Daemon、CLI/ACP、其余 `src` 四批重跑；
   worker RPC 超时本身不能算通过。
2. 运行构建：`npm run build`。
3. 特别检查 anonymous `dispatch_child_task`、`subagent_type`、Runtime、Daemon、
   Workflow 和 Worker-isolation 既有测试。

**预期结果**：

- [ ] 全仓测试通过。
- [ ] 构建和声明文件生成通过。
- [ ] anonymous、Constructed Agent 和无 target Workflow 无行为回归。
- [ ] Worker-isolated Runtime 对 function injection 明确失败，不静默降级。

## 已知限制

- v0.7.67 只交付中立执行平面和 Reference Executor，不提供生产 A2A、MCP
  Tasks 或 governed HTTP adapter。
- External Agent 不能直接修改本地 workspace；只允许 metadata/proposal。
- Worker-isolated Runtime 暂不接受 function injection；使用 inline Embedded
  或公开的进程内 Daemon host。
- Adapter 只能声明它实际支持的 durability/cancel/reconcile 语义。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 7 | - | - | - |

**测试结论**：待填写

**发现的问题**：待填写

---

*Feature/Issue ID: FEATURE_258*

*测试指南生成日期：2026-07-10*
