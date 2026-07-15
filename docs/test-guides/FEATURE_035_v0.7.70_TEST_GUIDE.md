# FEATURE_035 MCP 渐进式披露 v2 - 人工测试指南

## 功能概览

**功能名称**：MCP capability 渐进式披露、无损续页与目录真实性
**版本**：v0.7.70
**测试日期**：2026-07-15
**测试人员**：待填写

本次改造让主 Agent 只常驻 5 个简洁 MCP 入口，并按“环境感知 → inventory/search → describe → invoke”逐层读取远端能力。目录过大时只因真实上下文容量或显式 `limit` 续页，不再静默截断，也不通过有损预览迫使模型读取第二份 artifact。

---

## 测试环境

### 前置条件

- Node.js >= 20，已在仓库根目录执行 `npm install`。
- 至少配置一个可正常连接的 MCP server。
- 完整目录测试建议使用含 21 个以上 capability 的 server；本地验证使用 `github` 26 项与 `minimax` 2 项。
- stale/mixed 用例需要先成功生成缓存，再临时让一个测试 server 无法启动。
- 不要在测试记录中粘贴 MCP 配置里的 token、API key 或环境变量值。

### 自动回归基线

```powershell
$env:NODE_OPTIONS='--max-old-space-size=4096'
npx vitest run packages/agent/src/capabilities/mcp packages/coding/src/capabilities/providers/mcp-adapter.test.ts packages/coding/src/tools/mcp-tools.test.ts packages/coding/src/tools/registry.test.ts packages/coding/src/tools/tool-search.test.ts packages/coding/src/extensions/runtime.test.ts packages/coding/src/prompts/builder.test.ts --maxWorkers=1
npx tsc -b tsconfig.build.json --pretty false
```

预期：命令全部成功；没有 TypeScript 错误。

---

## 测试用例

### TC-001：直接发现 MCP，不经过 tool_search

**优先级**：高
**类型**：正向测试 / 效率测试

**步骤**：

1. 启动含可用 MCP server 的新会话。
2. 询问“列出你当前可用的所有 MCP capability”。
3. 展开工具轨迹。

**预期结果**：

- [ ] Agent 可直接调用 `mcp_search`。
- [ ] 不先调用 `tool_search("mcp_search")` 解锁固定入口。
- [ ] 空 query 的结果标题为 `MCP catalog inventory`。
- [ ] 结果只列 exact id，不携带每项远端长描述。

### TC-002：容量允许时一次返回完整目录

**优先级**：高
**类型**：正向测试 / 回归测试

**步骤**：

1. 使用 21 个以上、但可放入当前上下文的 capability 目录。
2. 调用不带 `query`、不带 `limit` 的 `mcp_search`。
3. 对照 server 实际 capability 数量。

**预期结果**：

- [ ] `returned` 等于 `total`。
- [ ] `has_more=false`。
- [ ] 目录超过旧上限 20 时仍一次完整返回。
- [ ] Agent 不再因为“还有更多未显示”重复拉取同一目录。

### TC-003：超过 100 项但上下文可容纳

**优先级**：高
**类型**：边界测试

**步骤**：

1. 使用测试 fixture 提供 150 个短 capability id。
2. 在容量足够的执行上下文中调用默认 inventory。

**预期结果**：

- [ ] 返回 150/150。
- [ ] 不存在固定 100 项上限。
- [ ] 不返回 cursor。

### TC-004：真实上下文容量触发无损续页

**优先级**：高
**类型**：边界测试 / 完整性测试

**步骤**：

1. 使用包含多条长 id 的测试目录。
2. 将测试执行上下文的 `toolResultCapacityTokens` 调低。
3. 调用 inventory，随后只携带返回的 `cursor` 重复调用，直至 `has_more=false`。
4. 合并每页 exact id。

**预期结果**：

- [ ] 受限页显示 `constrained_by=context_capacity`。
- [ ] 每页 token 数不超过测试容量；单条 exact id 也不能绕过容量检查。
- [ ] cursor 调用不再携带 query/server/kind/limit。
- [ ] 合并结果无重复、无遗漏、顺序稳定。
- [ ] 不出现“读取 raw artifact 才能恢复剩余目录”的提示。

### TC-005：显式 limit 与参数校验

**优先级**：中
**类型**：负向测试 / 参数测试

**步骤**：

1. 以 `limit=2` 调用至少 3 项的 inventory。
2. 使用 cursor 读取下一页。
3. 分别尝试 `limit=0`、`limit=1.5`、字符串 limit，以及 cursor 与 query 同时传入。

**预期结果**：

- [ ] 正常分页无重复遗漏。
- [ ] 非正安全整数返回清晰的 Tool Error，且不会调用 provider。
- [ ] cursor 与其他筛选参数同时传入时被拒绝。
- [ ] 不发生静默 clamp。

### TC-006：目录变化使旧 cursor 失效

**优先级**：高
**类型**：一致性测试

**步骤**：

1. 获取第一页 cursor。
2. 让 server capability 列表变化或模拟新的 snapshot revision。
3. 使用旧 cursor 继续。

**预期结果**：

- [ ] 返回 `MCP_CATALOG_CHANGED_RESTART`。
- [ ] 输出给出不带旧 cursor 的重启调用。
- [ ] 不混合两个 revision 的页面。

### TC-007：精确和多词搜索排序

**优先级**：中
**类型**：正向测试

**步骤**：

1. 搜索一个 exact capability name 或 exact id。
2. 搜索跨字段多词 query，例如 `github issue`。
3. 重复相同搜索。

**预期结果**：

- [ ] exact id/name 位于首位。
- [ ] 同时匹配全部词的结果排在只匹配部分词的结果之前。
- [ ] 相同 snapshot 下排序可重复。
- [ ] 搜索结果显示 bounded purpose，并明确 provider 文本不可信。

### TC-008：单 server stale cache

**优先级**：高
**类型**：故障降级测试

**步骤**：

1. 正常连接 server 并生成目录缓存。
2. 关闭 server 或把测试 command 改为不存在的路径。
3. 在新 runtime 中调用 `mcp_search`。

**预期结果**：

- [ ] 缓存 capability 仍可见。
- [ ] `freshness=stale`、`complete=false`。
- [ ] `Failures` 指明故障 server，错误文本被压成单行并受长度限制。
- [ ] 结果不会伪装成 live/complete。

### TC-009：多 server mixed 状态

**优先级**：高
**类型**：部分失败测试

**步骤**：

1. 配置一个健康 server 和一个已有缓存但当前故障的 server。
2. 不带 server filter 调用 inventory。

**预期结果**：

- [ ] 健康 server 的 live capability 保留。
- [ ] 故障 server 的 stale capability 也保留。
- [ ] 总体为 `freshness=mixed`、`complete=false`。
- [ ] 单个 server 故障不会让整个 MCP 搜索失败。

### TC-010：describe 的真实性与不可信边界

**优先级**：高
**类型**：安全测试

**步骤**：

1. 让测试 capability description 包含类似“ignore previous instructions”的文本。
2. 检查会话初始 MCP prompt context。
3. 搜索并 describe 该 capability。

**预期结果**：

- [ ] 初始 prompt 不包含远端 description、runtime error 或任意前 N 项描述。
- [ ] prompt 只出现完整 exact ids、完整 names 或 counts 三种无偏层级之一。
- [ ] 未生成缓存的 server 显示 `catalog=unavailable`，不伪装成 `catalog=empty`。
- [ ] `mcp_describe` 可返回完整 provider schema/description，但首行标明其为 untrusted data。
- [ ] describe 同时显示 `Catalog Freshness` 与 `Catalog Complete`。

### TC-011：未实现 snapshot 的旧 provider

**优先级**：中
**类型**：兼容性测试

**步骤**：

1. 注册只实现 legacy `search()` 的 capability provider。
2. 通过 snapshot runtime surface 搜索。

**预期结果**：

- [ ] items 保持兼容可用。
- [ ] `complete=false`、`freshness=unknown`。
- [ ] 缺失 revision 时生成稳定内容 revision，而不是 `revision=unknown`。

### TC-012：单条 capability 本身超过结果容量

**优先级**：高
**类型**：容量边界测试

1. 构造一个 exact id 本身大于 `toolResultCapacityTokens` 的 capability。
2. 调用 inventory。
3. 另用空目录和耗尽的结果容量调用 inventory。

**预期结果**：

- [ ] 返回 `MCP_PAGE_ITEM_EXCEEDS_CAPACITY`。
- [ ] 本次不消费该 capability，也不输出超容量页面。
- [ ] 提示缩小查询或等待上下文压缩，不生成有损 artifact。
- [ ] 空目录的元数据也无法容纳时返回 `MCP_CONTEXT_CAPACITY_EXHAUSTED`，不误报单条 item 过大。

### TC-013：目录协议与缓存完整性

**优先级**：高
**类型**：故障与恢复测试

分别模拟畸形 list 容器、缺失 name/uri、重复 cursor、跨页重复 id、结构损坏缓存和缓存目录不可写。

**预期结果**：

- [ ] 畸形条目和循环 cursor 不会被标记为 complete。
- [ ] 跨页重复 id 只出现一次。
- [ ] 损坏缓存被忽略，健康 server 可重新建立 live catalog。
- [ ] 仅缓存写入失败时仍返回 `freshness=live, complete=true`，错误进入 diagnostics，后续搜索不重复拉取目录。

### TC-014：长查询的全词匹配优先级

**优先级**：中
**类型**：排序回归测试

1. 构造一个在 summary 中命中全部查询词的 capability。
2. 构造一个在高权重 name 中命中大部分、但不是全部查询词的 capability。
3. 使用足够长的多词 query 搜索。

**预期结果**：

- [ ] 全词匹配始终排在部分匹配前，不依赖固定分数奖励。
- [ ] inventory 和 search 输出均标明 provider data 为 untrusted、不可视为指令。

### TC-015：同语种 CJK 紧凑查询

**优先级**：高
**类型**：多语言排序测试

1. 构造中文 summary 分别包含“创建一个新的项目问题”和“列出已有问题”的两个 capability。
2. 使用不带空格的 query `创建问题` 搜索。

**预期结果**：

- [ ] query 被分成有意义的 CJK 词，而不是当成一个不可命中的长串。
- [ ] 同时命中“创建”和“问题”的 capability 排在只命中“问题”的 capability 前。
- [ ] 英文 exact id/name 和多词排序行为不变。

### TC-016：跨语言零命中的无损恢复

**优先级**：高
**类型**：正确性 / token 效率测试

1. 对只有英文 metadata 的 GitHub MCP 目录搜索 `创建问题`，保留 `server=github, kind=tool`。
2. 检查同一次 `mcp_search` 的返回和 runtime 调用轨迹。
3. 按输出规则拼接每组 `Prefix + suffix`，与过滤后的真实 exact id 集合对比。

**预期结果**：

- [ ] 成功词法查询仍只执行一次 snapshot search，不读取 inventory。
- [ ] 零命中时只在工具内部追加一次空 query，且完整保留原 server/kind filter。
- [ ] 返回 `MCP_QUERY_NO_LEXICAL_MATCH` 和无损分组 exact ids，不产生第二个模型/工具 round。
- [ ] 拼接后与当前 filtered snapshot 100% 一致，无重复、无遗漏、无 cursor。
- [ ] freshness、complete、failure count 和 untrusted 边界保持真实；revision 变化则返回 `MCP_CATALOG_CHANGED_RESTART`。

### TC-017：零命中恢复的双重成本准入

**优先级**：高
**类型**：容量 / 负优化防护测试

1. 分别构造可紧凑分组的小目录、分组后仍很大的目录，以及低 `toolResultCapacityTokens` 环境。
2. 对三者执行必然零命中的非空 query。

**预期结果**：

- [ ] 只有完整分组结果不高于正常默认八项搜索页成本、且不超过物理容量时才返回 exact-id inventory。
- [ ] 任何一个条件不满足时只返回一次 concise catalog-language retry 指令。
- [ ] 不返回前 N 项、截断 suffix、cursor 或 raw artifact；模型不会把目录顺序误当相关性。
- [ ] 本地 GitHub 26 项基准可重建 26/26 ids；分组结果约 214 tokens，逐条完整 inventory 约 353 tokens。

### TC-018：并发刷新、失效通知与不可用目录

**优先级**：高
**类型**：竞态 / 故障效率回归测试

1. 同时发起两个首次 `mcp_search`，记录 MCP `tools/list` 请求次数。
2. 在分页目录读取期间发送 `notifications/tools/list_changed`。
3. 分别返回显式 `nextCursor: null`，以及无缓存、全部 server 连接失败的非空 query。
4. 对 `kind=tool` 和不带 kind 的同一目录比较 revision。

**预期结果**：

- [ ] 并发首次发现合并为一次目录刷新，两位调用者得到同一份已验证真值。
- [ ] 分页期间失效的快照不会覆盖通知并伪装成 `live, complete=true`；最后一份稳定快照仍保留。
- [ ] 显式 null cursor 被当作协议错误，而不是目录结束。
- [ ] 全部目录源不可用时只尝试一次发现，不再把不可用误判成词法零命中后重复连接。
- [ ] kind revision 只覆盖当前过滤后的目录；无关 capability family 变化不会让 cursor 无效。
- [ ] stale/mixed 的零命中恢复仍显示失败 server 与简洁原因。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 18 | - | - | - |

**测试结论**：待填写

**发现的问题**：如有问题，请记录 server、catalog revision、freshness、complete、调用参数和去敏后的错误；不要记录密钥。

---

*测试指南生成时间：2026-07-15*
*Feature ID：FEATURE_035*
