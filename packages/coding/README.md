# @kodax-ai/coding

KodaX Coding Agent 的核心实现，包含 coding preset、tool registry、role prompts、repo intelligence、session/runtime middleware、extension runtime 和 workflow integration。源码开发时可从 `@kodax-ai/coding` 引入；npm SDK 用户通常从 `@kodax-ai/kodax/coding` 引入。

## 概述

`packages/coding` 依赖 `llm` 和 `agent`，但不依赖 `repl`。它是“可嵌入的 coding agent”，适合 CLI、IDE、桌面壳或自动化宿主直接调用。

当前内置工具不是早期的 8 个文件工具，而是 50+ 个扁平 tool definition，按职责大致分为：

- 文件与搜索：`read`, `write`, `edit`, `multi_edit`, `insert_after_anchor`, `glob`, `grep`, `undo`
- Shell / Web：`bash`, `web_search`, `web_fetch`
- Agent 协作与控制：`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `agent_output`
- MCP：`mcp_search`, `mcp_describe`, `mcp_call`, resource / prompt helpers
- Worktree / user interaction / goal / todo：`worktree_create`, `ask_user_question`, `get_goal`, `todo_update`, ...
- Repo intelligence / LSP：`repo_overview`, `changed_scope`, `module_context`, `lsp_definition`, `symbol_context`, `impact_estimate`, ...
- Construction and self-extension: tool/agent scaffold, validate, stage, test, activate, self-modify helpers

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax-ai/kodax/coding';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { runKodaX } from '@kodax-ai/coding';
```

## 单次任务

```typescript
import { runKodaX, type KodaXEvents } from '@kodax-ai/kodax/coding';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onToolResult: (result) => console.log(`[tool] ${result.name}`),
  onComplete: () => console.log('\nDone'),
};

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'auto',
    events,
  },
  'Read package.json and summarize the workspace.',
);

console.log(result.lastText);
```

## 连续会话

```typescript
import { KodaXClient } from '@kodax-ai/kodax/coding';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

await client.send('Read package.json');
await client.send('What workspace packages exist?');

console.log(client.getSessionId());
console.log(client.getMessages().length);
```

## 长运行任务句柄

```typescript
import { startKodaX } from '@kodax-ai/kodax/coding';

const session = startKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'balanced',
    events: {
      onTextDelta: (text) => process.stdout.write(text),
    },
  },
  'Investigate the failing tests.',
);

const result = await session.result;
console.log(result.success);
```

## 常用公开能力

- Run API: `runKodaX`, `startKodaX`, `KodaXClient`
- Tools: `KODAX_TOOLS`, `executeTool`, `registerTool`, `KODAX_TOOL_REQUIRED_PARAMS`
- Repo intelligence: protocol helpers and premium/native mode integration
- Provider policy: capability checks, model hints, fallback helpers
- Workflows: `createCodingWorkflowBackend`, `runWorkflowFromOptions`, `generateWorkflowFromOptions`, `createWorkflowRunManager`, `createWorkflowLifecycleController`, built-in/saved workflow discovery
- Events: `KodaXEvents.onSidecarMessage` surfaces Sidecar Verifier `revise` / `blocked` messages for SDK and headless hosts
- Types: `KodaXOptions`, `KodaXResult`, `KodaXEvents`, `KodaXSidecarMessageEvent`, `KodaXToolExecutionContext`, session and task types

## 构建与测试

```bash
npm run build -w @kodax-ai/coding
npm test -- packages/coding/src
```

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
