# FEATURE_141 v0.7.37 — Transcript Inline Diff Renderer 人测指引

> **目的**：验证 edit / multi_edit / write 工具完成后，transcript 在 tool 调用块下显示带颜色的 unified-diff（绿色 `+` / 红色 `-` / 灰色 `@@`）。pre-FEATURE_141 KodaX 是**唯一不显示 tool result 输出**的主流 coding agent；本 feature 同时补齐"显示 tool output"+"diff 着色"两件事。
>
> **前置**：
> - 任意有效 LLM provider key（推荐 Anthropic-compat 或 OpenAI-compat）
> - KodaX v0.7.37 已构建（`npm run build`）

---

## Test 1 — 单文件 edit 工具显示 colored hunk（核心收益）

### 步骤

1. 启动 KodaX：`./bin/kodax.mjs` 或 `npm run dev`
2. 在仓库根目录创建测试文件 `/tmp/test-141.txt`：
   ```
   line 1
   line 2
   line 3
   line 4
   line 5
   ```
3. 给 LLM 指令：`"在 /tmp/test-141.txt 第 3 行后插入 'NEW LINE'"`
4. 等 LLM 调 `edit` 工具完成

### 期望结果

transcript 中 edit 工具调用块下显示：

```
✓ edit (file_path=/tmp/test-141.txt, ...)
    Completed in <time>

    File edited: /tmp/test-141.txt
      (+1 lines, -0 lines)

      <灰色>/tmp/test-141.txt (+1 -0)</灰色>
      <灰色>--- /tmp/test-141.txt</灰色>
      <灰色>+++ /tmp/test-141.txt</灰色>
      <灰色>@@ -1,5 +1,6 @@</灰色>
       line 1
       line 2
       line 3
      <绿色>+NEW LINE</绿色>
       line 4
       line 5
```

**通过门**：
- ✅ tool.output 文本**显示**（pre-141 完全不显示）
- ✅ `+NEW LINE` 行带**绿色** `+` 前缀
- ✅ `@@ ... @@` 头**灰色**
- ✅ `--- /tmp/...` / `+++ /tmp/...` 行**灰色**
- ✅ 上下文行（` line 1` 等）默认色

### 失败排查

| 现象 | 诊断 |
|------|------|
| tool 块只显示 `Completed in 1.2s`，无 output 内容 | Phase 2.3 ToolOutputBlock 没接通；检查 `ToolCallDisplay` 是否有 `tool.output` 渲染分支 |
| output 显示但无颜色 | DiffHunk 组件未注入；检查 `parseUnifiedDiff` 是否识别到 hunk |
| `+`/`-` 反色错（红绿互换） | `colorFor()` 函数 add/remove 分支调换；看 [DiffHunk.tsx:51-65](../../packages/repl/src/ui/components/DiffHunk.tsx#L51-L65) |
| `@@` 行被着绿色 | classifyLine 顺序错误；`@@ ` 检查必须在 `+` 检查之前 |

---

## Test 2 — multi_edit 多 hunk 同文件

### 步骤

1. 创建 `/tmp/multi-edit-141.py`：
   ```python
   def add(a, b):
       return a + b

   def sub(a, b):
       return a - b

   def mul(a, b):
       return a * b
   ```
2. 指令：`"用 multi_edit 把 add/sub/mul 三个函数都加上类型注解 (a: int, b: int) -> int"`

### 期望结果

transcript 中显示**单个** edit/multi_edit 工具调用块，下方**至少一个** unified-diff 区段（具体几个 hunk 视 LLM 怎么分块），3 处改动都用绿色 `+` / 红色 `-` 标出。

**通过门**：
- ✅ 3 处改动都可见
- ✅ 每处改动的 add/remove 行正确着色
- ✅ 文件路径在 hunk header 上方显示一次（不是每个 hunk 都重复）

---

## Test 3 — write 创建新文件（全 add）

### 步骤

1. 删除 `/tmp/test-141-new.md`（如存在）
2. 指令：`"用 write 工具创建 /tmp/test-141-new.md 含 5 行 markdown"`

### 期望结果

```
✓ write (file_path=/tmp/test-141-new.md, ...)

    File written: /tmp/test-141-new.md
      (+5 lines, -0 lines)

      <灰色>/tmp/test-141-new.md (+5 -0)</灰色>
      <灰色>--- /tmp/test-141-new.md</灰色>
      <灰色>+++ /tmp/test-141-new.md</灰色>
      <灰色>@@ -0,0 +1,5 @@</灰色>
      <绿色>+# heading</绿色>
      <绿色>+content line 1</绿色>
      ...
```

**通过门**：
- ✅ 全部行绿色 `+`
- ✅ 摘要 `+5 -0`（无删除）
- ✅ `@@ -0,0 +1,5 @@` 灰色

---

## Test 4 — 大文件 edit（折叠测试）

### 步骤

1. 创建 100 行测试文件 `/tmp/big-141.txt`（可用 `seq 1 100 > /tmp/big-141.txt`）
2. 指令：`"在 /tmp/big-141.txt 第 50 行后插入 'INSERTED'"`

### 期望结果

由于 hunk 上下文行（默认 3 行 each side）+ 改动行 ≤ 16 行，**应显示完整 hunk** 不触发折叠。

如果 LLM 选择更大上下文（>16 行），应看到中间 `... <N> lines collapsed ...`（灰色）。

**通过门**：
- ✅ 不卡顿
- ✅ 修改的那一行附近上下文清晰可见

---

## Test 5 — 极端大 diff（fallback）

### 步骤

构造一个 >200 行的 hunk（罕见）—— 比如要求 LLM `"用 write 工具把 /tmp/extreme-141.txt 改成 300 行"`。

### 期望结果

DiffHunk 组件触发 `extremeThreshold` fallback，显示：

```
<灰色>/tmp/extreme-141.txt (+300 -0)</灰色>
<灰色>[diff too large to render inline — 305 lines, 300+ / 0-]</灰色>
```

不应有数百行刷屏。

**通过门**：
- ✅ 显示 fallback 摘要
- ✅ transcript 不卡顿

---

## Test 6 — 非 diff 输出 fallback（read tool 等）

### 步骤

指令：`"读 README.md 文件"`

### 期望结果

`read` 工具完成后，transcript 显示 tool.output 文本（README 内容），用 dim color 平铺；**不**触发 DiffHunk（因为内容里没有 `@@ ... @@` hunk header）。

**通过门**：
- ✅ tool.output 文本显示
- ✅ 无错误地按纯文本渲染（暗色），不被误认为 diff

---

## Test 7 — Error / Cancelled 工具不泄露 partial output

### 步骤

让 LLM 故意调一个失败的 edit：`"用 edit 工具把 /tmp/不存在.txt 改成 'foo'"`

### 期望结果

```
✗ edit (file_path=/tmp/不存在.txt, ...)
    [Tool Error] read: ENOENT: no such file or directory
```

**通过门**：
- ✅ 显示 error 行
- ✅ **不**显示 tool.output 中可能的部分输出（避免错误状态泄露 LLM 端中间产物）

---

## Test 8 — child_task 内的 edit（A 方案自然继承）

### 步骤

指令：`"派一个 child agent 去 /tmp/test-141.txt 第 1 行加一行 'CHILD INSERTED'，子 agent 完成后总结改动"`

### 期望结果

主 transcript 中：
- child 的 dispatch_child_task 工具块显示完成 + child summary
- child summary 文本如**包含**类似 unified-diff 的片段（取决于子 agent 怎么写 summary），主 transcript 应**自动**着色（A 方案 parser 不区分文本来源）

**通过门**：
- ✅ child agent 任务正常完成
- ✅ 如 summary 含 `@@ ... @@` 文本则自动着色；如无则按纯文本（两种都算通过）

---

## 回归 checklist（每次 ship 必跑）

- [ ] Test 1 单文件 edit：colored hunk 显示
- [ ] Test 2 multi_edit：多改动正确着色
- [ ] Test 3 write 新文件：全 add 绿色
- [ ] Test 4 大文件 edit：折叠或正常显示，不卡
- [ ] Test 5 极端大 diff：fallback 摘要
- [ ] Test 6 read 工具：纯文本 dim 显示，不误识 diff
- [ ] Test 7 Error 工具：error 行显示，output 不泄露
- [ ] Test 8 child agent：summary 中如有 diff 文本自动着色
- [ ] `npm run test` 全绿（CI 自动）
- [ ] dark theme 下绿/红对比度合规（人眼可区分）

---

## 已知限制 / 不在本版本

- **不**做 inline 交互：折叠区段无 hover / 展开 / 跳转（v1 read-only）—— 想看完整 diff 直接打开 `formatDiffPreview` 落到 `~/.kodax/tool-results/` 的 persisted 文件
- **不**做 turn-level diff overlay（`/diff` 命令）—— FEATURE_138 后续根据用户实际反馈决定
- **不**做 syntax highlighting（diff 行不带语言着色）—— 仅 add / remove / context 三色
- **不**做 git diff 集成（用户跑 `git diff` 自己看）
- **不**改 `KodaXToolResultBlock.content` schema（保持 string，零 wire format 改动；B 方案显式拒绝）
- **不**为 child agent 单独建 diff 旁路事件流（v1 依赖 A 方案 parser 自然继承 child summary 文本）
- v1 用硬编码 theme.colors.success / theme.colors.error；FEATURE_007 Theme System Consolidation ship 后切到 theme primitives
