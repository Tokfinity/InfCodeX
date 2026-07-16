# FEATURE_267 双向 A2A 与通用 Agent 发布 - 人工测试指南

## 功能概览

**功能名称**：Bidirectional A2A Client Executor + KodaX Agent Server
**目标版本**：v0.7.69
**测试日期**：待填写
**测试人员**：待填写

本功能让用户无需编写接入代码即可注册、检查和调用第三方 A2A Agent，也可把 KodaX 默认 Agent 或 `~/.kodax/agents/*.md` 中的用户 Agent 作为 A2A 1.0 Agent 发布。出站支持 Bearer 兼容模式和由外部授权服务器签发动态 Token 的 OAuth 2.0 Client Credentials；入站可作为 RFC 9068 JWT Resource Server。入站执行使用启动时固定的 Agent、Skill、工具策略和工作区快照；Skill 自带脚本仅能在精确授权并通过 ASRT 检查后运行。

---

## 测试环境

### 前置条件

- Node.js 20 或 22，已执行 `npm install` 与 `npm run build`。
- 已配置可用的 KodaX LLM Provider。
- 使用临时 `KODAX_HOME`，不要在真实用户配置上测试迁移或错误配置。
- 准备一个独立 A2A 1.0 JSON-RPC/SSE 服务用于出站互操作测试。
- 入站服务只直接监听 loopback；公网测试必须使用宿主 TLS 反向代理。
- Skill 脚本用例需先执行 `kodax sandbox doctor`；未通过时只记录为环境阻塞，不降低到非隔离执行。

### 自动化发布基线

```bash
npx vitest run src/a2a/a2a.test.ts src/a2a/config.test.ts src/a2a/product.test.ts
npx vitest run src/a2a/security.test.ts src/a2a/client-auth.test.ts src/a2a/client-executor-auth.test.ts src/a2a/server-auth.test.ts
npx vitest run src/a2a/runtime-config.test.ts src/runtime-agent-binding.test.ts src/sandbox-runtime.test.ts
npx vitest run src/integration-cli.test.ts src/integration-hot-reload.test.ts
npx tsc -p tsconfig.json --noEmit
npm run build
```

任一命令失败时，不进入人工发布验收。

---

## 测试用例

### TC-001：无代码注册并调用第三方 A2A Agent

**优先级**：高
**类型**：正向 / 端到端

**步骤**：

1. 执行 `kodax a2a add reporting <CARD_URL> --effect read`。
2. 执行 `kodax a2a list` 与 `kodax a2a test reporting`。
3. 执行 `kodax a2a call reporting "生成一段测试摘要"`。
4. 让测试 Agent 分别返回带 A2A provenance 的有界 `data:`、`http:` 和
   `https:` artifact reference，并记录 HTTP(S) artifact URL 是否被请求。
5. 分别返回接近 32 MiB 的合法 task RPC/SSE 响应，以及超过 2 MiB 的
   Card/OAuth/security metadata 响应。
6. 删除注册：`kodax a2a remove reporting`。

**预期结果**：

- [ ] `add` 在写入前验证 A2A 1.0 JSON-RPC Card。
- [ ] `list` 只显示配置和环境变量名，不显示凭据值。
- [ ] `test` 返回公开 Card 名称、版本和技能。
- [ ] `call` 通过 F258 task plane 提交任务；若 `SendMessage` 只返回
  submitted/working Task，则继续 `GetTask`，直到 completed/failed/canceled/
  rejected/input-required/auth-required/unknown 后再返回快照。
- [ ] `call` 只接受有界、来源为 A2A 的 `data:`/HTTP(S) reference；HTTP(S)
  保持为引用且从不被 KodaX 隐式下载，其他 scheme、缺失 provenance 或越界
  inline data 均失败关闭。
- [ ] task RPC/SSE 使用独立 32 MiB 上限；Card、interface、OAuth 与其他
  security metadata 保持 CLI 网络策略的 2 MiB 上限，metadata 超限不会因
  task 文档预算而被放行。
- [ ] `remove` 后该名称不可再调用。

### TC-002：配置的出站 Agent 自动进入主 Runtime 编排面

**优先级**：高
**类型**：集成 / 热加载

**步骤**：

1. 保持一个 KodaX 交互会话或用户级 daemon 运行。
2. 在另一终端执行 `kodax a2a add reporting <CARD_URL> --effect read`。
3. 让主 Agent 列出或选择可调度 Agent，确认出现 `external:reporting`。
4. 更新该条目的 Card URL，验证有效目标替换；再改成不可达目标。
5. 删除该条目。

**预期结果**：

- [ ] 无需重启即可在 F258 executor plane 中发现新增注册。
- [ ] 有效更新只影响后续任务。
- [ ] 单条更新失败时保留该条目的最近有效注册，并输出不含 URL 凭据的诊断。
- [ ] 删除后新任务不再发现该 Agent。

### TC-003：发布 Runtime 默认 Agent

**优先级**：高
**类型**：正向 / CLI

**步骤**：

1. 设置随机测试凭据：POSIX 使用
   `export KODAX_A2A_TOKEN='<随机值>'`，PowerShell 使用
   `$env:KODAX_A2A_TOKEN='<随机值>'`。
2. 执行 `kodax a2a expose --name "KodaX Office" --description "处理通用办公任务" --token-env KODAX_A2A_TOKEN`。
3. 执行 `kodax a2a serve --port 8765`。
4. 读取 `http://127.0.0.1:8765/.well-known/agent-card.json`。
5. 使用 Bearer Token 调用 `SendMessage`，轮询 `GetTask` 至终态。

**预期结果**：

- [ ] 配置文件只保存 `KODAX_A2A_TOKEN` 名称，不保存随机值。
- [ ] 监听前完成配置、工具、Agent 与凭据验证。
- [ ] Card 只公开 `published` 投影，不泄露模型、系统提示词、内部 Skill 路径或本地目录。
- [ ] 请求在 `~/kodax_a2a_server_workspace/a2a-server/contexts/` 下获得独立上下文工作区。

### TC-004：发布 `~/.kodax/agents` 用户 Agent

**优先级**：高
**类型**：正向 / 负向

**前置条件**：创建 `~/.kodax/agents/office-agent.md`，包含合法的 `name`、`description`、`skills` 和正文。

**步骤**：

1. 执行 `kodax a2a expose missing-agent`。
2. 执行 `kodax a2a expose office-agent --name "Office Agent"`。
3. 启动服务并完成一次任务。

**预期结果**：

- [ ] 不存在或解析失败的用户 Agent 在写配置前被拒绝。
- [ ] 只接受 `markdown:user`，项目 Agent 不能冒充用户发布对象。
- [ ] 运行使用该 Markdown Agent 的提示词、模型偏好和工具声明。
- [ ] Agent 文件或有效 Skill 集变化后，运行中的服务要求重启，不悄然换权威。

### TC-005：Skill 发现、公开 Card Skill 与内部 Runtime Skill 分离

**优先级**：高
**类型**：功能 / 隐私

**步骤**：

1. 分别在 `~/.kodax/skills` 与 `~/.agents/skills` 安装两个无脚本 Skill。
2. 在 Markdown Agent 的 `skills` 中列出其中一个；另做一次未写 `skills` 的测试。
3. 在 `a2a.json#server.published.skills` 配置面向调用方的业务技能描述。
4. 启动服务并读取 Card，再让 Agent 调用内部 Skill。

**预期结果**：

- [ ] 两个标准用户目录均可发现。
- [ ] 显式 `skills` 只准入列出的 Skill；省略时准入可由模型调用的用户/插件/内置 Skill，不准入项目 Skill。
- [ ] Skill 指令、references、assets 不需要 process 权限即可使用。
- [ ] Card 只显示显式 `published.skills`，不会自动泄露内部 Skill 清单或文件路径。

### TC-006：工具策略足以工作且不会暴露宿主秘密

**优先级**：高
**类型**：安全 / 权限

**步骤**：

1. 使用默认 managed workspace 与 `process: deny` 启动 Agent。
2. 请求读取、grep、glob 工作区文件，并生成一个普通文档。
3. 请求读取工作区外文件、`.env`、`.ssh`、`.kodax` 与 `.agents`。
4. 精确配置一个带 `remoteContract` 的 Extension Tool 和一个 MCP capability 后重启。
5. 尝试调用未授权 Tool、MCP server/capability 与任意 shell。

**预期结果**：

- [ ] workspace 为 read/write 时，原生 `read`、`grep`、`glob` 可用；write 时写入工具可用。
- [ ] 路径逃逸、符号链接逃逸和敏感路径读取被阻断。
- [ ] 链接目录下尚未创建的写入目标也被真实父路径检查阻断；合法工具在
  guardrail 允许后不等待交互式权限响应。
- [ ] 精确授权的窄 Extension Tool 与 MCP capability 可用。
- [ ] 未声明远程契约的 Extension Tool、未授权 MCP 和任意 shell 均不可用。

### TC-007：Skill 自带脚本通过 ASRT 精确隔离执行

**优先级**：高
**类型**：安全 / 集成

**步骤**：

1. 执行 `kodax sandbox doctor`；Windows 首次使用按需执行 `kodax sandbox setup`。
2. 创建含 `scripts/render.mjs` 或 `scripts/render.py` 的测试 Skill。
3. 使用 `--skill-script skill-name:scripts/render.mjs` 重新执行 `a2a expose`。
4. 让 Agent 调用脚本并只写声明的输出文件。
5. 尝试调用未准入脚本、读取用户主目录、读取环境凭据、访问未授权网络与创建越界输出。

**预期结果**：

- [ ] doctor 未通过时服务在监听前失败，不回退到宿主 shell。
- [ ] 只运行绑定快照中精确列出的 `scripts/...` 文件。
- [ ] 脚本获得去凭据环境、Skill 快照和独立 staging 目录。
- [ ] 未授权文件、网络、脚本与输出映射失败；错误不含密钥。
- [ ] PowerShell/Batch/Python/Node 仅作为被隔离脚本解释器使用，不变成通用进程工具。

### TC-008：认证、租户隔离与限额

**优先级**：高
**类型**：安全 / 边界

**步骤**：

1. 对 `bearer-env` 分别使用无 Token、错误 Token、正确 Token 调用。
2. 对 `oauth2-jwt` 使用两个签名有效、但 `sub` 分别为 Caller A/B 的
   Token；Caller A 创建任务，Caller B 尝试 Get/Cancel/Subscribe/List。
3. 使用 issuer A、`sub=shared` 创建任务，热切换到 issuer B 后用相同
   subject/tenant 查询；再在相同 subject 下执行 Bearer 与 OAuth profile
   切换，以及 `tokenEnv` 名称切换。
4. 轮换同一 `tokenEnv` 背后的 secret 值和同一 issuer 的 JWKS；随后以同一
   `securityRealm`、同一 `dataDir` 重启并查询新格式任务。
5. 构造 pre-realm 持久化任务记录：先确认正常启动后仍不可见；停服执行
   `kodax a2a migrate-tasks` dry-run，确认文件字节不变，再使用
   `--apply --confirm-server-stopped` 精确迁移配置中的 Bearer owner。OAuth
   profile 额外传入已知 `--subject`。迁移后以原 message ID 重试。
6. 通过 SDK 创建缺失/空白 `securityRealm` 的 custom authentication，再对
   运行中 server 执行同类 `updateHot()`。
7. 达到并发、活动任务、保留任务、事件字节和工作区字节上限；让两个不同
   principal 的 workspace/session preparation 同时阻塞，并分别测试容量 1 和 2。

**预期结果**：

- [ ] 无效认证在任务查询前返回 401。
- [ ] Caller B 看不到 Caller A 的任务存在性、上下文或输出。
- [ ] `principalKey` 是 `(securityRealm, subject, tenant)` 规范 tuple 的
  SHA-256；Bearer realm 为 `bearer-env:<tokenEnv-name>`，OAuth realm 为
  `oauth2-jwt:<validated-exact-issuer>`，不包含 token、secret 或原始身份值。
- [ ] 同 realm 的 secret/JWKS 轮换与同 `dataDir` 重启保留访问；issuer、
  token-env 名称、认证 profile、subject 或 tenant 变化时，即使其他字段相同
  也不能接管旧任务。
- [ ] pre-realm 任务不会在正常 RPC 中被猜测或 legacy-key 双读；dry-run
  byte-preserving，apply 只重写显式 owner mapping，未知记录保持不变。迁移后
  `GetTask` 恢复且相同 message ID 仍命中原任务；运行中 server、歧义 mapping
  和未知 key scheme 均 fail closed。
- [ ] custom authentication 在创建或热更新时缺失/空白 `securityRealm` 都立即
  失败，原热配置保持不变。
- [ ] 超限只拒绝新工作或后续越界写入，不破坏已有终态记录；容量检查/预留
  不跨任何 `await`，慢速 preparation 不会跨 principal 队头阻塞，失败会释放预留。

### TC-009：A2A 热字段与重启字段

**优先级**：高
**类型**：热加载 / 一致性

**步骤**：

1. 服务运行时修改 `published`、Bearer 环境变量引用或 limits。
2. 验证新请求使用新值，既有任务继续完成。
3. 修改 `execution`、Agent、workspace、toolPolicy、Skill 脚本准入或 `dataDir`。

**预期结果**：

- [ ] Card/auth/limits 作为一个热块验证成功后原子更新。
- [ ] 无效热配置保留最近有效值。
- [ ] 执行与存储变化只报告 restart-required；旧监听器和旧绑定继续工作直至显式重启。

### TC-010：协议互操作与恢复

**优先级**：高
**类型**：协议 / 恢复

**步骤**：

1. 使用独立 A2A 1.0 client 或官方 TCK 完成 discovery、send、get、stream、subscribe、cancel、list。
2. 断开 SSE 后重新订阅。
3. 任务运行时重启 A2A edge，使用同一 `dataDir` 查询并重附 Runtime run。
4. 让不同 principal 并发执行 `SendMessage` 并逼近全局/固定工作区限额。
5. 在 durable replay 与 live subscription 交界处注入一个 Runtime event。
6. 发送无认证的超大 body、`application/jsonp`、`text/event-streamx`，并验证
   带参数的 `application/*+json` 与 `text/event-stream`。
7. 达到每任务/每服务 stream 数上限，并让一个 subscriber 超过 24 MiB
   encoded queue 或中途断开。
8. 在 preparation 与已准入 handler 尚未结束时并发调用多次 `close()`。

**预期结果**：

- [ ] JSON-RPC、SSE、错误码和 Card 通过 A2A 1.0 MUST profile。
- [ ] 网络断开不等于取消，事件 cursor 可恢复。
- [ ] 重启不为已有任务创建替代 run；损坏 task store 明确失败。
- [ ] 跨 principal 新任务经过短全局 reservation 临界区原子判限；Runtime
  执行和等待不持有该全局锁。
- [ ] Runtime attachment 先订阅再合并 durable replay，按 sequence 去重后
  切换 live；交界处事件既不丢失也不重复发布。
- [ ] header 认证先于 body 读取；JSON/SSE 只接受精确 structured media
  type（允许参数），拒绝 substring lookalike。
- [ ] 每任务最多 4 条 stream、每服务最多 8 条，每条 encoded queue 最多
  24 MiB；慢消费者或断连只关闭自身并释放 slot，不终止底层任务。
- [ ] `close()` 是共享幂等 barrier：先拒绝新 work，再等待 preparation 和
  所有已准入 handler tail，最后关闭 subscription/store/binding；返回后没有
  延迟 save、recovery 或 execution start。

### TC-011：外部 OAuth 签发与动态 Token 闭环

**优先级**：高
**类型**：认证 / 互操作

**步骤**：

1. 准备独立 OAuth Authorization Server：注册 KodaX client，开放 Client Credentials token endpoint，并发布可轮换 JWKS。
2. 使用 `kodax a2a add` 的 `--oauth-*` 参数配置一个 Card 已声明相同 scheme、token URL 和 scope 的外部 Agent；先执行 `a2a test`，再连续调用两次。
3. 让 Agent 对当前 access token 返回一次 `401`，随后让授权服务器签发新 token；再次观察调用。
4. 使用 `kodax a2a expose --auth oauth2-jwt` 配置 KodaX 入站服务，分别发送有效 token、错误 issuer/audience/signature/type/expiry 的 token，以及缺少 scope 的有效 token。
5. 分别通过 `a2a.json` 与 direct SDK factory 尝试公共 HTTP、userinfo、query/fragment issuer，带 fragment/凭据的 token/JWKS endpoint，以及相对或带 fragment 的 RFC 8707 resource。
6. 检查 KodaX 监听路由、配置文件和数据目录，确认不存在签发、刷新、登录、client 注册端点或 issuer 私钥。

**预期结果**：

- [ ] Client secret 只通过环境变量解析；配置、日志、任务和事件均不含 secret/access token。
- [ ] `a2a test` 只做 Card discovery/security planning，token endpoint 计数仍为零；首次 `call` 才申请 token。
- [ ] 未过期 token 只在进程内复用；`401` 只触发一次失效、刷新和 RPC 重试，第二次 `401` 不形成循环。
- [ ] 入站有效 token 映射 `sub` 为 principal；缺失/无效 token 返回带 Bearer challenge 的 `401`，scope 不足返回 `403 insufficient_scope`。
- [ ] 文件配置与 direct SDK 在构造期执行同一 URL/URI 规则；issuer 保留精确字符串语义，公共端点要求 HTTPS，只有精确 loopback 开发端点可用 HTTP，resource 只要求绝对 URI 且禁止 fragment。
- [ ] KodaX 只充当 A2A Client 或 OAuth Resource Server；签发、轮换、吊销和 client 管理始终属于外部 Authorization Server。

### TC-012：Card/Skill 安全要求与凭据边界

**优先级**：高
**类型**：安全 / 负向

**步骤**：

1. 分别构造匿名 OR Bearer、OAuth OR Bearer、双 scheme AND、以及 Skill 单独要求额外 scope 的 Agent Card。
2. 用不匹配 scheme/scope 的配置执行 `a2a add`/discovery；再用可满足其中一个完整 OR 分支的配置执行。
3. 让恶意 Agent RPC 响应重定向到 OAuth token origin，并分别在失败正文、成功 Message/Task/artifact 与 SSE error 中原样回显收到的 Authorization header。
4. 挂起一个使用 token A 的 Message/Task/artifact 响应；并发制造至少五次 token 轮换后再释放该响应。
5. 检查 token endpoint 请求计数、任务快照、事件、日志与持久化文件。

**预期结果**：

- [ ] OR 选择一个完整可满足分支；AND 不被部分降级；不满足的受保护 Skill 不进入可调度 catalog。
- [ ] API key、Basic、交互式 OAuth、OIDC、mTLS 和内置 client 无法满足的多 scheme AND 明确失败。
- [ ] Agent RPC 不能把 prompt/Authorization 重定向到 token origin；Card、RPC、token 三个网络边界互不借权。
- [ ] 每个在途 RPC/SSE 都保留自己的精确脱敏值直至解析结束；即使超过近期历史窗口，远端回显的 Authorization/access token 也不会进入 task、artifact、event、日志或持久化状态。

### TC-013：已准入任务的不可变路由与重启恢复

**优先级**：高
**类型**：持久化 / 一致性

**步骤**：

1. 通过一个 revision 启动保持 `input-required` 的三个外部任务。
2. 将 live registration 更新到新 endpoint/auth revision 后删除，并重启使用同一 store 的 Runtime。
3. 对三个旧任务分别调用 `sendInput`、`reconcile` 和 `cancel`，记录 executor factory 收到的 registration。
4. 尝试在旧任务仍非终态时，以同一 `(agentId, revision)` 写入不同 endpoint/executor config；再检查公共 task/daemon DTO 和内部 snapshot 文件。
5. 让任务进入终态，并分别注入 snapshot GC 失败与 snapshot 已写、task 尚未写的崩溃窗口后重启。
6. 让两个不同 external Agent（以及一个 local task）并发提交相同 `taskId`；再使用包含分隔控制字符、但旧拼接形式会碰撞的 Agent ID/revision 组合启动任务。

**预期结果**：

- [ ] 重启后的三种操作都使用准入时的 endpoint、协议、executor 配置和 credential reference，不使用更新后的 live registration。
- [ ] 同 revision 的不同执行内容明确失败；`enabled`、`managementOwner` 和 health 更新不被误判为执行内容变化。
- [ ] 完整路由只存在于内部 store，不扩展任务/daemon DTO，也不包含解析后的 token 或 secret。
- [ ] 终态 task 先持久化再清理最后 snapshot 引用；GC 失败不回滚终态或悬挂 waiter，下一次启动清理孤儿。
- [ ] 全局相同 `taskId` 只准入一次且最多调用一次远端 `start`；不同身份 tuple 各自创建并使用自己的 executor，不因字符串分隔碰撞而串路由。

---

## 边界用例

- **BC-001**：Unicode Agent 名称描述、消息和文件名保持 UTF-8，文件名不参与本地路径选择。
- **BC-002**：`--host 0.0.0.0`、公网 HTTP `publicBaseUrl` 和带 userinfo URL 必须失败。
- **BC-003**：固定可写 workspace 强制串行；managed workspace 可按 limits 并发且上下文隔离。
- **BC-004**：重复 `messageId` 同内容幂等；同 ID 不同内容返回冲突。
- **BC-005**：重复关闭服务、runner 和订阅不产生异常或残留进程。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 13 + 5 边界项 | - | - | - |

**测试结论**：待填写
**发现的问题**：待填写
**证据位置**：待填写（命令输出、TCK 报告、独立实现版本、ASRT doctor 输出）

---

*测试指南更新时间：2026-07-16*
*Feature ID：FEATURE_267*
