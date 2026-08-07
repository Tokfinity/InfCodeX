# Permission Modes

KodaX controls file-system and shell-command permissions through three
interactive modes, plus a Runtime-owned Auto mode.

## Three interactive modes

| Mode | Behavior |
|---|---|
| **Plan** | Read-only analysis. KodaX inspects code and proposes a plan but makes no edits. |
| **Edits** | KodaX can read and write files but asks before running shell commands. |
| **Auto** | KodaX can read, write, and run commands with minimal prompting. |

In the REPL, **Shift-Tab** cycles Plan → Edits → Auto. Auto displays its
configured/persisted LLM or rules engine immediately.

## Auto Mode

Auto Mode uses a classifier (Auto[LLM]) to decide whether each operation is safe
to execute without explicit user approval.

- **Deterministic safe operations** (ordinary reads, workspace/temp mutations)
  are admitted before classifier latency.
- **Classifier infrastructure failure** retries once, then falls back to the
  Accept-edits boundary without switching to rules.
- ASRT sandbox is **optional execution containment**, not permission authority.
  If the sandbox is not active, deterministic safe operations and Auto[LLM]
  decisions keep the same permission behavior; only OS-level containment is
  absent.

## SDK permission control

SDK callers can control permissions per Run through `KodaXOptions`. The same
permission modes are available programmatically, and the Runtime guardrail
decides before the permission UI.

## Shell Execution Contract

KodaX supports a host-configurable Shell Execution Contract. Runtime Session
settings or an individual Run can select `pwsh`, Windows PowerShell, `cmd`,
`bash`, `zsh`, or an explicit Git Bash executable. KodaX resolves the shell
environment in the effective project cwd and then executes the command through
that same interpreter.

Resolved environments are isolated by contract and cwd, expire after a bounded
TTL, and can be explicitly refreshed. Provider credentials and execution-control
variables are removed before profile/setup code and again before the command
starts.

When `shellExecution` is absent, the established interpreter path is unchanged.

## See also

- [Sandbox](./sandbox.md) — Optional OS-level containment
- [Configuration files](./config-files.md) — Config.json reference
- [CLI reference](../guides/cli-reference.md) — `--mode` flag
