# FEATURE_271 v0.7.73 首次 Provider 配置与 Auto LLM 可靠性 - 人工测试指导

## 功能概述

**功能名称**: First-Run Provider Setup and Auto LLM Reliability Closure
**版本**: v0.7.73
**测试日期**: 2026-07-20
**测试人员**: 待填写

本轮验收覆盖两个相互隔离的职责：首次交互启动在没有有效 provider
选择和本地凭据时进入不收集 Key 的配置界面；Runtime Auto LLM 在模型配置、
权限 owner、历史上下文和 20 秒 side-query 边界上保持安全且可恢复。

---

## 测试环境

### 前置条件

- Node.js 20 或更高版本，仓库依赖已安装并完成 `npm run build`。
- 使用独立测试配置目录，避免覆盖真实 `~/.kodax`：

```powershell
$env:KODAX_HOME = Join-Path $env:TEMP "kodax-f271-manual"
npm run dev -- --help
```

```bash
export KODAX_HOME="$(mktemp -d)"
npm run dev -- --help
```

- 不在截图、日志或测试记录中填写真实 API Key；需要模拟凭据存在时使用无效占位值，
  且不要发起模型请求。
- Auto LLM 宿主验收使用一个能观察 `runtime.permissions.listPending()` 和
  `permission.requested` 事件的 SDK/Space 测试壳。

### 自动化基线

```bash
npm run build
npx vitest run packages/repl/src/common/provider-setup.test.ts \
  packages/repl/src/interactive/provider-setup.test.ts \
  src/provider-setup-cli.test.ts
npx vitest run packages/coding/src/guardrails/auto-mode/transcript-strip.test.ts \
  packages/coding/src/guardrails/auto-mode/classify.test.ts \
  packages/coding/src/guardrails/auto-mode/guardrail.test.ts \
  packages/coding/src/tools/classifier-projection.test.ts \
  packages/coding/src/tools/registry.test.ts \
  packages/agent/src/primitives/guardrail.test.ts \
  packages/llm/src/side-query.test.ts
npx vitest run packages/repl/src/common/permission-config.test.ts \
  src/sdk-runtime.test.ts \
  src/sdk-runtime-daemon-upgrade.test.ts \
  src/runtime-daemon/server.test.ts
```

真实 GLM-5.2 latency probe 已完成，不是人工验收的必跑项，也不要为本指南重复消耗
token。原始四次结果为 1,905–2,763 ms，均返回 allow。

---

## 测试用例

### TC-001: 新机器裸启动进入专用配置界面

**优先级**: 高
**类型**: 正向测试 / UI 测试

**前置条件**: 独立 `KODAX_HOME` 下不存在 `config.json`，当前进程不存在任何内置
provider 的 API-key 环境变量。

**测试步骤**:

1. 在真实 TTY 中运行 `npm run dev`。
2. 观察 Runtime、session 和 REPL 初始化前的第一屏。
3. 暂不选择，确认界面说明不会收集或保存 API Key。

**预期效果**:

- [ ] 首先显示 provider/model 配置界面，而不是低层 missing-key 错误。
- [ ] 界面只展示 provider、model 和所需环境变量名。
- [ ] 没有 daemon、session、REPL 或 LLM 请求先于该界面创建。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: 内置 Provider 配置、重启交接与配置最小化

**优先级**: 高
**类型**: 正向测试 / 安全测试

**测试步骤**:

1. 在首次配置界面选择任一内置 provider 和其默认或其他受支持 model。
2. 确认保存。
3. 查看完成提示和独立 `KODAX_HOME/config.json`。

**预期效果**:

- [ ] 配置只新增 `provider` 与 `model`，不存在 Key 值或看似真实的 Key 占位符。
- [ ] 提示准确给出该 provider 的环境变量名。
- [ ] 提示关闭并重启 terminal，然后重新运行 `kodax`。
- [ ] 提示可用 `kodax doctor` 做不发送 LLM 请求的本地检查。
- [ ] 当前旧进程保存后退出，不继续创建 Runtime/REPL。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: 取消配置不产生副作用

**优先级**: 高
**类型**: 负向测试

**测试步骤**:

1. 换用新的独立 `KODAX_HOME`。
2. 运行 `npm run dev`，在 provider 选择处输入 `q` 或按 Ctrl+C。
3. 检查进程退出和配置目录。

**预期效果**:

- [ ] 显示简洁的 cancelled 与 `kodax setup` 重试提示。
- [ ] 不创建或修改 `config.json`。
- [ ] 终端立即恢复输入，不需要额外按键。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: 显式 `kodax setup` 保留无关配置

**优先级**: 高
**类型**: 正向测试 / 数据完整性测试

**前置条件**: 在测试 `config.json` 中先写入无关字段，例如
`{"locale":"zh-CN","extensions":["example.js"]}`。

**测试步骤**:

1. 运行 `npm run dev -- setup`。
2. 选择内置 provider/model 并确认。
3. 重新读取 `config.json`。

**预期效果**:

- [ ] `locale` 和其他无关字段保持不变。
- [ ] 仅 provider 相关字段发生预期变化。
- [ ] 写入结果是始终可解析的 JSON，没有遗留临时文件。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: 自定义 Provider 仅接受公开元数据

**优先级**: 高
**类型**: 正向测试 / 安全测试

**测试步骤**:

1. 运行 `npm run dev -- setup`，选择 custom provider。
2. 输入唯一名称、OpenAI 或 Anthropic 协议、HTTP(S) Base URL、环境变量名和 model。
3. 确认摘要并检查配置。

**预期效果**:

- [ ] 全流程没有 API Key 值输入框或提示。
- [ ] 摘要只包含名称、协议、URL、model 和环境变量名。
- [ ] `customProviders` 写入规范结构并成为当前 provider/model。
- [ ] 原有合法 custom provider 条目和无关配置均保留。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: 自定义 Provider 的凭据和损坏配置防护

**优先级**: 高
**类型**: 负向测试 / 安全测试

**测试步骤**:

1. 尝试 Base URL `https://user:secret@example.test/v1`。
2. 尝试 `https://example.test/v1?api_key=secret`，并确认普通公开参数如
   `?api-version=2026-07-20` 不受影响。
3. 另一次尝试非法环境变量名，例如 `NOT A VALID NAME`。
4. 再换一个目录，将 `config.json` 写成非法 JSON 后运行裸 `kodax` 和
   `kodax setup`。
5. 再测试包含残缺或重复 `customProviders` 的合法 JSON。

**预期效果**:

- [ ] URL 内嵌用户名/密码被拒绝，配置不写入。
- [ ] URL 内凭据型 query parameter 被拒绝，公开 endpoint 参数仍可使用。
- [ ] 非法环境变量名被拒绝，配置不写入。
- [ ] 非法 JSON 原字节不变，并报告准确路径和修复提示。
- [ ] 残缺/重复 custom provider 不被过滤或静默覆盖。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: 自动向导不会打断显式和非交互入口

**优先级**: 高
**类型**: 兼容性测试

**前置条件**: 使用没有配置和凭据的新 `KODAX_HOME`。

**测试步骤**:

1. 分别运行 `npm run dev -- --help`、`npm run dev -- -r`、
   `npm run dev -- --mode json -p "hello"` 和任意现有子命令。
2. 通过重定向 stdin/stdout 再运行一个非 TTY 命令。

**预期效果**:

- [ ] 所有入口都不插入首次配置界面。
- [ ] `-r` 仍进入恢复链，Help/JSON/子命令保持原有输出契约。
- [ ] 脚本和 CI 不因等待交互而挂起。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: 已选 Provider 缺少 Key 时不覆盖用户意图

**优先级**: 中
**类型**: 负向测试 / 兼容性测试

**测试步骤**:

1. 在配置中写入有效内置 `provider` 和 `model`，但不设置其 Key。
2. 裸启动 `kodax`。
3. 检查配置文件。

**预期效果**:

- [ ] 不自动进入会覆盖 provider 的首次配置向导。
- [ ] 原有 missing-credential 恢复路径能指出所需变量。
- [ ] 配置文件保持不变，用户仍可主动运行 `kodax setup`。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: Auto LLM 缺失模型不会变成权限弹窗

**优先级**: 高
**类型**: 负向测试 / SDK 测试

**测试步骤**:

1. 创建没有 default/run/session model 的 Runtime Session。
2. 设置 `permissionMode: 'auto'` 和 `autoModeEngine: 'llm'`。
3. 调用 `runtime.runs.start()` 并检查 permission 事件和 pending 列表。
4. 再分别尝试空白和不完整的 classifier model spec。
5. 直接创建通用 `createAutoModeToolGuardrail`，同时设置
   `defaultModel: ""` 且 live `getDefaultModel()` 返回空值，再执行一个需要
   classifier 的普通工具调用。

**预期效果**:

- [ ] 返回 `RuntimeAutoModeConfigurationError`，code 为
  `auto_mode_classifier_model_required` 且 `recoverable === true`。
- [ ] 没有 provider/classifier 调用。
- [ ] 没有 `permission.requested`，pending 列表为空。
- [ ] 通用 guardrail 返回本地配置 block，不调用 `askUser`，不增加 denial
  或 circuit-breaker 计数，也不会触发静默 rules fallback。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: 省略 Auto engine 仍由 Runtime LLM guardrail 接管

**优先级**: 高
**类型**: 回归测试 / SDK 测试

**测试步骤**:

1. 创建带有效 provider/model 的 Runtime Session。
2. 只设置 `permissionMode: 'auto'`，不设置 `autoModeEngine`。
3. 执行安全只读和普通验证命令，并观察 guardrail、permission hook、execute 顺序。

**预期效果**:

- [ ] 有效 engine 为 `llm`，Runtime 创建并复用 guardrail。
- [ ] 顺序为 guardrail -> permission hook（仅 escalate）-> execute。
- [ ] allow 命令不产生 pending permission。
- [ ] 只有模拟 classifier escalation 才产生恰好一次共享请求。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: 大会话历史不再拖入当前 Tool 权限判断

**优先级**: 高
**类型**: 边界测试 / 性能测试

**前置条件**: 使用自动化 fixture 或测试壳构造一条约 1.625 MB 的历史
`tool_result`，当前 action 保持为短的 process query 或 taskkill 命令。

**测试步骤**:

1. 触发当前短 tool call 的 Auto LLM 分类。
2. 在 mock provider 边界记录 classifier system/messages 字节数和输出 token cap。
3. 检查分类后 permission 状态。

**预期效果**:

- [ ] 大数据来自历史 tool result，而不是被误认为当前 action。
- [ ] 每条历史 tool result 仅包含 tool/status/text_chars/text_bytes/media_items 元数据，正文即使小于 2 KiB 也不进入 classifier。
- [ ] 单条 result 元数据不超过 2 KiB，序列化 transcript 不超过 8 KiB。
- [ ] assistant prose/thinking、图片、本地图片路径和 tool result 正文均未进入 classifier。
- [ ] 输出上限为 256 tokens，正常 allow 不产生弹窗。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-012: 超大当前 Action 安全升级而非截断放行

**优先级**: 高
**类型**: 边界测试 / 安全测试

**测试步骤**:

1. 构造超过 16 KiB 的 Bash/script action projection。
2. 触发分类并记录 provider call 数。
3. 由宿主检查产生的人工权限请求。

**预期效果**:

- [ ] provider call 数为零。
- [ ] verdict 是明确的 input-budget escalation，不是 allow。
- [ ] 有审批桥时最多产生一次请求；没有审批桥时保持 fail-closed。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-013: SDK 使用统一的 typed Auto settings resolver

**优先级**: 高
**类型**: SDK 兼容性测试

**测试步骤**:

1. 从 `@kodax-ai/kodax/repl` 和包根分别导入 `loadAutoModeSettings`、
   `resolveAutoModeSettings`、`AutoModeSettings` 和
   `ResolveAutoModeSettingsInput`。
2. 用显式输入分别覆盖 config、environment 和默认值优先级。
3. 调用 `loadConfig()` 并在 TypeScript 中读取返回值的 `autoMode`。
4. 对构建后的 `dist/sdk-repl.d.ts` 与 `dist/index.d.ts` 做一次消费者编译。

**预期效果**:

- [ ] 两个入口导出同一组函数与类型，无需宿主复制配置解析。
- [ ] `resolveAutoModeSettings()` 是纯函数，不读取磁盘或进程环境。
- [ ] `loadAutoModeSettings()` 只是读取权威配置后委托给同一 resolver。
- [ ] `loadConfig().autoMode` 在运行时和公开声明中一致存在。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-014: Session speculative window 与并发设置共用一个 owner

**优先级**: 高
**类型**: SDK 状态一致性 / 边界测试

**测试步骤**:

1. 将 Session 设为 `permissionMode: 'auto'`、`autoModeEngine: 'llm'`，并设置
   `autoModeSpeculativeWindowMs: 1200`。
2. 启动一个 active run 和一个不同 `executionCwd` 的 queued run。
3. 在 run 存续期间把 speculative window 更新为 `0`，并并发触发一次
   LLM-to-rules fallback 与无关 settings 更新。
4. 重启 Runtime，读取 Session settings 和后续 bootstrap 参数。
5. 尝试 `-1`、非整数和 `null`。

**预期效果**:

- [ ] `0` 被接受并持久化，active/queued projection 与 guardrail bootstrap 一致。
- [ ] 不同 cwd 使用各自 guardrail cache identity，不捕获另一 queued run 的 cwd。
- [ ] fallback 和 settings 更新经同一 mutation queue 合并，不丢失无关字段。
- [ ] 重启后 effective engine/window 与持久化值一致。
- [ ] 负数和非整数被拒绝；`null` 明确删除覆盖值。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-015: capability v3 升级旧 daemon 且不破坏旧最低要求

**优先级**: 高
**类型**: Daemon 升级 / 兼容性测试

**测试步骤**:

1. 分别让旧 daemon 广告 `runtimeAutoModeGuardrail: { version: 1 }` 与
   `{ version: 2 }`，并广告 `daemonManagement: { version: 1 }`。
2. 在无 active/queued run、Workflow、Agent turn、pending permission/user
   input 和其他 logical client 时，以 `autoStart: true` 连接。
3. 重复步骤 2，但制造一个 queued run blocker。
4. 用 v3 daemon 分别连接要求 v1、v2 和 v3 的 attach-only 客户端。
5. 检查 v3 capability 同时广告 `permissionGrantSuggestions: true`、
   `concretePermissionMatchers: true` 和 `clientScopeExpansion: false`。

**预期效果**:

- [ ] idle v1/v2 daemon 经 revision/owner-policy fenced preflight 安全停止并换成 v3。
- [ ] busy v1/v2 daemon 不被停止，返回带 blocker 的可恢复升级错误。
- [ ] v3 daemon 满足 v1/v2/v3 最低要求；v1/v2 daemon 不满足显式 v3 要求。
- [ ] v3 metadata 公布 effective timeout、speculative window、bounded input、
  diagnostics version、精确授权建议和 matcher；客户端不能扩展粗粒度 scope。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-016: timeout 诊断与 guardrail span 覆盖真实等待

**优先级**: 高
**类型**: 可观测性 / 安全测试

**测试步骤**:

1. 模拟 provider 在首个输出前超时，并模拟一次带 Retry-After 的超时。
2. 再模拟 provider 先发送非空文本增量、随后在 stream 中超时。
3. 捕获 `ClassifyDecision.diagnostics`、超时 reason 和 tracing processor 事件。
4. 在 guardrail callback 中放置可控等待，确认等待期间 span 已开始但未结束。
5. 搜索诊断对象，确认其中没有 system prompt、messages、action 或响应正文。

**预期效果**:

- [ ] 诊断包含 provider、model、effective timeout、elapsed、retry 次数/等待。
- [ ] 首输出前超时标记 `pre_output`；首输出后超时标记 `streaming`，并携带
  `firstOutputMs` 和 `streamMs`。
- [ ] 未观测的 DNS/connect/远端 queue 不被伪造为精确阶段。
- [ ] `guardrail:auto-mode` span 在 callback 前开始、最终 verdict 后结束，耗时覆盖
  classifier 实际等待。
- [ ] 所有诊断均为固定字段元数据，不复制 prompt、tool input 或模型正文。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-017: Auto LLM 工具语义投影保持风险事实且不泄露正文

**优先级**: 高
**类型**: 安全测试 / 兼容性测试 / 回归测试

**测试步骤**:

1. 用 mock classifier 分别触发 `run_skill_script`、`run_workflow`、`spawn_agent`、`send_message`、`web_search`、provider-backed `code_search`、`mcp_call` 和 `mcp_get_prompt`。
2. 参数中加入长路径、snake_case/camelCase 路径和控制字段、两个同时存在的 MCP action 字段、40 个排在 action 前面的未知字段，以及可唯一识别的 Write/Edit/Workflow/Message/Agent objective 私有正文。
3. 注册一个省略 `sideEffect`/`toClassifierInput` 的 JavaScript 扩展，再注册一个非只读但错误返回空投影的扩展。
4. 让另一个 projector 抛出异常，并构造一个空投影但命中 Tier-0 denylist 的调用。
5. 捕获发送给 classifier 的 action 和历史 transcript；不要记录真实凭据。

**预期效果**:

- [ ] 路径、URL、命令/script、args、scope、isolation、provider/model、能力 ID 和控制 flags 以有界形式保留。
- [ ] snake_case/camelCase SDK 字段语义一致；已知字段不会被前置未知字段挤掉，长路径同时保留根部与最终目标名。
- [ ] MCP 的多个 action 字段同时保留；未知短字符串只显示 `string:<length>`，不会因为“短”而原样外传。
- [ ] Write/Edit/Workflow/Message/Agent objective/result 正文只显示长度或状态元数据，唯一识别文本不存在于 classifier 请求中。
- [ ] 本地 `code_search` 继续跳过 classifier；provider-backed `code_search` 和网络读取携带 provider/capability 事实进入分类。
- [ ] 缺元数据或意外空投影的非只读扩展使用安全 fallback，不会自动放行。
- [ ] projector 抛错时明确升级；Tier 0 在任何空投影前阻断。
- [ ] 历史 `tool_call` 展开为真实目标，canonical summary 不重复长路径/命令。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界与兼容性清单

- [ ] Windows PowerShell、Windows Terminal 和至少一个 Unix-like shell 的向导输入/退出正常。
- [ ] 中文 provider/model 或错误提示不会乱码，路径含空格时仍能保存。
- [ ] Ctrl+C、`q`、确认前拒绝均无配置写入。
- [ ] 同一向导打开期间外部修改 config 会触发 revision conflict，不覆盖新内容。
- [ ] 配置文件不可写时显示路径/OS 错误，且不继续启动 KodaX。
- [ ] 规则到 LLM 的动态切换在无模型时 block 且不创建 permission。
- [ ] classifier timeout 仍为 20 秒；不能通过无限延长 timeout 掩盖输入失控。
- [ ] v3 capability 可被新版 SDK 识别，v1/v2 客户仍可把 v3 当作兼容的更高版本。
- [ ] `autoModeSpeculativeWindowMs: 0` 不会被 truthy 判断丢弃。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 17 | - | - | - |

**测试结论**: 待填写

**发现的问题**: 如有问题请记录输入、终端、`KODAX_HOME`、session/run ID、
是否产生 pending permission，以及脱敏后的 classifier input 字节数。禁止附带真实 Key。

---

*测试指导生成时间: 2026-07-20*
*Feature ID: FEATURE_271 / Runtime Auto LLM v0.7.73 patch*
