# FEATURE_267 双向 A2A 1.0 - 人工测试指南

## 功能概览

**功能名称**：Bidirectional A2A Client Executor + KodaX Agent Server

**目标版本**：v0.7.69

**测试日期**：待填写

**测试人员**：待填写

本功能提供 `@kodax-ai/kodax/a2a`：KodaX 可通过 F258 executor plane
调用外部 A2A Agent，也可把一个显式配置的 KodaX Runtime Agent 发布为
A2A 1.0 JSON-RPC/SSE 服务。两种方向可独立启用，也可同时启用。

规范基线：A2A 仓库 commit
`2183794bfb9b67af4aee1be0a0ef726050642873`，协议 `1.0`；
`specification/a2a.proto` 为 35,844 bytes，SHA-256
`e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016`。

---

## 测试环境

### 前置条件

- Node.js 20 或 22，执行 `npm install`、`npm run build` 成功。
- 一个独立 A2A 1.0 JSON-RPC/SSE Agent，或官方 A2A TCK/Inspector。
- 两个不同调用方凭据（下文称 Caller A、Caller B）。
- 临时、空白且可写的 A2A `dataDir`；不得使用生产数据目录。
- 公网测试必须通过宿主 TLS 反向代理调用 `server.handle()`；内置
  `listen()` 只用于 loopback 测试。

### 自动化基线

```bash
npx vitest run src/a2a/a2a.test.ts
npx vitest run packages/agent/src/external-agents/executor-plane.test.ts packages/agent/src/external-agents/reference-executor.test.ts src/sdk-runtime.external-agents.test.ts src/runtime-daemon/schema.test.ts src/runtime-daemon/server.test.ts
npx vitest run src/a2a/a2a.test.ts --coverage
npx tsc -p tsconfig.json --noEmit
npm run build
```

以上任一命令失败时，不进入发布验收。

---

## 测试用例

### TC-001：发现 Agent Card 并经 F258 完成外部任务

**优先级**：高

**类型**：正向 / 集成

**步骤**：

1. 配置只包含独立 Agent origin 的 `allowedOrigins`，公网目标设置
   `allowPrivateAddresses: false`。
2. 调用 `discoverA2ARegistration()`，检查返回的 registration。
3. 用 `createA2AAgentExecutorFactory()` 创建 Runtime owner，upsert registration。
4. 经 `runtime.agentTasks.start()` 启动任务并 `wait()` 到 terminal。
5. 重复一次 SSE 可用场景，再关闭 SSE 验证 polling fallback。

**预期结果**：

- [ ] Card 仅接受 `protocolBinding=JSONRPC`、`protocolVersion=1.0`。
- [ ] executor ID 为 `kodax-a2a-v1-jsonrpc`，技能/模态/能力与 Card 一致。
- [ ] SSE 与 polling 都得到同一 terminal 状态和可见输出。
- [ ] registration、事件和错误中没有 token 或 URL 凭据。
- [ ] Runtime/Workflow/Worker 使用同一个外部 Agent ID，无旁路 ledger。

### TC-002：外部 A2A 客户端调用 KodaX

**优先级**：高

**类型**：正向 / 协议

**步骤**：

1. 启动 loopback server，匿名读取 `/.well-known/agent-card.json`。
2. 使用 Caller A 向 Card 首选 interface 发 `SendMessage`，分别验证
   `returnImmediately=true` 与 blocking 模式。
3. 轮询 `GetTask`，再调用 `ListTasks`。
4. 用 `SendStreamingMessage` 和 `SubscribeToTask` 读取 SSE 至 terminal。

**预期结果**：

- [ ] Card 通过 1.0 schema，首选 JSON-RPC interface 可用，ETag 稳定。
- [ ] blocking、polling、streaming 的 task/context/status/output 等价。
- [ ] SSE 每帧是 JSON-RPC envelope，首帧含 Task，状态有序且 terminal 后关闭。
- [ ] `ListTasks` cursor 不透明，末页不返回多余 token。
- [ ] 未配置的 extended card 返回 `ExtendedAgentCardNotConfiguredError`。

### TC-003：同任务续写、去重与冲突

**优先级**：高

**类型**：状态 / 幂等

**步骤**：

1. 让测试 Runtime 进入 `waiting_user_input`，确认 A2A 状态为
   `TASK_STATE_INPUT_REQUIRED`。
2. 发送带原 `taskId`/`contextId` 的新 message，恢复运行。
3. 并发重发完全相同的 `messageId` 和内容。
4. 再使用相同 `messageId` 发送不同内容。

**预期结果**：

- [ ] 续写沿用原 task、context 和 Runtime session，不创建第二个 A2A task。
- [ ] 完全相同请求只启动一次 Runtime run，并返回同一 task。
- [ ] ID 相同而内容不同返回明确 invalid-params 错误，不覆盖既有状态。

### TC-004：取消、断线和重启恢复

**优先级**：高

**类型**：恢复 / 可靠性

**步骤**：

1. 启动一个长任务并断开 HTTP/SSE 客户端。
2. 重新 `GetTask`，确认任务仍运行；随后调用 `CancelTask`。
3. 再启动一个长任务，关闭 A2A edge，但保持 Runtime/daemon run 存活。
4. 用相同 `dataDir` 重建 edge，完成 Runtime run 后查询原 task。

**预期结果**：

- [ ] HTTP/SSE 断线不会被当作取消。
- [ ] 取消调用 Runtime abort，并最终稳定为 `TASK_STATE_CANCELED`。
- [ ] terminal task 再取消返回 `TaskNotCancelableError`。
- [ ] edge 重启只 replay/reattach 原 run，不启动替代 run；最终结果可查询。
- [ ] 损坏的 `tasks.json` 明确失败，不静默丢弃或覆盖。

### TC-005：认证、授权和租户隔离

**优先级**：高

**类型**：安全

**步骤**：

1. 不带凭据、带错误凭据、带 Caller A 正确凭据分别发送请求。
2. Caller A 创建 task；Caller B 使用该 task ID 调用 Get/Cancel/Subscribe。
3. Caller B 执行 ListTasks。
4. 在 `authorize()` 中拒绝一个 operation，并重试。

**预期结果**：

- [ ] 匿名/错误凭据返回 HTTP 401，且认证发生在 task lookup 前。
- [ ] Caller B 看不到 Caller A 的 task，点查/取消/订阅均表现为 not found。
- [ ] Caller B 列表不包含 Caller A 的 task、context 或输出。
- [ ] 授权拒绝不泄露 task 是否存在。

### TC-006：SSRF、TLS、redirect 与凭据边界

**优先级**：高

**类型**：安全 / 负向

**步骤**：

1. 依次尝试 loopback、RFC1918、link-local、IPv6 local、非 allowlist origin。
2. 尝试公网 `http://` URL、userinfo URL、超时、超大响应和重定向环。
3. 配置跨 origin redirect，并在初始请求设置 Authorization。
4. 尝试 `listen({ hostname: '0.0.0.0' })` 和 public HTTP `publicBaseUrl`。

**预期结果**：

- [ ] 未显式允许 private address 时全部 fail closed。
- [ ] 公网只允许 HTTPS，origin/redirect/DNS 每跳重验证。
- [ ] 跨 origin 后 Authorization 被移除；错误不回显凭据或完整敏感 URL。
- [ ] response byte、timeout 和 redirect 上限生效。
- [ ] 内置 listener 拒绝非 loopback；公网 HTTP Card 配置被拒绝。

### TC-007：消息、附件和信息泄露边界

**优先级**：高

**类型**：安全 / 边界

**步骤**：

1. 发送 text、允许的 inline raw、data part；再发送 URL part、非法 base64、
   未声明 media type、超 `maxPartBytes` part、超 `maxRequestBytes` body。
2. 在 text 中放置伪造 system prompt、provider/model/cwd/tool/permission 配置。
3. 让 Runtime 输出包含内部事件和一个普通 final text。

**预期结果**：

- [ ] text 只作为 user input；远端内容不能修改本地 Runtime 配置。
- [ ] raw/data 仅写入 server-owned attachments 目录，文件名被重新生成。
- [ ] URL、非法/超限/不支持 media type 明确失败且不启动 run。
- [ ] 响应不含本地路径、system prompt、reasoning/tool payload 或凭据。
- [ ] 仅最终批准输出进入 A2A artifact/history。

### TC-008：协议错误与可选能力诚实性

**优先级**：中

**类型**：兼容 / 负向

**步骤**：

1. 发送 malformed JSON、错误 JSON-RPC envelope、未知 method、A2A 0.3 header。
2. 调用四个 push-notification configuration method。
3. 检查所有 A2A-specific error 的 JSON-RPC code 和 `ErrorInfo` data。

**预期结果**：

- [ ] 分别返回标准 parse/invalid-request/method-not-found/version 错误。
- [ ] A2A 0.3 不被静默接受，返回 `VersionNotSupportedError (-32009)`。
- [ ] push 方法返回 `PushNotificationNotSupportedError (-32003)`。
- [ ] A2A-specific error 的 `data` 是数组并含 `google.rpc.ErrorInfo`。
- [ ] Card 不宣称 push、gRPC、HTTP+JSON 或 A2A 0.3。

### TC-009：官方 TCK/独立实现互操作

**优先级**：高

**类型**：协议 / 发布门禁

**步骤**：

1. 使用官方 A2A TCK 的 JSON-RPC MUST profile 指向测试 SUT。
2. 使用独立 A2A 1.0 client 完成 discovery、send、get、stream、cancel。
3. 使用 KodaX outbound executor 调用一个独立 A2A 1.0 server。
4. 保存 TCK JSON/HTML 报告和双方版本/commit。

**预期结果**：

- [ ] Agent Card、JSON-RPC envelope、错误码/ErrorInfo、SSE 格式通过。
- [ ] 与业务语义相关的 TCK fixture 使用可产生相应状态/artifact 的测试 Runtime。
- [ ] 所有声明能力通过；未声明 optional 项应 skip，不得出现无解释失败。
- [ ] 独立 client/server 双向均完成至少一次 terminal task。

### TC-010：既有功能回归

**优先级**：高

**类型**：回归

**步骤**：执行自动化基线，并用 Native/Constructed Agent、F258 reference
executor、Runtime daemon、ACP 和普通 CLI 各完成一个 smoke flow。

**预期结果**：

- [ ] 既有 dispatch、Runtime/daemon、ACP、Workflow 行为无退化。
- [ ] `packages/agent` 与 `packages/coding` 无 A2A wire dependency。
- [ ] root、既有 subpath 和新 `/a2a` 均可从构建产物导入。
- [ ] A2A focused line coverage不低于 80%。

---

## 边界用例

- **BC-001**：`pageSize` 最小/最大、空末页、非法 cursor 均有确定性结果。
- **BC-002**：两个 subscriber 同时订阅同一 task，事件顺序一致；关闭一个不影响另一个。
- **BC-003**：达到 per-principal/global concurrency 上限时拒绝新任务，既有任务不受影响。
- **BC-004**：重复 `close()` 安全；close 后新请求明确返回 unavailable。
- **BC-005**：Unicode text/filename/metadata 不破坏 JSON/SSE 编码，filename 不参与本地路径选择。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 10 + 5 边界项 | - | - | - |

**测试结论**：待填写

**发现的问题**：待填写

**证据位置**：待填写（命令输出、TCK report、独立实现版本）

---

*测试指南生成时间：2026-07-12*

*Feature ID：FEATURE_267*
