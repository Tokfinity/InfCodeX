# FEATURE_121 v0.7.40 — Envelope Spillover Gap-Fix 人测指引

> **目的**：验证 (1) child task `<task-completed>` banner 不再 1600+200 chars 双层硬截断；(2) 单 banner >50KB 时自动 spill 到磁盘文件，banner 替换为 preview + spill path；(3) Worker 能用标准 Read 工具读 spill 文件拿全文；(4) idle-yield envelope 在 N 个 banner 聚合 >200KB 时强制 `forceSpill` 二次回收；(5) 当 `persistToolOutput` 失败（disk full / readonly / SELinux 拒写）且原始 content >100KB 时，自动调用 LLM blob summarizer fallback 输出 lossy 摘要，并带显式 `[SPILL FAILED — ...]` banner 提醒；(6) 当 summarizer 自身也失败时落到 inline emergency dump 路径并带 `[SPILL FAILED AND LLM SUMMARIZER FAILED]` banner。
>
> **前置**：
> - 任意可用 provider API key（推荐能跑较大输出的 model：claude-sonnet / kimi-k2.6 / glm-5）
> - KodaX v0.7.40 已构建（`npm run build`）
> - 默认 async dispatch 已启（`KODAX_ASYNC_DISPATCH` 未设置或非 `0`）
>
> **重要约定**：
> - 本指引以**实际观察 transcript + 临时文件**为主，eval gate（Layer 2 数据）由 `tests/feature-121-envelope-spillover.eval.ts` + `tests/feature-121-blob-summarizer.eval.ts` 覆盖。
> - spill 目录路径：`getAgentConfigPath('tool-results')` —— 默认 `~/.kodax/tool-results/`，可通过 `KODAX_HOME` 重定向。
> - 所有 banner 文案是 production 路径硬编码字符串，可用 `grep` 在 transcript dump 里搜索验证。

---

## Test 1 — 单 banner 内 spillover 路径

### 设置

任意可写工作目录，`AGENTS.md` 可选。

### 步骤

1. 启 KodaX。
2. 发一个**会让 child 产出 25-100KB 文本**的任务（典型场景：跨多文件 audit）：
   ```
   派一个 dispatch_child_task：审计 packages/coding/src 下所有 .ts 文件，
   对每个文件输出 4-8 行的风险摘要。task_id 用 audit-coding。
   ```
3. 等 child 完成（transcript 出现 `<task-completed task_id="audit-coding">…</task-completed>`）。
4. 观察 banner 内容：
   - 若 child 原始 summary <50KB：banner 包含完整 summary，没有 spill 标记。
   - 若 ≥50KB：banner 是 preview 头 + 类似 `[Tool output truncated. Full output available at: ~/.kodax/tool-results/<uuid>.txt — read with the Read tool]` 的 spill 提示。
5. 让 Worker 读 spill 文件拿完整内容：
   ```
   读一下刚才 audit-coding 的完整 spill 文件，挑 5 个最严重的风险展开。
   ```
6. Worker 应该调用 `Read` 工具读 `~/.kodax/tool-results/<uuid>.txt` 并基于全文回应。

### 期望结果

- transcript 里 `<task-completed>` block 不再被砍到 200 chars（v0.7.39 行为）。
- ≥50KB child output 自动走 spill；磁盘上能 `ls ~/.kodax/tool-results/` 看到对应 `.txt` 文件。
- Worker 拿 Read 工具读出来的内容完整、无截断。

### 失败排查

| 现象 | 诊断 |
|------|------|
| banner 仍然砍到 ~200 chars | `dispatch-child-tasks.ts:256` `slice(0, 200)` 没删干净；或 `orchestration.ts:1033` `truncateText(lastText, 1600)` 还在；或 `applyToolResultGuardrail('child_task_summary', ...)` 没接通 |
| ≥50KB 但没 spill | `applyToolResultGuardrail` 的 threshold 配置错；或 `persistToolOutput` 写文件失败被静默吞了——查 stderr 是否有 `[KodaX persistToolOutput] failed to spill: ...` warn |
| spill 文件存在但 Read 读不到 | spill path 在 banner 里的写法错（应该是绝对路径）；或 Read 工具被 protected-path veto 拦截（不应该，`~/.kodax/` 是 user-config 区 |

---

## Test 2 — Envelope 聚合 cap（200KB）

### 设置

需要让 Worker 一次性 idle-yield 收到多个 child 完成事件。

### 步骤

1. 启 KodaX。
2. 派**多个**并行 child，每个产出 ~80-100KB（让聚合 >200KB）：
   ```
   并行审计这 3 个目录：packages/coding/src / packages/repl/src / packages/agent/src。
   对每个目录派一个 dispatch_child_task，task_id 分别为 audit-coding / audit-repl / audit-agent。
   每个 child 必须输出至少 60 行风险摘要。
   ```
3. 等 3 个 child 都完成。
4. 检查 Worker idle-yield resume 时收到的 user message 总长度（transcript 里 `<idle-yield>` 或合成的 user message block）。
5. 应该看到至少一个原本未到 50KB threshold 的 banner 被**追加 spill**——因为聚合超 200KB envelope cap，`composeIdleYieldUserMessage` 调 `applyToolResultGuardrail(..., { forceSpill: true })` 把所有 banner 再过一遍。

### 期望结果

- 单次 idle-yield resume 注入给 Worker 的 user message 总 chars **不超过** ~200KB（claudecode `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS=200_000` parity）。
- 被 force-spill 的 banner 同样带 `[Tool output truncated. Full output available at: ...]` 提示，Worker 可按需 Read。

### 失败排查

| 现象 | 诊断 |
|------|------|
| user message 总长 >200KB | `composeIdleYieldUserMessage` 没执行 envelope cap；或 cap 阈值漂了；或 `forceSpill` flag 没生效 |
| 单 banner 还原状（不 spill） | per-banner threshold 已过但 envelope 没触发——这是设计行为，单 banner 不超 50KB 时不会因为聚合 cap 被砍 |

---

## Test 3 — Spill 失败 + LLM blob summarizer fallback

### 设置

需要人工触发 `persistToolOutput` 失败。两种方式任选：

- **方式 A（推荐）**：临时 chmod `~/.kodax/tool-results/` 为只读：
  ```bash
  chmod -w ~/.kodax/tool-results/
  ```
  测完恢复：
  ```bash
  chmod +w ~/.kodax/tool-results/
  ```
- **方式 B**：用 `KODAX_HOME` 指向一个只读路径。

### 步骤

1. 触发上面的设置之一，让 spill 必失败。
2. 启 KodaX。
3. 派一个**会输出 >100KB** 的 child（必要时让 child 多读几个大文件 + 详细摘要）：
   ```
   派 dispatch_child_task：详细 audit packages/coding/src 整个目录，
   每个文件输出 10 行风险摘要 + 3 行 mitigation 建议。task_id: audit-big。
   ```
4. 等 child 完成。检查 banner 内容应包含：
   ```
   [SPILL FAILED — original ${size} bytes compressed via LLM summarizer; raw content unavailable. Worker: treat this summary as LOSSY and re-run the upstream tool with narrower scope if you need verbatim detail.]
   ```
   后接 ~2-8KB 的 LLM 摘要（包含具体文件路径、行号、findings 的有损压缩）。
5. 让 Worker 基于这个 lossy 摘要回应：
   ```
   audit-big 拿到了一份 lossy 摘要。基于它列出 5 个最严重的风险，并指出哪些细节需要重跑 upstream。
   ```

### 期望结果

- banner 头部明确 `[SPILL FAILED — ...]` 标签，Worker 能识别这是 LOSSY 输入。
- 摘要保留具体 file path / line number / error code / identifier verbatim（不是 paraphrase）。
- 摘要长度在 2000-8000 chars 范围（默认 `maxChars: 8000`）。
- Worker 能基于摘要给出合理回应 + 提示需要重跑 upstream 拿 verbatim。

### 失败排查

| 现象 | 诊断 |
|------|------|
| banner 没有 `[SPILL FAILED]` 头但有完整 content inline | summarizer 没被调用——可能 (a) `ctx.summarizeBlob` 没注入（runner-driven memoize 路径断了），(b) content <100KB threshold 走 inline fallback 不调 summarizer |
| 完全没 banner，原始 content 整段 inline | spill 失败检测路径断了（`GuardedToolResult.spillFailed` flag 没回传），或 `applyChildSummaryGuardrailWithSummarizer` helper 没接通 |
| LLM summarizer 也失败（provider 超时 / abort） | 应落到 `[SPILL FAILED AND LLM SUMMARIZER FAILED — original ${size} inlined as last-resort emergency dump]` 路径（Test 4）|

---

## Test 4 — Summarizer 也失败的 emergency dump

### 设置

在 Test 3 设置基础上，**再**人为让 LLM summarizer 失败：临时把 provider 切到一个无效 API key 或断网。或者直接设置：
```bash
# 用一个不存在的 provider/model 让 summarize 走时立刻失败
export ANTHROPIC_API_KEY=invalid_test_key
```

### 步骤

1. 设置好双重失败环境。
2. 启 KodaX，派一个会 >100KB output 的 child。
3. Banner 应该包含：
   ```
   [SPILL FAILED AND LLM SUMMARIZER FAILED — original ${size} inlined as last-resort emergency dump. Worker should expect possible downstream context overflow and re-run upstream with narrower scope.]
   ```
4. 后接**完整原始 content**（不截断 —— 优先保留信息而非节省 token，符合 FEATURE_121 契约："silent data loss is the worst outcome"）。

### 期望结果

- emergency banner 字面正确，Worker 能看到信号。
- 完整 content 跟在 banner 后。
- Worker 不崩溃，不丢内容。

### 失败排查

| 现象 | 诊断 |
|------|------|
| banner 缺失，只有原始 content | `applyChildSummaryGuardrailWithSummarizer` 的双重 fallback 没接通；或 summarizer 失败时静默吞错没加 banner |
| Worker context overflow / 报 max_tokens | 这是设计接受的代价（"over-budget but observable is acceptable"），用户应根据 banner 指示重跑 upstream |

---

## Test 5 — 行为对照 v0.7.39 基线

在不同 commit 上各跑一遍 Test 1，对比观察 v0.7.40 是否真的解决了 silent data loss：

- `git checkout v0.7.39` → 跑 Test 1 步骤 → 应该看到 banner 被砍到 ~200 chars（旧的 silent loss bug）
- `git checkout v0.7.40` → 跑 Test 1 步骤 → 应该看到 spill or full banner

跑完 `git checkout KodaX` 回 head。

---

## 自动化 eval 覆盖

| Eval 文件 | 覆盖范围 |
|---|---|
| `tests/feature-121-envelope-spillover.eval.ts` | 3 cases：`preview_sufficient` / `detail_required` / `inline_no_spillover` — 跨 4 alias × 5 runs，验 Worker 是否会按 banner 提示用 Read 拿 spill 详情 |
| `tests/feature-121-blob-summarizer.eval.ts` | 2 cases：`audit_report` / `grep_findings` — 验 LLM summarizer 在 disk-full 模拟下保留 file path / line / identifier verbatim 的能力（per `KODAX_EVAL_F121_SUMMARIZER=1` gated）|
