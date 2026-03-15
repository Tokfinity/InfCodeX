# KodaX

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is a **modular, lightweight AI coding agent** built with TypeScript. It supports 7 LLM providers and can be used as both a CLI tool and an npm library.

**Core Philosophy**: Transparent, Flexible, Minimalist

**Why KodaX?**

| Feature | KodaX | Other Tools |
|---------|-------|-------------|
| **Architecture** | Modular (5 packages), can be used as library | Usually CLI-only |
| **Code** | Clean separation, easy to understand and customize | Thousands of files, hard to navigate |
| **Models** | 10 LLM providers, switch freely | Often single provider |
| **Cost** | Use affordable models (Kimi, Zhipu, Qwen) | Expensive subscriptions |
| **Type Safety** | Native TypeScript | No types or weak typing |
| **Learning** | Perfect for understanding Agent principles | Black box |

---

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces, consisting of 5 packages:

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - Independent LLM abstraction layer
│   │   └── providers/       # 7 LLM providers (Anthropic, OpenAI, etc.)
│   │
│   ├── agent/               # @kodax/agent - Generic Agent framework
│   │   └── session/         # Session management, message handling
│   │
│   ├── skills/              # @kodax/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # 8 tools: read, write, edit, bash, glob, grep, undo, diff
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

---

## Features

- **Modular Architecture** - Use as CLI or as a library
- **10 LLM Providers** - Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding, MiniMax Coding, Gemini CLI, Codex CLI
- **Thinking Mode** - Deep reasoning support (anthropic, kimi-code, zhipu-coding, minimax-coding)
- **Streaming Output** - Real-time response display
- **8 Tools** - read, write, edit, bash, glob, grep, undo, diff
- **Session Management** - JSONL format persistent storage
- **Skills System** - Natural language triggering, extensible
- **Permission Control** - 4-level modes with pattern-based control
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

# Build all packages
npm run build:packages
npm run build

# Link globally (development mode)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
```

### As Library

```bash
npm install kodax
```

```typescript
import { runKodaX, KodaXClient } from 'kodax';

// Simple usage
const result = await runKodaX({
  provider: 'zhipu-coding',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onComplete: () => console.log('\nDone!'),
  },
}, 'your task');

console.log(result.lastText);
```

---

## Usage

### CLI Usage

```bash
# Set API Key
export ZHIPU_API_KEY=your_api_key

# Basic usage
kodax "Help me create a TypeScript project"

# Or use node directly
node dist/kodax_cli.js "your task"
```

### Session Mode (With Memory)

```bash
# Start a session with specific ID
kodax --session my-project "Read package.json"

# Continue same session (has context memory)
kodax --session my-project "Summarize it"

# List all sessions
kodax --session list

# Resume last session
kodax --session resume "continue"
```

### No Memory vs With Memory

```bash
# ❌ No memory: two independent calls
kodax "Read src/auth.ts"           # Agent reads and responds
kodax "Summarize it"               # Agent doesn't know what to summarize

# ✅ With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"        # Agent knows to summarize auth.ts
kodax --session auth-review "How to fix first issue"  # Agent has context
```

### Common Scenarios

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

### CLI Options

```
-h, --help [topic]  Show help, or detailed help for a topic
--provider <name>   LLM provider (default: zhipu-coding)
--thinking          Enable thinking mode
--no-confirm        Enable auto mode (skip all confirmations)
--session <id>      Session: resume, list, or specific ID
--parallel          Parallel tool execution
--team <tasks>      Run multiple agents in parallel
--init <task>       Initialize long-running project
--auto-continue     Auto-continue until complete
--max-iter <n>      Maximum iterations (default: 200)
--max-sessions <n>  Maximum sessions for --auto-continue (default: 50)
--max-hours <h>     Maximum hours for --auto-continue (default: 2.0)
```

### Permission Control

KodaX provides 4-level permission modes for fine-grained control:

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `default` | Safe mode (default) | write, edit, bash |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

```bash
# In REPL, use /mode command
/mode plan          # Switch to plan mode (read-only)
/mode accept-edits  # Switch to accept-edits mode
/mode auto          # Switch to auto-in-project mode

# Check current mode
/mode
```

**Features:**
- Auto-switch to `accept-edits` when selecting "always" in default mode
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
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning mode
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
```

### Library Usage

#### Simple Mode (runKodaX)

```typescript
import { runKodaX, KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text, charCount) => console.log(`Thinking: ${charCount} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}: ${result.content.slice(0, 100)}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events,
  auto: true,
}, 'What is 1+1?');

console.log(result.lastText);
```

#### Continuous Session (KodaXClient)

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
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
import { runKodaX, KodaXSessionStorage, KodaXMessage } from 'kodax';

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
- 10 LLM providers with unified interface
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

**Key Features**:
- Zero external dependencies
- Markdown-based skill files
- Natural language triggering
- Variable resolution
- Built-in skills included

### @kodax/coding - Coding Agent

Complete coding agent with tools and prompts:

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax/coding';

// Use runKodaX for single tasks
const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events: {
    onTextDelta: (text) => process.stdout.write(text)
  }
}, 'Read package.json and explain the dependencies');

// Or use KodaXClient for continuous sessions
const client = new KodaXClient({
  provider: 'anthropic',
  events: { ... }
});

await client.send('Create a new file');
await client.send('Add a function to it'); // Has context from previous message
```

**Key Features**:
- 8 built-in tools (read, write, edit, bash, glob, grep, undo, diff)
- System prompts for coding tasks
- Agent loop implementation
- Session management
- Auto-continue mode

### @kodax/repl - Interactive Terminal UI

Complete interactive REPL with Ink/React components:

```typescript
// Usually used as CLI, but can be integrated
import { InkREPL } from '@kodax/repl';

// The REPL package provides:
// - Interactive terminal UI
// - Permission control (4 modes)
// - Command system (/help, /mode, etc.)
// - Skills integration
// - Theme support
```

**Key Features**:
- Ink-based React components
- 4-level permission control
- Built-in commands
- Real-time streaming display
- Context usage indicator

### Package Dependency Graph

```
@kodax/ai (零业务依赖)
    ↓
@kodax/agent (依赖 @kodax/ai)
    ↓
@kodax/skills (零外部依赖)  →  @kodax/coding (依赖 ai, agent, skills)
                                        ↓
                                  @kodax/repl (依赖 coding, ink, react)
```

**Import Recommendations**:

| Use Case | Package | Why |
|----------|---------|-----|
| Only need LLM abstraction | `@kodax/ai` | Minimal dependencies |
| Building custom agent | `@kodax/agent` | Session + messages + tokenization |
| Using skills system | `@kodax/skills` | Zero deps, pure skills |
| Coding tasks | `@kodax/coding` | Complete coding agent |
| Terminal app | `@kodax/repl` | Full interactive experience |

---

| Provider | Environment Variable | Thinking | Default Model |
|----------|---------------------|----------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Yes | claude-sonnet-4-6 |
| openai | `OPENAI_API_KEY` | No | gpt-5.3-codex |
| kimi | `KIMI_API_KEY` | Yes | k2.5 |
| kimi-code | `KIMI_API_KEY` | Yes | k2.5 |
| qwen | `QWEN_API_KEY` | No | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | No | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Yes | glm-5 |
| minimax-coding | `MINIMAX_API_KEY` | Yes | MiniMax-M2.5 |
| gemini-cli | `GOOGLE_APPLICATION_CREDENTIALS` | Yes | (via gemini CLI) |
| codex-cli | `GOOGLE_APPLICATION_CREDENTIALS` | Yes | (via codex CLI) |

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

# Agent Team
kodax --team "Analyze code structure,Check test coverage,Find bugs"

# Long-running project
kodax --init "Build a Todo application"
kodax --auto-continue
```

---

## Tools

| Tool | Description |
|------|-------------|
| read | Read file contents (supports offset/limit) |
| write | Write to file |
| edit | Exact string replacement (supports replace_all) |
| bash | Execute shell commands |
| glob | File pattern matching |
| grep | Content search (supports output_mode) |
| undo | Revert last modification |
| diff | Compare files or show changes |

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
  estimateTokens, compactMessages,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal, checkAllFeaturesComplete, getFeatureProgress
};
```

---

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build all packages
npm run build:packages

# Build
npm run build

# Run tests
npm test

# Clean
npm run clean
```

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

- [README_CN.md](docs/README_CN.md) - Chinese Documentation
- [DESIGN.md](docs/DESIGN.md) - Architecture and Implementation Details
- [TESTING.md](docs/TESTING.md) - Testing Guide
- [test-guides/](docs/test-guides/) - Feature-specific test guides
- [LONG_RUNNING_GUIDE.md](docs/LONG_RUNNING_GUIDE.md) - Long-Running Mode Guide
- [CHANGELOG.md](CHANGELOG.md) - Version History

---

## License

MIT
