# ISSUE 162 v0.7.70 A2A Provider Resolution Regression Guide

## Scope

Verify that `kodax a2a serve` receives the same provider/model defaults as
other hosted Runtime entry points, that a selected Markdown Agent can pin its
provider, and that root/subcommand option placement cannot silently drop or
fall through after an integration command.

## Automated baseline

```bash
npx vitest run src/integration-cli.a2a-serve.test.ts \
  src/kodax_cli.command-options.test.ts \
  src/kodax_cli.interactive-exit.test.ts \
  packages/coding/src/construction/markdown-loader.test.ts \
  src/a2a/product.test.ts src/a2a/runtime-config.test.ts \
  src/runtime-agent-binding.test.ts tests/kodax_cli.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: all tests pass and TypeScript reports no error.

## Human acceptance

Use a temporary home/profile and a provider whose credentials are available
through the normal KodaX environment. Do not record credential values.

1. Run `kodax --provider <alias> a2a serve` and
   `kodax a2a serve --provider <alias>` on loopback. Send one authenticated A2A
   request to each server. Both must reach the chosen provider, and neither
   command may fall through into the normal interactive CLI.
2. Repeat without `--provider`, first with the provider environment setting,
   then core config, then neither. Confirm precedence is CLI, environment,
   config, built-in default and that model selection remains provider-compatible.
3. Add `provider: <alias>` to one valid `~/.kodax/agents/<name>.md`, expose that
   Agent, and serve it. Confirm its run uses the pinned provider.
4. Try an empty or invalid Markdown `provider`. Validation must reject it before
   listening; no remote request can inject a replacement provider or model.
5. Exercise duplicated root/subcommand `model`, `reasoning`, and provider
   options. The selected subcommand value is authoritative and no unrelated
   command receives the options.

Expected: every admitted inbound run has a deterministic provider/model, local
Agent authority is preserved, remote input cannot alter it, and command parsing
terminates at the selected integration subcommand.
