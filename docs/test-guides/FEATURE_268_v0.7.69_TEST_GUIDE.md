# FEATURE_268 集成配置分离与热加载 - 人工测试指南

## 功能概览

**功能名称**：Hot-Reloadable Integration Configuration Split
**目标版本**：v0.7.69
**测试日期**：待填写
**测试人员**：待填写

本功能把 MCP、A2A 与 Extension 的活动声明从核心 `config.json` 拆到用户级 `~/.kodax/integrations/{mcp,a2a,extensions}.json`。每个领域只有一个文件，支持原子写入、旧配置兼容迁移、运行时重新读取、最近有效配置保留与明确的 A2A restart-required 边界。A2A 的一个文件同时保存全部出站 Agent 和入站 server；每个出站条目通过热 `enabled` 期望态控制是否接受新编排。

---

## 测试环境

### 前置条件

- Node.js 20 或 22，已执行 `npm install` 与 `npm run build`。
- 使用临时 `KODAX_HOME`，保留一份包含旧 `mcpServers`/`extensions` 字段的测试 `config.json`。
- 准备一个可启动的本地 MCP server 和两个最小 Extension 文件。
- Windows 与一个 POSIX 环境各执行一次 watcher 用例。

### 自动化发布基线

```bash
npx vitest run packages/repl/src/common/integration-config.test.ts
npx vitest run packages/repl/src/common/mcp-servers.test.ts packages/repl/src/common/example-config.test.ts
npx vitest run packages/coding/src/capabilities/providers/mcp-adapter.test.ts
npx vitest run packages/coding/src/extensions/reconcile.test.ts packages/coding/src/extensions/capability-provider-drain.test.ts src/integration-hot-reload.test.ts
npx vitest run src/a2a/config.test.ts src/a2a/runtime-config.test.ts src/integration-cli.test.ts
npx vitest run src/a2a/security.test.ts src/a2a/client-auth.test.ts src/a2a/client-executor-auth.test.ts src/a2a/server-auth.test.ts
npm run config:templates:check
npm run build
```

---

## 测试用例

### TC-001：模板是唯一来源且不会激活配置

**优先级**：高
**类型**：正向 / 包装

**步骤**：

1. 在空 `KODAX_HOME` 分别执行 `kodax config template core`、
   `kodax config template mcp`、`kodax config template a2a` 和
   `kodax config template extensions`。
2. 执行 `kodax config paths`。
3. 执行 `npm run config:templates:check` 与 `npm pack --dry-run --json`。

**预期结果**：

- [ ] template 命令只写 stdout，不创建活动文件或 example 文件。
- [ ] 四个模板均合法且默认惰性；MCP/Extension 为 version 1，A2A 为
  version 2，core 模板不使用 integration domain version 包装。
- [ ] 根镜像、嵌入常量与 `config-templates/` 无漂移。
- [ ] npm 包包含可检查模板，单文件 CLI 仍可在无 sidecar 时打印嵌入模板。

### TC-002：旧核心配置兼容读取与显式迁移

**优先级**：高
**类型**：迁移 / 数据安全

**步骤**：

1. 仅在 `config.json` 写入两个旧 MCP 与两个旧 Extension。
2. 执行 `kodax integrations status` 和 `kodax integrations migrate`。
3. 执行 `kodax integrations migrate --apply`。
4. 再执行 `kodax integrations migrate --apply --cleanup-legacy`。

**预期结果**：

- [ ] 新文件不存在时 source 为 `legacy-user`，现有能力仍可用。
- [ ] 不带 `--apply` 的 plan-only 运行不写文件，并报告目标、条目数和疑似明文密钥警告。
- [ ] apply 先完整写入领域文件，不覆盖已存在目标。
- [ ] cleanup 仅在目标已存在后删除对应旧字段，核心其他字段不变。

### TC-003：首次领域修改不丢失旧条目

**优先级**：高
**类型**：迁移 / 回归

**步骤**：

1. 恢复“只有旧配置”的状态。
2. 执行 `kodax mcp add new-server --command node --arg server.mjs`。
3. 对 Extension 执行一次 add。

**预期结果**：

- [ ] 新领域文件同时包含所有旧条目和新增条目。
- [ ] 创建领域文件不会改写 `config.json` 或其他领域文件。
- [ ] A2A 出站与入站部分的任一写入都保留另一部分。

### TC-004：MCP 与出站 A2A 热加载

**优先级**：高
**类型**：热加载 / 集成

**步骤**：

1. 保持 KodaX 交互会话或 daemon 运行。
2. 新增、更新和删除 MCP server，验证后续 capability catalog/call。
3. 新增、更新和删除 A2A Agent，验证 F258 可调度列表。
4. 让一个条目更新失败，同时保留另一个有效更新。
5. 检查 daemon initialize capability，并分别连接只具备
   `externalAgentAdmin: 1` 的旧 owner 与同时具备
   `a2aConfigReconciler: 1` 的当前配置 owner。

**预期结果**：

- [ ] MCP 完整候选先预热，成功后替换 provider；失败保留上一完整 provider。
- [ ] 旧 provider 的 dispose 失败不回滚已激活的新 provider；Runtime 记录
  `dispose` 阶段的通用诊断，且后续关闭不重复执行有副作用的清理。
- [ ] 出站 A2A 按条目更新；Card/auth/effect 变化先把旧注册设为不可接收
  新任务，发现失败时只为既有任务保留其固定旧 revision，不 fail-open。
- [ ] 正在运行的任务使用捕获的 revision，不被中途切换。
- [ ] A2A 配置写入要求 `externalAgentAdmin: 1` 与独立的
  `a2aConfigReconciler: 1` 同时存在；只有实际拥有并协调目标 `a2a.json` 的
  daemon 才可满足后者，旧 owner 在写盘前得到明确升级/重启错误。

### TC-005：Extension 逐条事务热加载

**优先级**：高
**类型**：热加载 / 回滚

**步骤**：

1. 配置 Extension A 与 B 并启动长生命周期 host。
2. 把 A 改成激活时报错，同时删除 B 并新增有效 Extension C。
3. 观察诊断与工具目录。

**预期结果**：

- [ ] A 在新实例成功激活前不处置旧实例，因此失败后保留 A 的最近有效实例。
- [ ] B 被卸载，C 被加载；事件报告 applied/retained/removed 数量。
- [ ] 配置快照与逐条生效结果一致，不出现“配置整体回滚但部分 Runtime 已更新”。
- [ ] A2A 服务启动时固定已授权 Extension 工具；对应权威变化需重启服务。

### TC-006：无效文件、原子保存与 watcher 恢复

**优先级**：高
**类型**：负向 / 跨平台

**步骤**：

1. 运行 host 时写入非法 JSON、未知字段和错误类型。
2. 使用编辑器的临时文件 + rename 保存方式恢复合法文件。
3. 快速连续保存多次，并执行 `kodax integrations reload` 验证当前进程的
   磁盘快照；另通过长生命周期 owner 的 watcher/metadata fallback 验证实际协调。

**预期结果**：

- [ ] 非法候选不替换最近有效快照，使用 `invalid-config`；订阅者激活失败
  使用 `activation-failed`；两类诊断都不含异常中的密钥、URL 或本地路径。
- [ ] parent-directory watcher 能捕获原子 rename；突发事件被合并。
- [ ] owner 的 metadata fallback 或 owner 内部 reload 可弥补漏事件；被动
  `kodax integrations reload` 不伪装成对另一进程的生效通知。
- [ ] watcher 降级被报告，但不会清空活动能力或阻止进程正常退出。

### TC-007：A2A 热字段与重启状态

**优先级**：高
**类型**：一致性 / 安全

**步骤**：

1. 运行 `kodax a2a serve`。
2. 修改 `published`、authentication 环境引用与 limits。
3. 在同一 `tokenEnv` 名称下轮换 secret，再将 Bearer profile/token-env 名称
   切到 OAuth issuer；另在同 issuer 下轮换 JWKS。
4. 修改 execution、Agent、workspace、toolPolicy、Skill revision 或 dataDir。

**预期结果**：

- [ ] `published`、authentication 与 limits 通过完整验证后作为热块原子更新。
- [ ] execution、Agent、workspace、toolPolicy、Skill revision 与 `dataDir` 只
  报告 restart-required；旧监听器不自动重启。
- [ ] 既有任务继续使用旧执行绑定，新绑定只在显式重启后出现；任务查询仍
  按当前 authentication realm 授权，不会因相同 subject 跨 realm 接管。
- [ ] host/port 仅属于启动参数，不写入活动配置。
- [ ] Bearer 自动派生 `bearer-env:<tokenEnv-name>` realm，OAuth 自动派生
  `oauth2-jwt:<validated-exact-issuer>` realm；同 realm 的 secret/JWKS 轮换
  保持任务归属，profile、token-env 名称或 issuer 变化不会继承旧任务。

### TC-008：并发写入、权限与秘密边界

**优先级**：高
**类型**：安全 / 并发

**步骤**：

1. 两个进程基于同一 revision 同时修改同一领域文件。
2. 检查文件与 lock/tmp 残留。
3. 使用 CLI 添加只含 `credentialEnv`/`tokenEnv` 的配置并执行 status/validate。
4. 从 public `@kodax-ai/kodax/a2a` 导入 config API，检查 read/parse/inspect/
   classify 与 raw migrate/upsert/setEnabled/remove/server-write 的可见性。
5. 启动一个并不拥有 A2A config reconciler 的 SDK daemon，但通过 capability
   override 伪造 `externalAgents`、`externalAgentAdmin` 和
   `a2aConfigReconciler`；再尝试 CLI A2A mutation。

**预期结果**：

- [ ] 一个写入成功，另一个得到 busy 或 revision-changed，不静默覆盖。
- [ ] 文件替换完整，无半写 JSON；异常后锁和临时文件可恢复。
- [ ] 用户目录/文件使用限制权限。
- [ ] 配置、状态、诊断和日志从不显示已解析凭据值。
- [ ] public `/a2a` 的配置子面只导出 parse/read/inspect/classify 及类型；raw
  migration/mutation writer 不可导入，只能由受 owner fence 保护的 CLI 路径使用。
- [ ] capability override 中的三个 A2A ownership 字段都被剥离；非 owner
  无法伪造 `a2aConfigReconciler: 1`，mutation 在写盘前失败。

### TC-009：多 Agent 热启用、停用与任务连续性

**优先级**：高
**类型**：管理 / 热加载

**步骤**：

1. 配置 Agent A、B、C，其中 A/B 为 `enabled: true`，C 为 `enabled: false`；为每个 Card endpoint 和 OAuth token endpoint 记录请求次数。
2. 保持 daemon 或 embedded owner 运行，让 A 启动一个未完成任务，然后执行 `kodax a2a disable A`。
3. 等待 owning Runtime 的 admin 列表确认已应用该 revision，再尝试按 catalog
   和显式 `external:A` 启动新任务，同时继续查询/输入/取消步骤 2 的既有任务。
4. 执行 `kodax a2a enable C`，再只修改 B 的 effect 或 authentication 引用。

**预期结果**：

- [ ] `a2a list` 显示 configured/desired `enabled`，不伪装成其他进程的 live 状态；Runtime admin 列表反映实际已应用注册。
- [ ] 停用先关闭 A 的所有新任务入口，且不发送隐式远端 cancel；已准入任务继续使用固定 revision。
- [ ] 自动协调不请求停用 C 的 Card/token；启用 C 前重新 discovery/security planning，成功后才可调度。
- [ ] 切换或修改一个 Agent 不重新发现未变化的其他 Agent，也不覆盖 `server` 或同文件中的其他条目。

### TC-010：激活失败、同 revision 重试与持久化原子性

**优先级**：高
**类型**：恢复 / 一致性

**步骤**：

1. 让一个新启用 Agent 的 Card discovery 暂时失败；不修改文件，修复 endpoint
   后调用 owning host 的 `ConfiguredA2ARuntimeHandle.reload()`。
2. 让一个已启用 Agent 的 Card/auth/effect 新配置发现失败，确认旧 revision
   只能服务既有已准入任务，不能继续接收新调用。
3. 注入 registration store 写入失败，再执行 upsert/setEnabled/remove；随后恢复存储并重试。
4. 分别在 policy 与 executor preflight 尚未返回时停用同一 Agent，再释放该异步检查。
5. 用 SDK 手工注册一个同为 A2A executor、但不归 `a2a.json` owner 管理的 Agent；
   验证异 owner 同 ID 冲突。再在 owner 完成 list 后、disable/remove 前，用 SDK
   以相同 revision 接管或替换同 ID registration，并制造归属 registration 的
   删除/禁用/revision 漂移后触发 owner reload。
6. 启动三个保持非终态的远端任务，然后更新并删除其 live registration、关闭并
   重启 Runtime；分别执行 `sendInput`、`reconcile` 与 `cancel`。
7. 检查内部 task-registration snapshot 文件与公共 task/daemon DTO；再模拟
   snapshot-before-task 和 terminal-task-before-GC 两个崩溃窗口并重启。
8. 让一个 SDK-owned 同名冲突与两个可正常更新的配置 Agent 同批协调，并让
   `onEvent` 观察回调主动抛错。

**预期结果**：

- [ ] 首次失败不错误标记为 applied；相同磁盘 revision 的 owner reload 会重试并成功生效；被动 CLI reload 只做静态验证。
- [ ] 已启用条目更新失败时先 fail-closed 停止新准入，既有任务仍用固定旧 revision，且不阻止其他条目更新。
- [ ] 持久化失败时内存 catalog 不先行变化；恢复后可安全重试，不形成 desired/applied split-brain；setEnabled 保留完整 executor/auth payload。
- [ ] 所有异步 preflight 之后的最终同步 enabled/revision 检查是准入点；此前生效的停用不会启动远端 executor 或创建 task ledger。
- [ ] 协调器只修改自己的 `managementOwner` registration；revision 与 owner 在同一
  原子变更中同时比较，异 owner 冲突明确失败，list 后即使发生同 revision owner
  接管也不会被旧 manager 的 upsert/disable/remove 误伤；相同配置 reload 能修复
  归属 registration 的 live 删除、禁用或 revision 漂移。
- [ ] 更新/删除 registration 并重启后，三个已准入任务仍由原 endpoint/auth/executor
  路由完成输入、协调和取消；同 `(agentId, revision)` 的不同执行内容被拒绝。
- [ ] 完整路由快照不出现在 task/daemon 响应中，只包含公开配置和凭据引用而非真实
  token/secret；任务先终态落盘再清理最后引用，重启会清理孤儿快照且不误删非终态引用。
- [ ] owner 冲突只跳过并诊断该条目，其他 Agent 仍完成；协调器等待全部已启动 refresh
  后才返回，观察回调异常不回滚已应用变更，也不使 desired/applied 状态分叉。

---

## 边界用例

- **BC-001**：空领域文件与大量条目都保持确定排序/输出，不创建“一连接一文件”。
- **BC-002**：删除不存在条目返回明确结果且不改 revision。
- **BC-003**：Windows CRLF、POSIX LF 和 Unicode 路径均可读取。
- **BC-004**：领域文件存在时不再混入同领域旧核心字段。
- **BC-005**：关闭 host 后 watcher 不阻止 CLI/daemon 退出。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 10 + 5 边界项 | - | - | - |

**测试结论**：待填写
**发现的问题**：待填写
**证据位置**：待填写（命令输出、临时配置副本、跨平台日志、npm pack 清单）

---

*测试指南更新时间：2026-07-16*
*Feature ID：FEATURE_268*
