# 热轨快照

_生成时间: 2026-03-12 15:45_
_快照版本: v8_

---

## 1. 项目状态

### 当前目标
Issue 083 - 键盘快捷键系统详细设计与规划

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 083 规划 | ✅ 完成 | 6 阶段实现计划已添加到 KNOWN_ISSUES.md |
| 快捷键类型定义 | 📋 已设计 | ShortcutActionId, KeyBinding, ShortcutDefinition |
| Registry 架构 | 📋 已设计 | 单例模式 + 上下文感知激活 |
| useShortcut Hook | 📋 已设计 | React hook 接口已定义 |

### 当下阻塞
- **无**: 设计阶段已完成，等待实现

---

## 2. 已确定接口（骨架）

### packages/repl/src/ui/shortcuts/types.ts

```typescript
type ShortcutActionId =
  | 'interrupt'       // Ctrl+C - 中断
  | 'clearScreen'     // Ctrl+L - 清屏
  | 'showHelp'        // ? - 显示帮助
  | 'toggleWorkMode'  // Ctrl+O - 切换模式
  | 'toggleThinking'  // Ctrl+T - 切换思考
  | 'acceptCompletion'| 'submitInput' | 'historyUp' | 'historyDown'

interface KeyBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

interface ShortcutDefinition {
  id: ShortcutActionId;
  name: string;
  description: string;
  defaultBindings: KeyBinding[];
  context: 'global' | 'input' | 'streaming';
  priority: number;
  category: 'global' | 'navigation' | 'editing' | 'mode';
}
```

### packages/repl/src/ui/shortcuts/ShortcutsRegistry.ts

```typescript
class ShortcutsRegistry {
  // 单例模式
  private static instance: ShortcutsRegistry;

  // 从 ~/.kodax/keybindings.json 加载用户配置
  loadUserConfig(): void;

  // 查询匹配的快捷键
  findMatchingShortcut(key: string, context: ShortcutContext): ShortcutDefinition | null;

  // 注册快捷键
  register(definition: ShortcutDefinition): void;
}
```

### packages/repl/src/ui/shortcuts/useShortcut.ts

```typescript
function useShortcut(
  actionId: ShortcutActionId,
  handler: () => boolean | void,
  options?: {
    context?: ShortcutContext;
    isActive?: boolean;
  }
): void;
```

### 默认快捷键表

| Action | Key | Context | Description |
|--------|-----|---------|-------------|
| interrupt | Ctrl+C | streaming | 中断当前操作 |
| clearScreen | Ctrl+L | global | 清屏 |
| showHelp | ? | global | 显示帮助 |
| toggleWorkMode | Ctrl+O | global | 切换 Project/Coding 模式 |
| toggleThinking | Ctrl+T | global | 切换 Extended Thinking |
| acceptCompletion | Tab | input | 接受补全 |
| submitInput | Enter | input | 提交输入 |
| historyUp | Up | input | 历史上一条 |
| historyDown | Down | input | 历史下一条 |

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| 简单否定词列表 | 复杂否定表达仍误判，只要预设就可能出错 | 2026-03-08 |
| 删除 context.messages 赋值 | 后续对话会"失忆"，丢失上下文 | 2026-03-08 |
| 循环条件 i < length | 从 length-1 开始只执行一次 | 2026-03-08 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| 6 阶段渐进式实现 | 先基础设施，后集成，最后配置，保持向后兼容 | 2026-03-12 |
| 单例 Registry 模式 | 集中管理快捷键，支持全局查询和上下文感知 | 2026-03-12 |
| 上下文分离 (global/input/streaming) | 不同场景激活不同快捷键，避免冲突 | 2026-03-12 |
| 用户配置 ~/.kodax/keybindings.json | 支持自定义快捷键，覆盖默认值 | 2026-03-12 |
| 集成现有 KeypressContext | 复用优先级键盘事件分发系统，不重复造轮 | 2026-03-12 |

---

## 5. 版本历史

| 版本 | 主要变更 | 日期 |
|------|----------|------|
| v0.5.29 | 当前开发版本 | 2026-03-12 |
| v0.5.21 | 修复循环逻辑 bug，添加 ask-user-question 工具 | 2026-03-08 |
| v0.5.20 | /project edit 意图理解和上下文保存修复 | 2026-03-08 |
| v0.5.16 | Plan Mode Bash 权限精细化 | 2026-03-07 |

---

## 6. 待实现文件结构

```
packages/repl/src/ui/shortcuts/
  index.ts                    # Public exports
  types.ts                    # 核心类型定义
  ShortcutsRegistry.ts        # 集中式注册表单例
  defaultShortcuts.ts         # 默认快捷键定义
  useShortcut.ts              # React hook
  shortcuts-config.ts         # 配置文件加载/保存
```

**待修改文件**:
- `packages/repl/src/ui/contexts/KeypressContext.tsx` - 集成现有优先级系统
- `packages/repl/src/ui/InkREPL.tsx` - 添加全局快捷键注册
- `packages/repl/src/ui/components/InputPrompt.tsx` - 迁移硬编码快捷键
- `packages/repl/src/ui/types.ts` - 扩展快捷键类型

---

*Token 数: ~1,100*
