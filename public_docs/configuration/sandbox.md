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

## Windows workspace Shell behavior (v0.7.86)

Windows workspace Shell calls preserve the case-insensitive `PATH`/`Path` and
`PATHEXT` environment contract across the Runtime and sandbox brokers. KodaX
derives read grants from the final resolved PATH and shell executable, including
the bounded traversal needed by profile-manager junctions, rather than granting
the whole user application tree. `cmd.exe` command arguments retain their
verbatim-argument contract, so quoted paths and profile-managed executables are
not re-parsed by an intermediate broker.

The packaged Electron and Runtime smoke paths exercise this behavior. A missing
or unprovable sandbox lifecycle attestation after target start remains
fail-closed; KodaX does not retry a command that may already have started.
Commands with the same canonical workspace, Agent Home, additional filesystem,
toolchain, and network policy can share one Windows policy group across KodaX
processes. An incompatible policy or sandbox infrastructure failure before
target start returns the already-authorized command to normal permission
execution. Runtime sandbox capability v3 first fenced older daemon policy
revisions in v0.7.86. The current contract is `sandboxRuntime:4`: auto-start
replaces an idle v3-or-older daemon and fails closed while it is busy. Do not
delete `model-filesystem-effects.lock` by hand; on Windows the coordinator
state lives under `C:\ProgramData\KodaX\sandbox-runtime\runtime\`.

## Concurrent text tools (v0.7.94)

Runtime `write`, `edit`, `multi_edit`, `insert_after_anchor`, and `undo` may
overlap a compatible live Bash lease. Snapshot and commit use the same ASRT
workspace policy, with same-path FIFO. A covered workspace target fails closed
when that sandbox is unavailable. Hard-linked workspace targets are rejected.
Windows sandboxed git trusts authorized repo roots only
(`gitSafeDirectory: authorized-repo-roots`) and never emits `safe.directory=*`.
Linked-worktree and submodule relationship files are read through strict byte
bounds before that trust. Sandboxed text-helper stdin failures stay on the
operation Promise. A missing workspace directory omits the concurrent text
sandbox at Run start instead of aborting the Run.

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
