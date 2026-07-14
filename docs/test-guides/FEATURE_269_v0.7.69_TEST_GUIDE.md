# FEATURE_269 Shared Daemon 多客户端一致性与安全宿主桥接 — 人工测试指南

## 功能概览

**功能名称**：Shared Daemon Multi-Client Consistency + Secure Host Bridges
**目标版本**：v0.7.69
**Feature ID**：FEATURE_269
**测试日期**：待填写
**测试人员**：待填写

本功能让 CLI、Space、IDE 和本地 SDK 客户端共享同一个 Coder profile
daemon，并对同一 session/run 获得一致 transcript、队列、实时状态、交互请求与
唯一终态。Space credential 与专属工具仍由 Space 持有，只能绑定到 Space 明确
发起的 run。Partner 保持独立 inline Runtime。

---

## 测试环境

### 前置条件

- Windows 11（named pipe）以及 Ubuntu（Unix socket）各一套；Node.js 20 或 22。
- 使用临时 `KODAX_HOME`，不要在真实用户 profile 上执行崩溃、损坏或 rollback 用例。
- 准备 CLI、Space-like Node client 和 Observer Node client 三个独立进程。
- Space-like client 使用 OS keychain 持久化稳定 `instanceId` 和 32+ 字符
  `instanceSecret`；renderer 不得读取二者。
- Space-like client 的 credential broker 使用随机 canary，例如
  `F269_SECRET_<UUID>`；不要使用真实 provider key。
- Host Tool fixture 必须把 invocation ID 与副作用结果写入 Space 自己的测试账本，
  以便判断是否重复调用。
- Partner fixture 必须使用与 Coder 不同的 `homeDir` 和 `sessionsDir`。

### 自动化发布基线

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run src/runtime-daemon src/sdk-runtime.test.ts src/sdk-runtime.shared-daemon.test.ts
npx vitest run src/runtime-event.test.ts
npx vitest run packages/llm/src/provider-credential-context.test.ts
npx vitest run src/kodax_cli.daemon-smoke.test.ts
npm test
npm run build
npm pack --dry-run
```

任一命令失败时，不进入正式 Space packaged smoke。

---

## 测试用例

### TC-001：CLI 启动，Space 中途原子加入

**优先级**：P0
**类型**：跨进程 / 一致性

**步骤**：

1. CLI 在 `coder` profile 启动一个带可控 barrier 的长 run。
2. 等待 run 已产生 assistant delta、thinking、tool 与 Todo 后暂停。
3. 在独立 Space-like 进程调用 `sessions.observe(sessionId, listener)`。
4. 记录 snapshot cursor，释放 barrier，等待终态。

**预期结果**：

- [ ] snapshot 含完整 transcript/revision、running run、开始时间、origin、tool、Todo、
  managed-task、pending interaction、queued continuation safe preview 与 live draft。
- [ ] listener 只收到 cursor 之后的事件，没有 join gap。
- [ ] transcript item、terminal event 和 event ID 均不重复。
- [ ] CLI 与 Space 的最终 run phase、terminal revision 和 Todo 一致。

### TC-002：Space 退出、重连与 Runtime 重启识别

**优先级**：P0
**类型**：断线恢复

**步骤**：

1. Space 观察运行中的 run 后直接退出，不调用 daemon stop。
2. 确认 CLI run 仍继续，再启动新的 Space 进程并重新 observe。
3. 记录当前 `runtimeId`；随后强制终止 daemon 并重新启动同 profile。
4. Space 再次连接并完整 observe。

**预期结果**：

- [ ] Space 退出不取消 run，也不终止 daemon。
- [ ] 第一次重连得到一致 transcript，终态只显示一次。
- [ ] daemon 重启后 `runtimeId` 改变，客户端丢弃旧 derived projection 后完整重建。
- [ ] transport 中断立即收到含原因、`reconnectable`、connection/runtime epoch 的
  lifecycle signal，不依赖 5 秒 status polling。
- [ ] 原 queued run 为 `runtime_restarted/effectOutcome:none`；原 active run 为
  `daemon_crashed/effectOutcome:unknown`，不会自动恢复或重放。

### TC-003：同 session 顺序、after-turn 与 operation 重试

**优先级**：P0
**类型**：并发 / 幂等

**步骤**：

1. 两个独立 client 同时向同一 session start run，并保存各自 operation ID。
2. 对第一个 active run 从两个 client 提交多个 `after_turn` 输入。
3. 模拟丢失响应，使用完全相同的 operation ID 与 payload 重试。
4. 再用同一 operation ID 修改 payload 或切换稳定 client principal 重试。

**预期结果**：

- [ ] 所有接受的 run 都有唯一、单调的 `sessionOrder`。
- [ ] 同一 session 任意时刻只有一个 active run；continuation 按接受顺序执行。
- [ ] 完全相同的重试返回 canonical result，不创建重复 run/input。
- [ ] ID 与 payload/principal 不匹配返回 `operation_id_reuse`，无副作用。
- [ ] `delivery:'interrupt'` 返回 `unsupported_capability`，不取消 active run，也不入队。

### TC-004：设置 CAS 与跨客户端结果同步

**优先级**：P0
**类型**：并发控制

**步骤**：

1. 两个 client 读取同一 session 的 settings revision。
2. 使用同一 expected revision 同时写不同 model，并分别覆盖 `agentMode` 与
   `autoModeEngine`。
3. 两端继续观察 `session.settings.updated`，失败端重新读取。

**预期结果**：

- [ ] 只有一个更新成功，另一个返回结构化 `conflict` 与当前 revision。
- [ ] 不发生静默 last-write-wins。
- [ ] 两个观察端最终显示同一个 settings value/revision。
- [ ] `agentMode` 与 `autoModeEngine` 和其他共享设置一样经过 CAS 并跨客户端同步。

### TC-005：AskUser 跨客户端回答与竞争

**优先级**：P0
**类型**：交互 / 竞争

**步骤**：

1. client A 发起会触发 AskUser 的 daemon run。
2. client B 调用 `userInputs.listPending` 并使用 request revision/run ID 回答。
3. 再产生一个 AskUser，让 A/B 在 barrier 后同时回答不同内容。
4. 分别在 pending AskUser 时执行 cancel、超时和 daemon restart。

**预期结果**：

- [ ] B 的回答可让 A 发起的 run 继续。
- [ ] 并发回答只有一个 `accepted:true`，另一个为 `already_resolved`。
- [ ] cancel/timeout/run end 产生明确 dismissed/closed 结果。
- [ ] restart 通过新 `runtimeId`、旧 run terminal 与新 snapshot 无 pending 三者收敛，
  不把旧请求展示为仍可回答。

### TC-006：Permission 单次决定与持久 grant 唯一 owner

**优先级**：P0
**类型**：权限 / 持久化

**步骤**：

1. client A 的 run 触发 permission，client B 回答 `allow_once`。
2. 让 A/B 同时回答下一请求，确认 first-winner。
3. 管理端回答合法的 `allow_always`，重启 daemon 后读取 grants。
4. 使用旧 revision 与正确 revision 分别 revoke。
5. 无 `permission:grant-admin` 的 client 尝试创建持久 grant。

**预期结果**：

- [ ] 只有一个 permission decision 生效，所有 client 收到一致 resolved event。
- [ ] grant 由 daemon 唯一持久化，重启后仍存在。
- [ ] 越过当前 tool/session 的 grant scope 被拒绝且 pending request 仍可回答。
- [ ] stale revoke 冲突；正确 revision revoke 成功。
- [ ] 普通 responder 不能创建 persistent grant。

### TC-007：Space keychain credential 安全边界

**优先级**：P0
**类型**：安全 / 凭证

**步骤**：

1. Space Main 注册只允许测试 provider 的 credential lease。
2. 用该 lease 启动匹配 provider 的 run，并记录 broker 收到的 session/run/provider。
3. 关闭 Space 进程后，以相同稳定 client 身份重连并调用
   `credentials.resume(leaseId, broker)`；再尝试跨 provider、跨 lease、过期 lease。
4. 完成后递归扫描 daemon profile、session、日志、journal、diagnostic 与状态文件，
   同时检查所有 SDK observable payload。

**预期结果**：

- [ ] broker 只在绑定 run 需要时调用，收到 daemon 生成的可信上下文。
- [ ] 其他 client 无 API 可以读取 credential。
- [ ] provider mismatch 不回退 daemon 环境变量，返回 `credential_unavailable`。
- [ ] 已获取凭证的 run 可按声明完成；断线后的新请求明确失败。
- [ ] 已接受/排队 run 不依赖旧 connection；同一稳定 client 可恢复 callback，错误
  secret 或其他 client 无法接管 lease。
- [ ] canary 及其明文片段不出现在任何 KodaX 持久化或可观察面。

### TC-008：Space Host Tool 仅绑定一个 run

**优先级**：P0
**类型**：安全 / 宿主能力

**步骤**：

1. Space 注册一个 `non_idempotent` Artifact-like Host Tool。
2. Space 启动 run 并显式绑定 lease；验证工具可调用。
3. CLI 启动不绑定 lease 的 run，再让 Space 加入同 session。
4. 断开 Space，确认 run 显示 `waiting_host`；用相同稳定 client resume handlers。
5. 尝试伪造 lease/session/run/client 字段以及调用未声明工具。

**预期结果**：

- [ ] 只有 Space 显式绑定的 run 能发现并执行工具。
- [ ] CLI run 在 Space 加入前后都不能发现该工具。
- [ ] handler 收到的 invocation/session/run/lease 上下文由 daemon 注入。
- [ ] 伪造、越权、未知 capability 均 fail closed。
- [ ] KodaX 不持久化 Space Artifact 产品数据。
- [ ] resume 后状态回到 `ready`；CLI/其他 client 无法恢复或继承该 lease。

### TC-009：Host Tool 不确定结果不重放

**优先级**：P0
**类型**：故障恢复 / 副作用

**步骤**：

1. Host Tool handler 完成一次副作用并写 Space 测试账本。
2. 在返回结果已发出但 daemon 未确认时断开 Space transport。
3. 等待 invocation timeout，随后重连 Space 并检查 run 与账本。
4. 调用 `hostTools.getInvocation(invocationId)` 查询恢复结果。

**预期结果**：

- [ ] handler 对同一 invocation ID 只执行一次。
- [ ] run terminal 为 `host_outcome_unknown/effectOutcome:unknown`。
- [ ] daemon 不自动重放 Host Tool、run 或 provider 请求。
- [ ] invocation 查询返回 `completed`、`unknown` 或 `not_dispatched` 之一，不包含参数、
  结果或 credential。
- [ ] UI 显示“结果不确定”，不伪装成功或失败；后续动作由用户显式触发。

### TC-010：daemon/inline Coder owner 竞争与 sticky rollback

**优先级**：P0
**类型**：跨进程 / owner fence

**步骤**：

1. 同一 `homeDir + coder profile` 同时启动 daemon 与 inline owner contender。
2. 停止赢家，使用 expected revision 把 policy 切换为 `inline` 并获取 inline owner。
3. 此时从另一个 CLI 自动启动 daemon。
4. 显式 CAS 切回 `daemon` 后再启动。
5. 构造 PID 复用或无关进程仍活着的 stale state。

**预期结果**：

- [ ] 并发时只有一个有效 owner，失败方无 profile 写权限。
- [ ] inline rollback 后 CLI auto-start 被拒绝。
- [ ] 只有显式切回 daemon 后才能启动新 daemon。
- [ ] stale 检查不按 PID 猜测，不终止无关进程。

### TC-011：Partner inline 与 Coder daemon 隔离

**优先级**：P0
**类型**：兼容 / 回归

**步骤**：

1. 用独立 data/session root 启动 Partner inline Runtime。
2. 同时启动 Coder daemon，分别创建 session、修改设置、触发 permission。
3. 停止、重启和损坏 Coder daemon transport。
4. 让 daemon client 使用已知 Partner sessionId 尝试 list/load/run/settings/delete/
   rewind/fork/compact。
5. 分别列出 Partner/Coder session、grant、runtime status 与 config mutation。

**预期结果**：

- [ ] Partner 继续使用原 inline AskUser/permission callback。
- [ ] 两侧 session、Runtime 状态、permission grant、journal 和 owner state 不交叉。
- [ ] Coder daemon 可用、不可用或重启均不改变 Partner 当前 run。
- [ ] Partner 不获取 Coder owner fence，也不被 Coder rollback 影响。
- [ ] 所有 daemon 侧 Partner 路径返回 typed `session_not_admitted`，且 Partner
  transcript/settings/metadata/锁均未改变。

### TC-012：capability、安全监听与 packaged smoke

**优先级**：P0
**类型**：发布 / 安全

**步骤**：

1. `npm pack` 后在空临时项目安装 tarball，只从
   `@kodax-ai/kodax/runtime` 导入公开类型/API。
2. 使用 tarball CLI 启动 daemon，另起 Space-like process 执行 observe、AskUser、
   credential 与 Host Tool reduced smoke。
3. 使用旧 client（不声明 operation capability）尝试 mutation。
4. 使用错误 token、跨 profile endpoint、缺失 capability requirement 连接。
5. 检查系统监听地址与 packaged DTS/sidecar。
6. 给 daemon run 传入 callback、`AbortSignal`、Extension Runtime、guardrail 实例，
   并向 event parser 注入一个 malformed event 后再发送合法 event。
7. 在 active/queued/pending 状态下调用 `status.preflight()`。

**预期结果**：

- [ ] npm 包不依赖源码路径，DTS 自包含，Runtime Worker/daemon sidecar 可用。
- [ ] daemon 只监听当前用户本机 pipe/socket，不开放公共 TCP。
- [ ] 未认证、跨 profile 与 capability 缺失均明确失败。
- [ ] legacy client 可执行授权 read，但 mutation 返回 `client_upgrade_required` 且无副作用。
- [ ] packaged 两客户端状态、终态、credential 与 Host Tool 结果一致。
- [ ] inline-only run 值在类型或运行时以 `invalid_transport_value` + value path 拒绝。
- [ ] malformed event 被单独降级，后续合法 event 继续到达。
- [ ] preflight 准确返回 client、active/queued/pending、blocker 与 `canStop`。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 12 | - | - | - |

**测试结论**：待填写
**发现的问题**：待填写
**证据位置**：待填写（命令输出、两个 client 日志、Space 副作用账本、secret scan、
owner state、package tarball SHA-256）

### 2026-07-15 自动化预检证据

- 聚焦 Runtime/daemon：10 个测试文件，105/105 通过。
- Runtime facade 完整回归：65/65 通过。
- 真实 process-distinct daemon smoke：7/7 通过。
- `build:bundle` 与 12 个公共入口的 `build:dts` 通过。
- 本地 tarball clean-install 与 `@kodax-ai/kodax/runtime` import smoke 通过；
  候选 integrity 为
  `sha512-BeNsnNfX+Z1M4C+9gN9y60tG8HGJ4Eio1ycgnhs1Vytp+PmOpK88DjC5pkjaWbWy+D/oXV5LgN/nd0zIk6UizA==`。
- 上述结果不替代 Space packaged smoke 和本指南 12 项人工签收；npm 版本仍未发布。

---

*测试指南更新时间：2026-07-15*
*Feature ID：FEATURE_269*
