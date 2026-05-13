# FEATURE_134 v0.7.40 — Image / Screenshot Paste Input (REPL Vision Bridge) 人测指引

> **目的**：验证 (1) 5 类 paste source 都能把图片喂给 LLM；(2) `[Image #N]` pill 占位 UI 正确显示；(3) Alt+V autorepeat / 重复 paste 不会在 `$TMPDIR/kodax-paste/` 堆叠重复文件（hash 去重）；(4) 不支持 vision 的 provider/model 收到清晰错误而不是 silent drop；(5) Custom provider 通过 `capabilityProfile.multimodalSupport: 'image-input'` 能开启 vision；(6) orphan image prune 在文本编辑里删掉 pill 后磁盘文件能 GC。
>
> **前置**：
> - 至少一个 vision-capable provider API key（推荐 anthropic + 一个 compat clone 如 kimi-code 用于交叉验证）
> - KodaX v0.7.40 已构建（`npm run build`）
> - 一张能复制到 clipboard 的截图（PNG 或 JPEG 都行）
> - 一张能直接拖到 terminal / 用绝对路径粘贴的图片文件
>
> **重要约定**：
> - 5 类 paste source 不全跨平台。macOS Cmd+V auto-link 只 macOS 有效；Windows 必须 Alt+V；Linux 走 Ctrl+V + wl-paste/xclip。
> - 默认 vision-capable providers（v0.7.40 ship）：anthropic, openai, deepseek, kimi, kimi-code, qwen, zhipu, zhipu-coding, minimax-coding, mimo-coding, ark-coding (11 / 13)。CLI bridges (gemini-cli, codex-cli) 仍 text-only。
> - 临时文件目录：`$TMPDIR/kodax-paste/`，可通过 `KODAX_PASTE_TMP_DIR` env 覆盖。

---

## Test 1 — Source 1 / Bracketed paste 文本路径（无图片）

### 步骤

1. 启 KodaX。
2. 复制一段普通文字（< ~1000 字），按 Cmd+V (mac) / Ctrl+V (Win/Linux) 粘贴。
3. 文本应整段进入输入框，**没有** `[Image #N]` pill 出现。

### 期望结果

- 纯文本路径不被 vision 路径误触发。
- Bracketed paste mode (DEC 2004) 保证多行文字一次性进入而不是逐字符触发。

---

## Test 2 — Source 2 / 文件路径 paste（绝对路径）

### 步骤

1. 准备一张 PNG / JPEG 文件。例如 `~/screenshot.png` 或 `C:\Users\xxx\screenshot.png`。
2. 启 KodaX。
3. **直接把文件路径**粘贴或键入到输入框（不是 `@` ref，是裸路径）：
   - mac/Linux：拖文件到 terminal 通常会自动展开成绝对路径 + 空格——直接 Enter
   - Windows：键入路径或粘贴
4. 路径应被识别为 image ref，自动替换为 `[Image #1]` pill。
5. 输入文字 `描述这张图`，Enter 发送。
6. LLM 应该收到 vision 内容并回应。

### 期望结果

- 路径裸文本被 `extractImagePaths` 识别（split 在 `/` 或 `[A-Za-z]:\\` 前 + 扩展名匹配）。
- pill 占位 `[Image #1]` 在输入框可见。
- `~/.kodax-paste/` 不会因为 source 2 增加文件（源文件已经在磁盘上，不需要复制）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 路径被当成普通文字保留 | `extractImagePaths` 的 regex split 没匹配；或扩展名不在 `.png/.jpe?g/.gif/.webp/.bmp` 白名单 |
| pill 出现但 LLM 没回应图片 | 验证选中的 provider/model 是否 vision-capable；查 stderr 是否有 `[Provider Policy] multimodal requests are unsupported on this provider` |

---

## Test 3 — Source 3 / macOS Cmd+V 自动 clipboard image link

> **只在 macOS 测试。** Cmd+V 把截图直接送到 KodaX。

### 步骤

1. 在 macOS 用 Cmd+Shift+4 截图（截图自动进 clipboard）。
2. 启 KodaX。
3. 按 Cmd+V。
4. 触发 bracketed paste empty event（terminal 不能传 binary），KodaX 自动调 `osascript` 读 NSPasteboard 拿 PNG buffer → jimp 规一 → 写 `$TMPDIR/kodax-paste/paste-<sha256>.png` → 注入 `[Image #1]` pill。
5. 输入 `识别这张截图里的内容`，Enter。

### 期望结果

- Cmd+V 后立刻看到 `[Image #1]` pill 在输入框。
- `$TMPDIR/kodax-paste/` 目录新增 `paste-<hash>.png` 文件。
- LLM 给出 vision-based 回应。

### 失败排查

| 现象 | 诊断 |
|------|------|
| Cmd+V 后输入框空白（bracketed paste empty 但没 clipboard read） | (a) terminal 没启 DEC 2004（`KeypressContext.tsx:134` 是否正常 install），(b) `readClipboardImage` 失败 — 查 stderr |
| `osascript` 报错 | clipboard 不含 PNG（用户复制的是文本 / RTF / 其他格式）；这是预期的 silent noop |
| 多个 `paste-<uuid>.png` 文件（旧版 randomUUID 行为） | v0.7.40 修复了——所有 paste 文件名应该是 `paste-<sha256[:16]>.png`，相同内容复用同一路径 |

---

## Test 4 — Source 4 / Windows Alt+V explicit clipboard image

> **只在 Windows 测试。** Ctrl+V 是 cmd/conhost 自身 paste 快捷键，所以 KodaX 让位用 Alt+V。

### 步骤

1. Windows 任意截图工具（Win+Shift+S / Snipping Tool）截图到 clipboard。
2. 启 KodaX。
3. 按 Alt+V。
4. 触发 `triggerExplicitClipboardImage`，调 `powershell Get-Clipboard -Format Image` 拿 binary → jimp 规一 → 写文件 → 注入 pill。
5. 输入文字描述 + Enter。

### 期望结果

- Alt+V 立刻看到 `[Image #1]` pill。
- LLM 给 vision 回应。

### **Test 4b — Alt+V autorepeat 单击多发不产生重复文件**

> **关键回归测试** —— v0.7.40 RC 阶段的 P0 bug。

#### 步骤

1. **清空** paste tmp 目录：`rm -rf $TMPDIR/kodax-paste/*` 或 Windows `del %TMP%\kodax-paste\*` 或 PowerShell `Remove-Item $env:TEMP\kodax-paste\* -Force -ErrorAction SilentlyContinue`。
2. 用 Snipping Tool 截一张图到 clipboard。
3. 启 KodaX。
4. 按 Alt+V **一次**（短按即可，OS-level autorepeat 可能在毫秒级触发多次事件）。
5. 检查 `$TMPDIR/kodax-paste/` 文件数。

#### 期望结果

- 目录里**正好一个**文件 `paste-<sha256[:16]>.png`。
- 不是 N 个 `paste-<uuid>.png`。
- 输入框只显示一个 `[Image #1]` pill，不是 N 个。

#### 失败排查

| 现象 | 诊断 |
|------|------|
| 目录里多个 `paste-<sha256>.png` 但不同 hash | clipboard 内容在每次 read 之间变了（不太可能）；或 `persistImageAsBlock` 没走 `createHash` 路径 |
| 目录里 1 个文件但输入框多个 pill | inflight guard 没拦截好；或 `insert()` 被调多次但 path 相同 |
| 目录里 0 个文件 | clipboard 读失败；查 stderr 是否有 `[KodaX clipboard] image handling failed: ...` |

### **Test 4c — 同一截图反复 Alt+V 仍只一个文件**

1. 同上，clipboard 里有同一张截图。
2. 按 Alt+V，等 pill 出现。
3. 删除输入框里的 pill 文本（或不删）。
4. 再按 Alt+V 一次。
5. 检查 `$TMPDIR/kodax-paste/` 文件数。

#### 期望结果

- 仍然**正好一个**文件（内容相同的 clipboard 数据，sha256 相同，写文件 idempotent overwrite）。

---

## Test 5 — Source 5 / macOS / Linux Ctrl+V backup

> macOS/Linux 用 Ctrl+V 作为 explicit fallback；macOS Cmd+V 已经 source 3 覆盖。

### 步骤

1. 复制截图到 clipboard（macOS Cmd+Shift+4，Linux Wayland 截图工具如 `grim` + `wl-copy` 或 X11 用 `xclip`）。
2. 启 KodaX。
3. 按 Ctrl+V。
4. 同 Test 4 期望。

### 期望结果

- Linux Wayland：`wl-paste --type image/png` 拿到 binary。
- Linux X11：fallback 到 `xclip -selection clipboard -t image/png -o`。
- macOS：osascript NSPasteboard read。

---

## Test 6 — Vision 不支持的 provider 错误清晰

### 步骤

1. 设置 provider 切到 `gemini-cli`（CLI bridge，flag 仍是 `'none'`）。
2. 粘贴一张截图。
3. 应该看到 `[Provider Policy] multimodal requests are unsupported on this provider` 或 provider 自己的 API error。

### 期望结果

- 不是 silent drop。
- 用户能立刻知道当前 provider 不支持 vision。
- 切回 `anthropic` / `kimi-code` 后同截图能正常工作。

---

## Test 7 — Custom provider 开启 vision

### 步骤

1. 编辑 `~/.kodax/settings.json`，加一个自定义 provider 配置（示例 OpenAI-compat vision-capable model）：
   ```json
   {
     "customProviders": [
       {
         "name": "my-vision-provider",
         "protocol": "openai",
         "baseUrl": "https://api.example.com/v1",
         "apiKeyEnv": "MY_PROVIDER_KEY",
         "model": "my-vision-model",
         "capabilityProfile": {
           "transport": "native-api",
           "conversationSemantics": "full-history",
           "mcpSupport": "none",
           "contextFidelity": "full",
           "toolCallingFidelity": "full",
           "sessionSupport": "full",
           "longRunningSupport": "full",
           "multimodalSupport": "image-input",
           "evidenceSupport": "full"
         }
       }
     ]
   }
   ```
2. 设环境变量 `MY_PROVIDER_KEY=...`。
3. 启 KodaX，切到 `/provider my-vision-provider`，粘贴截图。
4. Vision 走 OpenAI-compat `image_url` 序列化路径，发往 your endpoint。

### 期望结果

- 不报 `[Provider Policy] multimodal requests are unsupported`。
- 序列化走 `openai.ts:904` `image_url` 路径（protocol: 'openai'）或 `anthropic.ts:770` `image` block（protocol: 'anthropic'）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 仍报 multimodal-unsupported | `capabilityProfile.multimodalSupport` 字段拼写错或被覆盖；或 custom-provider 没正确 register 走自己的 capabilityProfile（验 `getProviderConfiguredCapabilityProfile('my-vision-provider')`） |

---

## Test 8 — orphan pill 清理（删 pill 文本后磁盘文件能 GC）

> v0.7.40 实现：当用户在输入框删掉 `[Image #N]` 文本，下次提交时 KodaX 会扫一遍 prompt 文本里**实际引用的** image refs，没引用的 `inputArtifacts` 不进 message —— 但磁盘文件本身**不会** 主动 GC（OS-level tmpdir cleanup 处理）。本测验证 message 层 GC，不验磁盘 GC。

### 步骤

1. 粘贴 2 张截图（Source 3/4/5 任一），输入框显示 `[Image #1] [Image #2] 描述这两张图`。
2. 手动删 `[Image #2]`，保留 `[Image #1] 描述这张图`。
3. Enter 发送。
4. 实际发给 LLM 的 user message 应只含 1 个 image block（不是 2 个）。

### 期望结果

- LLM 回应只描述 1 张图。
- 磁盘上 2 个 `paste-<hash>.png` 都还在（不删——下次启动 OS 可能清 tmpdir）。

---

## Test 9 — 大图自动 jimp resize

### 步骤

1. 准备一张 5MB+ 的 PNG（4K 截图或更大）。
2. paste 进 KodaX。
3. jimp 应该 clamp 到 MAX_DIMENSION = 2000px 长边 + PNG/JPEG ladder 压到 TARGET_RAW_SIZE_BYTES ≈ 3.75MB。
4. 写到 disk 的文件应该 <4MB。

### 期望结果

- 没 `ImageResizeError`（除非源图极端大且 JPEG q40 还放不下）。
- LLM 仍能识别（适度压缩对 vision recognition 几乎无影响）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `ImageResizeError: Image still exceeds budget after PNG and JPEG q40 compression` | 源图过大，重新截一张小区域 |
| jimp decode 失败 | 不支持的格式（HEIC / SVG / 动画 GIF 第一帧之外）；只支持 PNG / JPEG / BMP / GIF static / WebP |

---

## 自动化测试覆盖

| 文件 | 覆盖范围 |
|---|---|
| `packages/repl/src/paste/persist-image.test.ts` | content-hash filename dedup（v0.7.40 新增 5 tests）|
| `packages/repl/src/paste/clipboard-image.test.ts` | 跨平台 clipboard reader 接口 |
| `packages/repl/src/paste/image-normalize.test.ts` | jimp dimension clamp + JPEG ladder（7 tests）|
| `packages/repl/src/paste/paste-handler.test.ts` | 5-source orchestration（14 tests）|
| `packages/repl/src/paste/bracketed-paste-mode.test.ts` | DEC 2004 lifecycle |
| `packages/repl/src/ui/utils/prompt-input-controller.test.ts` | Alt+V autorepeat single-flight guard（v0.7.40 新增）+ Ctrl+V / Alt+V 触发路径 |
| `packages/ai/src/providers/capability-profile.test.ts` | 11 vision-capable providers + 2 CLI-bridge text-only providers pin test（v0.7.40 新增）|
