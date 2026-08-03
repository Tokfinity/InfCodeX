# FEATURE_286 v0.7.79 Test Guide

## Goal

Verify that user-level `sandbox.envPass` exposes only selected host environment
variables to model-issued command targets while preserving the default
credential filter and immutable execution-control denies.

## Automated Coverage

Run:

```powershell
npx vitest run packages/coding/src/shell-execution/environment.test.ts packages/coding/src/shell-execution/resolver.test.ts packages/repl/src/common/config-env.test.ts packages/repl/src/common/example-config.test.ts packages/repl/src/common/setup-config.test.ts packages/coding/src/self-knowledge/registry.test.ts
```

Expected: all tests pass. Coverage includes Windows case-insensitive matching,
POSIX exact matching, final-target restoration after configured-shell profile
filtering, template/setup synchronization, and `kodax_manual` drift.

## Manual Verification

1. Set non-production test values in the host environment:

   ```powershell
   $env:GH_TOKEN = "feature-286-gh-test"
   $env:OPENAI_API_KEY = "feature-286-provider-test"
   ```

2. With `sandbox.envPass` omitted, ask KodaX to run a command that prints only
   whether each variable exists. Confirm both are absent; do not print values.
3. Add this user-level config and restart KodaX (and a persistent daemon):

   ```json
   {
     "sandbox": {
       "envPass": ["GH_TOKEN"]
     }
   }
   ```

4. Repeat the existence-only command. Confirm `GH_TOKEN` exists and
   `OPENAI_API_KEY` remains absent on both a sandbox-selected command and an
   ordinary fallback command.
5. Add `NODE_OPTIONS` to `envPass`; confirm it remains absent.
6. Run `kodax setup` under an isolated config home and confirm the generated
   `config.example.jsonc` documents `sandbox.envPass` without credential values.
7. Ask KodaX how to pass `GH_TOKEN` into sandboxed commands and confirm
   `kodax_manual` returns the same field/default/restart guidance.

## Pass Criteria

- Default credential filtering is unchanged.
- Only exact configured names become visible to final command targets.
- Execution-control variables remain blocked.
- Config, templates, and KodaX diagnostics contain names only. An authorized
  command can deliberately print a listed value, so command output must still
  be handled as sensitive data and may be retained in logs or Session data.
