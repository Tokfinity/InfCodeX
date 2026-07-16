# FEATURE_191 v0.7.43 — User-Authored Custom Agents 人测指引

> **目的**：验证 (1) markdown agent loader (Phase B) — 用户 `.md` 文件能注册为可调度的 specialist；(2) extension `registerAgent` API (Phase C) — 第三方 extension 能 contribute specialist；(3) `dispatch_child_task(subagent_type=...)` (Phase A) — Worker 能派遣 specialist child；(4) Source provenance — `/agents` 类查询能区分来源。
>
> **前置**：
> - KodaX v0.7.43 已构建（`npm run build`）
> - 测试在任意 git 仓库下做（KodaX 自身仓库即可）
> - Smoke eval 部分需要至少一个 coding-plan provider key（ARK / ZHIPU / KIMI / MMX 任一）

---

## Test 1 — Markdown agent loader (Phase B)

### 步骤

1. 创建 user-level agent 定义：

   ```bash
   mkdir -p ~/.kodax/agents
   cat > ~/.kodax/agents/db-reviewer.md <<'EOF'
   ---
   name: db-reviewer
   description: Reviews DB migrations for safety and best practices
   tools: [read, grep]
   ---
   You are a DB migration reviewer. Focus on:
   - Locking behavior under concurrent writes
   - Default value backfill cost on large tables
   - Index creation impact
   EOF
   ```

2. 在 KodaX 仓库根目录创建 project-level agent（同名覆盖 user-level）：

   ```bash
   mkdir -p .kodax/agents
   cat > .kodax/agents/db-reviewer.md <<'EOF'
   ---
   name: db-reviewer
   description: Project-specific DB migration reviewer (PostgreSQL + Supabase)
   tools: [read, grep, bash]
   ---
   You are a PostgreSQL + Supabase migration reviewer (project override).
   EOF
   ```

3. 启动 REPL（`npm start` 或 `npx kodax`）。

### 期望结果

- **Test 1.1** — boot banner / 日志显示已加载 markdown agents（v0.7.43 没有 `/agents list` slash surface — 用以下 node REPL 验证）：

  ```bash
  cd <your-repo>
  node --input-type=module --eval "
    const repl = await import('@kodax-ai/repl/dist/common/construction-bootstrap.js');
    const coding = await import('@kodax-ai/coding');
    await repl.bootstrapConstructionRuntime(process.cwd());
    // listConstructedAgents() is the public top-level reader. The
    // source-aware variant lives on the @internal construction sub-
    // barrel and is not part of the v0.7.43 SDK surface (see
    // FEATURE_191 design doc + SDK_EMBEDDER_GUIDE §8 boundary note).
    const agents = coding.listConstructedAgents();
    console.log(JSON.stringify(agents.map(a => ({name: a.name, description: a.description})), null, 2));
  "
  ```

- 期望输出包含：

  ```json
  [
    { "name": "db-reviewer", "description": "Project-specific DB migration reviewer (PostgreSQL + Supabase)" }
  ]
  ```

  （**project 覆盖 user**：description 显示 project-level 字面值而非 user-level，证明 last-write-wins 实现 precedence 正确。source tag 本身的 6 个 enum value 由 `agent-resolver.test.ts` 的 7 个 B.3 单元测试覆盖。）

### 失败排查

| 现象 | 诊断 |
|---|---|
| `listConstructedAgents()` 返回 `[]` | bootstrapConstructionRuntime 未被调用；检查 InkREPL 启动路径或手动调 `bootstrapConstructionRuntime(cwd)`. |
| description 显示 user-level 字面值而非 project-level | last-write-wins 失效；检查 markdown-loader.ts 的加载顺序（user 必须先于 project）. |
| boot 输出含 `markdownFailures: [...]` | frontmatter 缺 `description` 或 body 为空；检查 .md 文件 frontmatter. |

---

## Test 2 — Frontmatter validation

### 步骤

1. 创建一个**无 frontmatter** 的 reference doc：
   ```bash
   cat > ~/.kodax/agents/just-notes.md <<'EOF'
   # Some Personal Notes
   This is a reference doc, not an agent.
   EOF
   ```

2. 创建一个**缺 description** 的 agent：
   ```bash
   cat > ~/.kodax/agents/no-desc.md <<'EOF'
   ---
   name: no-desc
   ---
   body without description
   EOF
   ```

3. 启动 REPL 并查看 boot 日志（或用 Test 1 的 node snippet 检查 `markdownFailures`）。

### 期望结果

- `just-notes.md` — **silent skip**（不进 failed[]，不会注册）。这是 claudecode 兼容行为：无 frontmatter 的 `.md` 视为 reference doc。
- `no-desc.md` — **进 markdownFailures**，reason 包含 `description.*required`。

---

## Test 3 — Extension registerAgent (Phase C)

### 步骤

1. 创建一个测试 extension：

   ```bash
   mkdir -p /tmp/kodax-test-ext
   cat > /tmp/kodax-test-ext/ext.mjs <<'EOF'
   export default async function(api) {
     await api.registerAgent('python-reviewer', {
       instructions: 'You review Python code for PEP-8 + type hints.',
       description: 'Python code reviewer (PEP-8 + type hints)',
       tools: [{ ref: 'builtin:read' }, { ref: 'builtin:grep' }],
     });
   }
   EOF
   ```

2. 在一个测试脚本中加载 extension：

   ```bash
   cd <KodaX root>
   node --input-type=module --eval "
     const { createExtensionRuntime, listConstructedAgents } = await import('@kodax-ai/coding');
     const runtime = createExtensionRuntime().activate();
     await runtime.loadExtension('/tmp/kodax-test-ext/ext.mjs');
     console.log('agents:', listConstructedAgents().map(a => a.name));
     await runtime.dispose();
     console.log('after dispose:', listConstructedAgents().map(a => a.name));
   "
   ```

### 期望结果

- `agents: ['python-reviewer']`
- `after dispose: []`（auto-unregister 通过 disposables chain 触发）
- source tag = `'extension'` 由 `runtime.test.ts` FEATURE_191 registerAgent suite 的 4 个测试覆盖（包含 source 验证 + 自动 unregister + 手动 dispose + admission 拒绝）。`resolveConstructedAgentSource()` 是 `@internal` 不通过 top-level SDK 暴露 — 见 SDK_EMBEDDER_GUIDE §8 boundary note。

### 失败排查

| 现象 | 诊断 |
|---|---|
| activate 阶段 throw | admission 拒绝 — 看错误信息；常见原因：`declaredInvariants` 含未知 id，或 tools ref 格式错误. |
| dispose 后 agent 仍在 registry | disposables.push 未触发；检查 `runtime.ts:registerAgent` 是否把 dispose 加入 disposables array. |

---

## Test 4 — Dispatch with subagent_type (Phase A)

### 步骤

1. 注册一个 db-reviewer agent（用 Test 1 的 markdown 方法）。

2. 启动 REPL 并用一个明确触发 db-reviewer 的 prompt：

   ```
   > Review this PR: it adds a migration that ALTERs a 50M-row table to add a NOT NULL column with a default. The migration runs synchronously during deploy.
   ```

3. 观察 Worker 是否派遣 `dispatch_child_task` with `subagent_type='db-reviewer'`。

### 期望结果

- Worker SP 包含 `=== Available specialist agents ===` block（含 `db-reviewer: Reviews DB migrations for safety and best practices`）。
- Worker 在 `dispatch_child_task` 调用里带 `subagent_type='db-reviewer'` 参数（≥60% 的概率，根据 panel eval）。
- Child 用 db-reviewer 的 `instructions` 启动（不是默认 `CHILD_AGENT_SYSTEM_PROMPT`）。
- Child 的 tool 白名单收窄到 db-reviewer 声明的 `[read, grep]`（其它 tool 走 excludeTools 互补排除）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| Worker SP 不含 `=== Available specialist agents ===` | `listConstructedAgents()` 返回空，或 `prompts/capability-sections.ts:buildSpecialistAgentsBlock` 未生效. |
| Worker dispatch 不带 `subagent_type` | 模型可能 floor — 跑 `feature-191-dispatch-specialist-panel.eval.ts` 看各 alias rate. |
| Child 用了默认 prompt 而不是 specialist instructions | `child-executor.ts:resolveSpecialistOverride` 未 wire，或 bundle.specialistName 没透传. |

---

## Test 5 — Unknown subagent_type guard

### 步骤

1. 不注册任何 specialist。
2. 在 REPL 手动调（或用 mock 测试）`dispatch_child_task({subagent_type: 'nonexistent-agent', objective: '...'})`.

### 期望结果

- Tool 返回错误（不 throw）：`[Error] specialist "nonexistent-agent" not registered. Available: (none)`
- 不会 silently fall through 到 anonymous child（这会让 Worker 不知道 specialist 没注册）。

---

## Test 6 — Specialist write-child role gate

### 步骤

1. 注册一个 `tools: [read, grep, write, edit]` 的 specialist（write-capable）。
2. 在一个 non-Generator role（例如 Scout）下调 `dispatch_child_task(subagent_type=...)`.

### 期望结果

- Tool 返回错误：`[Error] specialist "<name>" is a write agent but current role "scout" cannot dispatch write children. Switch to Worker/Generator role first.`
- 不会 silently drop bundle（这会让 Worker 以为 child 在跑但实际没派出去）。

---

## Test 7 — task_output 含 specialistName

### 步骤

1. 派遣一个 specialist child（用 Test 4 的 setup）.
2. 在 child 跑的时候调 `task_output(child_id)`.

### 期望结果

- 返回的 ChildProgressSnapshot 含 `specialistName: 'db-reviewer'` 字段（非 undefined）。
- 事后 dispatch trace dump（若 `KODAX_DISPATCH_TRACE_DIR` 设置）含 `specialistName` 字段。

---

## Smoke eval（可选 — 自动化覆盖）

```bash
# Pilot — 1 alias × 4 case × 1 run，~$0.10
KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-pilot

# Full panel — 5 alias × 4 case × 5 run = 100 cells，~$5
KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-panel

# Judge audit — 3-judge majority on panel dump，~$2
KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-judge-audit
```

SHIP gate (pre-registered):
- (a) C1 each alias dispatch w/ `subagent_type='db-reviewer'` ≥60%
- (b) C3 each alias false-name dispatch ≤10%
- (c) C4 each alias correct `subagent_type` ≥50%
- (d) audit disagreement ≤10% → DATA VALID
- (e) 4-of-5 alias hard fail（kimi C1 floor 允许 single-alias DEFER）

---

## 清理

```bash
rm -rf ~/.kodax/agents/db-reviewer.md ~/.kodax/agents/just-notes.md ~/.kodax/agents/no-desc.md
rm -rf <repo>/.kodax/agents/db-reviewer.md
rm -rf /tmp/kodax-test-ext
```
