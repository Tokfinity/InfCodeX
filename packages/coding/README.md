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

`wait_agent` is a model-facing mailbox yield, not an Actor event reader. It
wakes for scoped Agent messages/completions, root user input, interruption, or
timeout; progress events remain available to UI and SDK event consumers without
resampling the parent model. The tool returns only a wake acknowledgement;
authenticated Agent evidence and structured completion metadata are injected
once at the next safe Runner boundary. Use `list_agents` for tree state and
`agent_output` for a targeted known result. SDK callers that need raw event
replay/long-poll continue to use the Actor event APIs directly.

v0.7.77 adds one shared six-pattern AMA catalog. The Worker composes useful
stages through the existing Actor tools and may attach validated
`quality_strategy` metadata; coding derives a bounded, fact-only
`PatternTrace` for the existing Sidecar. This does not activate Workflow,
create a fixed Agent topology, or add another quality judge.

The same release adds the JSON-only `KodaXShellExecutionContract`. Configured
Runtime sessions and runs resolve a credential-filtered shell environment in
the effective cwd, execute through the same explicit interpreter, inherit the
contract into native children and deterministic evaluators, and bind exact
command grants to the contract fingerprint. The feature is opt-in; callers
without `shellExecution` keep the legacy platform-shell interpreter path.
Credential-shaped variables are filtered from every model-issued command path.
The KodaX CLI can restore exact host variables only for the final command target
through user-level `sandbox.envPass`; its default list is empty and
execution-control variables remain blocked.

SDK callers use the same Run-scoped shape without changing global state:

```ts
await runKodaX({
  provider: 'openai',
  sandbox: { envPass: ['GH_TOKEN'] },
}, 'Inspect the authenticated repository.');
```

The same release replaces asynchronous semantic memory prefetch with sparse
foreground intervention after tool/verification failure or committed
compaction. The default path performs deterministic exact selection with zero
selector calls. Inline hosts may opt into `memoryRecallRunner` or construct the
coding-owned forced-tool selector with
`createCodingMemoryInterventionRunner()`.

Auto Mode is enforced by the active Runtime guardrail before the generic
permission bridge. A host only receives a permission request for an explicit
guardrail escalation; Runtime sessions retain the selected/fallback LLM or
rules engine across turns.

When `session.autoResume` or `session.resume` is set without an explicit ID,
the coding-runtime middleware requests a broad newest-first list and selects the
first record with `msgCount > 0`; empty ACP/bootstrap placeholders cannot shadow
the latest real conversation. A caller-provided ID always wins.

The v0.7.79 release scopes parallel quality-strategy admission to the same
parent Actor state, so unrelated child/progress updates do not create a false
conflict. Its built-in `kodax_manual` also documents current DeepSeek/custom
provider fields, configured-A2A network authorization, strict Session reads and
export, the evidence-checked ordinary-conversation projection, Runtime
status/diagnostic/coalescing capabilities, and the open Windows descendant-
containment boundary tracked as Issue 256.

The v0.7.80 release makes AMA parallel-first (independent lanes fan out
through ordinary Actor operations while indivisible work stays solo), bounds one
uninterrupted managed tool loop by a 500-iteration panic fuse that resets on
every idle-yield resume (the managed-task lifecycle stays unbounded), and lets
the CLI honor `worker.configuredA2A` from `~/.kodax/config.json` for a
Worker-hosted embedded Runtime. `kodax_manual` documents the same surface.

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
- Adaptive AMA: shared pattern catalog, strategy validation, bounded
  `PatternTrace`, and Sidecar strategy context
- Shell execution: `KodaXShellExecutionContract`,
  `normalizeShellExecutionContract`, `shellExecutionContractFingerprint`, and
  `clearShellExecutionEnvironmentCache`
- Governed memory: `createCodingMemoryInterventionRunner` for host-opt-in
  semantic selection; deterministic intervention remains the default
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
