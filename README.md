# InfCodeX

[English](README.md) | [中文](README_CN.md)

**InfCodeX** is Tokfinity's next-generation AI coding CLI and execution-oriented agent runtime for real software engineering.

It is not just a terminal chatbot for code. It is a modular, TypeScript-native system that can run as a CLI, be embedded as a library, and evolve into the execution layer of a larger agent platform.

> Current repository alias and command name: **KodaX / `kodax`**. The repository name is **InfCodeX**, while parts of the codebase and docs still use the historical KodaX naming.

---

## Why InfCodeX

Most AI coding tools optimize for quick demos or single-turn assistance. InfCodeX is built around a different goal: **reliable engineering execution**.

InfCodeX matters because it combines:

- **CLI-first execution** for developers who work in the terminal
- **Agent runtime architecture** instead of a single monolithic app
- **Project-aware continuity** through session memory and long-running task flows
- **Safety and governance** through permission modes and confirmation boundaries
- **Modularity** through reusable packages and clear dependency boundaries
- **Future multi-agent evolution** through parallel execution, team mode, and skills

For Tokfinity, InfCodeX is important not only as a developer tool, but as a **software-engineering execution substrate** that can integrate with the broader **InfOne** intelligent-organization platform.

---

## Positioning

**InfCodeX is a production-oriented AI coding CLI and agent runtime for serious software engineering.**

It serves two roles at the same time:

1. **Developer-facing CLI**
   - inspect repositories
   - read and modify files
   - run commands
   - iterate across multi-step engineering tasks

2. **Platform-facing execution layer**
   - reusable as npm packages
   - suitable for orchestration by higher-level systems
   - extensible with providers, tools, skills, and project policies

---

## Core Highlights

### 1. Modular layered architecture
InfCodeX is structured as a monorepo with five major packages:

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`

This separation is one of the project's strongest differentiators. Each layer has a clear responsibility, and several layers are designed to be independently reusable.

### 2. CLI and library dual use
InfCodeX can be used as:

- a terminal coding agent for day-to-day development
- a library embedded into other products or agent systems

That makes it much more strategic than a purely interactive tool.

### 3. Multi-provider model abstraction
The project exposes a provider abstraction layer and currently documents support for built-in providers such as:

- Anthropic
- OpenAI
- Kimi
- Kimi Code
- Qwen
- Zhipu
- Zhipu Coding
- MiniMax Coding
- Gemini CLI
- Codex CLI

This helps teams avoid hard vendor lock-in and makes the runtime more suitable for cost optimization, regional routing, private deployment, and enterprise model governance.

### 4. Real coding-agent execution loop
InfCodeX is designed around action, not just answer generation. Its coding layer includes tools and an iterative agent loop so the system can work on actual repositories.

Documented built-in tool capabilities include:

- read
- write
- edit
- bash
- glob
- grep
- undo
- diff

### 5. Permission-aware autonomy
InfCodeX introduces three permission modes:

- `plan`
- `accept-edits`
- `auto-in-project`

This is a critical design choice. It lets teams balance safety and efficiency rather than forcing a binary choice between manual mode and unrestricted automation.

### 6. Session memory and long-running work
Real engineering is rarely completed in one turn. InfCodeX supports persistent sessions and long-running workflows so the agent can resume work, preserve context, and move a task forward across multiple steps.

### 7. Skills-driven specialization
The skills layer allows InfCodeX to be specialized beyond generic prompting. It supports built-in skills, discoverable skills, markdown-based skill definitions, and natural-language triggering.

### 8. Native path toward multi-agent workflows
The project already points toward coordinated agent execution through features such as:

- parallel execution
- team mode
- project initialization
- auto-continue

This gives InfCodeX a credible path from "AI CLI" to "multi-agent engineering runtime".

---

## Architecture Overview

```text
InfCodeX
├─ AI Layer        → provider abstraction, streaming, retry, capability handling
├─ Agent Layer     → sessions, messages, token utilities, compaction
├─ Skills Layer    → skill discovery, registry, execution
├─ Coding Layer    → tools, prompts, coding-agent loop, long-running workflows
└─ REPL / CLI      → interactive UX, permission control, commands, project flows
```

This design provides several advantages:

- **Clear separation of concerns**
- **Replaceable boundaries across provider, runtime, and UI layers**
- **Better testability and replacement boundaries**
- **Potential for independent package reuse**
- **A stronger foundation for future enterprise orchestration**

### Package Overview

| Package | Responsibility | Notes |
|---------|----------------|-------|
| `@kodax/ai` | Provider abstraction and model adapters | Supports built-in providers and custom compatible endpoints |
| `@kodax/agent` | Sessions, messages, tokens, and compaction | Reusable outside the coding workflow |
| `@kodax/skills` | Skill discovery and execution | Lightweight specialization layer |
| `@kodax/coding` | Tools, prompts, and coding-agent loop | Execution-oriented core runtime |
| `@kodax/repl` | Terminal UI and slash commands | Permission UX and interactive workflow layer |

### Dependency Shape

```text
kodax CLI entry
├─ @kodax/repl
│  └─ @kodax/coding
│     ├─ @kodax/ai
│     ├─ @kodax/agent
│     └─ @kodax/skills
└─ @kodax/coding
```

---

## Why InfCodeX is strategically important to InfOne

InfOne represents the broader vision of an **intelligent organization / AI org** platform: defining, governing, routing, and managing large-scale agents across business scenarios.

Within that picture, InfCodeX can play a highly specific and valuable role.

### InfOne as control plane
InfOne is suited to handle:

- agent registration and lifecycle management
- model routing and policy decisions
- organization-level memory and governance
- permissions, auditability, and observability
- multi-agent orchestration at scale

### InfCodeX as execution plane
InfCodeX is suited to handle:

- repository-local engineering execution
- coding tools and file operations
- project-aware task continuation
- engineering-specific skills and workflows
- interactive and semi-automatic task delivery

### Combined value
Without a strong execution layer, an agent management platform can become a dashboard without operational depth.
Without a strong management layer, a coding CLI remains a local power tool with limited organizational leverage.

**InfOne + InfCodeX** together form a more complete system:

- InfOne decides **which agents should do what**.
- InfCodeX carries out **how software-engineering work gets done**.

That is why InfCodeX is not merely "another coding CLI". It is a practical bridge between:

- single-developer AI assistance,
- repository-level engineering execution,
- organization-level agent management.

---

## Typical Use Cases

### 1. Terminal-native coding copilot
Developers use InfCodeX locally to inspect code, patch files, run commands, and iterate faster without leaving the terminal.

### 2. Multi-step feature delivery
A task can continue across sessions rather than being constrained to one-shot prompting.

### 3. Team-standard engineering agent
A team can combine common rules, selected models, and skills to create more consistent coding-agent behavior across repositories.

### 4. SDLC agent execution substrate
InfCodeX can serve as the execution layer for coding-oriented agents inside a broader SDLC agent stack, including future integration with code review, testing, or delivery workflows.

### 5. Enterprise-safe rollout path
Organizations can adopt it incrementally with permission modes, scoped automation, and provider flexibility.

---

## Feature Snapshot

- TypeScript-native implementation
- Monorepo with reusable packages
- CLI + library usage model
- Streaming output
- Thinking / reasoning mode support
- Session persistence
- Permission-aware execution
- Skills system
- Parallel execution
- Team mode
- Long-running project workflows
- Cross-platform usage on Windows / macOS / Linux

---

## Project Mode

| Feature | KodaX | Typical hosted coding assistant |
|---------|-------|----------------------------------|
| **Architecture** | Modular (5 packages), library-friendly | Usually product-first, less reusable as code |
| **Provider choice** | 11 providers, custom provider support | Often optimized for one provider |
| **Customization** | Edit prompts, tools, skills, session flow directly | Limited extension surface |
| **Codebase clarity** | Small TypeScript monorepo | Often much larger and harder to trace |
| **Learning value** | Good for understanding agent internals | More black-box |

## Quick Start

### Requirements

- Node.js `>=18.0.0`
- npm workspaces

### 1. Install and build

```bash
npm install
npm run build:packages
npm run build
npm link
```

### 2. Configure a provider

Built-in providers read credentials from environment variables:

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
  "reasoningMode": "auto",
  "permissionMode": "accept-edits",
  "parallel": false
}
```

If you need a custom base URL or an OpenAI/Anthropic-compatible endpoint:

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

```typescript
import { registerCustomProviders, runKodaX } from 'kodax';

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
    context: {
      gitRoot: '/repo',
      executionCwd: '/repo/packages/app',
    },
  },
  'Explain this codebase'
);
```

### Common examples

```bash
# session memory
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"

# parallel execution
kodax --parallel "analyze and improve this module"

# team mode
kodax --team "implement,review,test"

# initialize long-running project work
kodax --init "deliver feature X"

# auto-continue until complete
kodax --auto-continue --max-hours 2
```

---

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces, consisting of 5 packages:

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - Independent LLM abstraction layer
│   │   └── providers/       # 11 LLM providers (Anthropic, OpenAI, DeepSeek, etc.)
│   │
│   ├── agent/               # @kodax/agent - Generic Agent framework
│   │   └── session/         # Session management, message handling
│   │
│   ├── skills/              # @kodax/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # 8 tools: read, write, edit, bash, glob, grep, undo, ask_user_question
│   │
│   └── repl/                # @kodax/repl - Interactive terminal UI
│       ├── ui/              # Ink/React components, themes
│       └── interactive/     # Commands, REPL logic
│
├── src/
│   └── kodax_cli.ts         # Main CLI entry point
│
└── package.json             # Root workspace config
```

### Package Dependencies

```
                    ┌─────────────────┐
                    │   kodax (root)  │
                    │   CLI Entry     │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
       ┌─────────────┐               ┌─────────────┐
       │ @kodax/repl │               │@kodax/coding│
       │  UI Layer   │               │ Tools+Prompts│
       └──────┬──────┘               └──────┬──────┘
              │                             │
              │              ┌──────────────┼──────────────┐
              │              │              │              │
              ▼              ▼              ▼              ▼
       ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
       │@kodax/skills│ │ @kodax/agent│ │  @kodax/ai  │ │  External   │
       │(zero deps)  │ │Agent Frame  │ │LLM Abstract │ │   SDKs      │
       └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

### Package Overview

| Package | Purpose | Key Dependencies |
|---------|---------|------------------|
| `@kodax/ai` | Independent LLM abstraction, reusable by other projects | @anthropic-ai/sdk, openai |
| `@kodax/agent` | Generic Agent framework, session management | @kodax/ai, js-tiktoken |
| `@kodax/skills` | Skills standard implementation | Zero external deps |
| `@kodax/coding` | Coding Agent with tools and prompts | @kodax/ai, @kodax/agent, @kodax/skills |
| `@kodax/repl` | Complete interactive terminal UI | @kodax/coding, ink, react |

| Mode | Meaning |
|------|---------|
| `plan` | Read-only planning mode |
| `accept-edits` | Automatically accept file edits; confirm bash |
| `auto-in-project` | Full auto execution within project scope |

## Features

- **Modular Architecture** - Use as CLI or as a library
- **11 LLM Providers** - Anthropic, OpenAI, DeepSeek, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding, MiniMax Coding, Gemini CLI, Codex CLI
- **Reasoning Modes** - Unified `off/auto/quick/balanced/deep` interface across providers
- **Streaming Output** - Real-time response display
- **8 Tools** - read, write, edit, bash, glob, grep, undo, ask_user_question
- **Session Management** - JSONL format persistent storage
- **Project Mode / Harness Engineering** - Verifier-gated long-running workflow with project truth files and `/project` commands
- **Skills System** - Natural language triggering, extensible
- **Permission Control** - 3 permission modes with pattern-based control
- **Cross-Platform** - Windows/macOS/Linux
- **TypeScript Native** - Full type safety and IDE support
These modes make InfCodeX more suitable for serious environments where safety, auditability, and trust calibration matter.

---

## Detailed Usage

### REPL Quickstart

Running `kodax` with no prompt starts the interactive REPL:

```bash
kodax
```

Inside the REPL you can mix natural-language requests with slash commands:

```text
Read package.json and summarize the architecture
/model
/mode
/help
```

### CLI Quickstart

```bash
# Basic usage
kodax "Help me create a TypeScript project"

# Choose a provider explicitly
kodax --provider openai --model gpt-5.4 "Create a REST API"

# Use a deeper reasoning mode
kodax --reasoning deep "Review this architecture"
```

### Session Workflows

Use a session when you want memory across turns:

```bash
# No memory: two separate calls
kodax "Read src/auth.ts"
kodax "Summarize it"

# With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"
kodax --session auth-review "How should I fix the first issue?"

# Session management
kodax --session list
kodax --session resume "continue"
```

### Workflow Examples

```bash
# Code review
kodax --session review "Review src/"
kodax --session review "Focus on security issues"
kodax --session review "Give me fix suggestions"

# Project development
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
--team <tasks>       Run multiple sub-agents in parallel
--init <task>        Initialize a long-running task
--auto-continue      Continue long-running tasks until complete
--max-iter <n>       Max iterations
--max-sessions <n>   Max sessions for --auto-continue
--max-hours <n>      Max runtime hours for --auto-continue
```

### ACP Server

KodaX can also run as a stdio ACP server for editors and IDEs:

```bash
kodax acp serve
kodax acp serve --cwd /path/to/repo --permission-mode accept-edits
kodax acp serve -m openai --model gpt-5.4 --reasoning balanced
```

This mode exposes ACP `initialize`, `sessions/new`, `chat/prompt`, `chat/cancel`, streaming session updates, and permission requests while reusing KodaX's normal runtime and tool semantics.

ACP lifecycle logs are written to `stderr` so they do not pollute ACP `stdout`. Use `KODAX_ACP_LOG=off|error|info|debug` to control verbosity. The default is `info`.

ACP session `cwd` is passed into the coding runtime as an explicit `executionCwd`. If you start the server with `--cwd`, that value pins the execution root for every ACP session. Prompt context, relative file paths, and shell commands stay scoped to that explicit directory without mutating the Node.js process-global working directory.

### AAMP Server

KodaX can also run as an AAMP async task worker backed by `aamp-sdk`:

```bash
kodax aamp serve \
  --email agent@example.com \
  --jmap-token <token> \
  --jmap-url http://localhost:8080/jmap \
  --smtp-host localhost \
  --smtp-password <password>

KODAX_AAMP_EMAIL=agent@example.com \
KODAX_AAMP_JMAP_TOKEN=<token> \
KODAX_AAMP_JMAP_URL=http://localhost:8080/jmap \
KODAX_AAMP_SMTP_HOST=localhost \
KODAX_AAMP_SMTP_PASSWORD=<password> \
kodax aamp serve --cwd /path/to/repo -m openai --model gpt-5.4
```

This mode listens for AAMP `task.dispatch` messages, bridges each task into `runKodaX(...)`, and sends `task.result` replies back through the same mailbox transport.

Current v1 behavior:

- inbound `task.dispatch` is supported
- `taskId -> sessionId` is persisted locally so completed tasks are not re-executed
- outbound `task.result` is sent through the real AAMP SDK
- inbound `task.ack` is handled by `aamp-sdk` automatic acknowledgement logic

Required configuration can be passed either as CLI flags or environment variables:

- `KODAX_AAMP_EMAIL`
- `KODAX_AAMP_JMAP_TOKEN`
- `KODAX_AAMP_JMAP_URL`
- `KODAX_AAMP_SMTP_HOST`
- `KODAX_AAMP_SMTP_PASSWORD`

Optional flags:

- `--cwd`
- `--provider`
- `--model`
- `--smtp-port`
- `--allow-insecure-tls`

This first version intentionally focuses on the minimal async loop: `task.dispatch -> task.result`. Richer protocol flows such as `task.help_needed`, attachments, and structured result mapping can be layered on later without changing the KodaX runtime core.

### Permission Control

KodaX provides 3 permission modes for fine-grained control:

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

```bash
kodax -h sessions
kodax -h init
kodax -h project
kodax -h auto
kodax -h provider
kodax -h thinking
kodax -h team
kodax -h print
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
kodax -h acp           # ACP server mode
kodax -h aamp          # AAMP async task worker mode
kodax -h init          # Long-running project initialization
kodax -h project       # Project mode / harness workflow
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning mode
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
```

## Advanced Library Usage

### Simple Mode with `runKodaX`

```typescript
import { runKodaX, type KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`Thinking delta: ${text.length} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo/packages/service',
  },
  events,
}, 'What is 1+1?');

console.log(result.lastText);
```

### Continuous Session with `KodaXClient`

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

await client.send('Read package.json');
await client.send('Summarize it');

console.log(client.getSessionId());
```

### Custom Session Storage

```typescript
import { type KodaXMessage, type KodaXSessionStorage } from 'kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // Save to your own storage
  }

  async load(id: string) {
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo',
  },
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { ... },
}, 'task');
```

### Library Modes Comparison

| Feature | `runKodaX` | `KodaXClient` |
|---------|------------|---------------|
| Message memory | No | Yes |
| Call style | Function | Class instance |
| Context | Independent each time | Accumulates |
| Use case | Single tasks and batch work | Multi-step or interactive workflows |

### Working Directory Semantics

`runKodaX()` distinguishes between two related but different concepts:

- `context.gitRoot`: the project root used for project-scoped prompts and permission logic.
- `context.executionCwd`: the working directory used for prompt context, relative tool paths, and shell execution.

If `executionCwd` is omitted, KodaX falls back to `gitRoot`, then `process.cwd()`.

```typescript
await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo/packages/web',
  },
}, 'Review the current package and run local checks');
```

This is especially useful for monorepos where the project root and the active package directory are not the same.

---

## Using Individual Packages

KodaX is built with a modular architecture. Each package can be used independently:

### @kodax/ai - LLM Abstraction Layer

Independent LLM provider abstraction, reusable in any project:

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax/ai';

// Get a provider instance
const provider = getProvider('anthropic');

// Stream completion
const stream = await provider.streamCompletion(
  [{ role: 'user', content: 'Hello!' }],
  { onTextDelta: (text) => process.stdout.write(text) }
);

for await (const result of stream) {
  if (result.type === 'text') {
    // Handle text delta
  } else if (result.type === 'tool_use') {
    // Handle tool call
  }
}
```

**Key Features**:
- 11 LLM providers with unified interface
- Streaming output support
- Thinking mode support
- Error handling and retry logic
- Zero business logic dependencies

### @kodax/agent - Agent Framework

Generic agent framework with session management:

```typescript
import {
  generateSessionId,
  estimateTokens,
  compactMessages,
  type KodaXMessage
} from '@kodax/agent';

// Generate session ID
const sessionId = generateSessionId();

// Estimate tokens
const tokens = estimateTokens(messages);

// Compact messages when context is too long
if (tokens > 100000) {
  const compacted = await compactMessages(messages, {
    threshold: 75000,
    keepRecent: 20
  });
}
```

**Key Features**:
- Session ID generation and title extraction
- Token estimation (tiktoken-based)
- Message compaction with AI summarization
- Generic types for messages and tools

### @kodax/skills - Skills System

Agent Skills standard implementation with zero external dependencies:

```typescript
import {
  SkillRegistry,
  discoverSkills,
  executeSkill,
  type SkillContext
} from '@kodax/skills';

// Discover skills from paths
const skills = await discoverSkills(['/path/to/skills']);

// Initialize registry
const registry = getSkillRegistry();
await registry.registerSkills(skills);

// Execute a skill
const context: SkillContext = {
  skillId: 'code-review',
  arguments: { target: 'src/' },
  workingDirectory: process.cwd()
};

const result = await executeSkill(context);
```

### `@kodax/ai`

Use when you only need provider abstraction, streaming, and reasoning compatibility.

### `@kodax/agent`

Use when you need sessions, message handling, token estimation, or compaction behavior.

### `@kodax/skills`

Use when you want markdown-based skill discovery and execution without pulling in the full coding runtime.

### `@kodax/coding`

Use when you want the complete coding-agent loop, tool execution, prompts, and session-aware task handling.

### `@kodax/repl`

Use when you want the interactive terminal UI, slash-command system, and permission UX.

---

## Supported Providers

| Provider | Environment Variable | Reasoning Support | Default Model |
|----------|----------------------|-------------------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Native budget | claude-sonnet-4-6 |
| openai | `OPENAI_API_KEY` | Native effort | gpt-5.3-codex |
| deepseek | `DEEPSEEK_API_KEY` | Native toggle on `deepseek-chat`; model-selected reasoning on `deepseek-reasoner` | deepseek-chat |
| kimi | `KIMI_API_KEY` | Native effort | k2.5 |
| kimi-code | `KIMI_API_KEY` | Native budget | k2.5 |
| qwen | `QWEN_API_KEY` | Native budget | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native budget | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Native budget | glm-5 |
| minimax-coding | `MINIMAX_API_KEY` | Native budget | MiniMax-M2.7 |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

### Examples

```bash
# Use Zhipu Coding
kodax --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "Create a REST API"

# Use DeepSeek
export DEEPSEEK_API_KEY=your_key
kodax --provider deepseek "Summarize this repository"
kodax --provider deepseek --model deepseek-reasoner "Think through this refactor plan"

# Resume last session
kodax --session resume

# List all sessions
kodax --session list

# Parallel tool execution
kodax --parallel "Read package.json and tsconfig.json"

# Agent Team
kodax --team "Analyze code structure,Check test coverage,Find bugs"

# Long-running project
kodax --init "Build a Todo application"
kodax --auto-continue --max-hours 2
```

---

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents with offset and limit support |
| `write` | Write a file |
| `edit` | Exact string replacement with `replace_all` support |
| `bash` | Execute shell commands |
| `glob` | File pattern matching |
| `grep` | Content search |
| `undo` | Revert the last modification |
| `ask_user_question` | Ask the user to choose between options |

---

## Skills System

The KodaX branch also introduced a more explicit skills story that remains relevant in InfCodeX.

Examples:

```bash
kodax "Help me review this code"
kodax "Write tests for this module"
kodax /skill:code-review
```

Built-in skills include:

- `code-review`
- `tdd`
- `git-workflow`

Custom skills can live under `~/.kodax/skills/`.

---

## Commands

Commands are `/xxx` shortcuts exposed through the CLI and REPL experience.

```bash
kodax /review src/auth.ts
kodax /test
```

Command definitions live in `~/.kodax/commands/`:

- `.md` files provide prompt commands
- `.ts` / `.js` files provide programmable commands

---

## Configuration

The repository includes a configuration template with:

- default provider selection
- provider model selection
- provider model overrides
- custom provider definitions
- unified reasoning mode
- compaction settings
- permission mode defaults

The current documented config path is:

```text
~/.kodax/config.json
```

See `config.example.jsonc` for the full template.

---

## Development

```bash
# Development mode
npm run dev "your task"

# Build all packages
npm run build:packages

# Build the root CLI
npm run build

# Run tests
npm test

# Clean generated artifacts
npm run clean
```

---

## Design Philosophy

InfCodeX is guided by several principles:

- **Transparent over black-box**
- **Composable over monolithic**
- **Execution-oriented over chat-oriented**
- **Governable over uncontrolled**
- **Evolvable over one-off**

This is what makes the project valuable not only as a CLI, but as a foundation for a broader engineering-agent ecosystem.

---

## Roadmap Direction

Based on the existing repo structure and internal documents, the natural forward path includes:

- [README_CN.md](README_CN.md) - Chinese documentation
- [docs/ADR.md](docs/ADR.md) - Architecture decision records
- [docs/HLD.md](docs/HLD.md) - High-level design
- [docs/DD.md](docs/DD.md) - Detailed design
- [docs/PRD.md](docs/PRD.md) - Product requirements
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature tracker and roadmap
- [docs/features/README.md](docs/features/README.md) - Feature design index
- [docs/test-guides/](docs/test-guides/) - Feature-specific test guides
- [CHANGELOG.md](CHANGELOG.md) - Version history

---

## License

[Apache License 2.0](./LICENSE)

---

## Summary

**InfCodeX is important because it is not only a CLI.**

It is a practical execution runtime for software-engineering agents, and it has the right architecture to grow from a powerful terminal tool into a key execution component inside Tokfinity's larger intelligent-agent platform strategy.
