# FEATURE_117 v2 v0.7.38 — Write-Child Mutation Context Injection 人测指引

> **目的**：验证 (1) write child（H2 Generator fan-out）的 system prompt 包含项目 AGENTS.md 的 mutation policy；(2) read child（Scout / 其他 read-only 派发）的 system prompt **不含** AGENTS.md（保持 minimal）；(3) `agents-loader.ts` 不再 fallback 到 `CLAUDE.md`（仅读 `AGENTS.md`）。
>
> **前置**：
> - 任意可用 provider API key（推荐 Anthropic / kimi-code / zhipu-coding）
> - KodaX v0.7.38 已构建（`npm run build`）
> - 本指引在 KodaX 自身仓库下做（已有 `AGENTS.md`，无独立 `CLAUDE.md` 但有 `docs/CLAUDE.md`）

---

## Test 1 — Write child 注入 AGENTS.md（核心收益验证）

### 设置

确保 `${gitRoot}/AGENTS.md` 存在。在 KodaX 仓库可直接用根目录 `AGENTS.md`。如果在新仓库测，先创建一个：

```bash
echo "# Project Rules

- ❌ NEVER use \`any\` type
- ❌ NEVER hardcode config (use env vars)
- ✅ All commits use conventional format" > AGENTS.md
```

### 步骤

1. 启 KodaX。
2. 发一个**显式触发 H2 Generator + write fan-out** 的复杂 mutation 任务。在 KodaX 自身仓库示例：
   ```
   重构 packages/ai/src/anthropic.ts 和 packages/ai/src/openai.ts，
   把它们的 retry 逻辑提取到一个共享 helper。请并行处理这两个文件，
   每个文件用独立的 child agent。
   ```
3. 观察：Scout → Generator → child fan-out（worktree 写）流程。
4. 进入 child 工作的 worktree（路径在 transcript 里报，类似 `~/.kodax/worktrees/...`），或在主 transcript 里观察 child 的 system prompt 输出（如开了 verbose / debug log）。

### 期望结果

- 每个 write child 的 system prompt 应包含：
  - 基础 `CHILD_AGENT_SYSTEM_PROMPT`（"You are a focused sub-agent..." 起头）
  - 紧接的 framing 句 `Project rules apply to your mutations. Follow them as the parent agent would:`
  - `formatAgentsForPrompt` 输出的 `# Project Context` H1 块（含每份 AGENTS.md 的全文，按 directory/global/project scope 标注）
- write child 在 worktree 内的实际产出**遵守 AGENTS.md 规则**（例如不用 `any` 类型 / 不 hardcode config / commit message 用 conventional 格式）。
- read child（Scout 探查阶段，如无 AGENTS.md 注入）行为不变。

### 失败排查

| 现象 | 诊断 |
|------|------|
| write child 写出违反 AGENTS.md 的代码（`any` / `console.log` / hardcoded config） | system prompt 没注入，看 `child-executor.ts:executeWriteChild` 的 `systemPromptOverride` 行 |
| `Mutation Policy` 块出现在 read child 的 prompt 里 | read path 误装载，看 `executeReadChild`（应仍是 `CHILD_AGENT_SYSTEM_PROMPT` 字面量） |

---

## Test 2 — 无 AGENTS.md 仓库的 fallback（read 仓库 / 临时仓库）

### 设置

```bash
mkdir /tmp/kodax-test-noagents && cd /tmp/kodax-test-noagents
git init
echo "console.log('hello')" > index.js
git add . && git commit -m "init"
```

确保**不创建** `AGENTS.md`。

### 步骤

1. 在 `/tmp/kodax-test-noagents` 下启 KodaX：`kodax`（或绝对路径调本地 build）。
2. 发一个 write fan-out 任务：
   ```
   把 index.js 改成一个简单的 HTTP server，并在另一个文件 server.test.js
   写测试。请并行处理。
   ```
3. 观察 write child 的 system prompt（debug log / verbose）。

### 期望结果

- write child 的 `systemPromptOverride` **完全等于** `CHILD_AGENT_SYSTEM_PROMPT`（无 framing 句、无 `# Project Context` 块）。
- child 仍然能完成任务（write children 在无 AGENTS.md 时不退化）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| 看到空的 `## Mutation Policy` 块 | `formatAgentsForPrompt([])` 应返回 `''`；如果返回 `\n---\n` 之类则需修 |
| 抛错 "Cannot read AGENTS.md" | `loadAgentsFiles` 应静默返回空数组而不是抛错；`statSync` 失败 → cache delete 路径 |

---

## Test 3 — KodaX 只读 AGENTS.md，不读 CLAUDE.md（配套清理）

### 设置

```bash
mkdir /tmp/kodax-test-claudemd && cd /tmp/kodax-test-claudemd
git init
echo "# Project Rules
- ❌ NEVER use any type
- THIS_IS_CLAUDE_MD_NOT_AGENTS_MD" > CLAUDE.md
# 注意：故意不创建 AGENTS.md
git add . && git commit -m "init"
```

### 步骤

1. 在 `/tmp/kodax-test-claudemd` 下启 KodaX。
2. 发任意 mutation 任务：`改 README，加个一行注释`。
3. 让 KodaX 完成任务。
4. 观察整个会话 system prompt（包括 worker / child 各层）。

### 期望结果

- **任何位置都不应出现** `THIS_IS_CLAUDE_MD_NOT_AGENTS_MD` sentinel。
- KodaX 行为如同没有任何 project rules（CLAUDE.md 被忽略）。
- 用户在产物中不会被强制约束遵循 CLAUDE.md 内容（因为 KodaX 没读它）。

### 反向验证

```bash
mv CLAUDE.md AGENTS.md
```

重新启 KodaX 发同一任务。这次应能看到 sentinel **出现在** worker / write child 的 system prompt 中（worker 通过 `capability-sections.ts` 的 `project-agents` section，write child 通过 v2 的 `Mutation Policy` 块）。

### 失败排查

| 现象 | 诊断 |
|------|------|
| sentinel 出现在 system prompt 里（即使没 AGENTS.md） | `agents-loader.ts:CONTEXT_FILE_CANDIDATES` 没改干净，仍含 `"CLAUDE.md"` |
| `mv CLAUDE.md AGENTS.md` 后仍找不到 | 检查 mtime cache 是否需要清（重启 KodaX 应该够，因为 cache 是进程内 module-singleton） |

---

## 回归 checklist（每次 ship 必跑）

- [ ] Test 1 write inject：write child 看到 AGENTS.md mutation policy，遵守项目规则
- [ ] Test 2 no AGENTS.md fallback：write child 在无 AGENTS.md 仓库不退化
- [ ] Test 3 CLAUDE.md isolation：CLAUDE.md 不被 KodaX 读取
- [ ] `npm run test -- packages/coding/src/child-executor.test.ts` 全绿（29 tests）
- [ ] `npm run build` 全绿

---

## 已知限制 / 不在本版本

- **不**给 read child 注入 AGENTS.md（read 不 mutate，规则不适用）
- **不**给 write child 注入 `.kodaxrc` / git status / project-snapshot（这些不是 mutation policy）
- **不**做 fine-grained per-rule injection（整段 AGENTS.md 注入，由 prompt cache 摊平成本）
- **不**改 worker (parent) 的 system prompt（v2 仅作用于 child path；worker 通过 `capability-sections.ts` 的 `project-agents` section 已有 AGENTS.md）
- **不**自动迁移用户的 `CLAUDE.md` → `AGENTS.md`（需用户手工 `mv` 或建 symlink）
- **不**把 CLAUDE.md fallback 留作 env-var escape hatch（清晰断点优于半遗留）
