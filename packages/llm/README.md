# @kodax-ai/llm

KodaX 的独立 LLM 抽象层。源码开发时可从 `@kodax-ai/llm` 引入；npm SDK 用户通常安装单包 `@kodax-ai/kodax`，再从 `@kodax-ai/kodax/llm` 引入同一公开能力。

## 概述

`packages/llm` 负责 provider registry、OpenAI / Anthropic 兼容适配、reasoning 模式、model capability snapshot、credential verification、cost tracking 和 side-query。它不依赖 `agent` / `coding` / `repl`，可独立复用。

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { getProvider, listBuiltinModelCapabilities } from '@kodax-ai/kodax/llm';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { getProvider } from '@kodax-ai/llm';
```

## 内置 Provider Alias

Capability 数据的单一来源是 `src/providers/provider-capabilities.json`（当前更新时间：2026-06-14）。

| Alias | Environment variable | Reasoning | Default model |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Yes | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | Yes | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | Yes | `deepseek-v4-flash` |
| `kimi` | `KIMI_API_KEY` | Yes | `kimi-k2.6` |
| `kimi-code` | `KIMI_CODE_API_KEY` | Yes | `kimi-for-coding` |
| `qwen` | `QWEN_API_KEY` | Yes | `qwen3.5-plus` |
| `zhipu` | `ZHIPU_API_KEY` | Yes | `glm-5` |
| `zhipu-coding` | `ZHIPU_CODING_API_KEY` | Yes | `glm-5` |
| `minimax-coding` | `MINIMAX_CODING_API_KEY` | Yes | `MiniMax-M2.7` |
| `mimo-coding` | `MIMO_CODING_API_KEY` | Yes | `mimo-v2.5-pro` |
| `mimo` | `MIMO_API_KEY` | Yes | `mimo-v2.5-pro` |
| `ark-coding` | `ARK_CODING_API_KEY` | Yes | `glm-5.1` |
| `gemini-cli` | `GEMINI_API_KEY` | No | CLI bridge default |
| `codex-cli` | `OPENAI_API_KEY` | No | CLI bridge default |

2026-06-14 模型快照重点：

- OpenAI 默认 `gpt-5.3-codex`，并提供 `gpt-5.4` / `gpt-5.3-codex-spark`。
- Kimi 默认 `kimi-k2.6`，并提供 `kimi-k2.7-code`（256K）/ `k2.5`。
- Zhipu / Zhipu Coding 默认 `glm-5`，并提供 `glm-5.2`（1M context, 131072 max output）/ `glm-5.1` / `glm-5-turbo`。
- MiniMax Coding 默认 `MiniMax-M2.7`，并保留 `MiniMax-M3`（Frontier Coding, native multimodal, 1M context）/ `MiniMax-M2.7-highspeed`；旧 M2.5/M2.1/M2 路由已移除。
- Ark Coding 默认 `glm-5.1`，同一 gateway 暴露 GLM、Kimi K2.6、MiniMax M3/M2.7、DeepSeek V3.2/V4、Doubao Seed 2.0 Code/Pro/Lite。

## 使用示例

```typescript
import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax-ai/kodax/llm';

const provider = getProvider('zhipu-coding');

if (!provider.isConfigured()) {
  throw new Error('Set ZHIPU_CODING_API_KEY before calling zhipu-coding');
}

const messages: KodaXMessage[] = [
  { role: 'user', content: 'Hello, world!' },
];
const tools: KodaXToolDefinition[] = [];

const result = await provider.stream(
  messages,
  tools,
  'You are a concise assistant.',
  { mode: 'auto' },
  {
    onTextDelta: (text) => process.stdout.write(text),
    onThinkingDelta: (text) => process.stderr.write(text),
  },
);

console.log(result.text);
```

## 常用公开能力

- Provider registry: `getProvider`, `getProviderList`, `isProviderConfigured`, `registerCustomProviders`, `resolveProvider`
- Model capability: `listBuiltinModelCapabilities`, `getModelCapabilities`, `listAllModelCapabilities`
- Credential probe: `verifyProviderCredential`, `listProviderModels`, `runVerifyCredential`
- Reasoning helpers: `normalizeReasoningRequest`, `resolveThinkingBudget`, `getReasoningCapability`
- Custom provider base classes: `KodaXBaseProvider`, `KodaXAnthropicCompatProvider`, `KodaXOpenAICompatProvider`
- Cost and retry helpers: `createCostTracker`, `calculateCost`, `parseRetryAfter`

## 构建与测试

```bash
npm run build -w @kodax-ai/llm
npm test -- packages/llm/src
```

## License

Apache-2.0
