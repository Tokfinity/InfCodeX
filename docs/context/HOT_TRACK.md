# 热轨快照

_生成时间: 2026-03-08 14:30_
_快照版本: v7_

---

## 1. 项目状态

### 当前目标
Compaction 分块压缩优化，避免 TPM Rate Limit

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| cleanupIncompleteToolCalls 修复 | ✅ 完成 | 循环条件 bug 修复 |
| 版本升级 0.5.21 | ✅ 完成 | 所有包同步版本 |
| Compaction 分块压缩 | ✅ 完成 | 解决 TPM Rate Limit 问题 |

### 当下阻塞
- **无**: 当前任务已完成

---

## 2. 已确定接口（骨架）

### packages/coding/src/agent.ts - cleanupIncompleteToolCalls()

**Bug 修复**：循环条件从 `i < messages.length` 改为 `i >= 0`

```typescript
function cleanupIncompleteToolCalls(messages: KodaXMessage[]): KodaXMessage[]

// 修复前（bug）：只执行一次
// for (let i = messages.length - 1; i < messages.length; i++)

// 修复后：正确向前遍历所有消息
for (let i = messages.length - 1; i >= 0; i--) {
  const msg = messages[i];
  if (!msg || msg.role !== 'user') continue;
  // ... 收集 tool_result_ids
}
```

**问题原因**：
- `i = length - 1` 开始
- 条件 `i < length` 第一次为真
- `i++` 后 `i = length`，条件为假退出
- 结果：只检查最后一条消息

### packages/agent/src/compaction/compaction.ts - chunkMessages()

**分块压缩**：将大消息列表拆分为多个分块，避免 TPM Rate Limit (429)

```typescript
function chunkMessages(
  messages: KodaXMessage[],
  maxTokensPerChunk: number
): KodaXMessage[][]

// 核心逻辑：
// 1. 按原子块分组（tool_use + tool_result 不可拆分）
// 2. 累积 token 直到接近上限
// 3. 新起一个 chunk
// 4. 返回分块数组

// Compaction 主流程：
const MAX_TOKENS_PER_CHUNK = 50000;
const chunks = chunkMessages(toCompact, MAX_TOKENS_PER_CHUNK);

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const chunkFileOps = extractFileOps(chunk); // 每个 chunk 独立 fileOps

  const chunkSummary = await generateSummary(
    chunk,
    provider,
    chunkFileOps,
    customInstructions,
    systemPrompt,
    summary !== '' ? summary : undefined // 传递之前累积的摘要
  );

  summary = chunkSummary; // LLM 内部已融合 previousSummary

  if (i < chunks.length - 1) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // 延迟避免 rate limit
  }
}
```

### packages/repl/src/interactive/project-commands.ts - editSingleFeature()

**核心原则**：
- 子命令/参数（结构化）→ 关键词匹配
- 用户 prompt（自然语言）→ LLM 语义分析

```typescript
async function editSingleFeature(
  index: number,
  guidance: string,
  feature: Feature,
  storage: ProjectStorage,
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void>
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| 简单否定词列表 | 复杂否定表达仍误判，只要预设就可能出错 | 2026-03-08 |
| 删除 context.messages 赋值 | 后续对话会"失忆"，丢失上下文 | 2026-03-08 |
| 循环条件 i < length | 从 length-1 开始只执行一次 | 2026-03-08 |

### T01: 简单否定词列表
- **失败原因**: 复杂表达如"不要标记为完成"仍可能误判
- **放弃日期**: 2026-03-08

### T02: 删除 context.messages 赋值
- **失败原因**: 后续对话 LLM 会"失忆"
- **放弃日期**: 2026-03-08

### T03: 循环条件 `i < messages.length`
- **失败原因**: 从 `length-1` 开始只执行一次循环
- **发现方式**: 外部 AI 代码审查
- **教训**: 写循环时检查边界条件的实际执行次数

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| Prompt 统一走 LLM | 子命令/参数无歧义可用关键词，prompt 必须用 LLM 理解语义 | 2026-03-08 |
| 替换消息而非删除 | 保留上下文给后续对话，同时避免显示原始 JSON | 2026-03-08 |
| 保留删除操作关键词 | 破坏性操作需要明确意图确认 | 2026-03-08 |
| Compaction 分块压缩 | 避免单一请求过大触发 TPM Rate Limit (429) | 2026-03-08 |
| 每个 chunk 独立 fileOps | 避免向 LLM 传递"未来"的文件信息导致幻觉 | 2026-03-08 |
| 2 秒延迟机制 | 避免连续请求触发 rate limit | 2026-03-08 |

---

## 5. 版本历史

| 版本 | 主要变更 | 日期 |
|------|----------|------|
| v0.5.21 | 修复循环逻辑 bug，添加 ask-user-question 工具 | 2026-03-08 |
| v0.5.20 | /project edit 意图理解和上下文保存修复 | 2026-03-08 |
| v0.5.16 | Plan Mode Bash 权限精细化 | 2026-03-07 |

---

*Token 数: ~900*
