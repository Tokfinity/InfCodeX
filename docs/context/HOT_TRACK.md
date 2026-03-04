# 热轨快照

_生成时间: 2026-03-04 14:30_
_快照版本: v15_

---

## 1. 项目状态

### 当前目标
常规维护 - Issue 修复 + 归档

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 072 - 流式中断 tool_call_id | **已解决** | v0.5.5 |
| Issues 归档 | **已完成** | 41 issues 完整详情 |
| Issue 077 - 高级功能 | **Open** | Low 优先级 |
| Issue 058 - Alternate Buffer | **Open** | 需升级 Ink 6.x |

### 当下阻塞
- **问题**: 无阻塞
- **下一步**: 常规维护

---

## 2. 已确定接口

### 流式中断处理架构
```typescript
// packages/coding/src/agent.ts
// cleanupIncompleteToolCalls() - AbortError 时清理不完整的 tool_use 块

// Issue 072 修复：当 Ctrl+C 中断时
// 1. 检查最后 assistant 消息是否包含 tool_use 块
// 2. 检查是否有对应的 tool_result 块
// 3. 如果没有，移除 tool_use 块，保留 text/thinking
```

### maxIter 配置架构
```typescript
// packages/coding/src/agent.ts
const maxIter = options.maxIter ?? 200;

// src/kodax_cli.ts
maxIter: opts.maxIter ? parseInt(opts.maxIter, 10) : undefined,
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| **手动 ANSI Alternate Buffer** | 与 Ink 5.x 渲染机制冲突，闪烁更严重 | 2026-03-02 |
| CLI 多余参数设计 | --plan/-y/--allow/--deny/--config 冗余 | 2026-02-26 |
| 上下文字符预算管理 | pi-mono 未实现，KodaX 也不需要 | 2026-03-04 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| Issue 072 修复 | 流式中断时清理 tool_use 块，避免下次请求 API 报错 | 2026-03-04 |
| Issues 完整归档 | ISSUES_ARCHIVED.md 保留完整详情，可追溯 | 2026-03-04 |
| maxIter CLI fallback | 统一默认值到 coding 包，避免多处修改 | 2026-03-04 |

---

## 5. 本次会话新增内容

### Issue 072 修复详情
- **问题**: 流式中断后 tool_call_id 不匹配导致 API 错误
- **根因**: Ctrl+C 中断时，messages 包含 tool_use 但无 tool_result
- **修复**: 添加 cleanupIncompleteToolCalls() 函数
- **修改**: packages/coding/src/agent.ts

### 归档工作
- 归档 41 个已修复 issues 到 ISSUES_ARCHIVED.md
- 保留完整详情：Original Problem, Root Cause, Resolution, Files Changed

---

*Token 数: ~450*
