# FEATURE_116 v0.7.37 — Active Cache Control 人测指引

> **目的**：验证 prompt cache 在真实 Anthropic-compat provider 上工作；OpenAI-compat / ACP CLI bridge 路径无副作用回归。
>
> **前置**：
> - 至少一个有效 Anthropic-compat API key（`ANTHROPIC_API_KEY` / `KIMI_API_KEY` for kimi-code / `ZHIPU_API_KEY` for zhipu-coding / `MIMO_CODING_API_KEY` / `MINIMAX_CODING_API_KEY` / `ARK_CODING_API_KEY`）
> - KodaX v0.7.37 已构建（`npm run build`）

---

## Test 1 — Anthropic-compat 路径 cache 命中（核心收益验证）

### 设置

```bash
export ANTHROPIC_API_KEY=sk-ant-...
unset KODAX_DISABLE_PROMPT_CACHE   # 默认开启
```

### 步骤

1. 启 KodaX：`./bin/kodax.mjs` 或 `npm run dev`
2. 选 anthropic provider（默认 zhipu-coding，可 `/model anthropic` 切换）
3. **Turn 1**（cold cache）：发任意问题，例如 `"列出 packages/ 目录下的所有包"`
4. 等响应完成后输入 `/cost`，**记下** `Cache: ... write` 数值（应为正数，~10k tokens 量级；read 应为 0）
5. **Turn 2**（warm cache，5 min TTL 内）：发第二个问题，例如 `"刚才列出的包里 ai 包是干什么的？"`
6. `/cost`，**记下** read / write
7. **Turn 3-5**：继续问 3 个相关问题（保持 5 min 内）
8. `/cost` 最后一次

### 期望结果

| Turn | cacheReadTokens | cacheWriteTokens | 累积 cacheHitRate |
|------|-----------------|------------------|-------------------|
| 1    | 0               | ~10,000          | 0%                |
| 2    | ~10,000         | 0 或少量         | ~50%              |
| 3-5  | ~10,000 each    | 0 或少量         | **≥ 70%**         |

`/cost` 末尾输出形如：
```
Cache: 50,000 tokens (40,000 read / 10,000 write, 80% hit rate)
```

**通过门**：第 5 turn 累积 cacheHitRate ≥ 70%。

### 失败排查

| 现象 | 诊断 |
|------|------|
| `Cache:` 行缺失 | 该 provider 不返回 cache_creation/cache_read_input_tokens；不是 FEATURE_116 bug |
| read 一直为 0 | turn 间隔 > 5 min（Anthropic ephemeral TTL 已过期）；或 system prompt 在 turn 间被改动；或 `KODAX_DISABLE_PROMPT_CACHE=1` |
| 抛错 `cache-boundary marker reached system message serialization` | Phase 1.4+ 加的某条 caller 路径漏 lower——不应出现在 v1，看错误 stack 定位 |

---

## Test 2 — Anthropic-compat coding-plan 子类（zhipu-coding / kimi-code / 等）

### 设置

```bash
export ZHIPU_API_KEY=...   # 或 KIMI_API_KEY / MIMO_CODING_API_KEY / MINIMAX_CODING_API_KEY / ARK_CODING_API_KEY
```

### 步骤

同 Test 1，但 provider 切到对应 coding-plan：`/model zhipu-coding`（或 kimi-code / mimo-coding / minimax-coding / ark-coding）。

### 期望结果

第三方 Anthropic-compat 网关**可能**：
- 返 cache_creation / cache_read 字段（zhipu-coding 实测会）→ 与 Test 1 同期望
- 不返这两个字段（部分 gateway 不实现）→ `Cache:` 行**缺失**也算通过（不算 FEATURE_116 bug）

**通过门**：无 build / runtime 错误；如返字段则 hit rate 趋势同 Test 1。

---

## Test 3 — OpenAI-compat 路径 strip（无副作用回归）

### 设置

```bash
export OPENAI_API_KEY=sk-...   # 或 DEEPSEEK_API_KEY / KIMI_API_KEY / QWEN_API_KEY / ZHIPU_API_KEY
```

### 步骤

1. `/model openai`（或 deepseek / kimi / qwen / zhipu）
2. 发 3 个问题
3. `/cost`

### 期望结果

- 不抛错
- 响应正常
- `Cache:` 行如果出现（OpenAI / DeepSeek 自动 prefix-cache），数据应 monotonically 上升
- 如果 `Cache:` 行不出现也算通过（部分 gateway 不返 prompt_tokens_details.cached_tokens）

**通过门**：无 typecheck / runtime 错误；功能性 chat / tool 调用一切正常。

---

## Test 4 — ACP CLI bridge 路径（gemini-cli / codex-cli）

### 步骤

1. `/model gemini-cli`（前置：本地装了 `gemini` CLI）
2. 发问 → 期待正常响应
3. `/model codex-cli`（前置：本地装了 `codex` CLI）
4. 发问 → 期待正常响应

### 期望结果

- 子进程启动正常
- prompt 文本正常传递（不应见到 `[object Object]` 或 `cache-boundary` 字样进入 CLI input）
- 响应正常返回

**通过门**：CLI bridge 启动 + 运行无 regression。

---

## Test 5 — Escape hatch（紧急回滚）

### 设置

```bash
export KODAX_DISABLE_PROMPT_CACHE=1
```

### 步骤

1. 重启 KodaX
2. `/model anthropic`
3. 发 3 个问题
4. `/cost`

### 期望结果

- `Cache:` 行的 read 列在多 turn 后仍为 0 或极低（cache 被禁用，turn 间无复用）
- 功能性所有 chat / tool 调用一切正常

**通过门**：env var 设置后 cache 不工作（read=0），其他功能不退化。

### 取消禁用

```bash
unset KODAX_DISABLE_PROMPT_CACHE
```

---

## 回归 checklist（每次 ship 必跑）

- [ ] Test 1 anthropic：cacheHitRate ≥ 70% by turn 5（5 min 内）
- [ ] Test 2 zhipu-coding：基础响应 OK + 如有 cache 字段则 hit rate 上升
- [ ] Test 3 openai / deepseek：无 typecheck / runtime 错误
- [ ] Test 4 gemini-cli / codex-cli：CLI bridge 正常
- [ ] Test 5 escape hatch：`KODAX_DISABLE_PROMPT_CACHE=1` 完全禁用 cache
- [ ] `npm run test` / `npm run build` 全绿（CI 自动跑）
- [ ] `npm run test:eval -- tests/feature-116-active-cache-control.eval.ts` 全绿（CI 自动跑）

---

## 已知限制 / 不在本版本

- **不**集成 Kimi / Zhipu OpenAI-compat 路径的 cache_id 端点 → 留 v0.7.45+ 与 FEATURE_102 一起做
- **不**做 caller 端显式 boundary 切分（v1 整段 system / 整段 tools 当作单一 cache prefix）→ 未来真有精细化需求时改 stream() signature 跨层做
- **不**优化 child agent cache → FEATURE_117 v0.7.38 read-path stripping 是另一维度
- TTL 由 provider 决定（Anthropic ephemeral 5 min）；超出窗口必然 miss，不算 acceptance 失败
