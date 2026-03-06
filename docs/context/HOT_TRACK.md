# 热轨快照

_生成时间: 2026-03-05 21:50_
_快照版本: v17_

---

## 1. 项目状态

### 当前目标
实现 Feature 011 - 智能上下文压缩 (Compact)

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Feature 012 | **Completed** | TUI 自动补全增强，v0.5.13 发布 |
| Feature 011 | **InProgress** | 智能上下文压缩，规划完成 |

### 当下阻塞
- **问题**: 无阻塞
- **下一步**: 等待用户确认实施计划，开始 Phase 1 (创建类型定义)

---

## 2. 已确定接口（骨架）

### Compaction 类型定义 (packages/agent/src/compaction/types.ts)
```typescript
interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

interface CompactionResult {
  compacted: boolean;
  summary?: string;
  tokensBefore: number;
  tokensAfter: number;
  entriesRemoved: number;
  details?: CompactionDetails;
}
```

### 核心函数签名
```typescript
// File tracking
function extractFileOps(messages: KodaXMessage[]): FileOperations;

// Message serialization
function serializeConversation(messages: KodaXMessage[]): string;

// LLM summary generation
async function generateSummary(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  details: CompactionDetails,
  customInstructions?: string
): Promise<string>;

// Compaction logic
function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow?: number
): boolean;

async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  customInstructions?: string
): Promise<CompactionResult>;
```

### /compact 命令 (packages/repl/src/interactive/commands.ts)
```typescript
{
  name: 'compact',
  description: '手动触发上下文压缩',
  usage: '/compact [instructions]',
  handler: async (args: string, context: CommandContext) => { ... }
}
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| (无) | 规划阶段，尚无失败尝试 | - |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| 分 8 个 Phase 实施 | 每阶段独立验证，降低风险 | 2026-03-05 |
| LLM 摘要用 haiku 模型 | 成本优化，摘要质量足够 | 2026-03-05 |
| 保留旧 compactMessages() | 添加 useLegacy 开关，快速回滚 | 2026-03-05 |
| 80ms 刷新间隔 | 复用 Issue 048 修复经验 | 2026-03-05 |
| 累积文件追踪 | 参考 pi-mono，多轮压缩保留历史 | 2026-03-05 |

---

## 5. 本次会话新增内容

### Feature 012 完成
- **Issue 081 修复**: 输入框抖动 → 建议区域移到输入栏下方，hasEverShown 延迟预留
- **Enter 键优化**: 补全即发送 → 参考 claude-code，一键完成
- **发布**: v0.5.13
- **状态**: Planned → InProgress → Completed

### Feature 011 开始
- **分析现有实现**: compactMessages() 简单截断 100 字符
- **对标 pi-mono**: LLM 结构化摘要 + 文件追踪 + 配置化
- **详细实施计划**: 8 Phase，每阶段独立验证
- **风险评估**:
  - HIGH: 核心循环重构，需完整回归测试
  - MEDIUM: LLM API 调用，添加重试逻辑
  - LOW: 配置加载，新功能不影响现有代码
- **状态**: Planned → InProgress

### 实施计划概览
```
Phase 1: 类型定义 (无风险)
Phase 2: 文件追踪 (无风险)
Phase 3: 消息序列化 (无风险)
Phase 4: LLM 摘要生成器 (MEDIUM - 需验证 Provider API)
Phase 5: 核心压缩逻辑 (HIGH - 替换旧函数)
Phase 6: 配置加载 (LOW - 新功能)
Phase 7: /compact 命令 (MEDIUM - 事件传递)
Phase 8: agent.ts 集成 (HIGH - 核心循环)
Phase 9-10: 测试 + 验证
Phase 11: 文档更新
```

---

## 6. 依赖关系图

```
Phase 1 (types)
  ↓
Phase 2 (file-tracker) ← Phase 1
  ↓
Phase 3 (utils) ← standalone
  ↓
Phase 4 (summary-gen) ← Phase 1, 3
  ↓
Phase 5 (compaction) ← Phase 1, 2, 4
  ↓
Phase 6 (config) ← standalone
  ↓
Phase 7 (/compact) ← Phase 5
  ↓
Phase 8 (agent.ts) ← Phase 5, 6
```

---

*Token 数: ~800*
