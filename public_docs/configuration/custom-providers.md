# Custom Providers

Point KodaX at any OpenAI-compatible or Anthropic-compatible endpoint.

## Basic custom provider

Define a custom provider in `~/.kodax/config.json`:

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

`"apiKeyEnv": "MY_LLM_API_KEY"` is a reference to an environment-variable name,
not an API key value. Put the custom provider's actual API key in the
`MY_LLM_API_KEY` environment variable, then close the current terminal and open
a new one before running `kodax`.

## User-Agent mode

`userAgentMode` defaults to `"compat"`, which sends `KodaX` instead of the
official SDK User-Agent. Switch it to `"sdk"` only when your gateway expects the
upstream SDK header.

## Reasoning configuration

For custom reasoning models, `reasoning: { efforts, default }` is the preferred
shape; use `"reasoning": "none"` for models without thinking capability.

SDK hosts should render effort pickers from `reasoningProfile.supportedEfforts`
/ `defaultEffort` rather than assuming a fixed five-option ladder.

## OpenAI-compatible reasoning providers

Some OpenAI-compatible reasoning models require KodaX to replay the previous
assistant turn's `reasoning_content` on later requests. DeepSeek V4 thinking
mode is the known load-bearing case. Built-in DeepSeek already opts in; custom
providers must say so explicitly:

```json
{
  "customProviders": [
    {
      "name": "my-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    }
  ]
}
```

DeepSeek Chat Completions uses `max_tokens`; OpenAI proper defaults to
`max_completion_tokens`. Keep `replayReasoningContent` unset or `false` for
OpenAI proper and gateways that reject unknown assistant-message fields.

### Per-model overrides

If one gateway routes mixed models, prefer per-model overrides:

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    },
    { "id": "gpt-5", "replayReasoningContent": false }
  ]
}
```

## Prompt cache affinity

If a custom endpoint is confirmed to support cache-affinity routing, set
`"promptCacheAffinity": true`. Anthropic-compatible requests then receive the
opaque logical-context key as `metadata.user_id`; OpenAI-compatible requests
receive `prompt_cache_key`. The default is `false` because some strict
compatible gateways reject unknown request fields.

## Vision / image input

If your custom provider's underlying model supports image input (vision), add a
`capabilityProfile.multimodalSupport: "image-input"` block so KodaX does not
artificially block multimodal requests at the policy gate:

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

Built-in vision-capable aliases (Anthropic, OpenAI, Kimi, Qwen, Zhipu, MiniMax,
MiMo, Ark, plus Gemini-CLI) already ship with this flag enabled. DeepSeek V4
and Codex-CLI are text-only; custom providers need to opt in.

## See also

- [Providers](./providers.md) — Built-in provider aliases
- [Configuration files](./config-files.md) — Full config.json reference
