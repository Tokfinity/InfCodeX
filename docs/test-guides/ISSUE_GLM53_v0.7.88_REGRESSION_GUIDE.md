# GLM-5.3 Coding Plan v0.7.88 Regression Guide

## Purpose

Verify the v0.7.88 Coding Plan catalog, exact wire IDs, reasoning normalization,
and documentation/manual alignment. Do not run `npm publish`; publication
remains a manual maintainer step.

## Automated checks

```bash
npm run build:packages
npx vitest run packages/llm/src/providers/provider-capabilities.test.ts \
  packages/llm/src/providers/model-capabilities.test.ts \
  packages/llm/src/providers/registry.test.ts \
  packages/llm/src/cost-rates.test.ts \
  packages/coding/src/self-knowledge/registry.test.ts
```

The assertions must prove:

- `zhipu-coding`, `zai-coding`, and `ark-coding` default to `glm-5.3`;
- `glm-5.2` remains selectable on all relevant Coding Plan routes and Ark
  retains the `glm-latest` alias;
- exact wire IDs are `glm-5.3` / `glm-5.2`, with no `[1m]` suffix;
- GLM-5.3 keeps its 1M context and provider-specific output caps;
- `off` / `none` intent lowers to enabled `low` reasoning rather than sending
  an unsupported disabled-thinking request;
- `kodax_manual`, package README, public provider guide, and the release docs
  state the same defaults and rollback routes.

## Live probes (optional, credential-gated)

With the appropriate provider key already configured, issue a minimal request
for `glm-5.3` through `zai-coding` and `ark-coding`. Record HTTP status and
request model only; never record credentials or full prompts. A provider-side
entitlement error must be distinguished from an invalid model-code error.

## CLI smoke

For each of `zai-coding` and `ark-coding`, open `/model` and confirm the
default is `glm-5.3`, `glm-5.2` remains selectable, and no model choice shows
the synthetic `[1m]` suffix. Confirm a legacy `off` choice is shown as
`off->low` where the REPL exposes the normalized intent.
