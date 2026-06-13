# FEATURE_172 v0.7.41 — REPL Render Path Refactor Regression Guide

> Status: **Skeleton (Layer 0 / Phase 0 deliverable)** — to be expanded as Layer 0 baseline capture proceeds.
>
> Validates that the JSX-driven + claudecode-parity selection refactor (ADR-027 / FEATURE_172) **preserves every existing user-facing behavior**, while fixing the SSH long-session lag.

---

## Scope

Two render paths to verify after each Phase commit:

- **Legacy mode** (`KODAX_FULLSCREEN=0` or non-mouse host): output flows into terminal native scrollback; terminal owns selection
- **Owned mode** (`KODAX_FULLSCREEN=1` or modern local terminal): KodaX owns viewport; alternate-screen + KodaX-managed mouse selection

Hosts to verify each path:
| Host | Legacy | Owned |
|---|---|---|
| Windows Terminal (Win 10/11) | ✅ | ✅ |
| iTerm2 (macOS) | ✅ | ✅ |
| VS Code integrated terminal | ✅(默认)| 跳过(强制 legacy)|
| SSH from {WT,iTerm} → Linux box | ✅ **(原 bug 复现场景)** | optional |

## Preconditions

- Use a real project session with **≥200 history items**(必要 — 这是原 bug 复现条件)
- Start with `kodax -c` to resume the long session
- Prefer a streaming-heavy scenario(让 streaming 跑 ≥30s 观察 spinner / 实时输出)
- Have a paste-target ready(VS Code 编辑器或浏览器输入框)

---

## Scenario 1: SSH Long-Session Streaming Cadence(P0 — 原 bug 修复验证)

**前置**:从 SSH 客户端连服务器,启 `kodax -c` 恢复 ≥200 history items session,触发一个会流式输出 ≥30s 的请求(如 "总结这个 repo 的架构")。

**步骤**:
1. 观察流式输出过程中 spinner 旋转流畅性
2. 观察 token 一边到一边显示流畅度
3. 同时输入文字进 prompt input(测试键盘 latency)
4. 观察 status bar 更新流畅性

**期望**:
- spinner 旋转**接近 12.5fps**(80ms tick),无明显丢帧或停顿
- token 流式显示**无 2-3 秒卡顿**
- prompt 输入响应 latency < 100ms
- status bar 更新及时

**Fail criterion**:任何一项有 >500ms 卡顿即 fail,record platform + steps。

---

## Scenario 2: 鼠标拖拽选择 + 自动复制(Legacy mode)

**前置**:legacy 模式,确认终端原生鼠标选择启用。

**步骤**:
1. 鼠标按住拖拽选中 transcript 中**单行的几个词**
2. 释放鼠标
3. 在外部应用(VS Code)粘贴
4. 重复:跨 **3 行** 拖拽选择
5. 重复:选中 **CJK 中文字符**(`你好世界`)
6. 重复:选中包含 **emoji** 的行(若 transcript 有)

**期望**:
- 视觉高亮跟手,光标释放后选区保持
- 自动复制(legacy 用终端原生 → KodaX 不介入)
- 粘贴内容跟屏幕看到的字符**完全一致**(不带 ANSI 转义、不带 spinner 字符、不带行号 sigil)
- CJK 不出现半角截断或乱码
- emoji 完整

**Fail criterion**:粘贴内容与屏幕不一致 / 多出垃圾字符 / CJK 截断。

---

## Scenario 3: 鼠标拖拽选择 + 自动复制(Owned mode)

**前置**:owned 模式(alternate-screen),终端进入全屏 KodaX UI。

**步骤**:
1. 鼠标按住拖拽选中**单行**
2. 释放 → 检查屏幕看到选区高亮(claudecode parity:cell-buffer bgColor overlay)
3. 粘贴到外部应用
4. 重复:跨 **3 行**
5. 重复:从 **viewport 中部** 拖到 **底部** 时,自动滚动 transcript(edge-scroll)
6. 重复:**反向选择**(从右下拖到左上)
7. 重复:CJK + emoji

**期望**:
- 选区视觉高亮**正确**(KodaX 自管,非终端原生)
- 释放后**自动复制到剪贴板**(OSC 52 协议)
- 粘贴内容跟选区文字 byte-equal
- edge-scroll 拖到边缘时 transcript 自动卷动
- 反向选择仍能产生正确选区

**Fail criterion**:任何一项不达成。

---

## Scenario 4: NoSelect 区域跳过(spinner / gutter / sigil)

**前置**:有任意 transcript 包含:
- 活跃 spinner 行(streaming 中)
- 缩进装饰(`│ `、`└ `、`▸ ` 等 sigil)
- 行首 spinner braille glyph

**步骤**:
1. 鼠标拖拽**跨过 spinner 行**选择上下两行
2. 复制粘贴
3. 拖拽**跨过缩进 sigil** 选择
4. 复制粘贴

**期望**:
- spinner 字符、sigil 装饰、缩进 padding **不出现在粘贴结果**
- 粘贴文本就是 message 的语义内容(claudecode `<NoSelect>` + bitmap 等价)

**Fail criterion**:粘贴结果含 spinner braille (`⠋⠙⠹...`)、sigil 字符、行号、装饰边框。

---

## Scenario 5: 键盘 copy-mode(j/k 整条 message)

**前置**:transcript 模式(`Ctrl+O`),进入键盘导航。

**步骤**:
1. `j` / `k` 导航选中一条 user message
2. 按对应复制键(查 CHANGELOG / help)
3. 粘贴
4. 重复对 assistant message + tool_group + thinking item 各做一次

**期望**:
- 整条 message 内容(走 `buildTranscriptCopyText(item)` 直接从 HistoryItem)
- 这条路径**不应受 D2.C 影响**(走 HistoryItem 不走 screen buffer)

**Fail criterion**:任何 item 类型复制不出来或内容截断。

---

## Scenario 6: 搜索 + 高亮 + 跳转

**前置**:transcript 中有 ≥10 个匹配 "test" 的位置。

**步骤**:
1. 进 search 模式,输入 `test`
2. 用 next/prev 在结果间循环
3. 检查 hit 是否被高亮(背景色)
4. 检查跳到 hit 时 transcript 自动滚到该位置

**期望**:
- 全部匹配数显示正确
- 高亮位置正确
- 跳转生效

**Fail criterion**:miss 任何匹配 / 高亮错位 / 跳转无效。

---

## Scenario 7: Streaming 中断恢复

**步骤**:
1. 触发流式输出,正在显示时按 Esc 中断
2. 立刻发新 prompt
3. 等新 prompt 流式完成
4. 检查 transcript 历史无错位

**期望**:
- 中断后 spinner 立刻停
- 新 prompt 接管时屏幕无残留旧 stream 文字
- 历史滚动正确

**Fail criterion**:屏幕显示残留 / 行错位 / spinner 不停。

---

## Scenario 8: 终端 resize 处理

**步骤**:
1. 长 session 跑 streaming 时改终端宽度(拖窗口边)
2. 观察 transcript 重新 layout
3. 在 resize 后立刻鼠标选择 → 复制

**期望**:
- resize 后内容不丢、不重叠
- 选择/复制立刻可用,坐标系正确

**Fail criterion**:resize 后选择坐标偏移 / 屏幕花。

---

## Scenario 9: 200/400/800 items perf 抽样验证

**前置**:用 fixture / synthetic 生成的长 session(可手工 fork 一个含 800 items 的会话)。

**步骤**:
1. `kodax -c` 加载 200/400/800 items
2. 触发一次 streaming
3. 用秒表/录屏估算 frame 间隔

**期望**(benchmark gate 锚点):
- 200 items:tick interval 平均 ≤ 100ms(目标 ≤ 80ms = 完全跟得上 streaming flush)
- 400 items:≤ 150ms
- 800 items:≤ 250ms

**Fail criterion**:任一档位卡顿明显(>500ms)。

---

## Acceptance Matrix

每个 Phase 完成后,执行**全部 9 个 scenario** × 2 模式(legacy + owned)+ 至少 1 个 SSH 场景。

- ≥ 1 个 fail → **block phase 完成**,回到 Phase 起点修
- 0 fail → 进入下一 Phase

Layer 5 24h soak 期间,日常使用持续监控这 9 个 scenario;0 issue 才打 v0.7.41 tag。

---

## 自动化补强(随 Phase 一起 land)

- `tests/visual-frame-golden.test.tsx` — Scenarios 2/3/4 的 frame buffer byte-equal 自动化
- `tests/e2e/owned-mode-mouse-select.spec.ts` — Scenarios 3/4 的 Playwright pty 自动化
- `benchmark/repl-render-perf.bench.ts` — Scenario 9 的量化锚点

---

## 已知限制 / 设计决定

- claudecode 的"复制为 markdown 引用"语义 KodaX **不实现**(audit 证实无消费方),粘贴是纯文本
- legacy 模式下选择由终端原生处理 — KodaX 不介入也不能介入(这是终端能力,不是 KodaX bug)
- 在不支持 OSC 52 的旧终端,owned 模式自动复制可能失败 — fallback 行为见 `tui/runtime.ts` `supportsCopyOnSelect` 判定
