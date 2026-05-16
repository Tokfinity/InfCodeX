# KodaX

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is a **modular, lightweight AI coding agent** built with TypeScript. It supports **12 LLM providers**, works as both a CLI tool and a library, ships an optional **Node-free standalone binary**, and includes a Scout-first adaptive multi-agent workflow for long-running coding tasks.

**Core Philosophy**: Transparent, Flexible, Minimalist

**Why KodaX?**

| Question | KodaX answer |
|---------|--------------|
| Why not only use Claude Code? | KodaX is easier to inspect, modify, self-host, and switch across providers. |
| Why not only use an SDK? | KodaX already gives you a CLI, sessions, tools, permissions, and skills out of the box. |
| Why use it as a codebase? | The architecture is small enough to understand and customize without wading through thousands of files. |
| Why use it in production tools? | The packages are separated cleanly, so you can reuse only the layer you need. |

**KodaX vs hosted coding assistants**

| Feature | KodaX | Typical hosted coding assistant |
|---------|-------|----------------------------------|
| **Architecture** | Modular (5 packages), library-friendly | Usually product-first, less reusable as code |
| **Provider choice** | 12 providers (incl. Anthropic, OpenAI, DeepSeek, Kimi, Qwen, Zhipu, MiniMax, MiMo, Gemini CLI, Codex CLI) + custom OpenAI/Anthropic-compatible providers | Often optimized for one provider |
| **Customization** | Edit prompts, tools, skills, session flow directly | Limited extension surface |
| **Codebase clarity** | Small TypeScript monorepo | Often much larger and harder to trace |
| **Distribution** | npm install / global link / **standalone binary** (Bun --compile, no Node required on target) | Closed-source installer or web app |
| **Learning value** | Good for understanding agent internals | More black-box |

## Quick Start

### 1. Install and build the CLI

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

### 2. Configure a provider

KodaX reads API keys from environment variables. For built-in providers, the fastest path is:

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

For CLI defaults, create `~/.kodax/config.json`:

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto"
}
```

If you need a custom base URL or an OpenAI/Anthropic-compatible endpoint, define a custom provider in the same config file:

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
      "userAgentMode": "compat"
    }
  ]
}
```

`userAgentMode` defaults to `"compat"`, which sends `KodaX` instead of the official SDK User-Agent. Switch it to `"sdk"` only when your gateway expects the upstream SDK header.

#### Opting a custom provider into image / vision input (FEATURE_134 v0.7.40)

If your custom provider's underlying model supports image input (vision), add a `capabilityProfile.multimodalSupport: "image-input"` block so KodaX does not artificially block multimodal requests at the SA-path policy gate. The 12 built-in vision-capable providers (Anthropic, OpenAI, the 9 Anthropic-/OpenAI-compat clones — DeepSeek, Kimi, Kimi-code, Qwen, Zhipu, Zhipu-coding, MiniMax-coding, MiMo-coding, Ark-coding — plus Gemini-CLI via the CLI's `@<path>` file-include syntax) already ship with this flag enabled by default; only Codex-CLI and custom providers need to opt in.

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

The serializer layer (`packages/llm/src/providers/anthropic.ts:770` for Anthropic-compat, `openai.ts:904` for OpenAI-compat) forwards image blocks automatically through base-class inheritance. The flag only gates whether KodaX's policy layer pre-rejects multimodal requests — the model-level vision contract remains your upstream provider's responsibility. If the model is actually text-only, you'll see the real upstream API error instead of a KodaX-side rejection.

### 3. Start in REPL or run a one-shot task

```bash
# Interactive REPL
kodax

# Then ask naturally inside the REPL
Read package.json and summarize the architecture
/mode
/help

# One-shot CLI usage
kodax "Review this repository and summarize the architecture"
kodax --session review "Find the riskiest parts of src/"
kodax --session review "Give me concrete fix suggestions"
```

### 4. Use it as a library

Library usage still expects API keys from environment variables. If you want custom provider names or base URLs in code, register them explicitly:

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

const result = await runKodaX(
  {
    provider: 'my-openai-compatible',
    reasoningMode: 'auto',
  },
  'Explain this codebase'
);
```

## Core Workflows

- **CLI coding assistant**: run one-off tasks or stay in a session for multi-step work.
- **Skills-driven workflows**: trigger built-in or custom skills from natural language.
- **Project Mode / harness engineering**: bootstrap a long-running project, keep project truth on disk, and execute through verifier-gated `/project` flows.
- **Embeddable library**: reuse the provider layer, session layer, or full coding agent in your own app.

## Repo Intelligence Premium

KodaX now supports a split repo-intelligence architecture:

- **Public OSS baseline** lives in the public `KodaX` repo and keeps `CLI`, `REPL`, `ACP`, library imports, and repo-aware tools working even when no premium component is installed.
- **Premium intelligence** lives in the sibling private repo `KodaX-private` and runs through the local `repointel` daemon / CLI frontdoor.
- **KodaX native mode** is the flagship experience. It can prefetch repo intelligence before routing and prompt building, while other hosts such as Codex / Claude Code / OpenCode use the same premium tool through thin skills.

### Runtime modes

KodaX supports these repo-intelligence modes:

- `off`: strict benchmark baseline. Disable the repo-intelligence working plane entirely while keeping `/repointel` control commands available.
- `oss`: use only the public OSS baseline.
- `premium-shared`: use the premium engine, but without the native KodaX auto lane. This is useful for comparing KodaX against other hosts.
- `premium-native`: use the premium engine through the KodaX native bridge. This is the best local experience.
- `auto`: user-facing convenience mode. KodaX resolves it to `premium-native` when the premium daemon is reachable, otherwise it falls back to `oss`.

### Quick usage

Run KodaX with explicit repo-intelligence mode flags:

```bash
# OSS baseline only
kodax --repo-intelligence oss

# Premium native mode with trace output
kodax --repo-intelligence premium-native --repo-intelligence-trace

# Compare against the shared premium path
kodax --repo-intelligence premium-shared --repo-intelligence-trace
```

You can also set the same behavior through config or environment variables:

```powershell
$env:KODAX_REPO_INTELLIGENCE_MODE = "premium-native"
$env:KODAX_REPO_INTELLIGENCE_TRACE = "1"
$env:KODAX_REPOINTEL_BIN = "C:\Tools\repointel\repointel.exe"
```

Official `KodaX-private` releases should now publish only the native `repointel` package. The older offline bundle remains useful for internal/manual validation, but it should not be the normal end-user release artifact.

### REPL mode

It is not CLI-only. REPL mode supports the same repo-intelligence runtime modes.

The most direct premium-native REPL flow is:

```powershell
Set-Location <path-to-your-KodaX-clone>
kodax --repo-intelligence premium-native --repo-intelligence-trace
```

If you save the premium settings in `~/.kodax/config.json`, plain REPL startup is enough:

```powershell
kodax
```

Inside REPL, repo intelligence is still consumed automatically by the normal KodaX flow, and there are also lightweight status/control commands:

- `/status`: shows a compact repo-intelligence summary together with the normal session status output.
- `/repointel` or `/repointel status`: shows the current repo-intelligence state in more detail.
- `/repointel mode premium-native|premium-shared|oss|off|auto`: switches the current mode and writes it back to user config.
- `/repointel trace on|off|toggle`: turns repo-intelligence trace output on or off.
- `/repointel warm`: tries to warm or start the local premium service. If it cannot be started, KodaX reports the failure clearly and continues with the normal fallback path.

The most important fields to watch are:

- `mode`: the resolved runtime mode, such as `oss`, `premium-shared`, or `premium-native`
- `engine`: the actual engine in use, `oss` or `premium`
- `bridge`: `none`, `shared`, or `native`
- `status`: typically `ok`, `limited`, or `unavailable`

The practical difference between the two premium modes is:

- `premium-native`: the flagship KodaX path. KodaX can prefetch and inject repo intelligence earlier in its native runtime flow.
- `premium-shared`: still uses premium, but intentionally avoids the KodaX-native auto lane so you can compare against the shared multi-host path.
- `oss`: keep the public baseline repo tools and OSS intelligence only.
- `off`: strict disable for repo-intelligence working tools and auto injection. `/repointel` remains available as the control plane.

### User-level config

Repo-intelligence premium settings are supported in the user config file `~/.kodax/config.json`.

Supported fields:

- `repoIntelligenceMode`
- `repointelEndpoint`
- `repointelBin`
- `repoIntelligenceTrace`

Recommended end-user example when `repointel` is installed but not on `PATH`:

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto",
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe",
  "repoIntelligenceTrace": false
}
```

For normal user installs, the preferred setup is to install the premium tool so the `repointel` command is already on `PATH`, in which case this is usually enough:

```json
{
  "repoIntelligenceMode": "premium-native"
}
```

If `repointel` is not on `PATH`, `repointelBin` can point to the installed native executable, for example:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe"
}
```

For author same-parent local development, it is still valid to point `repointelBin` at the sibling private source build:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelEndpoint": "http://127.0.0.1:47891",
  "repointelBin": "C:\\path\\to\\KodaX-private\\packages\\repointel-cli\\dist\\index.js",
  "repoIntelligenceTrace": true
}
```

`repointelEndpoint` is optional in normal installs. It only tells KodaX which local premium daemon address to use, and the default `http://127.0.0.1:47891` is usually enough unless you deliberately run a non-default endpoint.

For same-parent author local development, `repointelBin` can still point to the sibling private build output.

These config values are loaded by both CLI mode and REPL mode, and they are bridged into the runtime environment automatically.

### Config template

The repo now includes a user-facing config template:

- `config.example.jsonc`

Copy it to `~/.kodax/config.json`, then adjust provider and repo-intelligence settings as needed.

### Local same-parent development

The intended phase-1 development layout is to clone both repos under the same parent directory, for example:

- Public repo: `<parent>/KodaX`
- Private repo: `<parent>/KodaX-private`

Typical local workflow:

```powershell
# 1. Build the public repo
Set-Location <parent>\KodaX
npm install
npm run build

# 2. Build the private premium repo
Set-Location <parent>\KodaX-private
npm install
npm run build

# 3. Warm or start the premium daemon
node .\packages\repointel-cli\dist\index.js warm "{}"

# 4. Run KodaX in premium-native mode
Set-Location <parent>\KodaX
npm run dev -- --repo-intelligence premium-native --repo-intelligence-trace
```

### How KodaX behaves after the split

- If premium is unavailable, KodaX automatically falls back to the OSS baseline. Startup, imports, and public tools keep working.
- If premium is available, `premium-native` uses the daemon client directly and injects repo intelligence earlier than shared-host integrations.
- Trace-enabled runs can be used to compare `off`, `oss`, `premium-shared`, and `premium-native` on the same task, including mode, engine, bridge, daemon latency, cache hits, and capsule token estimates.

### External hosts

Codex, Claude Code, and OpenCode are intentionally thinner in phase 1:

- they install the shared Repointel skill
- they call the same local premium tool
- they do **not** ship a separate OSS fallback engine

Install the shared thin skill from the public repo:

```powershell
# Cross-platform primary entrypoint
node .\clients\repointel\scripts\install.mjs --host codex
node .\clients\repointel\scripts\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\scripts\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

Useful helper scripts:

- `clients/repointel/scripts/demo.mjs`: run a local premium demo flow against a temporary endpoint.
- `clients/repointel/scripts/doctor.mjs`: inspect local premium setup, bridge status, daemon reachability, and host skill installation.
- `clients/repointel/scripts/install.mjs`: install the shared thin skill into Codex / Claude / OpenCode host paths.

The installable shared skill itself lives at:

- `clients/repointel/SKILL.md`

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces. Source layout has 9 workspace packages; published as a single bundled npm package `@kodax-ai/kodax` with 5 SDK subpath exports (ADR-022 + ADR-024, v0.7.39):

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax-ai/llm - LLM abstraction (12 providers)
│   │   └── providers/       # Anthropic, OpenAI, DeepSeek, Kimi, MiMo, MiniMax, Zhipu, Ark, …
│   │
│   ├── agent/               # @kodax-ai/agent - Generic Agent framework
│   │   └── orchestration/   # Runner, runFanOut, runWithIdleYield, ChildTaskRegistry
│   │
│   ├── skills/              # @kodax-ai/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax-ai/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # 30+ tools: read, write, edit, bash, glob, grep, undo,
│   │                        #   dispatch_child_task, send_message, task_stop,
│   │                        #   ask_user_question, repo-intelligence, …
│   │
│   ├── repl/                # @kodax-ai/repl - Interactive terminal UI (Ink TUI)
│   ├── mcp/                 # @kodax-ai/mcp - MCP integration
│   ├── repointel-protocol/  # @kodax-ai/repointel-protocol - repo-intel protocol
│   ├── session-lineage/     # @kodax-ai/session-lineage - branchable session tree
│   └── tracing/             # @kodax-ai/tracing - tracing / observability
│
├── src/                     # CLI entry + 5 SDK subpath entries (sdk-{agent,llm,coding,repl,skills}.ts)
│   ├── kodax_cli.ts         # Main CLI entry point (bin: `kodax`)
│   └── sdk-*.ts             # SDK subpath re-exports → @kodax-ai/kodax/{agent,llm,coding,repl,skills}
│
└── package.json             # Root workspace config; release.mjs rewrites name + injects subpath exports
```

### Package Dependencies

```
                    ┌──────────────────┐
                    │  kodax (root)    │
                    │  CLI Entry       │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
       ┌──────────────┐              ┌────────────────┐
       │@kodax-ai/repl│              │@kodax-ai/coding│
       │  UI Layer    │              │ Tools+Prompts  │
       └──────┬───────┘              └──────┬─────────┘
              │                             │
              │              ┌──────────────┼──────────────┐
              │              │              │              │
              ▼              ▼              ▼              ▼
       ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐
       │@kodax-ai/    │ │@kodax-ai/    │ │@kodax-ai/llm │ │  External   │
       │skills        │ │agent         │ │LLM Abstract  │ │   SDKs      │
       │(zero deps)   │ │Runner +      │ │(12 providers)│ │             │
       │              │ │fan-out +     │ │              │ │             │
       │              │ │idle-yield    │ │              │ │             │
       └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘
```

### Package Overview

Source-side workspace package names (`@kodax-ai/*`). npm consumers install the single bundled `@kodax-ai/kodax` package and import from SDK subpaths — see [SDK Usage](#sdk-usage) below.

| Workspace package | Purpose | Key Dependencies |
|---------|---------|------------------|
| `@kodax-ai/llm` | LLM abstraction (12 providers + custom registration) | @anthropic-ai/sdk, openai |
| `@kodax-ai/agent` | Generic Agent framework — Runner, fan-out, idle-yield, session, tokenization (ADR-021 standalone-consumable) | @kodax-ai/llm, js-tiktoken |
| `@kodax-ai/skills` | Skills standard implementation | Zero external deps |
| `@kodax-ai/coding` | Coding Agent — 30+ tools (incl. `dispatch_child_task` / `send_message` / `task_stop`) + role prompts + auto-continue | @kodax-ai/llm, @kodax-ai/agent, @kodax-ai/skills |
| `@kodax-ai/repl` | Complete interactive terminal UI (Ink/React, permission modes, commands, streaming) | @kodax-ai/coding, ink, react |

---

## Features

- **Modular Architecture** - Use as CLI, as a library, or as a Node-free single binary
- **12 LLM Providers** - Anthropic, OpenAI, DeepSeek, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding, MiniMax Coding, MiMo Coding (Xiaomi Token Plan), Gemini CLI, Codex CLI — plus user-defined OpenAI/Anthropic-compatible providers
- **Worker + Evaluator AMA (V2, default)** - Adaptive multi-agent with H0/H1/H2 harness levels. Worker single-loop replaces the V1 Scout/Planner/Generator chain (FEATURE_114, v0.7.36); structural Evaluator gate preserved. Async child steering via `dispatch_child_task` + `send_message` + `task_stop` with idle-yield wait (FEATURE_120 / FEATURE_155, v0.7.39).
- **Reasoning Modes** - Unified `off/auto/quick/balanced/deep` interface across providers
- **Streaming Output** - Real-time response display
- **Session Management** - JSONL format with branchable session lineage tree
- **Skills System** - Natural language triggering, extensible, role-projected in AMA
- **Repo Intelligence** - OSS baseline + optional `repointel` premium engine, with native KodaX auto-injection lane
- **Rich Tool Surface** - 30+ built-in tools across file ops, shell, search, repo intelligence, MCP capabilities, git worktree, and agent control
- **Permission Control** - 3 permission modes with pattern-based control
- **Standalone Binary** - `bun --compile` releases for Win/macOS/Linux x64+arm64, no Node.js required on target machines
- **Cross-Platform** - Windows/macOS/Linux
- **TypeScript Native** - Full type safety and IDE support

---

## Installation

### As CLI Tool

```bash
# Clone repository
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# Install dependencies (includes workspace packages)
npm install

# Build the monorepo
npm run build

# Link globally (development mode)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
```

### As Standalone Binary (no Node required on target)

KodaX can be packaged into a single executable + a small `builtin/` sidecar directory using `bun --compile`. The target machine does **not** need Node.js or any other runtime.

Supported targets: `win-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Win7 / pre-glibc-2.27 distros / LoongArch are not supported.

**Build locally**:

```bash
# Install Bun once on your build machine
npm i -g bun                  # or scoop/brew/curl install — see docs/release.md

npm run build:binary          # Current host platform (fastest)
npm run build:binary:all      # All five targets in sequence
node scripts/build-binary.mjs --target=linux-arm64   # Specific target
```

Output lives under `dist/binary/<target>/`:

```
dist/binary/linux-x64/
├── kodax              # ~60 MB Bun-compiled executable
└── builtin/           # Sidecar built-in skills
```

Smoke-test: `dist/binary/<host>/kodax --version`.

**Automated release**: pushing a `v*` git tag triggers `.github/workflows/release.yml`, which builds all five targets on native runners, runs smoke tests, and publishes a GitHub Release with archives + SHA256SUMS. Use the `workflow_dispatch` button in the Actions UI to test the pipeline without tagging.

See [docs/release.md](docs/release.md) for full details on build flags, archive layout, troubleshooting, and the build-time `KODAX_BUNDLED` / `KODAX_VERSION` defines.

### As Library

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';

process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? 'your_api_key';

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onComplete: () => console.log('\nDone!'),
  },
}, 'your task');

console.log(result.lastText);
```

#### SDK Subpath Imports (v0.7.39+)

For smaller surface and tree-shake-friendly imports, the SDK is also exposed via subpath exports — pick only the package(s) you need:

```typescript
import { Runner } from '@kodax-ai/kodax/agent';       // agent runtime
import { createProvider } from '@kodax-ai/kodax/llm'; // LLM abstraction (12 providers)
import { runKodaX } from '@kodax-ai/kodax/coding';    // coding tools + prompts
import { SkillRegistry } from '@kodax-ai/kodax/skills'; // zero-dep skill loader
import { loadConfig } from '@kodax-ai/kodax/repl';    // REPL config / session helpers
```

All 6 entries (root + 5 subpaths) share internal code via ESM chunk splitting — importing from `/agent` does not pull in `/repl`'s Ink + React surface.

For CLI users, provider defaults live in `~/.kodax/config.json`. For library users, API keys are still read from environment variables; if you need custom base URLs or provider aliases, use `registerCustomProviders()` as shown above.

---

## Usage

### REPL Quickstart

Running `kodax` with no prompt starts the interactive REPL.

```bash
kodax
```

Inside the REPL you can type normal requests or slash commands:

```text
Read package.json and summarize the architecture
/model
/mode
/help
```

### CLI Quickstart

```bash
# Set API key
export ZHIPU_API_KEY=your_api_key

# Basic usage
kodax "Help me create a TypeScript project"

# Choose a provider explicitly
kodax --provider openai --model gpt-5.4 "Create a REST API"

# Use a deeper reasoning mode
kodax --reasoning deep "Review this architecture"
```

### Session Workflows

Use a session when you want memory across turns. Without a session, each CLI call is independent.

```bash
# No memory: two separate calls
kodax "Read src/auth.ts"
kodax "Summarize it"

# With memory: same session
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"
kodax --session my-project "How should I fix the first issue?"

# Session management
kodax --session list
kodax --session resume "continue"
```

### Session Patterns

```bash
# ❌ No memory: two independent calls
kodax "Read src/auth.ts"           # Agent reads and responds
kodax "Summarize it"               # Agent doesn't know what to summarize

# ✅ With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"        # Agent knows to summarize auth.ts
kodax --session auth-review "How to fix first issue"  # Agent has context
```

### Workflow Examples

```bash
# Code review (multi-turn conversation)
kodax --session review "Review src/ directory"
kodax --session review "Focus on security issues"
kodax --session review "Give me fix suggestions"

# Project development (continuous session)
kodax --session todo-app "Create a Todo application"
kodax --session todo-app "Add delete functionality"
kodax --session todo-app "Write tests"
```

### CLI Reference

```text
kodax                    Start the interactive REPL
-h, --help [topic]   Show help or topic help
-p, --print <text>   Run a single task and exit
-c, --continue       Continue the most recent conversation in this directory
-r, --resume [id]    Resume a session by ID, or the latest session
-m, --provider       Provider to use
--model <name>       Override the model
--reasoning <mode>   off | auto | quick | balanced | deep
-t, --thinking       Compatibility alias for --reasoning auto
-s, --session <op>   Session ID or legacy session operation
-j, --parallel       Enable parallel tool execution
--max-iter <n>       Max iterations
```

### Permission Control

KodaX provides 3 permission modes for fine-grained control:

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

```bash
# In REPL, use /mode command
/mode plan          # Switch to plan mode (read-only)
/mode accept-edits  # Switch to accept-edits mode
/mode auto-in-project  # Switch to auto-in-project mode
/auto                  # Alias for auto-in-project

# Check current mode
/mode
```

**Features:**
- In `accept-edits` mode, choosing "always" can persist safe Bash allow-patterns
- Plan mode includes system prompt context for LLM awareness
- Permanent protection zones: `.kodax/`, `~/.kodax/`, paths outside project
- Pattern-based permission: Allow specific Bash commands (e.g., `Bash(npm install)`)
- Unified diff display for write/edit operations

### CLI Help Topics

Get detailed help for specific topics:

```bash
# Basic help
kodax -h
kodax --help

# Detailed topic help
kodax -h sessions      # Session management details
kodax -h init          # Long-running project initialization
kodax -h project       # Project mode / harness workflow
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning mode
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
```

### Environment Variables

KodaX recognizes a number of environment variables for tuning runtime behavior. The most commonly used ones are listed below; for the full list, search the repo for `process.env.KODAX_`.

#### `KODAX_MAX_OUTPUT_TOKENS`

Overrides the per-turn `max_tokens` value sent to **every** provider (Anthropic, OpenAI, Zhipu, Kimi, MiniMax, Qwen, DeepSeek, MiMo, Gemini, Codex, …). Set to a positive integer; unset or non-numeric values are ignored. This is an **explicit user intent**: when set, it wins over the provider's model descriptor cap, over the provider config default, and over the global `KODAX_MAX_TOKENS` fallback. The runtime's automatic safety caps (e.g. the v0.7.28 P2b RST-prone write-turn cap that limits write/edit turns to 8K tokens on Zhipu/Kimi/MiniMax) are **bypassed** when this variable is set, so the user override is also a way to opt out of those caps.

```bash
# Allow up to 48K output tokens per turn (use a higher cap when generating long files)
export KODAX_MAX_OUTPUT_TOKENS=48000
kodax "generate the full implementation"

# Unset to restore default behavior
unset KODAX_MAX_OUTPUT_TOKENS
```

Precedence used by every provider's `getEffectiveMaxOutputTokens()` (see `packages/llm/src/providers/base.ts`):

1. One-shot per-request override (agent-loop escalation / context-overflow recovery — internal)
2. **`KODAX_MAX_OUTPUT_TOKENS`** (this variable, explicit user intent)
3. Active model descriptor's `maxOutputTokens` (FEATURE_098 per-model cap)
4. Provider config default
5. Global `KODAX_MAX_TOKENS` fallback

Related variables: `KODAX_MAX_TOKENS` (global fallback when no provider/model cap applies), `KODAX_RST_PRONE_PROVIDERS` and `KODAX_WRITE_TURN_MAX_TOKENS` (v0.7.28 P2b write-turn safety cap configuration), `KODAX_ESCALATED_MAX_OUTPUT_TOKENS` (escalation budget used by the agent loop when a turn returns `stop_reason: max_tokens`).

## Advanced Library Usage

#### Simple Mode (runKodaX)

```typescript
import { runKodaX, KodaXEvents } from '@kodax-ai/kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`Thinking delta: ${text.length} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}: ${result.content.slice(0, 100)}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events,
}, 'What is 1+1?');

console.log(result.lastText);
```

#### Continuous Session (KodaXClient)

```typescript
import { KodaXClient } from '@kodax-ai/kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (t) => process.stdout.write(t),
  },
});

// First message
await client.send('Read package.json');

// Continue same session
await client.send('Summarize it');

console.log(client.getSessionId());
```

#### Custom Session Storage

```typescript
import { runKodaX, KodaXSessionStorage, KodaXMessage } from '@kodax-ai/kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // Save to your database
  }
  async load(id: string) {
    // Load from your database
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { ... },
}, 'task');
```

### Library Modes Comparison

| Feature | runKodaX | KodaXClient |
|---------|----------|-------------|
| **Message Memory** | ❌ No | ✅ Yes |
| **Call Style** | Function | Class instance |
| **Context** | Independent each time | Accumulates |
| **Use Case** | Single tasks, batch processing | Interactive dialogue, multi-step tasks |

---

## SDK Usage

KodaX ships as a single npm package `@kodax-ai/kodax` with 5 SDK subpath exports (ADR-024, v0.7.39). Each subpath is tree-shake-friendly so consumers pull only what they need:

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';                  // root: CLI helpers + runKodaX
import { Runner, runFanOut } from '@kodax-ai/kodax/agent';   // generic Agent framework
import { getProvider } from '@kodax-ai/kodax/llm';           // 12-provider LLM abstraction
import { KODAX_TOOLS } from '@kodax-ai/kodax/coding';        // tools + prompts + agent loop
import { InkREPL } from '@kodax-ai/kodax/repl';              // Ink TUI components
import { SkillRegistry } from '@kodax-ai/kodax/skills';      // zero-dep skill loader
```

### `@kodax-ai/kodax/llm` — LLM Abstraction

12 built-in providers (Anthropic, OpenAI, DeepSeek, Kimi, Kimi-Code, Qwen, Zhipu, Zhipu-Coding, MiniMax-Coding, MiMo-Coding, Ark-Coding, Gemini-CLI, Codex-CLI) + custom provider registration.

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax-ai/kodax/llm';

const provider = getProvider('anthropic');
const stream = await provider.streamCompletion(
  [{ role: 'user', content: 'Hello!' }],
  { onTextDelta: (text) => process.stdout.write(text) }
);

for await (const result of stream) {
  if (result.type === 'text') { /* … */ }
  else if (result.type === 'tool_use') { /* … */ }
}
```

**Key Features**: unified provider interface · streaming · reasoning modes (`off/auto/quick/balanced/deep`) · per-provider retry + error handling · zero business-logic dependencies.

### `@kodax-ai/kodax/agent` — Agent Framework (standalone-consumable)

ADR-021 standalone-consumable: `@kodax-ai/agent` has **zero inbound `@kodax-ai/coding` dependency** — you can wire any tool surface on top of it.

```typescript
import {
  Runner,
  runFanOut,
  runWithIdleYield,
  registerChildTask,
  type ChildTaskRegistry,
  generateSessionId,
  estimateTokens,
  DefaultSummaryCompaction,
} from '@kodax-ai/kodax/agent';

// Bounded-concurrency fan-out with abort + structured progress events (v0.7.39 FEATURE_120)
const result = await runFanOut({
  bundles: [{ id: 'a', task: 'audit-foo' }, { id: 'b', task: 'audit-bar' }],
  maxParallel: 4,
  run: async (bundle) => doWork(bundle),
});

// Idle-yield wait — pause when out of useful work, resume when a wake event arrives
await runWithIdleYield({ runOnce, computeSnapshot, registry, messageQueue, agentId });

// Pluggable compaction policy (FEATURE_081)
const policy = new DefaultSummaryCompaction({ thresholdRatio: 0.8, keepRecent: 10 });
```

**Key Features**: `Runner` + per-step lifecycle · `runFanOut` (bounded-concurrency + abort + progress events) · `runWithIdleYield` (chat-while-waiting) · `ChildTaskRegistry` / `TaskAbortRegistry` · session-id generation · tiktoken-based token estimation · `CompactionPolicy` interface.

### `@kodax-ai/kodax/skills` — Skills System

Zero external dependencies. Markdown-based skill files with natural-language triggers and variable resolution.

```typescript
import {
  SkillRegistry,
  discoverSkills,
  executeSkill,
  type SkillContext,
} from '@kodax-ai/kodax/skills';

const skills = await discoverSkills(['/path/to/skills']);
const registry = new SkillRegistry();
await registry.registerSkills(skills);

const result = await executeSkill({
  skillId: 'code-review',
  arguments: { target: 'src/' },
  workingDirectory: process.cwd(),
});
```

**Key Features**: zero deps · markdown-based skill files · natural-language triggering · variable resolution · built-in skills included.

### `@kodax-ai/kodax/coding` — Coding Agent

Complete coding agent: 30+ tools (`read`/`write`/`edit`/`bash`/`grep`/`glob`/`dispatch_child_task`/`send_message`/`task_stop`/...) + role prompts (Worker / Evaluator) + agent loop + auto-continue + session management.

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax-ai/kodax/coding';

// Single-task helper
const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: { onTextDelta: (text) => process.stdout.write(text) },
}, 'Read package.json and explain the dependencies');

// Continuous session
const client = new KodaXClient({
  provider: 'anthropic',
  reasoningMode: 'auto',
  events: { /* … */ },
});
await client.send('Create a new file');
await client.send('Add a function to it'); // Has context from previous message
```

**Key Features**: 30+ built-in tools (see [Tools](#tools)) · Worker+Evaluator V2 chain (FEATURE_114, v0.7.36 default) · async child steering via `send_message` / `task_stop` (FEATURE_120, v0.7.39) · idle-yield wait mechanic (FEATURE_155, v0.7.38) · auto-continue · session lineage.

### `@kodax-ai/kodax/repl` — Interactive Terminal UI

Ink/React-based interactive REPL. Permission modes, command system, themed streaming display.

```typescript
import { InkREPL } from '@kodax-ai/kodax/repl';

// Usually used via the `kodax` bin command; can be embedded:
// - Interactive terminal UI (Ink components)
// - Permission control (auto/plan/accept-edits modes)
// - Command system (/help, /mode, /clear, /status, …)
// - Skills integration
// - Theme support
```

**Key Features**: Ink-based React components · 3 permission modes (auto / plan / accept-edits) · built-in commands · real-time streaming display · context-usage indicator.

### Package Dependency Graph (workspace internal)

```
@kodax-ai/llm    (zero business-logic deps)
    ↓
@kodax-ai/agent  (depends @kodax-ai/llm; ADR-021 standalone-consumable)
    ↓
@kodax-ai/skills (zero external deps)  →  @kodax-ai/coding  (depends llm + agent + skills)
                                                    ↓
                                              @kodax-ai/repl (depends coding + ink + react)
```

**Subpath Recommendations**:

| Use Case | Subpath | Why |
|----------|---------|-----|
| Only need LLM abstraction | `@kodax-ai/kodax/llm` | Minimal deps; 12 providers |
| Building custom agent | `@kodax-ai/kodax/agent` | Runner + fan-out + idle-yield + sessions |
| Using skills system | `@kodax-ai/kodax/skills` | Zero deps, pure skills |
| Coding tasks | `@kodax-ai/kodax/coding` | Complete coding agent + tools |
| Terminal app | `@kodax-ai/kodax/repl` | Full interactive experience |

---

| Provider | Environment Variable | Reasoning Support | Default Model |
|----------|----------------------|-------------------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6 |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex |
| kimi | `KIMI_API_KEY` | Native | kimi-k2.6 |
| kimi-code | `KIMI_API_KEY` | Native | kimi-for-coding |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Native | glm-5 |
| minimax-coding | `MINIMAX_API_KEY` | Native | MiniMax-M2.7 |
| mimo-coding | `MIMO_API_KEY` | Native | mimo-v2.5-pro (Xiaomi Token Plan, Anthropic-compat) |
| ark-coding | `ARK_API_KEY` | Native | glm-5.1 (Volcengine Ark Coding Plan, multi-model gateway, Anthropic-compat) |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

> **Custom providers**: any OpenAI- or Anthropic-compatible endpoint can be added via `customProviders[]` in `~/.kodax/config.json` (CLI) or `registerCustomProviders()` (library). See the [Quick Start](#2-configure-a-provider) for the configuration shape.

### Examples

```bash
# Use Zhipu Coding
kodax --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "Create a REST API"

# Resume last session
kodax --session resume

# List all sessions
kodax --session list

# Parallel tool execution
kodax --parallel "Read package.json and tsconfig.json"

# Adaptive multi-agent (AMA) mode — Scout-first fan-out for multi-file work
kodax --agent-mode ama "Analyze code structure, check test coverage, find bugs"
```

---

## Tools

KodaX ships 30+ built-in tools, grouped below. They are registered as a single flat tool surface to the LLM; the categories here are just for navigation.

### File operations
| Tool | Description |
|------|-------------|
| `read` | Read file contents (supports offset/limit) |
| `write` | Write a new file or fully rewrite an existing one |
| `edit` | Exact string replacement (supports `replace_all`) |
| `multi_edit` | Atomic batch of independent edits to one file |
| `insert_after_anchor` | Insert content after a unique anchor without rewriting the file |
| `undo` | Revert the last file modification |

### Shell & search
| Tool | Description |
|------|-------------|
| `bash` | Execute a shell command (supports `run_in_background`, output truncation) |
| `glob` | Find files by pattern |
| `grep` | Regex content search (context lines, multiline, file-type filter, pagination) |
| `code_search` | Lower-noise code search (extension-provider aware) |
| `semantic_lookup` | Symbol/module/process-aware search backed by repo intelligence |
| `web_search` | Discovery-oriented web search with trust + freshness signals |
| `web_fetch` | Fetch a specific URL with provenance hints |

### Repo Intelligence (working tools)
| Tool | Description |
|------|-------------|
| `repo_overview` | Summarize structure, key areas, entry hints, intelligence snapshot |
| `changed_scope` | Which files/areas/categories the current diff touches |
| `changed_diff` | Paged diff slice for a single file |
| `changed_diff_bundle` | Paged diff slices for multiple files in one call |
| `module_context` | Module capsule (deps, entries, symbols, tests, docs) |
| `symbol_context` | Definition + probable callers/callees + alternatives |
| `process_context` | Approximate static execution capsule for an entry |
| `impact_estimate` | Blast radius for a symbol/path/module |

### MCP capabilities (when MCP servers are configured)
| Tool | Description |
|------|-------------|
| `mcp_search` / `mcp_describe` / `mcp_call` | Discover and invoke MCP tools through the shared capability runtime |
| `mcp_read_resource` / `mcp_get_prompt` | Read MCP resources and prompts |

### Git worktree
| Tool | Description |
|------|-------------|
| `worktree_create` | Create a new worktree on an isolated branch for safe agent work |
| `worktree_remove` | Remove a worktree (with safety checks) |

### Agent control & UX
| Tool | Description |
|------|-------------|
| `dispatch_child_task` | Spawn a sub-agent for an independent investigation/edit task. Optional `model_hint: 'fast' \| 'balanced' \| 'deep'` (advisory; routing no-op until FEATURE_102 v0.7.45). |
| `send_message` | Append an instruction to an in-flight child's queue — surfaces as `<coordinator-instruction>` at the child's next turn boundary. Coordinator-only. (FEATURE_120, v0.7.39) |
| `task_stop` | Request graceful exit of a specific child. Current tool finishes atomically, then the child sees a `<coordinator-stop-request>` and emits a final summary. Coordinator-only. (FEATURE_120, v0.7.39) |
| `ask_user_question` | Single/multi-select or free-text prompt back to the user |
| `exit_plan_mode` | Present a finalized plan for approval (REPL only) |
| `emit_managed_protocol` | Internal managed-task protocol side-channel for role payloads (handoff / verdict). V2 chain (Worker→Evaluator) is the default since v0.7.36 (FEATURE_114). |

---

## Skills System

KodaX includes a built-in Skills system that can be triggered by natural language:

```bash
# Natural language triggering (no explicit /skill needed)
kodax "帮我审查代码"           # Triggers code-review skill
kodax "写测试用例"             # Triggers tdd skill
kodax "提交代码"               # Triggers git-workflow skill

# Explicit skill command
kodax /skill:code-review
```

Built-in skills include:
- **code-review** - Code review and quality analysis
- **tdd** - Test-driven development workflow
- **git-workflow** - Git commit and workflow automation

Skills are stored in `~/.kodax/skills/` and can be extended with custom skills.

---

## Commands (CLI)

Commands are `/xxx` shortcuts in CLI:

```bash
kodax /review src/auth.ts
kodax /test
```

Commands are stored in `~/.kodax/commands/`:
- `.md` files → Prompt commands (content used as prompt)
- `.ts/.js` files → Programmable commands

---

## API Exports

```typescript
// Main functions
export { runKodaX, KodaXClient };

// Types
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// Tools
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Providers
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// Utilities
export {
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build
npm run build

# Optional: only build workspace packages
npm run build:packages

# Build standalone binary (current platform / all platforms)
npm run build:binary
npm run build:binary:all

# Run tests
npm test

# Eval-driven development tests (provider matrices, identity round-trip, etc.)
npm run test:eval

# Clean
npm run clean
```

### Repo Intelligence cache directories

KodaX now uses two repo-intelligence cache locations on disk:

- `.agent/repo-intelligence/`
  - OSS baseline repo-intelligence artifacts and existing task-engine snapshots.
- `.repointel/`
  - Premium `repointel` workspace cache shared by the local daemon/native frontdoor.

They are intentionally separated so:

- OSS fallback stays available even when premium is disabled or unavailable.
- Premium cache does not pollute OSS artifacts.
- KodaX and other hosts can share the same premium workspace cache.

`.repointel/` is a local generated directory and should not be committed.

---

## Code Style

### Comment Guidelines

KodaX uses an **English-first** comment style with selective Chinese brief notes for complex logic.

| Situation | Style | Example |
|-----------|-------|---------|
| Import/Export | English only | `// Import dependencies` |
| Simple constants | English only | `// Max retry count` |
| Simple logic | English only | `// Return if null` |
| **Business rules** | English + Chinese | `// Skip tool_result - 跳过工具结果块` |
| **Platform compatibility** | English + Chinese | `// Windows path handling - Windows 路径处理` |
| **Performance optimization** | English + Chinese | `// Debounce to prevent flicker - 防抖避免闪烁` |

---

## Documentation

- [README_CN.md](README_CN.md) - Chinese Documentation
- [docs/release.md](docs/release.md) - Standalone binary build & release pipeline
- [docs/PRD.md](docs/PRD.md) - Product Requirements
- [docs/ADR.md](docs/ADR.md) - Architecture Decisions
- [docs/HLD.md](docs/HLD.md) - High-Level Design
- [docs/DD.md](docs/DD.md) - Detailed Design
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature Tracking
- [docs/test-guides/](docs/test-guides/) - Feature-specific test guides
- [CHANGELOG.md](CHANGELOG.md) - Version History (v0.7.0+; [archive](docs/CHANGELOG_ARCHIVE.md) for older)

---

## License

[Apache License 2.0](LICENSE) - Copyright 2026 [icetomoyo](mailto:icetomoyo@gmail.com)
