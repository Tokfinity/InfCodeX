# FEATURE_267 双向 A2A 与通用 Agent 发布 - 人工测试指南

## 功能概览

**功能名称**：Bidirectional A2A Client Executor + KodaX Agent Server
**目标版本**：v0.7.69
**测试日期**：待填写
**测试人员**：待填写

本功能让用户无需编写接入代码即可注册、检查和调用第三方 A2A Agent，也可把 KodaX 默认 Agent 或 `~/.kodax/agents/*.md` 中的用户 Agent 作为 A2A 1.0 Agent 发布。入站执行使用启动时固定的 Agent、Skill、工具策略和工作区快照；Skill 自带脚本仅能在精确授权并通过 ASRT 检查后运行。

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
4. 删除注册：`kodax a2a remove reporting`。

**预期结果**：

- [ ] `add` 在写入前验证 A2A 1.0 JSON-RPC Card。
- [ ] `list` 只显示配置和环境变量名，不显示凭据值。
- [ ] `test` 返回公开 Card 名称、版本和技能。
- [ ] `call` 通过 F258 task plane 提交任务；若 `SendMessage` 只返回
  submitted/working Task，则继续 `GetTask`，直到 completed/failed/canceled/
  rejected/input-required/auth-required/unknown 后再返回快照。
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

1. 设置随机测试凭据：`KODAX_A2A_TOKEN=<随机值>`。
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

1. 分别使用无 Token、错误 Token、正确 Token 调用。
2. Caller A 创建任务，Caller B 尝试 Get/Cancel/Subscribe/List。
3. 达到并发、活动任务、保留任务、事件字节和工作区字节上限。

**预期结果**：

- [ ] 无效认证在任务查询前返回 401。
- [ ] Caller B 看不到 Caller A 的任务存在性、上下文或输出。
- [ ] 超限只拒绝新工作或后续越界写入，不破坏已有终态记录。

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

**预期结果**：

- [ ] JSON-RPC、SSE、错误码和 Card 通过 A2A 1.0 MUST profile。
- [ ] 网络断开不等于取消，事件 cursor 可恢复。
- [ ] 重启不为已有任务创建替代 run；损坏 task store 明确失败。

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
| 10 + 5 边界项 | - | - | - |

**测试结论**：待填写
**发现的问题**：待填写
**证据位置**：待填写（命令输出、TCK 报告、独立实现版本、ASRT doctor 输出）

---

*测试指南更新时间：2026-07-13*
*Feature ID：FEATURE_267*
