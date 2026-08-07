# Configuration Files

KodaX reads configuration from `~/.kodax/` with a strict split-file layout.

## File layout

| File | Purpose |
|---|---|
| `~/.kodax/config.json` | Core configuration (strict JSON) |
| `~/.kodax/config.example.jsonc` | Annotated reference with all settings |
| `~/.kodax/integrations/mcp.json` | MCP server definitions |
| `~/.kodax/integrations/extensions.json` | Extension definitions |
| `~/.kodax/integrations/a2a.json` | A2A agent definitions |

The first line of `config.example.jsonc` points to all split files and documents
every supported core setting.

## Core config example

```json
{
  "provider": "zhipu-coding",
  "effort": "auto",
  "runtimeMode": "daemon"
}
```

## Environment variables

Every JSON setting has a `KODAX_UPPER_SNAKE_CASE` environment variable
equivalent. Resolution order:

1. Explicit CLI/SDK option
2. Environment variable (`KODAX_*`)
3. `config.json`
4. Built-in default

| JSON key | Environment variable | Default |
|---|---|---|
| `provider` | `KODAX_PROVIDER` | — (prompted on first run) |
| `effort` | `KODAX_EFFORT` | `auto` |
| `runtimeMode` | `KODAX_RUNTIME_MODE` | `embedded` |
| (home dir) | `KODAX_HOME` | `<OS user home>/.kodax` |

JSON names stay camelCase while environment names use `KODAX_UPPER_SNAKE_CASE`.

## Runtime mode

Three Runtime modes are available:

- **`embedded`** (default) — inline, lowest latency, private
- **`worker`** — Worker-hosted, private, hard-disposable (V8 fault boundary)
- **`daemon`** — process-isolated, shared across multiple clients

```bash
kodax daemon start
kodax daemon stop --profile default
kodax --runtime-mode daemon
kodax -p "Review this repository" --runtime-mode daemon
```

By default, daemon state, config, and runtime session storage use the exact
resolved `KODAX_HOME` (normally `<OS user home>/.kodax`), so CLI and SDK clients
converge on the same local daemon even when `KODAX_HOME` is a custom directory.

An explicit `--home <dir>` selects the isolated `<dir>/.kodax` namespace for
tests, CI, or project-local experiments.

## Sandbox envPass

Credential-shaped environment variables are filtered from model-issued shell
commands by default. To expose specific host variables to command targets:

```json
{
  "sandbox": {
    "envPass": ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]
  }
}
```

The default list is empty. Values remain in the host environment and are never
stored in `config.json`; project configuration cannot extend the list. Matching
is exact (case-insensitive on Windows), and execution-control variables such as
`NODE_OPTION` and `BASH_ENV` remain blocked.

## See also

- [Providers](./providers.md) — Provider configuration
- [Custom providers](./custom-providers.md) — Custom endpoint configuration
- [Sandbox](./sandbox.md) — OS-level containment
- [SDK overview](../sdk/overview.md) — Runtime SDK and daemon API
