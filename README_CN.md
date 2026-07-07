<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" alt="KodaX" width="640">
  </picture>
</p>

<p align="center">
  <b>开源 AI Coding Agent，跑你能拿到的任何 LLM。</b><br>
  Anthropic · OpenAI · DeepSeek · Kimi · 智谱 · MiniMax · 小米 MiMo · 火山方舟 · Qwen · Gemini · Codex<br>
  REPL · CLI · 库 · 免 Node 单文件二进制
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kodax-ai/kodax"><img alt="npm version" src="https://img.shields.io/npm/v/@kodax-ai/kodax?style=flat-square&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  <a href="https://github.com/icetomoyo/KodaX/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/icetomoyo/KodaX?style=flat-square&logo=github&color=f1c40f"></a>
  <a href="https://github.com/icetomoyo/KodaX/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/icetomoyo/KodaX/release.yml?style=flat-square&label=release"></a>
  <img alt="providers" src="https://img.shields.io/badge/LLMs-15_aliases_+_custom-2ecc71?style=flat-square">
</p>

<p align="center">
  <a href="#30-秒上手">安装</a> ·
  <a href="#四种使用形态">使用形态</a> ·
  <a href="#为什么用-kodax">为什么用</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="docs/FEATURE_LIST.md">Roadmap</a> ·
  <a href="https://github.com/icetomoyo/KodaX/discussions">讨论</a> ·
  <a href="README.md">English README</a>
</p>

<p align="center">
  <img src="kodax-hd.gif" alt="KodaX 实战演示" width="880">
</p>

---

## 30 秒上手

```bash
npm i -g @kodax-ai/kodax

# 选一个你有 API key 的 provider
export ZHIPU_API_KEY=...        # 或 KIMI_API_KEY / MINIMAX_API_KEY / MIMO_API_KEY /
                                # ARK_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY /
                                # OPENAI_API_KEY / QWEN_API_KEY / GEMINI_API_KEY

kodax
```

就这样。进 REPL，自然语言提问。

> **不装 Node 的目标机器**：从 [GitHub Releases](https://github.com/icetomoyo/KodaX/releases) 拿 Bun 编译的单文件二进制（Win / macOS / Linux × x64 + arm64）。详见 [docs/release.md](docs/release.md)。

---

## 四种使用形态

| 形态 | 命令 / 入口 | 什么时候用 |
|---|---|---|
| **REPL** | `kodax` | 交互式多轮编码会话，流式 UI + 权限 + slash 命令 |
| **CLI** | `kodax -p "your task"` | 单次脚本任务、CI、批量处理 |
| **库** | `import { runKodaX } from '@kodax-ai/kodax'` | 嵌入你自己的工具 / agent / 服务 |
| **单文件二进制** | `./kodax` | 分发到没装 Node 的机器 |

---

## 为什么用 KodaX

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <h3>🇨🇳 6 家国内 LLM 原生</h3>
      <sub>智谱 · Kimi · MiniMax · 小米 MiMo · 火山方舟 · 通义千问</sub>
      <br><br>
      first-class 适配器，跨 provider 在 5-alias canonical panel 做过 <a href="benchmark/EVAL_GUIDELINES.md">prompt-eval 校准</a> —— 不是 OpenAI-compat 转发。
    </td>
    <td width="33%" align="center" valign="top">
      <h3>📦 单文件二进制</h3>
      <sub>Bun --compile · Win / macOS / Linux · x64 + arm64</sub>
      <br><br>
      目标机器不装 Node。一份文件随处跑 —— 受管环境、内网、CI runner、断网机器都行。
    </td>
    <td width="33%" align="center" valign="top">
      <h3>🌳 可分叉会话血缘</h3>
      <sub>fork · rewind · 并行编辑</sub>
      <br><br>
      对话历史是 DAG 不是链表。即将发布的 <b>KodaX Space</b> 桌面端基于此。
    </td>
  </tr>
  <tr>
    <td align="center" valign="top">
      <h3>🤖 默认多 agent</h3>
      <sub>V2 Worker 单循环 + Sidecar Verifier + 异步子 agent</sub>
      <br><br>
      <code>dispatch_child_task</code>、<code>send_message</code>、<code>task_stop</code>，多实例自动协调（content-hash safety net）。
    </td>
    <td align="center" valign="top">
      <h3>🧩 Skills + 自构造</h3>
      <sub>Markdown skill，自然语言触发</sub>
      <br><br>
      5 阶自改造阶梯（scaffold → validate → stage → test → activate），由 8 条 admission invariant 守护。
    </td>
    <td align="center" valign="top">
      <h3>🛠 50+ 内置工具</h3>
      <sub>文件 · shell · 搜索 · MCP · ACP</sub>
      <br><br>
      repo intelligence、语义搜索、git worktree、web fetch，统一从干净的 tool definition 接口暴露。
    </td>
  </tr>
</table>

## 同类产品对比

| 能力 | **KodaX** | Claude Code | Aider | Codex CLI | Cursor | Cline |
|---|---|---|---|---|---|---|
| 开源协议 | ✅ Apache&nbsp;2.0 | ❌ source-available | ✅ Apache&nbsp;2.0 | ✅ Apache&nbsp;2.0 | ❌ 闭源 | ✅ Apache&nbsp;2.0 |
| 免 Node 单文件 | ✅ Bun | ❌ 需 Node | ❌ 需 Python | ✅ Rust | ❌ Electron | ❌ 插件 |
| 国内 6 家原生<br><sub>（智谱·Kimi·MiniMax·MiMo·方舟·Qwen）</sub> | ✅ 6 家原生 | ❌ | ⚠ 走 LiteLLM | ❌ OpenAI 主线 | ❌ 无 provider 菜单 | ⚠ Kimi/Qwen/DeepSeek |
| 可分叉会话血缘 | ✅ fork & rewind | ⚠ routines/sessions | ❌ | ❌ | ❌ | ⚠ checkpoints |
| Multi-agent + MCP + 50+ 工具 | ✅ 三项全有 | ✅ 三项全有 | ⚠ 有 tools, 无 MCP | ✅ 三项全有 | ⚠ Composer + MCP | ✅ 三项全有 |

<sub>数据于 2026-05 对照官方公开文档核对（[Claude Code](https://github.com/anthropics/claude-code) · [Aider](https://aider.chat/docs/llms.html) · [Codex CLI](https://github.com/openai/codex) · [Cursor](https://cursor.com) · [Cline](https://github.com/cline/cline)）。⚠ 表示部分支持 / 需额外配置 / 非 first-class。欢迎 PR 修正。</sub>

## 详细配置

> 上面的 `npm i -g @kodax-ai/kodax` 一行就够了。下面这一节是给"从源码构建 / 接自定义 provider / 把 KodaX 当库使用"的场景。

### 1. 从源码构建

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

构建完成后就可以直接启动：

```bash
kodax
```

### 2. 配置模型提供商

最简单的方式是先设置 API Key：

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

然后在 `~/.kodax/config.json` 里写一个最小配置：

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

### 3. 启动 REPL 或执行单次任务

```bash
# 进入交互式 REPL
kodax

# 单次任务
kodax "Review this repository and summarize the architecture"
```

进入 REPL 后，你可以直接自然语言提问，也可以使用命令：

```text
/help
/mode
/agent-mode ama
```

### 4. 作为库使用

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    effort: 'auto',
  },
  'Explain this codebase'
);
```

#### SDK Subpath 导入（v0.7.39+）

如果只想用某个子能力，按 subpath 引入更轻量，bundler 也能更好地 tree-shake：

```typescript
import { Runner } from '@kodax-ai/kodax/agent';                // Agent runtime
import { getProvider } from '@kodax-ai/kodax/llm';              // LLM 抽象（15 个内置 alias）
import { runKodaX } from '@kodax-ai/kodax/coding';              // Coding tools + prompts
import { createImageArtifactFromPath } from '@kodax-ai/kodax/media'; // 输入 artifact helpers
import { SkillRegistry } from '@kodax-ai/kodax/skills';         // 零依赖 skill loader
import { loadConfig } from '@kodax-ai/kodax/repl';              // REPL 配置 / session 工具
import { createMcpManager } from '@kodax-ai/kodax/mcp';         // MCP popout manager（v0.7.42 起）
import { listSessions } from '@kodax-ai/kodax/session';         // session 历史工具
```

9 个 SDK 入口（root + 8 subpath）通过 ESM 共享 chunk 复用底层代码 —— 只 import `/agent` 不会把 `/repl` 的 Ink + React 一起拉进来。

> **SDK 是 ESM-only**。在 CommonJS 上下文（Electron main 进程、传统 Webpack CJS bundle、`require()` 调用方）必须用 `await import('@kodax-ai/kodax/...')` 代替 `require()`。详见 [docs/SDK_EMBEDDER_GUIDE.md §5](docs/SDK_EMBEDDER_GUIDE.md#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles)，含 Electron main 完整 recipe + 为什么大多数 subpath 物理上无法做 dual ESM/CJS bundle。

### 5. 自定义 Provider（OpenAI / Anthropic 兼容端点）

任何 OpenAI 或 Anthropic 协议兼容的 endpoint 都可以通过 `customProviders[]` 接入，CLI 模式写在 `~/.kodax/config.json` 里：

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model",
      "userAgentMode": "compat",
      "reasoning": {
        "efforts": ["off", "low", "medium", "high", "max"],
        "default": "high"
      }
    }
  ]
}
```

`userAgentMode` 默认 `"compat"`（发送 `KodaX` 而非上游 SDK 的 User-Agent）；如果你的网关要求原生 SDK header，再切到 `"sdk"`。

自定义 reasoning 模型优先使用 v0.7.57 的 `reasoning: { efforts, default }`；无 thinking 能力的模型使用 `"reasoning": "none"`。SDK 宿主的 effort 选择器应从 `reasoningProfile.supportedEfforts` / `defaultEffort` 动态生成，不要假定固定五档。

#### OpenAI 兼容推理模型

部分 OpenAI-compatible 推理模型要求多轮请求时回放上一轮 assistant 的 `reasoning_content`。DeepSeek V4 thinking mode 是已知必须开启的场景；内置 DeepSeek provider 已经默认开启，但自定义 provider 需要显式配置：

```json
{
  "customProviders": [
    {
      "name": "my-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "reasoningPreset": "deepseek-v4-openai",
      "replayReasoningContent": true
    }
  ]
}
```

如果网关同时代理 DeepSeek 和 OpenAI proper，建议用 per-model override，避免把 `reasoning_content` 发给不接受该字段的模型：

```json
{
  "models": [
    { "id": "deepseek-v4-flash", "replayReasoningContent": true },
    { "id": "gpt-5", "replayReasoningContent": false }
  ]
}
```

Sidecar verifier 的结构化裁决请求会优先使用 provider 级 `tool_choice` 强制工具调用；如果某个兼容端点明确拒绝 `tool_choice` 参数，KodaX 会对该 verifier 请求自动重试一次“不强制但仍带 tools”的兼容模式，并保持 fail-open，不会阻塞主 Worker。

调试 Worker 结束后的 verifier 行为时可设置：

```bash
export KODAX_VERIFIER_LOG=1
export KODAX_VERIFIER_PROVIDER=anthropic
export KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001
```

`KODAX_VERIFIER_LOG=1` 等价于在 `~/.kodax/config.json` 写 `"verifierLog": true`，会显示 verifier gate、elapsedMs 和 trace；`KODAX_VERIFIER_PROVIDER` / `KODAX_VERIFIER_MODEL` 需要成对设置，用独立模型执行 verifier；`KODAX_VERIFIER_ALWAYS=1` 仅建议调试和回归测试时使用。

SDK / headless 宿主可以通过 `KodaXEvents.onSidecarMessage` 观察 Sidecar
Verifier 的 `revise` / `blocked` 可执行消息；JSONL 输出使用同形
`sidecar.message` 事件。`accept` 仍保持静默。

#### 给自定义 provider 开图片 / vision 输入（FEATURE_134 v0.7.40）

如果你的自定义 provider 后面的模型支持 vision，加 `capabilityProfile.multimodalSupport: "image-input"` 显式开启，KodaX 的 SA-path policy gate 就不会人为拦截多模态请求。内置 vision-capable alias（Anthropic、OpenAI、DeepSeek、Kimi、Qwen、Zhipu、MiniMax、MiMo、Ark，以及通过 CLI `@<path>` file-include 语法传图的 Gemini-CLI）已经默认开了这个 flag。Codex-CLI 和自定义 provider 在底层模型支持图片输入时需要手动 opt-in。

```json
{
  "customProviders": [
    {
      "name": "my-vision-provider",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
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

序列化层（Anthropic-compat 走 `packages/llm/src/providers/anthropic.ts:770`，OpenAI-compat 走 `openai.ts:904`）通过基类继承自动转发 image block。这个 flag 只控制 KodaX 自身是否预先拒绝多模态请求 —— 上游模型到底支不支持 vision 由 provider 自己决定。如果模型实际是 text-only，你会看到真实的上游 API 错误，而不是 KodaX 一侧的 `[Provider Policy] multimodal requests are unsupported` 预拦截。

库模式下用 `registerCustomProviders()` 显式注册：

```typescript
import { registerCustomProviders, runKodaX } from '@kodax-ai/kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
    userAgentMode: 'compat',
  },
]);

await runKodaX({ provider: 'my-openai-compatible' }, '解释这个仓库');
```

### 6. 打包成单文件二进制（无需 Node）

KodaX 可以用 `bun --compile` 打包成单可执行文件 + 一个 `builtin/` sidecar 目录，目标机器**不需要安装 Node.js 或任何运行时**。

支持目标：`win-x64`、`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。Win7 / glibc < 2.27 的发行版 / 龙芯 LoongArch 暂不支持。

本地构建：

```bash
# 先在构建机器上装好 Bun（一次性）
npm i -g bun                  # 或 scoop / brew / curl，详见 docs/release.md

npm run build:binary          # 当前平台（最快）
npm run build:binary:all      # 一台机器出全部 5 个目标
node scripts/build-binary.mjs --target=linux-arm64   # 指定平台
```

产物在 `dist/binary/<target>/`：

```
dist/binary/linux-x64/
├── kodax              # ~60 MB Bun 编译的二进制
└── builtin/           # 内置 skills sidecar
```

冒烟验证：`dist/binary/<host>/kodax --version`。

**自动发布**：推送 `v*` git tag 会触发 `.github/workflows/release.yml`，在原生 runner 上构建全部 5 个目标、跑冒烟测试，然后自动创建 GitHub Release 并上传 archives + SHA256SUMS。也可以从 Actions UI 用 `workflow_dispatch` 不打 tag 跑流水线测试。

详细的构建参数、archive 结构、`KODAX_BUNDLED` / `KODAX_VERSION` build-time defines、故障排查，参见 [docs/release.md](docs/release.md)。

## 内置 Provider 列表

| Provider | 环境变量 | Reasoning | 默认 Model |
|----------|----------|-----------|-----------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6（可 `/model` 切换 `claude-opus-4-6` / `claude-haiku-4-5`） |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex（可 `/model` 切换 `gpt-5.4` / `gpt-5.3-codex-spark`） |
| kimi | `KIMI_API_KEY` | Native | kimi-k2.6（可 `/model` 切换 `kimi-k2.7-code` 256K / `k2.5`） |
| kimi-code | `KIMI_CODE_API_KEY` | Native | kimi-for-coding |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5（可 `/model` 切换 `glm-5.2` 1M ctx / `glm-5.1` / `glm-5-turbo`） |
| zhipu-coding | `ZHIPU_CODING_API_KEY` | Native | glm-5（GLM Coding Plan；可 `/model` 切换 `glm-5.2` 1M ctx / `glm-5.1` / `glm-5-turbo`） |
| zai-coding | `ZAI_CODING_API_KEY` | Native | glm-5.2（GLM Coding Plan 海外站，通过 `api.z.ai` 接入，Anthropic 协议 — 模型清单和 `zhipu-coding` 完全一致） |
| minimax-coding | `MINIMAX_CODING_API_KEY` | Native | MiniMax-M2.7（可 `/model` 切换 `MiniMax-M3` Frontier Coding，原生多模态 + 1M ctx；以及 `MiniMax-M2.7-highspeed`） |
| mimo | `MIMO_API_KEY` | Native | mimo-v2.5-pro（小米 MiMo 按量计费，Anthropic 协议） |
| mimo-coding | `MIMO_CODING_API_KEY` | Native | mimo-v2.5-pro（小米 MiMo Token Plan，Anthropic 协议） |
| ark-coding | `ARK_CODING_API_KEY` | Native | glm-5.2（火山方舟 Coding Plan — GLM-5.2（别名 `glm-latest`） · Kimi K2.7 Code / K2.6 · MiniMax M3 / M2.7 · DeepSeek V4 Pro / V4 Flash · Doubao Seed 2.0 Code / Pro / Lite · Doubao Seed Code） |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash（可 `/model` 切换 `deepseek-v4-pro`） |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | （通过 gemini CLI） |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | （通过 codex CLI） |

> 不在表里的端点：用上面"自定义 Provider"那一节加进来即可。

## 内置工具一览

KodaX 有 50+ 个内置工具，按类别分组如下（实际暴露给 LLM 是一张扁平表）。

**文件操作**

| 工具 | 说明 |
|------|------|
| `read` | 读取文件（支持 offset / limit） |
| `write` | 创建新文件或完整重写 |
| `edit` | 精确字符串替换（支持 `replace_all`） |
| `multi_edit` | 对同一文件做一批独立 edit，整批原子提交 |
| `insert_after_anchor` | 在唯一 anchor 后插入内容，避免整文件重写 |
| `undo` | 撤销最近一次文件修改 |

**Shell 与搜索**

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令（支持后台、输出截断） |
| `glob` / `grep` | 文件名匹配 / 正则内容搜索 |
| `code_search` | 代码搜索，比裸 grep 噪音更低 |
| `semantic_lookup` | 借助 repo intelligence 的符号 / 模块 / 流程感知查找 |
| `web_search` / `web_fetch` | 联网搜索 / 抓取，自带 trust + 时效信号 |

**Repo Intelligence working tools**

| 工具 | 说明 |
|------|------|
| `repo_overview` | 仓库结构、关键区域、入口提示、intelligence 快照 |
| `changed_scope` | 当前 diff 涉及的文件 / 区域 / 类别 |
| `changed_diff` / `changed_diff_bundle` | 单文件 / 多文件分页 diff |
| `module_context` | 模块 capsule（依赖、入口、符号、测试、文档） |
| `symbol_context` | 定义 + 可能的 caller/callee + 备选 |
| `process_context` | 入口的近似静态执行/流程 capsule |
| `impact_estimate` | 符号 / 路径 / 模块的影响面估算 |

**MCP 能力**（配置了 MCP server 时可用）

| 工具 | 说明 |
|------|------|
| `mcp_search` / `mcp_describe` / `mcp_call` | 通过共享 capability runtime 发现并调用 MCP 工具 |
| `mcp_read_resource` / `mcp_get_prompt` | 读取 MCP 资源、获取 MCP prompt |

**Git Worktree**

| 工具 | 说明 |
|------|------|
| `worktree_create` | 在隔离分支上新建 worktree，让 agent 安全工作 |
| `worktree_remove` | 移除 worktree（自带安全检查） |

**Agent 控制 / 交互**

| 工具 | 说明 |
|------|------|
| `dispatch_child_task` | 派发子 agent 跑独立调研 / 改动任务。可选 `model_hint: 'fast' \| 'balanced' \| 'deep'`（advisory 标记，routing 在 FEATURE_102 v0.7.45 之前是 no-op） |
| `send_message` | 给在跑 child 队列追加一条 `<coordinator-instruction>` 指令，child 下一个 turn 边界看到。仅 coordinator 可用。(FEATURE_120, v0.7.39) |
| `task_stop` | 请求指定 child 优雅退出。当前 tool 原子结束后 child 看到 `<coordinator-stop-request>` 并 emit 最终摘要。仅 coordinator 可用。(FEATURE_120, v0.7.39) |
| `ask_user_question` | 向用户发起单选 / 多选 / 自由文本提问 |
| `exit_plan_mode` | Plan 模式下提交最终方案给用户审批（仅 REPL） |
| `emit_managed_protocol` | managed-task 协议侧信道（verdict role payload）。v0.7.42 FEATURE_184 起默认走 V2 Worker 单循环 + Sidecar Verifier；v0.7.43 FEATURE_193 退役 V1 chain。 |

## Repo Intelligence（内置 full/light 引擎）

KodaX 内置 repo intelligence（`repo_overview` / `module_context` / `symbol_context` / `process_context` / `impact_estimate` 等），让 coding agent 不靠零散 grep/glob 就能理解大型仓库。

REPL 中使用 `/repo-intel status` 查看当前引擎状态。旧的独立 `repointel` host skill 已移除；repo intelligence 已内置于 KodaX，无需任何外部安装。

```bash
# 选一个运行模式（auto | full | light | off）
kodax --repo-intelligence full --repo-intelligence-trace
```

## 仓库结构

KodaX 是基于 npm workspaces 的 TypeScript monorepo，**源码层 4 个 workspace 包**（FEATURE_194 v0.7.43 包合并 — 9 → 4，ADR-036），npm 上以单 bundle 包 `@kodax-ai/kodax` 发布 + 8 个 SDK subpath exports（`/agent`、`/llm`、`/coding`、`/media`、`/repl`、`/skills`、`/mcp`、`/session`；ADR-024 + ADR-032 + ADR-038）。核心包：

| Workspace 包 | 作用 | 主要依赖 |
|----|------|---------|
| `@kodax-ai/llm` | LLM 抽象层（15 个内置 provider alias + 自定义 provider 注册），可独立使用 | `@anthropic-ai/sdk`, `openai` |
| `@kodax-ai/agent` | 通用 Agent 框架 —— Runner / runFanOut / runWithIdleYield / ChildTaskRegistry + media/input artifacts + 会话管理 + tokenization + 可插拔 compaction + **inline 后**:session-lineage 子树 + capabilities (mcp + skills + builtin) + tracing（subpaths: `/media`、`/session-lineage`、`/capabilities/mcp`、`/capabilities/skills`、`/tracing`） | `@kodax-ai/llm`, `js-tiktoken`, `fflate`, `jimp`, `yaml` |
| `@kodax-ai/coding` | Coding Agent:50+ 工具(含 `dispatch_child_task`/`send_message`/`task_stop`)、role prompts、agent loop、auto-continue + repo-intelligence protocol(v0.7.43 inline) | `@kodax-ai/llm`, `@kodax-ai/agent` |
| `@kodax-ai/repl` | 完整交互式终端 UI（Ink / React、权限模式、命令系统、流式渲染） | `@kodax-ai/coding`, `ink`, `react` |

根目录 `src/kodax_cli.ts` 是 CLI 入口；`src/sdk-{agent,llm,coding,media,repl,skills,mcp,session}.ts` 是 SDK subpath 入口；构建产物在 `dist/`，单文件二进制在 `dist/binary/<target>/`。

### 源码层 vs npm 发布层

KodaX 有两层结构，SDK 用户需要分开理解：

- **源码层**：上面 4 个 workspace 包（开发者读代码时看到的物理结构）。
- **npm 发布层**：单个 bundled 包 `@kodax-ai/kodax`，对外暴露 8 个 SDK subpath（SDK 消费者 `import` 时看到的接口）。subpath 分两种角色：
  - **完整包 subpath**（`/agent`、`/llm`、`/coding`、`/repl`）—— 每个 1:1 对应一个源码包，暴露完整公开 API。
  - **窄子集 subpath**（`/media`、`/skills`、`/mcp`、`/session`）—— 从 `/agent` 或 `/repl` 切出聚焦的能力子集，让"只用 Skills/MCP/会话管理"的消费者引入更小的依赖。

| 源码包 | npm subpath | 类型 | 内容 | 典型消费者 |
|---|---|---|---|---|
| `packages/llm`    | `@kodax-ai/kodax/llm`     | 完整包 | 15-alias LLM 抽象 (77 exports) | 独立 LLM 客户端 |
| `packages/agent`  | `@kodax-ai/kodax/agent`   | 完整包 | Runner / fan-out / session-lineage / capabilities / tracing (202 exports) | 自定义 agent 框架 |
| `packages/agent`  | `@kodax-ai/kodax/skills`  | **窄子集** | 仅 Skills 系统 —— `SkillRegistry` / `loadFullSkill` / `expandSkillForLLM` 等 (26 exports = v0.7.43 之前 `@kodax-ai/skills` 完整 API) | Skill 加载器、IDE 插件 |
| `packages/agent`  | `@kodax-ai/kodax/mcp`     | **窄子集** | 仅 MCP —— `McpCapabilityProvider` / `createMcpTransport` / `searchMcpCatalog` 等 (11 exports = v0.7.43 之前 `@kodax-ai/mcp` 完整 API) | MCP server 宿主 |
| `packages/coding` | `@kodax-ai/kodax/coding`  | 完整包 | Coding agent + 50+ 工具 + repo-intelligence (342 exports) | 构建 Claude Code 形态产品 |
| `packages/repl`   | `@kodax-ai/kodax/repl`    | 完整包 | Ink TUI + 权限模式 + 命令系统 (193 exports) | 终端 UI 消费者 |
| `packages/repl`   | `@kodax-ai/kodax/session` | **窄子集** | 仅会话管理 —— `listSessions` / `loadFullTranscript` / `appendClientNotice` / `forkSession` / `compactSession` / `watchSessions` 等 | 读取 session 历史的 IDE 插件和桌面宿主 |

**经验法则**：需要 Runner / Agent / fan-out 时从 `/agent` 引入；只需要 skills 或 mcp API 时从 `/skills` 或 `/mcp` 引入，bundle 更小。窄子集是完整包的真子集 —— **不会**有额外符号。

**Workflow process surface（FEATURE_229，v0.7.50）**：动态工作流不再只是 REPL 私有文本，而是 Agent 层可复用的 process/event/snapshot 契约。SDK 宿主可以订阅 `WorkflowProcessEvent`、轮询 `WorkflowProcessSnapshot`，并通过 `createWorkflowRunManager` / `createWorkflowLifecycleController` 做 stop/pause/resume、读取 final result/artifact、删除/清理 terminal runs、管理 workflow identity/preflight。`/coding` 负责 coding workflow backend 与 run graph，`/repl` 只是消费同一份 snapshot 渲染 UI；SDK 不需要解析 slash-command 输出或 Ink view-model。`KodaXEvents` 回调新增可选 meta 尾参（`KodaXToolEventMeta` / `KodaXActivityEventMeta` / `KodaXWorkflowEventMeta`），宿主据此把每个子 Agent 的 tool/thinking/progress 事件归因到对应 workflow run 与 child id，无需第二套事件协议；生成/保存的工作流脚本在运行前过 `validateRestrictedWorkflowSource`（编译 + 源策略检查）与 generator 的 repair/smoke 循环。分层取舍见 [docs/ADR.md ADR-040](docs/ADR.md)。

**宿主读持久化历史（FEATURE_230 + FEATURE_234，v0.7.51；v0.7.63 hardening）**：面向「宿主读持久化状态」的 additive 闭环。**持久化工具记录回放**——resume 的会话现在会回放助手用过的工具卡片，而不是退化成纯文本。`messages` / `lineage` 仍是 canonical；`SessionData.uiHistory` 成为有界、脱敏、仅 terminal 状态的回放缓存。SDK transcript 契约明确化：`loadSession()` = 活动 model context，`loadFullTranscript()` = 带结构化条目的追加序 host scrollback（`message` / `compaction` / `branch_summary` / `rewind_marker` / `client_notice` / `task_result`）并带 clone provenance（`logicalId` / `sourceEntryId`），`uiHistory` = 可选回放缓存，工具卡片始终可从 canonical messages 重建。宿主可用 `appendClientNotice()` 持久化本地 slash 输出且不进入模型上下文；workflow/child 完成结果通过结构化 `taskResults[]` 暴露，不再要求解析 `<task-completed>` 文本。`rewind_marker` 只用于 host scrollback 审计，不进入 model-context messages。**Workflow run 宿主归属**——`WorkflowProcessTrackerOptions` / `WorkflowProcessSnapshot` 新增 host-owned 不透明 `hostMetadata?: Record<string, string>`，SDK 存储、持久化进 `run.json`、回读回显（含进程重启后）但不解释其含义，让宿主零侧表把 run 归回发起它的 session/surface。未 stamp 的旧 run 诚实回显 `hostMetadata === undefined`。详见 [docs/features/v0.7.51.md](docs/features/v0.7.51.md)。

**Inline workflow authoring（FEATURE_246，v0.7.58）**：AMA/AMAW 下 Worker 现在可通过 model-callable 的 `run_workflow` 工具在会话内直接编写并运行工作流——先用自己的工具 scout 代码库，再把具体发现烤进每个 child prompt，然后走**不变的** sandbox + 静态校验 + postcondition 验证流水线。它取代 context-blind 的 `sideQuery` generator 成为主交互路径（generator 仅作为显式 `/workflow create` 命令与无 investigating Worker 的 non-interactive/CI 主机的 fallback 保留）；新增结构化 child 输出（`outputSchema`）、无 barrier 的 `wf.pipeline` 分阶段原语、同会话 resume（`resumeFromRunId`）、嵌套 `wf.workflow(...)`，`/workflow create` 重定向到 Worker 的 scout-then-author；`run_workflow` 为 async / idle-yield，不阻塞当前轮。中立的 run-lifecycle manager（`createWorkflowRunManager`）已移入 `@kodax-ai/kodax/agent` 供非 coding SDK 宿主使用。详见 [docs/features/v0.7.58.md](docs/features/v0.7.58.md) 与 [docs/ADR.md](docs/ADR.md) ADR-044/046/047/048/049。

**工作流激活分层（FEATURE_248 + FEATURE_249，v0.7.59）**：三种 agent 模式现在有一致的工作流姿态。**AMAW** 携带 mode-level 的 `ORCHESTRATION DEFAULT` 常驻指令（对齐参考实现的 "ultracode" 姿态）：实质性工作——多文件调查、设计决策、任何做错代价高的任务——默认编排多个交叉验证的 agent，并有 PLAN-TIME COMMITMENT 流程修正把 orchestrate-vs-solo 决策前置到第 0 轮。**AMA** 同样 host `run_workflow` 工具但没有常驻指令——当你用自然语言请求编排时才激活，绝不因复杂度独自触发。**SA** 保持单独作业。该指令通过 `amawOrchestrationAvailable` 关闭泄漏，因此 AMA 与 SA 的 prompt 保持逐字节一致。详见 [docs/features/v0.7.59.md](docs/features/v0.7.59.md)。

**managed 工具路径的渐进披露（FEATURE_250，v0.7.60）**：deferred-tool 渐进披露机制——此前仅 SA path 拥有——现在也应用于 AMA/AMAW 的 **managed** path。缓存冷启的 managed 轮次对 13 个 non-mcp 延迟工具（repo-intelligence + web/code + goal）携带一行 search hint 而非完整描述；每个工具的 `input_schema` 不变，因此仍可直接调用，完整描述按需通过 `tool_search` 拉取。`mcp_*` 保持常驻，`run_workflow` 不动。对用户透明；由两个 5-alias eval panel 验证（DEFER_SAFE 5/5，0% read/grep 回退）。详见 [docs/features/v0.7.60.md](docs/features/v0.7.60.md)。

**工具输出压缩 + Workflow 质量预检（FEATURE_251 + FEATURE_252，v0.7.61）**：KodaX 自有的 `bash` 工具现在**在工具内**压缩高噪声命令输出，一次大 `git diff`、测试、包安装或 `docker build` 不再吞掉数千 context token——命令感知过滤器（git/test/lint/JSON + 声明式 package/docker/infra 长尾）摘要 stdout/stderr 正文，`Command:`/`Exit:` 头部逐字保留，所有有损摘要都保留 raw 恢复路径；隔离测量显示正文 token 降幅约 66–99%。同时，inline `run_workflow` 新增确定性启动前质量 lint，在运行前硬失败弱模型的编写合约 bug（未 await 的 workflow-command 用作布尔、顶层访问本应位于 `result.structured` 的字段、字面 agent fanout 超 manifest/host 上限）。二者均为确定性（无 prompt 改动）。详见 [docs/features/v0.7.61.md](docs/features/v0.7.61.md) 与 [docs/ADR.md ADR-050](docs/ADR.md)。

```
KodaX/                       # 4 workspace packages(FEATURE_194 v0.7.43)
├── packages/
│   ├── llm/                 # @kodax-ai/llm —— 15 个内置 provider alias
│   ├── agent/               # @kodax-ai/agent —— Runner / fan-out / idle-yield + 子树:
│   │   ├── session-lineage/ # 分支 session tree (v0.7.43 inline)
│   │   ├── capabilities/
│   │   │   ├── mcp/         # MCP 集成 (v0.7.43 inline)
│   │   │   └── skills/      # Skills 标准实现 + builtin (v0.7.43 inline)
│   │   └── tracing/         # 追踪 / 可观测性 (v0.7.43 inline)
│   ├── coding/              # @kodax-ai/coding —— tools + prompts + agent loop
│   │   └── repo-intelligence/ # 含 protocol.ts (v0.7.43 inline)
│   └── repl/                # @kodax-ai/repl —— Ink TUI
├── src/
│   ├── kodax_cli.ts         # CLI 主入口（bin: `kodax`）
│   └── sdk-*.ts             # SDK subpath 入口 → @kodax-ai/kodax/{agent,llm,coding,media,repl,skills,mcp,session}
├── scripts/
│   ├── build-bundle.mjs     # esbuild 单 bundle 多 entry 打包（CLI + root + 8 SDK subpath + chunks）
│   ├── build-binary.mjs     # Bun --compile 单文件二进制打包
│   └── release.mjs          # ADR-024 release-time pkg name/exports 注入
└── .github/workflows/
    └── release.yml          # 推 v* tag 自动发布 GitHub Release
```

这套拆分让你既可以把 KodaX 当成完整产品使用，也可以只复用其中某一层能力 —— SDK 消费者装 `@kodax-ai/kodax` 后从 subpath（`@kodax-ai/kodax/agent` 等）按需 import。
## API 导出

```typescript
// 主函数
export { runKodaX, KodaXClient };

// 类型
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// 工具
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Provider
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// 工具函数
export {
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## 术语说明

| 术语 | 含义 | 位置 |
|------|------|------|
| **Skills** | Agent 能力（KODAX_TOOLS: read, write, bash 等）+ 扩展 Skills | Coding 层 + Skills 层 |
| **Commands** | CLI 快捷命令（/review, /test 等） | REPL 层 |

---

## 开发

```bash
# 开发模式
npm run dev "你的任务"

# 构建
npm run build

# 可选：只构建 workspace packages
npm run build:packages

# 打包成单文件二进制（当前平台 / 全平台）
npm run build:binary
npm run build:binary:all

# 测试
npm test

# Eval-driven development（provider 矩阵、identity round-trip 等）
npm run test:eval

# 清理
npm run clean
```

### Repo Intelligence 缓存目录

KodaX 现在会把 Repo Intelligence 的本地缓存分成内置引擎 profile：

- `.agent/repo-intelligence/`
  - full 引擎索引、缓存和现有 task-engine 产物。
- `.agent/repo-intelligence/light/`
  - light 模式启发式索引缓存。

这样拆开的目的很明确：

- full 和 light profile 可以独立重建。
- light 模式的低置信度状态不会被误认为 full 引擎状态。
- 未来缓存迁移可以删除一个 profile，而不破坏另一个。

`.agent/repo-intelligence/` 是本地生成目录，不应该提交到 Git。

---

## 文档

- [README.md](README.md) - 英文版 README
- [docs/release.md](docs/release.md) - 单文件二进制构建与发布流程
- [docs/PRD.md](docs/PRD.md) - 产品需求
- [docs/ADR.md](docs/ADR.md) - 架构决策
- [docs/HLD.md](docs/HLD.md) - 高层设计
- [docs/DD.md](docs/DD.md) - 详细设计
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature 跟踪
- [docs/test-guides/](docs/test-guides/) - 功能专用测试指南
- [CHANGELOG.md](CHANGELOG.md) - 更新日志（v0.7.0+；更早版本见 [CHANGELOG_ARCHIVE](docs/CHANGELOG_ARCHIVE.md)）


---

## 许可证

公共仓库当前采用：

- `Apache-2.0`

## 相关仓库

建议把公仓和私仓 clone 到同一个父目录下，例如：

- public repo: `<parent>/KodaX`
- private repo: `<parent>/KodaX-private`（未公开发布）
