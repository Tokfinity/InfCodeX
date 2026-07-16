# FEATURE_251 v0.7.61 纠偏回归测试指导

## 功能概述

**功能名称**：Tool-Output Token Efficiency（完整采集、无损优先、批次容量回退）

**原始版本**：v0.7.61

**纠偏日期**：2026-07-15（含 reopened implementation review 修复）

**测试人员**：待填写

本指导验证 FEATURE_251 的当前契约。v0.7.61 原测试曾把 git/test/lint/JSON 等输出被
有损摘要且带 raw hint 视为成功；该期望已废止。默认运行中若仍出现
`[git diff summarized: ...]`、failure-focus、进度行剥离或 JSON 结构摘要，应判为回归失败。

当前验收目标是降低完成任务的总 token 与轮次，同时保持模型第一次读取时的证据完整：

- 本地输出先完整采集；512KiB 只是 Bash memory→spool 阈值。
- 默认只做契约等价且严格更短的无损规范化；命令专用有损 filter 关闭。
- 并行结果只在下一次物理 LLM 请求的唯一 capacity owner 处统一判容。
- 完整批次能放下时全部原样返回；确实放不下时才使用完整 artifact 与
  `KODAX_RESULT_INCOMPLETE`。
- 32KB / 600 行 / 64KB per-tool 均不是当前 token policy。
- 自动历史压缩只在最终 provider 物理请求确实超容量时触发；容量内 canonical history 不变。
- 默认 microcompaction/destructive fallback 关闭；压力下 summary-first，失败时 typed error 且
  不修改 canonical history。
- 静态百分比 `<100%` 仅是显式 opt-in；手动 `/compact` 是显式 force，不是默认收益假设。

## 测试环境

- Node.js 20+，已安装仓库依赖。
- 从仓库根目录开始；命令注明 workspace 时进入对应目录。
- 不发布 npm 包、不打 tag。
- 记录测试时使用的 provider、context window、effective max output tokens，以及发起 tool
  batch 前的物理请求 token；否则无法复核容量边界。

## 自动化基线

### Coding：采集、交付、恢复与工具边界

在 `packages/coding` 执行：

```powershell
npx vitest run src/tools/bash.test.ts src/tools/bash-output-collector.test.ts src/tools/output-filters/generic.test.ts src/tools/output-filters/registry.test.ts src/tools/tool-result-policy.test.ts src/tools/tool-result-budget.test.ts src/tools/tool-output-gc.test.ts src/agent-runtime/__contract-tests__/cap-077-tool-dispatch-parallel.contract.test.ts src/agent-runtime/__contract-tests__/tool-dispatch-bridge.contract.test.ts src/tools/read.test.ts src/tools/grep.test.ts src/tools/glob.test.ts src/tools/code-search.test.ts src/tools/retrieval.test.ts src/tools/task-output.test.ts src/tools/web-fetch.test.ts src/tools/web-search.test.ts src/tools/mcp-tools.test.ts src/tools/changed-diff.test.ts src/tools/edit.test.ts src/tools/tool-search.test.ts src/tools/relationship-scan-budget.test.ts src/tools/envelope-budget.test.ts src/self-knowledge/resolver.test.ts src/child-executor.test.ts src/agent-runtime/middleware/session-snapshot.test.ts
```

在 `packages/coding` 再执行 managed runner 回归：

```powershell
npx vitest run src/task-engine/runner-driven.test.ts src/task-engine/runner-driven-tool-wiring.test.ts
```

### Agent：Runner 批次结果转换边界

在 `packages/agent` 执行：

```powershell
npx vitest run src/context-capacity.test.ts src/primitives/runner.test.ts src/primitives/runner-handoff.test.ts src/capabilities/mcp/runtime.test.ts src/session-lineage/compaction/compaction.test.ts src/session-lineage/compaction/microcompaction.test.ts
```

### Coding / REPL：物理容量驱动的历史压缩

在 `packages/coding` 执行：

```powershell
npx vitest run src/compaction-config.test.ts src/agent-runtime/run-substrate.microcompaction-pressure.test.ts src/task-engine/_internal/managed-task/compaction.test.ts
```

在 `packages/repl` 执行：

```powershell
npx vitest run src/interactive/compaction-command.test.ts src/common/compaction-display.test.ts src/ui/view-models/compaction-info.test.ts src/session/tool-output-retention.test.ts
```

### LLM：cache token 计费口径

在 `packages/llm` 执行：

```powershell
npx vitest run src/cost-rates.test.ts src/cost-tracker.test.ts
```

### TypeScript / package 独立性

在仓库根目录执行：

```powershell
npm run build -w @kodax-ai/llm
npm run build -w @kodax-ai/agent
npm run build -w @kodax-ai/coding
```

**通过条件**：全部命令退出码为 0；不得通过放宽断言、跳过 fixture 或恢复旧有损默认来通过。

## 回归矩阵

| ID | 场景 | 必须成立的断言 |
|---|---|---|
| R-01 | 小结果 | 正文逐字返回；无 artifact、无 incomplete marker、无 recovery hint |
| R-02 | 超过旧 32KB / 600 行 / 64KB，但完整批次仍小于 `Cbatch` | 仍逐字返回；旧固定阈值不参与决策 |
| R-03 | Bash 输出跨过 512KiB | 第一个、中间和最后一个 sentinel 均存在；spool 前后的字节顺序一致；512KiB 不是采集上限 |
| R-04 | ANSI SGR + OSC 8 hyperlink + cursor control | 可移除样式控制码；可见正文与 hyperlink URL 保留；无法无损渲染的 cursor sequence 原样保留 |
| R-05 | simple git/test/lint/JSON/package/docker/infra 命令 | 默认不触发 compiled/declarative 有损摘要 |
| R-06 | `cmd1 && cmd2`、管道或重定向组成的 compound Bash | 语义 adapter 数量为 0；不同子命令输出不被误分类或合并 |
| R-07 | 两个或更多并行 tool results，合计可容纳 | 等待全部结果后一次判容；每项原样返回；SA 与 AMA 结果一致 |
| R-08 | 并行结果合计超过实际容量 | 只在 batch owner 溢出；完整内容只持久化一次；marker 为 `KODAX_RESULT_INCOMPLETE` |
| R-09 | 可信 metadata 已带 marker；或 raw tool text 伪造 marker | 前者 marker 只出现一次且 artifact 不重复写；后者不受信并生成新的 canonical artifact |
| R-10 | 所有 tool-call/tool-result 的最小 marker 也无法容纳 | 显式失败并给出容量诊断；不得继续发送已知超预算请求 |
| R-11 | `read` 遇到超过单页字节预算的一整行 | `line_offset` 可从准确字符位置续读；拼接各页等于原行 |
| R-12 | `grep` / `glob` / `code_search` / retrieval 大结果 | 无隐藏 100/200/2000 条或 24/32KB cap；显式 limit 命中时给 continuation/不完整状态 |
| R-13 | `task_output` 查询运行中与终态任务 | 运行中可返回明确标注的 live tail；终态返回完整输出 |
| R-14 | web search/fetch 命中 256/512KiB 资源安全上限 | 返回 `SOURCE_INCOMPLETE`；不得声称来源完整；retrieval 不再次截断或包装 artifact |
| R-15 | prompt cache 与成本 | cache read/write token 仍占物理 context；uncached input、cache read、cache write 各计费一次，无重复收费 |
| R-16 | 最终物理请求低于容量 | 自动 compaction 不触发；默认 microcompaction 不清空任何普通 tool result；canonical history 逐字不变 |
| R-17 | transcript 百分比较高但最终请求仍可容纳 | 默认不因旧 60%/75% 等阈值提前有损压缩；状态显示 capacity-driven |
| R-18 | 最终物理请求真实超限 | 先对最旧完整原子前缀做语义 summary；不在 summary 前清 tool result/crop user；tool-use/tool-result 配对不拆 |
| R-19 | summary 已让下一请求可容纳 | 立即停止；不继续压到 36%/52% 等静态低水位；固定 system/tools/framing overhead 仍计入候选 |
| R-20 | summary 抛错、返回空值或仍不足 | canonical history 与 snapshot 不变；抛出 typed `ContextCapacityError`；Runner 不吞错且不提交已知超限请求 |
| R-21 | 显式配置 `<100%` 或手动 `/compact` | 前者才允许提前 trigger；后者显式 force；默认 100% 不伪装为百分比目标，SA/AMA/REPL 语义一致 |
| R-22 | 未来候选有损策略声称节省 token | 必须有预注册任务级 A/B，报告总 input/output/cache、轮次、tool calls、recovery/重跑与质量；仅 body 变短不得放行 |
| R-23 | MCP/self-knowledge/cancellation/legacy guard | distinct MCP text+structured channel 在直接与 fallback 路径均保留且 ordinary body 不重复，分页失败不缓存 partial；精确 topic 全文；cancelled Bash 保留 partial+状态；无 capacity 的 guard passthrough |
| R-24 | diff/edit/relationship/tool-search/child evidence 大结果 | 无旧 hidden slice；changed-diff >64 path 显式拒绝拆批，grep/code-search 每 512 candidate 返回 `scan_offset`；child briefing 按 routed model 判容 |
| R-25 | safety margin 边界与校准数据 | 2048/3% 只在唯一 owner 计算一次；记录 estimate-vs-actual 与 margin-zone recovery；不得把 margin artifact 计作 token 优化收益或复制成 per-tool cap |
| R-26 | provider 无 usage / system 含 skills / edit recovery sibling | fallback 计入最终 system 一次、active tool schemas、messages/framing/cache 与同请求 recovery；不重复 skills；有效 usage 仍权威；legacy snapshot/byte helper 仅兼容导出且内部不调用 |
| R-27 | 空、marker-only、identity 或 partial summary | 无效 summary 不消费 chunk；partial 仅替换成功前缀；首个 Worker system prompt 字节不变；hard error 持久化最新 transcript |
| R-28 | MCP ordinary resource 与全部显式 search limit | ordinary body 只出现一次，真实独立 structured channel 保留；local/provider code、semantic、keyword tool、MCP/web search、read/grep 在 N 无 marker、N+1 才有 `RESULT_LIMIT_REACHED`/continuation；负数 grep limit 报错 |
| R-29 | Bash 取消、delayed close、spool read 失败与 background capture | 正常取消等到 close；deadline 后返回 `KODAX_CAPTURE_INCOMPLETE` + 持续追加 recovery，后续 chunk 不丢，close 后才有 `KODAX_CAPTURE_COMPLETE`；background 仅以 `[Exit]` footer 证明完成 |
| R-30 | resumable session 引用旧 artifact / orphan artifact / long-task checkpoint | REPL startup 保留 active/archived JSONL 引用，删除超过 grace 的 orphan，发现失败不删；Bash spool 同目录管理；checkpoint 按最新 mtime 恢复 |
| R-31 | batch transform 抛 capacity error / AMA result observer | error snapshot 保留最后合法 transcript；AMA observer/sidecar 只看到 admitted content，不看到 pre-admission raw blob |
| R-32 | Bash direct-spill metadata through SA and AMA | The incomplete marker is last, trusted `outputPath` metadata reaches the final batch owner, and re-admission creates no nested artifact. |

## 手动验证

### TC-001：旧固定阈值不再截断可容纳结果

1. 在测试 harness 中构造一个超过 32KB、超过 600 行但小于本次 `Cbatch` 的结果；正文首、中、尾
   放置唯一 sentinel。
2. 分别经 SA tool dispatch 与 AMA managed Runner 执行。
3. 对最终 tool-result 与输入正文计算 hash，并检查 artifact 目录。

**预期**：两个模式均逐字一致；三个 sentinel 均存在；没有
`KODAX_RESULT_INCOMPLETE`、artifact 或“read raw output”提示。

### TC-002：Bash memory→spool 完整性

1. 运行一个输出至少 768KiB 的本地 Node 命令，在第 1 字节附近、512KiB 边界两侧和末尾写入
   不同 sentinel。
2. 让测试 harness 读取 Bash 完成态原始采集结果；若下一请求容量不足，则读取容量层生成的
   artifact。
3. 与命令直接写入文件的基准结果比较长度与 hash。

**预期**：长度和 hash 一致，所有 sentinel 存在。通常由批次容量层决定 artifact；仅当
`rawBytes > requestCapacityTokens × 128` 已严格证明不可能容纳时，Bash 可直接封存完整 spool，且
artifact 尾部必须有 `KODAX_CAPTURE_COMPLETE`，不能先把全部 spool 重新物化进内存。

### TC-003：无损规范化与 compound 禁用

1. 输出带 SGR 颜色和 OSC 8 hyperlink 的文本。
2. 输出一个外形同时像 `git diff` 与测试 summary 的 compound Bash 结果。
3. 检查最终正文。

**预期**：颜色样式可去除，但 hyperlink URL、可见字符与行序保留；compound 结果保持原文，
不出现 git/test/lint/JSON 摘要或 raw recovery hint。

### TC-004：批次容量边界

按实际 provider 参数计算：

```text
safety(P) = max(2048, ceil(P * 0.03))
Pmax      = max P such that P + providerReservedOutputTokens + safety(P)
            <= contextWindow
Cbatch    = max(0, Pmax - currentPhysicalRequestTokens)
```

这里的 `P` 必须是加入完整批次后的最终候选输入；增加一条反例，证明若错误地只按加入前输入
计算 3%，大批次会越过最终 safety margin，而 `Pmax` 解法不会。

分别构造 `Cbatch - 1`、`Cbatch`、`Cbatch + 1` 附近的多结果批次，计数须包含 tool protocol
framing。重复让已溢出的结果经过 guard，并记录估算值与 provider 实际 input usage 的误差。

**预期**：前两组完整返回；只有超预算组出现 incomplete marker；重复 guard 后 marker 与 artifact
仍各一个。若最小配对 marker 超预算，Runner 返回显式容量错误。2048/3% margin 只扣一次；
margin-zone fallback 标成可靠性回退，不算作 token-saving 样本。

### TC-005：恢复接口与来源完整性

1. 用 `read` 分页读取一个超长单行并按 `line_offset` 拼接。
2. 生成超过旧隐藏 caps 的 grep/glob/code-search 结果，验证全部结果或明确 continuation。
3. 查询一个仍在运行、随后进入终态的 background task。
4. 用 fixture 触发 web search/fetch 的资源字节上限。
5. 让 MCP 返回 distinct `content`/`structuredContent` 并在后续分页失败；读取精确 self-knowledge
   topic；中断一个已有 stdout/stderr 的 Bash；调用一个没有物理 budget 的 legacy public guard。
6. 构造超过旧固定 cap 的 changed-diff bundle、单行 edit receipt、relationship supplemental
   evidence、tool select 与 child evidence/completion，分别检查原始结果和最终 envelope；再用 513 个
   candidate 验证 `scan_offset`，以及 65 个 diff path 验证显式拆批错误。

**预期**：本地结果可无损重组；终态 task output 完整；网络截断只出现于声明的资源安全边界，
并含 `SOURCE_INCOMPLETE`。retrieval 层不再做第二次固定大小 guard。MCP distinct channel 不互相
覆盖、分页失败不缓存 partial；精确 topic 不变成 preview；取消结果带 partial 和 cancelled 状态；
legacy guard 在不知道容量时不裁剪。

changed-diff/edit/relationship/tool-search/child 结果也不得在工具内命中旧 hidden slice；显式 schema
limit 达到边界时有 continuation，完整 envelope 若需回退只能由物理 capacity owner 执行一次。

### TC-006：真实 review 复现

使用原问题形态请求模型 review 一个包含多次提交和 `--stat` 的版本范围。记录首次 tool result、
后续 tool calls、总输入/输出 token 与是否读取 artifact。

**预期**：只要批次能容纳，首次结果就是完整证据，模型无需因系统自动有损摘要而读取 raw 或
重跑换格式命令。若模型基于任务意图主动选择更窄的 git 参数，记为请求整形收益，不记为结果
压缩收益。

### TC-007：历史压缩只由最终物理容量触发

1. 构造两组相同 transcript；分别改变 final system prompt、实际 tool schema 与 provider
   output reserve，使一组满足、一组违反
   `P + reserve + max(2048, ceil(P * 3%)) <= contextWindow`。
2. 在 SA 与 AMA 各运行一次，记录传给 summary provider 的 messages 和 compact 后 snapshot。
3. 对可容纳组再把 transcript 比例提高到旧静态 trigger 之上，但保持物理不等式仍成立。

**预期**：可容纳组不调用 summary provider，ordinary tool result 未出现 `[Cleared: ...]`；真实
超限组的 summary 输入仍含完整 evidence/tool pairs。summary 后在第一处满足物理不等式时停止，
SA 与 AMA 决策一致。

### TC-008：summary 失败不静默删历史

1. 让 summary provider 分别抛错、返回空文本、返回仍无法满足容量的结果。
2. 记录调用前后的 canonical messages、tool 配对、context snapshot 与最终错误类型。
3. 重启/恢复同一 session，确认持久化历史未被失败尝试改写。

**预期**：三种情况都保留原历史和配对，返回 `ContextCapacityError`；不调用 destructive graceful
prune，不出现只剩 placeholder 的“成功”结果，也不继续向 provider 发送已知超预算请求。

### TC-009：端到端收益声明门槛

若未来提出重新启用某个有损 adapter/filter，先阅读并遵循
[`benchmark/EVAL_GUIDELINES.md`](../../benchmark/EVAL_GUIDELINES.md)，预注册 baseline、候选、
任务集、样本规模和判定门槛。任务集至少包含小结果、高噪声但可容纳结果、真实批次溢出和
历史容量压力；记录 provider 总 input/output、cache read/write、模型轮次、tool calls、
artifact/recovery read、改格式重跑、完成质量与证据完整性。

**预期**：只有任务级 token/轮次改善且质量不回退的候选才可进入显式启用评审。单个字符串
fixture 变短、存在 raw artifact 或模型最终完成任务均不能单独判为正收益；未通过前不得恢复
默认有损行为或新增面向用户的假设性配置。

### TC-010：envelope、恢复与生命周期完整性

1. 让 provider 不返回 usage，system prompt 已包含 skills，并让 edit 结果附带同一 next request 的
   recovery sibling；核对本地 snapshot 包含 final system 一次、active tools 和全部消息 framing。
2. 依次返回空、marker-only、原样回显和只覆盖部分 chunk 的 summary，随后触发 hard capacity error
   并恢复 session。
3. 让 MCP 返回 ordinary resource text，再分别返回真正独立的 structured channel，并经直接和
   fallback 路径读取；对 code/semantic/tool/MCP/web search、read、grep 恰好等于和超过 limit 的
   fixture 检查请求数与 marker，再传入负数 grep limit。
4. 取消一个持有 cwd 且已有 partial 输出的 Bash；让 close 延迟超过 drain deadline 并在 deadline
   后再写 chunk；注入 spool read 失败；完成一个 background task。
5. 创建被 active/archived resumable session 引用且 mtime 很旧的 tool artifact、同龄 orphan 和
   pasted image，再启动 Classic/Ink REPL；构造创建已 3 小时但刚写第 4 轮 checkpoint 的长任务。

**预期**：容量计数不漏项也不重复 skills；无效 summary 不消费历史，首个 Worker system prompt
逐字保留，hard error 可恢复最新 transcript。ordinary MCP body 只交付一次，真实 structured channel
不丢；只有额外候选存在时才出现 limit marker，非法 grep limit 不放大查询。Bash 正常 close 后 cwd
可删除；delayed-close 结果有持续追加 artifact，前后 chunk 均存在且最终有 completion footer；spool
失败有明确 marker 与恢复坐标，background 完整结果含 `[Exit]` footer。被引用 tool/image artifact
仍存在，orphan 在 grace 后删除；引用扫描失败时两者都保留。长任务最新 checkpoint 可恢复。

## 通过标准

- R-01 至 R-32 全部通过。
- SA 与 AMA 对相同物理 token 状态作出相同判容决定。
- “完整结果可容纳却生成 artifact / marker”是阻断发布的问题。
- “来源不完整却没有明确 marker / continuation”是阻断发布的问题。
- 不再使用旧 `context-savings.test.ts` 中“每个有损 fixture 都必须更短”的断言作为发布门槛；
  若保留该文件，只能作为历史实验数据，不能启用旧默认行为。

## 测试总结

| 回归项 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 32 | 待填写 | 待填写 | 待填写 |

**人工用例结果**：待填写

**测试结论**：待填写

**功能 ID**：251
