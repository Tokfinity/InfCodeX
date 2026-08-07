# Sandbox

KodaX supports an optional OS-level sandbox (ASRT) that contains file-system and
network access for model-issued shell commands.

## Activate the sandbox

```bash
kodax sandbox doctor    # Check readiness
kodax sandbox setup     # Activate
```

`kodax setup` and first-run setup also check sandbox readiness once.

## Platform backends

| Platform | Backend | Dependencies |
|---|---|---|
| **Windows** | Restricted sandbox account + network policy | None (UAC prompt on first activation) |
| **macOS** | Seatbelt (`sandbox-exec`) | ripgrep (`brew install ripgrep`) |
| **Linux** | bubblewrap | `bubblewrap`, `socat`, `ripgrep` |

KodaX never runs `sudo` or a package manager automatically. If the sandbox is
not active, deterministic safe operations and Auto[LLM] decisions keep the same
permission behavior; only OS-level containment is absent. Ordinary runs do not
repeatedly prompt for setup.

## REPL diagnostics

In the REPL, `/sandbox` refreshes readiness and diagnostics without activating
the backend or requesting elevation. Per-command sandbox routing remains
internal and is not shown in normal command history.

## Environment variable passthrough

Credential-shaped environment variables are filtered from model-issued shell
commands by default. To expose specific host variables to those command targets:

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

Restart KodaX after changing the host variables or this setting; stop/restart a
persistent KodaX daemon so it receives the new environment and configuration.

## SDK sandbox

SDK callers pass the same shape per Run as `KodaXOptions.sandbox`, so concurrent
Runs can use different lists without mutating process-global configuration.

```ts
await runKodaX({
  provider: 'openai',
  sandbox: { envPass: ['GH_TOKEN'] },
}, 'Inspect the authenticated repository.');
```

SDK embedders can also use the standalone sandbox capability independently
through `@kodax-ai/kodax/sandbox`.

## See also

- [Permissions](./permissions.md) — Permission modes and Auto Mode
- [Configuration files](./config-files.md) — Config.json reference
- [SDK overview](../sdk/overview.md) — SDK sandbox subpath
