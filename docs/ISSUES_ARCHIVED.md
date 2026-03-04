# Archived Issues

_Last Updated: 2026-03-04_

---

## 2026-02 Archived Issues

### 001: 未使用常量 PLAN_GENERATION_PROMPT (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.5
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-27

**Original Problem**:
- 定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它
- 而是通过 `runKodaX` 内部的系统提示词来生成计划

**Context**: `packages/repl/src/common/plan-mode.ts`

**Resolution**:
- 删除未使用的 `PLAN_GENERATION_PROMPT` 常量（25 行代码）
- `generatePlan` 函数已有自己的内联提示词，不需要这个常量
- 纯删除操作，无功能变更

**Files Changed**: `packages/repl/src/common/plan-mode.ts`

---

### 002: /plan 命令未使用 _currentConfig 参数 (WON'T FIX)
- **Priority**: Low
- **Status**: Won't Fix
- **Introduced**: v0.3.1
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-27

**Original Problem**:
```typescript
handler: async (args, _context, callbacks, _currentConfig) => {
  // _currentConfig 从未使用
}
```
- 所有命令 handler 签名相同，但此参数未被使用

**Context**: `packages/repl/src/interactive/commands.ts`

**Decision**: 不修复，理由如下：
1. **下划线前缀是标准约定**: `_currentConfig` 表示"故意不使用"，是 TypeScript 社区标准做法
2. **类型签名要求**: `CommandHandler` 类型要求 4 个参数，无法删除
3. **无实际功能问题**: 这是代码风格观察，不是 bug
4. **修改风险高**: 修改类型签名会影响所有命令

---

### 003: Plan 文件无版本号 (WON'T FIX)
- **Priority**: Medium
- **Status**: Won't Fix
- **Introduced**: v0.3.1
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-22

**Original Problem**:
- `ExecutionPlan` 接口没有版本字段
- 如果未来计划格式变更（添加新字段、修改步骤结构），旧文件无法正确解析
- 未来兼容性风险，用户升级后保存的计划可能损坏

**Context**: `src/cli/plan-storage.ts` - `ExecutionPlan` 接口

**Decision**: 不添加版本字段，理由如下：
1. **行业标准实践**: Claude Code 的 JSONL 会话文件不使用版本字段，数据格式被视为内部实现细节
2. **Plan 文件是短期存储**: 存储在 `.kodax/plans/` 目录，主要用于当前会话，不需要长期跨版本兼容
3. **容错解析更合适**: 如未来需要兼容性处理，应在 `PlanStorage.load()` 中采用容错解析策略，而非增加版本控制复杂度

---

### 004: Plan 解析正则表达式脆弱 (WON'T FIX)
- **Priority**: Medium
- **Status**: Won't Fix
- **Introduced**: v0.3.1
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-22

**Original Problem**:
```typescript
const match = line.match(/^\d+\.\s*\[([A-Z]+)\]\s*(.+?)(?:\s+-\s+(.+))?$/);
```
- 期望格式：`1. [READ] description - target`
- 脆弱点：
  - AI 输出 `1.[READ]` (无空格) → 失败
  - AI 输出 `1. [read]` (小写) → 失败
  - AI 输出 `1. [ READ ]` (多空格) → 失败
- Plan 生成失败时无提示，跨模型兼容性差

**Context**: `src/cli/plan-mode.ts`

**Decision**: 不修复，理由如下：
1. **脆弱点 1 不是真正的问题**: 正则 `\s*` 允许 0 个或多个空格，`1.[READ]` 实际可以匹配
2. **PLAN_GENERATION_PROMPT 已明确指定格式**: 提示词要求使用大写的 READ/WRITE 等，AI 会遵循
3. **v0.4.0 会重构 Plan Mode**: 架构重构可能改变或移除 Plan Mode，现在修复意义不大
4. **无实际使用报告**: 没有证据表明这个问题在实际使用中出现过

---

### 005: 中英文注释混用 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.5
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-27

**Original Problem**:
- 代码中混合使用中文和英文注释
- 例如：`// 延迟创建 readline 接口` (中文) vs `// Check if project exists` (英文)
- 国际化团队协作困难，代码风格不一致

**Context**: `src/interactive/` 目录下多个文件

**Resolution**:
- 建立了英文优先的双语注释风格指南
- 格式: `// English comment - 中文简述` (单行) 或 `/** English description - 中文描述 */` (JSDoc)
- 简单逻辑使用纯英文，复杂/业务逻辑使用英文+中文简述
- 更新了所有 interactive 模块和 UI 模块的注释

**Files Changed**:
- packages/repl/src/interactive/*.ts
- packages/repl/src/ui/**/*.ts, packages/repl/src/ui/**/*.tsx

**Tests Added**: None (comment-only changes, build verification)

---

### 007: 静默吞掉错误 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.3
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-22

**Original Problem**:
```typescript
async loadFeatures(): Promise<FeatureList | null> {
  try {
    // ...
  } catch {
    return null;  // 所有错误都返回 null
  }
}
```
- 不同错误有不同含义，但都被静默处理：
  - `ENOENT` (文件不存在) → 正常，项目未初始化
  - `EACCES` (权限不足) → 需要告知用户
  - `SyntaxError` (JSON 格式错误) → 文件损坏，需要警告
- 调试困难，用户无法知道真正的问题

**Context**: `src/interactive/project-storage.ts` - `loadFeatures()`, `readProgress()`, `readSessionPlan()` 方法

**Resolution**:
- 在三个方法中区分 `ENOENT` 和其他错误
- 对于 `ENOENT` 错误（文件不存在），返回 null/空字符串（正常行为）
- 对于其他错误（权限、格式等），使用 `console.error` 记录错误日志
- 保持返回类型不变，确保向后兼容

**Files Changed**: `src/interactive/project-storage.ts`

---

### 008: 交互提示缺少输入验证 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.3
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-22

**Original Problem**:
```typescript
rl.question(`${message} (y/n) `, answer => {
  resolve(answer.toLowerCase().startsWith('y'));
});
```
- 用户输入未进行清理，空白字符可能导致意外行为
- 输入 " y" 或 "y " 可能不被正确识别

**Context**: `src/interactive/project-commands.ts`

**Resolution**:
- 在 `createConfirmFn` 函数中添加 `.trim()` 方法
- 现在用户输入会先去除首尾空白字符，再进行大小写转换和匹配
- 修改后代码：`resolve(answer.trim().toLowerCase().startsWith('y'));`

**Files Changed**: `src/interactive/project-commands.ts`

---

### 009: 不安全的类型断言 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.3
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-22

**Original Problem**:
```typescript
const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;
```
- 空对象 `{}` 被断言为 `KodaXOptions` 类型，但空对象实际上并不包含该接口所需的任何属性
- 运行时访问不存在的属性会得到 `undefined`，类型安全被绕过

**Context**: `src/interactive/project-commands.ts`

**Resolution**:
- 移除不安全的类型断言 `{} as KodaXOptions`
- 改为显式检查 options 是否存在，如果不存在则输出错误并返回
- 修复后代码：
  ```typescript
  const options = callbacks.createKodaXOptions?.();
  if (!options) {
    console.log(chalk.red('\n[Error] KodaX options not available\n'));
    return;
  }
  ```

**Files Changed**: `src/interactive/project-commands.ts`

---

### 010: 非空断言缺乏显式检查 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-25

**Original Problem**:
```typescript
return { feature: data.features[index]!, index };
```
- 使用 `!` 非空断言操作符时缺少显式 null 检查
- TypeScript 的 `!` 在编译后被移除，运行时无保护

**Context**: `packages/repl/src/interactive/project-storage.ts`

**Resolution**:
- 修改 `getNextPendingFeature()` 函数，添加显式 null 检查
- 修复后代码：
  ```typescript
  const feature = data.features[index];
  if (!feature) return null;
  return { feature, index };
  ```
- 与同文件 `getFeatureByIndex()` (line 152-153) 保持风格一致

**Files Changed**: `packages/repl/src/interactive/project-storage.ts`

---

### 011: 命令预览长度不一致 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26

**Original Problem**:
```typescript
// 行 239: 显示 50 字符
const preview = cmd.slice(0, 50) + (cmd.length > 50 ? '...' : '');

// 行 253-254: 显示 60 字符
const cmd = (input.command as string)?.slice(0, 60) ?? '';
const suffix = cmd.length >= 60 ? '...' : '';
```
- 用户体验不一致，代码维护困难

**Context**: `src/interactive/prompts.ts` - 行 253-254 vs 239

**Resolution**:
- 在 `common/utils.ts` 添加共享常量 `PREVIEW_MAX_LENGTH = 60`
- 修改 `cli-events.ts` 和 `prompts.ts` 使用共享常量
- 统一所有命令预览长度为 60 字符

**Files Changed**: `packages/repl/src/common/utils.ts`, `packages/repl/src/index.ts`, `packages/repl/src/ui/cli-events.ts`, `packages/repl/src/interactive/prompts.ts`

---

### 012: ANSI Strip 性能问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26

**Original Problem**:
```typescript
private stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
```
- `stripAnsi()` 在每次渲染时都调用正则替换
- 状态栏更新频繁时可能影响性能
- 正则表达式每次都重新编译

**Context**: `src/interactive/status-bar.ts` - 行 206-208

**Resolution**:
- 将正则表达式提取为模块级常量 `ANSI_REGEX`
- 在 `stripAnsi()` 方法中复用缓存的正则表达式
- 添加 `lastIndex = 0` 重置以确保从头匹配

**Files Changed**: `packages/repl/src/interactive/status-bar.ts`

---

### 016: InkREPL 组件过大 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26

**Original Problem**:
- InkREPL 组件约 994 行代码（原记录 637 行，增长 56%）
- 包含 7+ 个职责：命令处理、Shell 命令执行、会话管理、消息格式化、状态管理等
- `handleSubmit()` 单函数 300+ 行，包含 13 个内联回调
- 代码可读性降低，维护成本增加，难以单独测试各模块

**Context**: `packages/repl/src/ui/InkREPL.tsx`

**职责分析** (994 行):
```
1. SessionStorage 接口 + 实现    (lines 84-136)   ~52行
2. Helper 函数                   (lines 64-81)    ~17行
3. Banner 组件                   (lines 153-240)  ~87行
4. InkREPLInner 核心组件         (lines 242-820) ~578行
   ├── 状态管理 (useState x 5)
   ├── 全局中断处理 (useKeypress)
   ├── 消息同步 (useEffect)
   ├── processSpecialSyntax()    ~45行
   ├── extractTitle()            ~8行
   ├── createStreamingEvents()   ~28行
   ├── runAgentRound()           ~16行
   └── handleSubmit()           ~300行 (巨型函数)
5. InkREPL 包装器                (lines 823-836)  ~13行
6. isRawModeSupported()          (lines 838-843)  ~5行
7. printStartupBanner() - 死代码 (lines 845-896) ~51行
8. startInkREPL() 入口           (lines 898-994) ~96行
```

**Resolution**:
- 采用方案 A 保守重构
- 新建 4 个工具模块:
  - `utils/session-storage.ts` - SessionStorage 接口 + MemorySessionStorage 实现
  - `utils/shell-executor.ts` - processSpecialSyntax() 和 Shell 命令执行
  - `utils/message-utils.ts` - extractTextContent(), extractTitle(), formatMessagePreview()
  - `utils/console-capturer.ts` - ConsoleCapturer 类和 withCapture() 函数
- 删除死代码: printStartupBanner() 函数
- 更新 utils/index.ts barrel export
- 结果: 994 行 → 819 行 (减少 175 行，-17.6%)

---

### 019: 状态栏 Session ID 显示问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.4.4
- **Created**: 2026-02-20
- **Resolved**: 2026-02-26

**Original Problem**:
- 存在两套 StatusBar 实现：
  - Legacy `status-bar.ts` (readline 界面): 截断为 6 字符，不显示 model
  - Active `StatusBar.tsx` (Ink React 组件): 截断为 13 字符，已显示 provider/model
- 当前使用的 Ink 版本截断 Session ID 为 13 字符，丢失最后 2 位秒数
- Session ID 格式为 `YYYYMMDD_HHMMSS` (15 字符)，13 字符截断后显示 `YYYYMMDD_HHMM`

**Context**: `packages/repl/src/ui/components/StatusBar.tsx` - 行 25-27

**Expected Behavior**: Session ID 完整显示，不截断，保留 `YYYYMMDD_HHMMSS` 格式

**Resolution**:
- 移除截断逻辑，直接显示完整 Session ID (15 字符)
- 修复后代码：
  ```typescript
  // 直接显示完整 Session ID，不截断
  const displaySessionId = sessionId;
  ```

**Files Changed**: `packages/repl/src/ui/components/StatusBar.tsx`

---

### 020: 资源泄漏 - Readline 接口 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-19

**Original Problem**:
- `project-commands.ts` 创建了自己的 readline 接口但从未关闭
- 可能导致字符双倍显示和资源泄漏

**Context**: `src/interactive/project-commands.ts`

**Resolution**:
- 通过 `CommandCallbacks` 传递 REPL 的 readline 接口
- 在 `CommandCallbacks` 接口添加 `readline?: readline.Interface`
- 在 `repl.ts` 中传入 `rl` 实例

**Files Changed**: `src/interactive/project-commands.ts`, `src/interactive/repl.ts`

---

### 021: 全局可变状态 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-19

**Original Problem**:
```typescript
let rl: readline.Interface | null = null;
let autoContinueRunning = false;
```
- 模块级可变变量可能导致状态残留和测试困难

**Context**: `src/interactive/project-commands.ts`

**Resolution**: 封装到 `ProjectRuntimeState` 类

**Files Changed**: `src/interactive/project-commands.ts`

---

### 022: 函数过长 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-19
- **Resolution Date**: 2026-02-19

**Original Problem**:
- `projectInit()` ~70 行, `projectNext()` ~80 行, `projectAuto()` ~100 行

**Context**: `src/interactive/project-commands.ts`

**Resolution**: 提取辅助函数 (createConfirmFn, createQuestionFn, displayFeatureInfo, buildFeaturePrompt, executeSingleFeature, parseAutoOptions, parseAutoAction)

**Files Changed**: `src/interactive/project-commands.ts`

---

### 023: Delete 键无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 在 `InputPrompt.tsx` 中，Delete 键的处理函数为空，无法删除光标后的字符

**Context**: `src/ui/components/InputPrompt.tsx`

**Resolution**: 添加 `delete: deleteChar` 别名并调用 `deleteChar()`

**Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 024: Backspace 键无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 在某些终端中，按 Backspace 键无法删除字符
- 代码中 `key.delete` 检查在 `char === "\x7f"` 之前，导致调用错误的处理函数

**Context**: `src/ui/components/InputPrompt.tsx`

**Resolution**: 调整检测顺序，使 `\x7f` 字符检测优先于 `key.delete` 检测

**Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 025: Shift+Enter 换行无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 在某些终端中，按 Shift+Enter 无法插入换行
- Ink 的 `useInput` hook 在某些终端中无法正确检测 Shift+Enter 组合键

**Context**: `src/ui/components/InputPrompt.tsx`

**Resolution**: 添加对 `\n` 字符的检测作为换行的后备方案

**Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 026: Resize handler 空引用 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- `TextInput.tsx` 中的 resize handler 使用闭包中的 `stdout` 变量，可能为 null

**Context**: `src/ui/components/TextInput.tsx`

**Resolution**: 使用 `process.stdout` 替代闭包中的 `stdout`

**Files Changed**: `src/ui/components/TextInput.tsx`

---

### 027: 异步上下文直接退出 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- `InkREPL.tsx` 中在异步上下文直接调用 `process.exit()`
- 导致资源未正确释放，可能造成数据丢失或资源泄漏

**Context**: `src/ui/InkREPL.tsx`

**Resolution**: 新增 `KodaXTerminalError` 错误类，在顶层处理错误

**Files Changed**: `src/ui/InkREPL.tsx`, `src/ui/errors.ts`

---

### 028: 超宽终端分隔符 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 在超宽终端（如 300+ 列）中，分隔符会生成过长的字符串

**Context**: `src/ui/components/TextInput.tsx`

**Resolution**: 添加 `MAX_DIVIDER_WIDTH=200` 限制

**Files Changed**: `src/ui/components/TextInput.tsx`

---

### 029: --continue 会话不恢复 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 使用 `--continue` 参数时，不会恢复最近的会话

**Context**: `src/ui/InkREPL.tsx`

**Resolution**: 添加 `resume`/`autoResume` 选项处理，加载最近会话

**Files Changed**: `src/ui/InkREPL.tsx`

---

### 030: gitRoot 未设置 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1
- **Fixed**: v0.3.2
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 创建 context 时 `gitRoot` 未设置，导致会话过滤功能不正常

**Context**: `src/ui/InkREPL.tsx`

**Resolution**: 在创建 context 前获取 gitRoot

**Files Changed**: `src/ui/InkREPL.tsx`

---

### 031: Thinking 内容不显示 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.2
- **Fixed**: v0.3.3
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 在 Thinking 模式下，模型的 thinking 内容不会在 UI 中实时显示

**Context**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`

**Resolution**: 添加 `thinkingContent` 字段和 `appendThinkingContent` 方法，在 MessageList 中显示

**Files Changed**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### 032: 非流式输出 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.2
- **Fixed**: v0.3.3
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 非 Thinking 模式下，响应内容会在流式完成后一次性显示，而非实时逐字显示

**Context**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

**Resolution**: 添加 `streamingResponse` prop 实现实时流式显示

**Files Changed**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### 033: Banner 消失 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.2
- **Fixed**: v0.3.3
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- 用户首次交互后，启动 Banner 会消失或被隐藏

**Context**: `src/ui/InkREPL.tsx`

**Resolution**: 移除 `setShowBanner(false)` 调用

**Files Changed**: `src/ui/InkREPL.tsx`

---

### 034: /help 输出不可见 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.2
- **Fixed**: v0.3.3
- **Created**: 2026-02-20
- **Resolution Date**: 2026-02-20

**Original Problem**:
- `/help` 等命令的 `console.log` 输出在 Ink 的 alternate buffer 中不可见

**Context**: `src/ui/InkREPL.tsx`

**Resolution**: 在 Ink 的 `render()` 选项中设置 `patchConsole: true`

**Files Changed**: `src/ui/InkREPL.tsx`

---

### 035: Backspace 检测边缘情况 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.3.3
- **Created**: 2026-02-22
- **Resolved**: 2026-02-23

**Original Problem**:
- `InputPrompt.tsx` 中的 Backspace 检测逻辑存在条件重叠
- 某些边缘情况可能导致 Backspace 行为不一致：
  1. 条件 `(key.delete && char === "")` 与 Delete 检测存在潜在冲突
  2. 后备条件 `(char === "" && key.backspace === undefined && key.delete === undefined)` 可能捕获其他空事件
- 不同终端对 Backspace 的报告方式不一致（`\x7f`、`\x08`、`key.delete=true`）

**Context**: `src/ui/components/InputPrompt.tsx` - 行 135-157

**Root Cause Analysis**:
```typescript
// 当前代码
const isBackspace = key.backspace ||
                    char === "\x7f" ||
                    char === "\x08" ||
                    (key.ctrl && char === "h") ||
                    (char === "" && (key.backspace === undefined && key.delete === undefined)) ||
                    (key.delete && char === "");  // ⚠️ 与 Delete 检测重叠

// Delete 检测
if (key.delete && char !== "\x7f" && char !== "") {
  deleteChar();  // 如果终端发送 key.delete=true + char=某个字符，会错误触发 Delete
}
```

**Resolution**:
- 按置信度分层重构 Backspace 检测逻辑
- 分离高/中/低置信度条件，避免重叠
- 后备检测仅在无其他键标识时触发
- 与 Delete 检测逻辑完全解耦

**Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 036: React 状态同步潜在问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.4.5
- **Created**: 2026-02-22
- **Resolved**: 2026-02-26

**Original Problem**:
- `useTextBuffer.ts` 中的 `syncState` 函数使用三个独立的 `setState` 调用
- 在极端情况下（React 批处理失败），可能导致中间渲染状态不一致

**Context**: `packages/repl/src/ui/hooks/useTextBuffer.ts`

**Root Cause Analysis**:
```typescript
// 旧代码 - 三个独立的 setState
const [text, setText] = useState(initialValue);
const [cursor, setCursor] = useState<CursorPosition>({ row: 0, col: 0 });
const [lines, setLines] = useState<string[]>([""]);

const syncState = useCallback(() => {
  setText(buffer.text);      // 状态更新 1
  setCursor(buffer.cursor);  // 状态更新 2
  setLines(buffer.lines);    // 状态更新 3
  onTextChange?.(buffer.text);
}, [buffer, onTextChange]);
```

**Resolution**:
- 使用单一状态对象 `TextBufferState` 替代三个独立的 `useState`
- `syncState` 现在只调用一次 `setState`，确保原子更新
- 公开 API 完全保持不变，仅内部实现变更

**Files Changed**: `packages/repl/src/ui/hooks/useTextBuffer.ts`

**Tests Added**: 无（该项目暂无自动化测试，已手动验证编译通过）

---

### 037: 两套键盘事件系统冲突 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.4.5
- **Created**: 2026-02-22
- **Resolved**: 2026-02-26

**Original Problem**:
- 项目存在两套键盘事件处理系统：
  1. `KeypressContext.tsx` - 优先级系统，支持多个处理器
  2. `InputPrompt.tsx` - 直接使用 Ink 的 `useInput`
- 两者无法同时使用，导致优先级系统无法用于 REPL

**Context**: `packages/repl/src/ui/contexts/KeypressContext.tsx`, `packages/repl/src/ui/components/InputPrompt.tsx`

**Resolution**:
- `InkREPL.tsx` 现已使用 `<KeypressProvider>` 包裹组件（行 695-697）
- `InputPrompt.tsx` 已迁移使用 `useKeypress` 从 `KeypressContext`（行 15, 70）
- 使用优先级系统 `KeypressHandlerPriority.High` 注册输入处理器
- 实现了完整的 Proposed Solution（v0.4.0 Scope）

**Files Changed**: `packages/repl/src/ui/InkREPL.tsx`, `packages/repl/src/ui/components/InputPrompt.tsx`

---

### 038: 输入焦点竞态条件 (WON'T FIX)
- **Priority**: Low
- **Status**: Won't Fix
- **Introduced**: v0.3.3
- **Created**: 2026-02-22
- **Resolution Date**: 2026-02-22

**Original Problem**:
- 当 `isLoading` 从 `false` 变为 `true` 时，`InputPrompt` 的 `focus` prop 变为 `false`
- `useInput` 的 `isActive` 选项随之变为 `false`
- 如果此时有按键事件正在处理中，可能导致意外行为

**Context**: `src/ui/components/InputPrompt.tsx`, `src/ui/InkREPL.tsx`

**Decision**: 不修复，理由如下：
1. **理论问题，无实际报告**: 实际使用中从未有用户报告此问题
2. **React 18 自动批处理**: 现代 React 会自动批处理状态更新，时间窗口极小
3. **useInput 内部检查**: `isActive` 在处理事件前检查，竞态条件难以触发
4. **修复成本高**: 添加延迟机制会增加代码复杂性且可能引入新问题

---

### 040: REPL 显示问题 - 命令输出渲染位置错误 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.4.2
- **Created**: 2026-02-23
- **Resolved**: 2026-02-25

**Original Problem**:
- `/help`, `/model` 等命令的输出被渲染在 Banner 下面、用户消息上面
- 预期顺序：Banner → 用户输入 → 命令输出
- 实际顺序：Banner → 命令输出 → 用户输入

**Root Cause Analysis**:
- `executeCommand()` 使用 `console.log` 输出命令结果
- Ink 的 `patchConsole: true` 模式捕获所有 console 输出
- 被捕获的 console 输出被渲染在 MessageList 组件之前的位置

**Resolution**:
- 采用方案 B：捕获 console 输出
- 在命令执行期间临时拦截 `console.log`
- 将捕获的内容添加到 history 作为 "info" 类型
- 命令输出按正确顺序出现在 MessageList 中

**Files Changed**:
- `packages/repl/src/ui/InkREPL.tsx` - 捕获 console.log 并添加到 history

**Related**: 037 (两套键盘事件系统冲突), 034 (/help 输出不可见)

---

### 041: 历史导航清空输入无法恢复 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.3.3
- **Created**: 2026-02-23
- **Resolution Date**: 2026-02-23

**Original Problem**:
- 用户输入文字后按上键浏览历史，再按下键回到最新位置时，输入被清空
- 再次按上键无法恢复刚才输入的文字

**Context**: `src/ui/hooks/useInputHistory.ts`, `src/ui/components/InputPrompt.tsx`

**Root Cause Analysis**:
- `useInputHistory.ts` 中 `navigateDown()` 返回 `tempInputRef.current || null`
- 当 `tempInputRef.current` 为空字符串时，返回 `null`
- `InputPrompt.tsx` 中检测到 `null` 后调用 `setText("")` 清空输入
- 参考 Gemini CLI/OpenCode: 应该返回空字符串而不是 null

**Resolution**:
- 修改 `navigateDown()` 返回 `tempInputRef.current` (可能是空字符串)
- 修改 `InputPrompt.tsx` 在 `historyText !== null` 时更新文本（包括空字符串）

**Files Changed**: `src/ui/hooks/useInputHistory.ts`, `src/ui/components/InputPrompt.tsx`

---

### 042: Shift+Enter/Ctrl+J 换行无效 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.3.3
- **Created**: 2026-02-23
- **Resolution Date**: 2026-02-23

**Original Problem**:
- Shift+Enter 无法插入换行（大多数终端无法区分 Shift+Enter 和 Enter）
- 用户无法在输入中插入多行文本（只能用 `\`+Enter 后备方案）

**Context**: `src/ui/utils/keypress-parser.ts`, `src/ui/components/InputPrompt.tsx`

**Root Cause Analysis**:
- 大多数终端（尤其是 Windows）不支持 CSI u 格式的 modifyOtherKeys
- Shift+Enter 发送的 `\x1b[13;2u` 序列很少被终端支持
- 实际上 Shift+Enter 和 Enter 发送的都是 `\r`

**Resolution**:
- 添加 Ctrl+J (Line Feed, `\n`) 作为换行的可靠替代
- 修改 `keypress-parser.ts` 将 `\n` 命名为 "newline"
- 修改 `InputPrompt.tsx` 处理 `key.name === "newline"` 为换行

**Files Changed**: `src/ui/utils/keypress-parser.ts`, `src/ui/components/InputPrompt.tsx`

---

### 043: 流式响应中断不完全 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3
- **Fixed**: v0.3.4
- **Created**: 2026-02-23
- **Resolution Date**: 2026-02-23

**Original Problem**:
- 在 LLM 流式响应时按 Ctrl+C 或 ESC 中断
- UI 显示 "[Interrupted]" 但 API 请求可能仍在后台继续
- 流式输出过程中中断可能导致显示问题

**Context**: `src/ui/InkREPL.tsx`, `src/ui/contexts/StreamingContext.tsx`, `src/core/providers/`

**Root Cause Analysis**:
- `StreamingContext` 创建了 `AbortController` 但 signal 未传递给 API 调用
- `abort()` 调用 `abortController.abort()` 但 Anthropic/OpenAI SDK 不知道这个 signal

**Resolution**:
1. 修改 `anthropic.ts` 和 `openai.ts`：传递 signal 给 SDK 的 create 方法
2. 修改 `agent.ts`：正确识别并处理 AbortError（`error.name === 'AbortError'`）
3. 添加 `KodaXResult.interrupted` 字段标记中断状态
4. 使用 Gemini CLI 风格的 `isActive` 模式优化 keypress handler 订阅

**Files Changed**:
- `src/core/providers/anthropic.ts` - 传递 signal 给 SDK
- `src/core/providers/openai.ts` - 传递 signal 给 SDK
- `src/core/agent.ts` - AbortError 处理
- `src/core/types.ts` - 添加 interrupted 字段
- `src/ui/contexts/KeypressContext.tsx` - 支持 isActive 模式
- `src/ui/InkREPL.tsx` - 使用 Gemini CLI 风格中断处理

---

### 045: Spinner 出现时问答顺序颠倒 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.4.3
- **Fixed**: v0.4.4
- **Created**: 2026-02-25
- **Resolution Date**: 2026-02-25

**Original Problem**:
- 在问答过程中，当 spinner (加载指示器) 出现时，问答顺序会上下颠倒乱序
- 表现类似 Issue 040：命令输出渲染位置错误
- 当前行为：问答顺序错乱，可能出现"回答显示在问题之前"的情况
- 预期行为：问答应按时间顺序显示，最新响应应显示在底部

**Context**: REPL UI 渲染层，Ink 组件

**Root Cause Analysis**:
- **渲染结构分析**：
  - 当 `history.length > 0` 时，MessageList 组件渲染，Spinner 在 MessageList 内部（MessageList.tsx 行 468-483）
  - 当 `history.length === 0 && isLoading` 时，ThinkingIndicator 在 MessageList 外部渲染（InkREPL.tsx 行 762-766）
- **问题根源 1 - Ink patchConsole 行为**：
  - Ink 使用 `patchConsole: true`（InkREPL.tsx 行 952）捕获所有 console 输出
  - 被捕获的输出会作为虚拟组件插入渲染树
  - 在流式响应期间，渲染树不断变化，捕获的输出可能出现在错误位置
  - Agent 执行路径中的 console.log（onError、catch 块）未被显式处理，被 patchConsole 任意插入
- **问题根源 2 - Thinking 内容消失**：
  - `onTextDelta` 被调用时，会调用 `stopThinking()`（InkREPL.tsx 行 399）
  - `stopThinking()` 会清空 `thinkingContent`（StreamingContext.tsx 行 309）
  - 这导致 Thinking 内容在第一个文本到达时消失
- **MessageList 渲染顺序**（MessageList.tsx 行 435-484）：
  1. filteredItems（历史消息）
  2. thinkingContent（思考内容）
  3. streamingResponse（流式响应）
  4. Spinner（加载指示器）

**Related**: 040 (REPL 显示问题 - 命令输出渲染位置错误，已修复)

**Resolution**:
1. **修复 1**：在 agent 运行期间捕获 console.log（类似 Issue 040 的解决方案）
   - 在 `InkREPL.tsx` 的 `runAgentRound` 调用前后捕获/恢复 console.log
   - 将捕获的内容添加到 history 作为 info 类型
2. **修复 2**：保留 Thinking 内容显示
   - 修改 `StreamingContext.tsx` 的 `stopThinking()` 函数，不再清空 `thinkingContent`
   - Thinking 内容现在会保留显示，直到下一个 thinking session 开始

---

## Summary
- Total Archived: 41 issues
- Archive Started: 2026-03-04
- Last Archived: 2026-03-04
