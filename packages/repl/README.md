# @kodax-ai/repl

KodaX 的交互式终端层，基于 Ink/React，同时保留 readline 传统 REPL。源码开发时可从 `@kodax-ai/repl` 引入；npm SDK 用户通常从 `@kodax-ai/kodax/repl` 或更窄的 `@kodax-ai/kodax/session` 引入。

## 概述

`packages/repl` 负责终端体验和本地用户配置，不承载 coding agent 核心逻辑。主要能力包括：

- Ink TUI 入口：`runInkInteractiveMode`
- 传统 readline REPL：`runInteractiveMode`
- Slash command parsing / execution
- Provider、custom provider、MCP server 配置读写
- Permission mode helpers and path/tool allow logic
- File-backed session storage and public session-management SDK
- Terminal host detection and renderer policy

Bare `-r` starts with the searchable session picker rather than importing the
full CLI. Selecting a session transfers stdin to the resumed REPL; Esc releases
the picker stdin and returns to the invoking terminal. Auto Mode configuration
is passed to the Runtime guardrail, which decides before the permission UI.
Automatic large-context compaction is always enabled: `triggerPercent` defaults
to 75 (15-90), optional `triggerTokens` adds an absolute ceiling, and the smaller
effective threshold wins. Runtime-backed REPL paths let the Runtime own the
durable compact transaction and update only the local live projection after its
acknowledgement.

`session.resume` / `session.autoResume` selects the newest non-empty
conversation from a broad scan and skips zero-message ACP/bootstrap records.
The rule is shared by Ink and classic startup, and explicit IDs win. Both
interactive surfaces restore persisted workspace/runtime identity before the
next turn. Shift-Tab cycles Plan -> Edits -> Auto while Shift+Enter inserts a
newline; Auto displays its configured/persisted LLM or rules engine immediately.

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runInkInteractiveMode, loadConfig } from '@kodax-ai/kodax/repl';
import { listSessions } from '@kodax-ai/kodax/session';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { runInkInteractiveMode } from '@kodax-ai/repl';
```

## 启动 Ink REPL

```typescript
import { runInkInteractiveMode, type InkREPLOptions } from '@kodax-ai/kodax/repl';

const options: InkREPLOptions = {
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  session: {
    resume: true,
  },
};

await runInkInteractiveMode(options);
```

## 传统 REPL

```typescript
import { runInteractiveMode, type RepLOptions } from '@kodax-ai/kodax/repl';

const options: RepLOptions = {
  provider: 'zhipu-coding',
  reasoningMode: 'off',
};

await runInteractiveMode(options);
```

## 配置管理

```typescript
import {
  loadConfig,
  listCustomProviders,
  upsertCustomProvider,
  listMcpServers,
  upsertMcpServer,
} from '@kodax-ai/kodax/repl';

const config = loadConfig();
console.log(config.provider);

upsertCustomProvider({
  name: 'my-openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'MY_LLM_API_KEY',
  model: 'my-model',
});

console.log(listCustomProviders().length);
console.log(Object.keys(listMcpServers()).length);
upsertMcpServer('local-tools', { command: 'node', args: ['server.js'] });
```

## 权限与 Session SDK

```typescript
import {
  computeConfirmTools,
  isPermissionMode,
  listSessions,
  forkSession,
  watchSessions,
} from '@kodax-ai/kodax/repl';

if (!isPermissionMode('default')) {
  throw new Error('unexpected permission mode');
}

const confirmTools = computeConfirmTools('default');
console.log(confirmTools);

const firstPage = await listSessions({
  limit: 20,
  scope: 'user',
  surface: 'repl',
});
const first = firstPage[0];
const nextPage = firstPage.at(-1)?.cursor
  ? await listSessions({
      limit: 20,
      scope: 'user',
      surface: 'repl',
      cursor: firstPage.at(-1)?.cursor,
    })
  : [];

if (first) {
  await forkSession(first.id, { title: `${first.title} copy` });
}

const watcher = watchSessions((event) => {
  console.log(event.kind, event.sessionId);
});

watcher.close();
```

Session-only consumers can import the same session APIs from `@kodax-ai/kodax/session` to avoid the full REPL surface.

## 常用公开能力

- Entrypoints: `runInkInteractiveMode`, `runInteractiveMode`, `processSpecialSyntax`
- Commands: `InteractiveContext`, `parseCommand`, `executeCommand`, `BUILTIN_COMMANDS`
- Config: `loadConfig`, `prepareRuntimeConfig`, `saveConfig`, custom-provider CRUD, MCP-server CRUD
- Sessions: `FileSessionStorage`, `findMostRecentResumableSession`, `listSessions`, `loadSession`, `forkSession`, `rewindSession`, `archiveSession`, `watchSessions`
- Permissions: `computeConfirmTools`, `isPermissionMode`, `isToolCallAllowed`, `getPlanModeBlockReason`
- Headless events: JSON/CLI event output includes `sidecar.message` for Sidecar Verifier `revise` / `blocked` messages
- UI exports: `App`, `SimpleApp`, hooks, contexts, components, terminal-host utilities

## 构建与测试

```bash
npm run build -w @kodax-ai/repl
npm test -- packages/repl/src
```

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
