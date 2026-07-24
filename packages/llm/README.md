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

Capability 数据的单一来源是 `src/providers/provider-capabilities.json`（当前更新时间：2026-07-25）。

| Alias | Environment variable | Reasoning | Default model |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Yes | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | Yes | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | Yes | `deepseek-v4-flash` |
| `kimi` | `KIMI_API_KEY` | Yes | `kimi-k2.7-code` |
| `kimi-code` | `KIMI_CODE_API_KEY` | Yes | `k3-256k` |
| `qwen` | `QWEN_API_KEY` | Yes | `qwen3.5-plus` |
| `qwen-token-plan` | `QWEN_TOKEN_API_KEY` | Yes | `qwen3.8-max-preview` |
| `zhipu` | `ZHIPU_API_KEY` | Yes | `glm-5` |
| `zhipu-coding` | `ZHIPU_CODING_API_KEY` | Yes | `glm-5.2` |
| `minimax-coding` | `MINIMAX_CODING_API_KEY` | Yes | `MiniMax-M3` |
| `mimo-coding` | `MIMO_CODING_API_KEY` | Yes | `mimo-v2.5-pro` |
| `mimo` | `MIMO_API_KEY` | Yes | `mimo-v2.5-pro` |
| `ark-coding` | `ARK_CODING_API_KEY` | Yes | `glm-5.2` |
| `gemini-cli` | `GEMINI_API_KEY` | No | CLI bridge default |
| `codex-cli` | `OPENAI_API_KEY` | No | CLI bridge default |

2026-07-25 模型快照重点：

- OpenAI 默认 `gpt-5.3-codex`，并提供 `gpt-5.4` / `gpt-5.3-codex-spark`。
- Qwen Token Plan 使用 Anthropic 兼容端点，默认 `qwen3.8-max-preview`，并提供 `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro`；六个模型均为 1M context。`qwen3.8-max-preview`、`qwen3.7-plus`、`qwen3.6-flash` 支持图片理解，其余三个为纯文本；Qwen 3.8 的思考模式不可关闭。
- Kimi 默认 `kimi-k2.7-code`（思考始终开启），并提供同模型高速路由 `kimi-k2.7-code-highspeed`，以及可切换思考的 `kimi-k2.6` / `kimi-k2.5`；四者上下文均为 262,144 token。
- Kimi Code 默认使用官方 `k3-256k`（Moderato 及以上，262,144 token），并直接请求同名上游 Model ID；`/model` 仍可选择 `k3`（本地按 Allegretto+ 的 1,048,576 token tier 配置）、`kimi-for-coding`（K2.7 Code）与 `kimi-for-coding-highspeed`。K3 支持 `low` / `high` / `max` 三档思考强度，默认 `high`，也支持显式关闭；`k3-256k` 支持图片但不支持视频输入。
- `kimi` 使用开放平台 `KIMI_API_KEY`；`kimi-code` 是独立的 Kimi For Coding 订阅端点和 `KIMI_CODE_API_KEY`，两类密钥不可互换。
- Zhipu 开放平台保留上游 `glm-5` 路由；Zhipu Coding 默认 `glm-5.2`（1M context, 131072 max output），并保留 `glm-5.1` / `glm-5-turbo` 供显式兼容选择。
- MiniMax Coding 默认 `MiniMax-M3`（Frontier Coding, native multimodal, 1M context），并保留 `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` 供显式兼容选择；旧 M2.5/M2.1/M2 路由已移除。
- Ark Coding 默认 `glm-5.2`（wire alias `glm-latest`）；同一 gateway 暴露 Kimi K2.7 Code/K2.6、MiniMax M3/M2.7、DeepSeek V4 Pro/Flash、Doubao Seed 2.0 Code/Pro/Lite 与 Doubao Seed Code。

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

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
