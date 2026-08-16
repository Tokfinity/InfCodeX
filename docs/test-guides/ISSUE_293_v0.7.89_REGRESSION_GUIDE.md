# Issue 293 - managed context 导致分页历史重复 - 人工回归指导

## 功能概述

**问题编号**: 293  
**目标版本**: v0.7.89  
**测试日期**: 2026-08-16  
**测试人员**: 待填写

本修复让普通对话历史在 compaction 替换 `managed-run-context` /
`managed-runtime-context` 时忽略这些可替换的内部上下文，同时保留原始审计记录、
真实重复内容和无法可靠判定的历史分支。旧 v3 分页缓存会失效并按新规则重建。

---

## 测试环境

### 前置条件

- 使用包含 Issue 293 修复的 KodaX SDK 构建；发布验收时版本应为 v0.7.89。
- 保留受影响 Session `20260816_110200_432759c1554ee5` 的备份。
- Space 验收需安装使用该 SDK 的新构建；v0.1.42 不包含本修复。
- 自动化门禁：
  `conversation-history.test.ts`、`conversation-page-cache.test.ts`、
  `public-api.test.ts` 与 `sdk-conversation-history.test.ts`。
- 环境注意：宿主若导出 `KODAX_HOME`（KodaX 沙箱会设置），
  `public-api.test.ts` 会读到真实存储而误报门禁失败；运行门禁前先执行
  `Remove-Item Env:KODAX_HOME`（Unix 用 `unset KODAX_HOME`）。

### 平台

- Windows 11 x64（主验收环境）
- macOS 或 Linux（兼容性抽测）

---

## 测试用例

### TC-001: 受影响 Session 只展示一条目标 query

**优先级**: 高  
**类型**: 正向测试

**前置条件**:

- 将目标 Session 放在 KodaX Session 目录中。
- 删除或保留旧分页缓存均可；两种情况各执行一次。

**测试步骤**:

1. 使用 SDK `readConversationHistory` 读取目标 Session。
2. 检查返回状态和 issues。
3. 统计目标 query“请你用生动表现的网页……”出现次数。
4. 在 Space 中打开同一对话并滚动加载全部旧历史。

**预期效果**:

- [ ] SDK 返回 `status: resolved` 且 `issues: []`。
- [ ] 目标 query 只出现一次。
- [ ] 原先成对出现的 compacted assistant 内容只展示一份。
- [ ] Space 不再显示“旧历史存在多种可能解释”的提示。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-002: 旧 v3 缓存自动失效

**优先级**: 高  
**类型**: 兼容性测试

**前置条件**:

- 使用升级前生成的 v3 conversation page cache。

**测试步骤**:

1. 升级到包含修复的版本，不手工删除旧缓存。
2. 首次打开 Session 并加载第一页。
3. 向上滚动跨过至少一个分页边界。
4. 执行 Ctrl+R 后再次检查相同位置。

**预期效果**:

- [ ] v3 缓存不会作为有效 v4 缓存读取。
- [ ] 首次打开、分页后和刷新后的条目顺序一致。
- [ ] 不出现 query 或 assistant 内容重复。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-003: 新缓存追加 managed context 时拓扑透传

**优先级**: 高  
**类型**: 边界测试

**前置条件**:

- 在 KodaX 仓库根目录安装依赖。
- 使用已签入的 fixture（`conversation-page-cache.test.ts`）：
  `appends through leading topology-transparent managed context`、
  `appends real messages around a mid-batch managed context`、
  `advances the append chain across a managed-context-only batch`。

**测试步骤**:

1. 执行
   `npm test -- packages/repl/src/session/conversation-page-cache.test.ts -t managed`。
2. 确认用例覆盖 managed context 位于批首、批中、以及整批均为 managed context
   的追加形态；同时覆盖透传落盘与 canonical 重建的等价性（entryChain 一致、
   refresh 复用不失效）、仅托管批次 watermark 推进与父链断裂拒绝。
3. 确认 append admission 返回仅含普通消息的投影数组，而不是 `undefined`。
4. 再执行完整 `conversation-page-cache.test.ts`，确认普通消息的增量追加仍通过。

**预期效果**:

- [ ] 增量快路径不会把 managed context 投影成普通对话消息。
- [ ] managed context 在物理父链上被透传推进（批首/批中/整批均保持热路径），
      append admission 返回普通消息数组，缓存无需失效重建。
- [ ] 不含 managed context 的普通增量追加测试仍通过。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-004: 无法证明的真实分支仍 fail-closed

**优先级**: 高  
**类型**: 负向测试

**前置条件**:

- 在 KodaX 仓库根目录安装依赖。
- 使用已签入的 fixture：
  `packages/repl/src/session/conversation-history.test.ts` 中
  `preserves all candidates when two predecessor branches are indistinguishable`。

**测试步骤**:

1. 执行
   `npm test -- packages/repl/src/session/conversation-history.test.ts -t "preserves all candidates when two predecessor branches are indistinguishable"`。
2. 检查测试断言的 status、issues 和返回候选。

**预期效果**:

- [ ] 状态仍为 `ambiguous`，诊断信息保留。
- [ ] SDK 不猜测分支、不按文本删除候选。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-005: 合法重复文本不被误删

**优先级**: 高  
**类型**: 安全测试

**前置条件**:

- 使用安装了修复版 SDK 的 Space，新建一个空 Session。

**测试步骤**:

1. 连续两次发送完全相同的 query，分别等待 assistant 回答完成。
2. 执行 Ctrl+R 并重新打开该 Session。
3. 向上滚动触发分页，确认两轮 query 和回答仍在。
4. 运行已签入的保护测试：
   `npm test -- packages/repl/src/session/conversation-history.test.ts -t "does not collapse a genuine repeated interaction on one active path"`。
5. 记下 Space 中的 Session ID，在安装修复版 SDK 的终端执行：
   `node --input-type=module -e "import {createSessionManager} from '@kodax-ai/kodax/repl'; const data=await createSessionManager().loadFullTranscript(process.argv[1]); console.log(JSON.stringify(data,null,2))" <SESSION_ID>`。
6. 在输出中查找两轮 query 的物理 entry 和 provenance 字段。

**预期效果**:

- [ ] 两条真实消息都保留。
- [ ] 修复没有引入基于字符串的去重。
- [ ] raw transcript 仍包含所有物理 entry 和 provenance。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-006: 大 Session 分页性能无明显回退

**优先级**: 中  
**类型**: 性能测试

**前置条件**:

- 使用至少 150 条 ordinary history entry 且发生过 compaction 的 Session。
- 打开 Windows 任务管理器“详细信息”页，显示 KodaX Space 进程的内存列。
- 找到该 Session 的 `*.conversation-cache.json` 文件。

**测试步骤**:

1. 删除旧缓存或首次升级打开，记录完整加载历史耗时 `T-cold`。
2. 记录重建后 cache manifest 的 `generation` 和修改时间。
3. 记录 Space 进程稳定 30 秒后的内存 `M-base`。
4. 连续执行 5 次 Ctrl+R；每次滚动到历史顶部，记录耗时 `T1..T5`
   和峰值内存。
5. 再次读取 cache manifest 的 `generation` 和修改时间。

**预期效果**:

- [ ] 首次因旧缓存失效允许发生一次 canonical rebuild。
- [ ] 每次暖加载耗时不超过 `max(2 秒, T-cold × 1.25)`。
- [ ] Session 未变化时，5 次暖加载前后 cache `generation` 和修改时间不变。
- [ ] 5 次循环的峰值内存不超过 `M-base + 150 MiB`，结束后不持续增长。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

### TC-007: 跨平台展示和警告状态一致

**优先级**: 中  
**类型**: UI测试

**前置条件**:

- Windows 主环境，以及 macOS 或 Linux 任一环境。

**测试步骤**:

1. 在两个平台打开同一份 resolved Session 副本。
2. 加载全部历史并刷新。
3. 比较消息数量、顺序、警告条和滚动位置附近内容。

**预期效果**:

- [ ] 两个平台消息数量与顺序一致。
- [ ] resolved Session 均不显示历史歧义警告。
- [ ] query、工具结果和 assistant 内容没有跨条目错位。

**实际结果**: 待填写  
**是否通过**: [ ] Pass / [ ] Fail

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 7 | - | - | - |

**测试结论**: 待填写  
**发现的问题**: 待填写

---

*测试指导生成时间: 2026-08-16*  
*Issue ID: 293*
