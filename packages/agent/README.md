# @kodax-ai/agent

通用 Agent 框架。源码开发时可从 `@kodax-ai/agent` 引入；npm SDK 用户通常安装单包 `@kodax-ai/kodax`，再从 `@kodax-ai/kodax/agent`、`/skills` 或 `/mcp` 引入需要的能力。

## 概述

`packages/agent` 是 KodaX 的平台层，不包含 coding 业务工具。当前包内聚合了 v0.7.43 之后内联的能力子树：

- Layer A primitives: `Agent`, `Runner`, handoff, guardrail, compaction policy
- Runtime substrate: admission, runtime middleware, idle-yield, child task registry
- Session lineage: branchable session tree、compaction、persistence helpers
- Capabilities: MCP integration、Skills loader、builtin skills
- Observability: tracing spans / trace store
- Workflow runtime: domain-neutral workflow execution primitives plus `WorkflowProcessEvent` / `WorkflowProcessSnapshot` process types

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { createAgent, Runner } from '@kodax-ai/kodax/agent';
import { SkillRegistry } from '@kodax-ai/kodax/skills';
import { createMcpManager } from '@kodax-ai/kodax/mcp';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { createAgent, Runner } from '@kodax-ai/agent';
```

## 最小 Agent / Runner 示例

```typescript
import { createAgent, Runner } from '@kodax-ai/kodax/agent';

const agent = createAgent({
  name: 'summary-agent',
  instructions: 'Summarize the user request in one sentence.',
  reasoning: { default: 'off' },
});

const result = await Runner.run(agent, 'Explain the current task', {
  llm: async (messages) => {
    const last = messages.at(-1);
    return `Summary: ${typeof last?.content === 'string' ? last.content : 'request received'}`;
  },
  tracer: null,
});

console.log(result.output);
```

The generic `Runner` path can be used with a caller-provided `llm` callback. The coding preset wires a richer substrate through `@kodax-ai/coding` / `@kodax-ai/kodax/coding`.

## 常用公开能力

- Agent primitives: `createAgent`, `createHandoff`, `Runner`, `DefaultSummaryCompaction`
- Runtime helpers: `runFanOut`, `runWithIdleYield`, `ChildTaskRegistry`
- Session lineage: session tree, compaction, archive markers, persistence types
- Skills: `SkillRegistry`, `loadFullSkill`, `expandSkillForLLM`
- MCP: `McpCapabilityProvider`, `createMcpTransport`, catalog helpers
- Tracing: trace / span primitives and stores
- Workflow: `createWorkflowRuntime`, `runWorkflow`, `WorkflowAbortError`, `WorkflowLimitError`, `WorkflowProcessEvent`, `WorkflowProcessSnapshot`, `isFinalWorkflowProcessStatus`

## Subpath 说明

根 npm 包 `@kodax-ai/kodax` 暴露：

- `/agent`: agent 完整公开 API
- `/skills`: skills 窄子集，只给 skill loader / IDE 插件等轻量消费者
- `/mcp`: MCP 窄子集，只给 MCP server host / popout UI 等轻量消费者

源码包 `@kodax-ai/agent` 还保留内部子路径，例如 `@kodax-ai/agent/workflow`，但根发布包没有 `@kodax-ai/kodax/agent/workflow` 这个 subpath；SDK 用户从 `/agent` 引入 workflow 符号即可。

## 构建与测试

```bash
npm run build -w @kodax-ai/agent
npm test -- packages/agent/src
```

## License

Apache-2.0
