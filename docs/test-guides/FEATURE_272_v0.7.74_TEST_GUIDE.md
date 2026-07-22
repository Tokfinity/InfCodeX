# FEATURE_272 v0.7.74 - 人工测试指导

## 功能概述

**功能名称**: 可靠的大型上下文压缩与 SDK 可观测性

**版本**: v0.7.74

**测试日期**: 2026-07-21

**测试人员**: [待填写]

自动大型压缩始终开启；百分比阈值限制在 15%-90%，可增加绝对 token
阈值且两者取较小值。一次压缩覆盖保护尾部之外的全部历史，保留真实用户
query，并以 contextId 区分主/子 Agent。Runtime/Space 使用有界 transcript
分页与 chunk，避免 8 MiB daemon 帧。

---

## 测试环境

### 前置条件

- Node.js 20+，主仓与 KodaX Space 位于相邻目录。
- 主仓已执行 `npm run build`；Space 已执行 `npm run link:kodax`。
- Space 使用一个声明 1M context window 的可用 provider/model。
- 准备一个可持续多轮对话的测试项目；不要在生产 Session 上做破坏性测试。

### 记录要求

- 保存每次 `context.compaction.finished` 的完整 payload。
- 记录 UI 压缩前/后数值、实际阈值、contextId/contextKind/revision。
- 失败时保存日志及 Session ID，不要只截取通知文案。

---

## 测试用例

### TC-001: 百分比边界与始终开启

**优先级**: 高

**类型**: 边界测试

**测试步骤**:

1. 在 Space 压缩设置中依次输入百分比 `15`、`90` 并保存。
2. 尝试输入 `14`、`91`，确认 UI 阻止越界提交。
3. 在 `~/.kodax/config.json` 临时设置 `enabled:false, triggerPercent:1`，重启并读取有效配置。

**预期效果**:

- [ ] 15 和 90 均可保存。
- [ ] UI 范围为 15-90；SDK 对遗留的 1 归一化为 15。
- [ ] `enabled:false` 不会关闭自动大型压缩。
- [ ] 留空百分比时有效值为 75。

### TC-002: 百分比与绝对阈值取较小者

**优先级**: 高

**类型**: 正向测试

**测试步骤**:

1. 在 1M 模型上设置百分比 75、绝对阈值 300000。
2. 打开上下文指示器详情。
3. 将绝对阈值改为 0，再次查看详情。

**预期效果**:

- [ ] 第一次有效阈值显示 300k，而不是 750k。
- [ ] 设置 0 后绝对阈值不再生效，有效阈值恢复 750k。
- [ ] 设置说明明确表示两个阈值取较小者。

### TC-003: `322,973` 类事故回放

**优先级**: 高

**类型**: 回归测试

**前置条件**: 1M 模型，百分比 30 或绝对阈值 300000。

**测试步骤**:

1. 构造约 323k 的主上下文，其中最近约 60k 为可辨认的尾部标记；更早历史分为多个时间段。
2. 触发自动压缩，记录 canonical event。
3. 继续提问早期、中期和最近三个阶段的约束。

**预期效果**:

- [ ] `protectedBudgetTokens` 约为 60k，而不是 200k。
- [ ] `eligibleTokens` 覆盖保护尾部之外的全部历史，不只约 100k 最旧片段。
- [ ] 一次 trigger 只产生一次 committed canonical event，不在同一轮循环压缩。
- [ ] UI 显示真实主上下文 before → after；完整滚动历史仍可见但不冒充 active context。

### TC-004: 用户 query 跨两轮压缩保持

**优先级**: 高

**类型**: 数据完整性测试

**测试步骤**:

1. 在历史早、中、晚期分别发送带唯一 ID 的三条请求和一条纠正请求。
2. 触发压缩；继续增长上下文并再次触发压缩。
3. 检查第二次 checkpoint 中的 `User Queries & Corrections` JSONL。

**预期效果**:

- [ ] 四条真实请求原文、顺序和 ID 均存在。
- [ ] tool_result、自动继续和 compaction checkpoint 不被误记为用户 query。
- [ ] 上一轮保护尾部中的同一消息没有在第二轮重复入账。
- [ ] 用户在新 turn 再次发送相同文字时仍形成独立条目。

### TC-005: 主/子 Agent 指标隔离

**优先级**: 高

**类型**: 并发/可观测性测试

**测试步骤**:

1. 启动会产生子 Agent 的任务。
2. 让主上下文压缩到例如 222k，再让子上下文产生较小的 8k 压缩结果。
3. 查看 canonical events 和 Space 上下文指示器。

**预期效果**:

- [ ] 主事件 `contextKind=root, contextId=<sessionId>`。
- [ ] 子事件具有独立 `contextId`、`parentContextId` 和 `agentId`。
- [ ] 子事件仍可观察，但不会把主 UI 的 222k 覆盖成 8k。
- [ ] contextRevision 只随所属上下文提交递增。

### TC-006: 手动 compact 使用有效阈值保护预算

**优先级**: 高

**类型**: SDK 测试

**测试步骤**:

1. 通过 Runtime Session settings 设置 60% 和绝对 250000。
2. 在未达到自动阈值时调用 `runtime.sessions.compact({sessionId})`。
3. 检查 manual canonical event。

**预期效果**:

- [ ] 手动调用立即执行，但 `effectiveTriggerTokens=250000`。
- [ ] 保护预算约 50k；没有隐藏的 `triggerPercent:100`。
- [ ] `source=manual` 且 before/after revision 连续。

### TC-007: 超过 8 MiB 的 transcript 无损恢复

**优先级**: 高

**类型**: 性能/边界测试

**测试步骤**:

1. 写入一条大于 8 MiB 的 client notice 或等价 transcript entry。
2. 建立 daemon observation；记录 snapshot 的 JSON 字节数。
3. 使用 page API 和 entry chunk API 读取全部内容并按 index 重组。
4. 在读取中途追加一条新 entry，再使用旧 cursor。

**预期效果**:

- [ ] observation/page/chunk 单个响应均显著小于 8 MiB。
- [ ] 超大 entry 以 `oversized:true` 描述，不被静默截断。
- [ ] chunk 解码后的 JSON 与原 entry 字节内容一致。
- [ ] 旧 cursor 明确报 stale/resync，而不是返回混合 revision。
- [ ] Space 滚动历史最终按原 append 顺序显示。

### TC-008: 压缩失败不部分提交

**优先级**: 高

**类型**: 负向测试

**测试步骤**:

1. 使用会让 summary provider 失败或返回 tool_use 的测试 provider。
2. 触发一次大型压缩。
3. 比较失败前后的 canonical active messages、revision 和 query ledger。

**预期效果**:

- [ ] active history 和 contextRevision 不变。
- [ ] 不出现只覆盖最旧一部分的临时 summary。
- [ ] 错误通过诊断/调用错误明确暴露。
- [ ] 若显式启用了 legacy emergency pruning，其恢复 checkpoint 仍包含全部真实用户 query。

### TC-009: fallback 不误报成功

**优先级**: 高

1. 构造“不可裁剪的 mandatory system/checkpoint 已超过物理容量”的上下文。
2. 触发显式 legacy emergency pruning。
3. 记录 canonical messages、`onCompactStats`、`onCompact` 与 Runtime event。

**预期效果**:

- [ ] 返回的 canonical history 与触发前相同。
- [ ] 新数组引用但 token 未减少不算成功。
- [ ] token 有减少但完整请求仍超过物理容量也不算成功。
- [ ] 两种失败候选都不发出成功 compact stats，不增加 context revision。

### TC-010: 配置模板与 kodax_manual 一致性

**优先级**: 中

1. 查看仓库根 `config.example.jsonc` 与首次启动生成的配置模板。
2. 调用 `kodax_manual({topic:"compaction"})`。
3. 对照 SDK 指南第 25 节与 Space 设置界面。

**预期效果**:

- [ ] 两份模板均包含 `triggerPercent:75` 与 `triggerTokens:0` 示例。
- [ ] manual 明确自动压缩不可关闭、百分比限制 15-90、0 只关闭绝对阈值。
- [ ] manual 明确保护量为有效阈值的 20%、覆盖完整 eligible prefix、保留用户 query。
- [ ] manual 与 SDK 均说明只有物理有效且已提交的实际 token 减少才是成功。

---

## 自动化预检

```powershell
# KodaX
npm run build
npx vitest run packages/agent/src/session-lineage/compaction packages/coding/src/agent-runtime/__contract-tests__/cap-059-compact-trigger.contract.test.ts src/runtime-event.test.ts src/runtime-daemon/server.test.ts

# KodaX Space
npm run link:kodax
npm run typecheck
node --test --import tsx apps/desktop/electron/test/runtime-context-telemetry.test.ts apps/desktop/electron/test/app-store-runtime-projection.test.ts apps/desktop/electron/test/runtime-host-adapter.test.ts
```

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 10 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [待填写]

---

*测试指导生成时间: 2026-07-21*

*Feature/Issue ID: FEATURE_272 / ISSUE_192*
