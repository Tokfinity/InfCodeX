# Repo Intelligence — OSS baseline + optional premium engine

> Moved out of [README.md](../README.md) on 2026-05-19 to keep the project landing page focused. The content below is unchanged.

KodaX ships with built-in OSS repo intelligence (`repo_overview`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`, …) that helps the coding agent understand large codebases without ad-hoc grep/glob exploration. An optional premium engine — the local `repointel` daemon, distributed via the sibling `KodaX-private` repo — adds proactive context injection, deeper module capsules, and a native auto-lane integration.

This page documents how to install / configure / switch between the two.

---

## Architecture overview

- **Public OSS baseline** lives in the public `KodaX` repo and keeps `CLI`, `REPL`, `ACP`, library imports, and repo-aware tools working even when no premium component is installed.
- **Premium intelligence** lives in the sibling private repo `KodaX-private` and runs through the local `repointel` daemon / CLI frontdoor.
- **KodaX native mode** is the flagship experience. It can prefetch repo intelligence before routing and prompt building, while other hosts such as Codex / Claude Code / OpenCode use the same premium tool through thin skills.

## Runtime modes

KodaX supports these repo-intelligence modes:

- `off`: strict benchmark baseline. Disable the repo-intelligence working plane entirely while keeping `/repointel` control commands available.
- `oss`: use only the public OSS baseline.
- `premium-shared`: use the premium engine, but without the native KodaX auto lane. This is useful for comparing KodaX against other hosts.
- `premium-native`: use the premium engine through the KodaX native bridge. This is the best local experience.
- `auto`: user-facing convenience mode. KodaX resolves it to `premium-native` when the premium daemon is reachable, otherwise it falls back to `oss`.

## Quick usage

Run KodaX with explicit repo-intelligence mode flags:

```bash
# OSS baseline only
kodax --repo-intelligence oss

# Premium native mode with trace output
kodax --repo-intelligence premium-native --repo-intelligence-trace

# Compare against the shared premium path
kodax --repo-intelligence premium-shared --repo-intelligence-trace
```

You can also set the same behavior through config or environment variables:

```powershell
$env:KODAX_REPO_INTELLIGENCE_MODE = "premium-native"
$env:KODAX_REPO_INTELLIGENCE_TRACE = "1"
$env:KODAX_REPOINTEL_BIN = "C:\Tools\repointel\repointel.exe"
```

Official `KodaX-private` releases should now publish only the native `repointel` package. The older offline bundle remains useful for internal/manual validation, but it should not be the normal end-user release artifact.

## REPL mode

It is not CLI-only. REPL mode supports the same repo-intelligence runtime modes.

The most direct premium-native REPL flow is:

```powershell
Set-Location <path-to-your-KodaX-clone>
kodax --repo-intelligence premium-native --repo-intelligence-trace
```

If you save the premium settings in `~/.kodax/config.json`, plain REPL startup is enough:

```powershell
kodax
```

Inside REPL, repo intelligence is still consumed automatically by the normal KodaX flow, and there are also lightweight status/control commands:

- `/status`: shows a compact repo-intelligence summary together with the normal session status output.
- `/repointel` or `/repointel status`: shows the current repo-intelligence state in more detail.
- `/repointel mode premium-native|premium-shared|oss|off|auto`: switches the current mode and writes it back to user config.
- `/repointel trace on|off|toggle`: turns repo-intelligence trace output on or off.
- `/repointel warm`: tries to warm or start the local premium service. If it cannot be started, KodaX reports the failure clearly and continues with the normal fallback path.

The most important fields to watch are:

- `mode`: the resolved runtime mode, such as `oss`, `premium-shared`, or `premium-native`
- `engine`: the actual engine in use, `oss` or `premium`
- `bridge`: `none`, `shared`, or `native`
- `status`: typically `ok`, `limited`, or `unavailable`

The practical difference between the two premium modes is:

- `premium-native`: the flagship KodaX path. KodaX can prefetch and inject repo intelligence earlier in its native runtime flow.
- `premium-shared`: still uses premium, but intentionally avoids the KodaX-native auto lane so you can compare against the shared multi-host path.
- `oss`: keep the public baseline repo tools and OSS intelligence only.
- `off`: strict disable for repo-intelligence working tools and auto injection. `/repointel` remains available as the control plane.

## User-level config

Repo-intelligence premium settings are supported in the user config file `~/.kodax/config.json`.

Supported fields:

- `repoIntelligenceMode`
- `repointelEndpoint`
- `repointelBin`
- `repoIntelligenceTrace`

Recommended end-user example when `repointel` is installed but not on `PATH`:

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto",
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe",
  "repoIntelligenceTrace": false
}
```

For normal user installs, the preferred setup is to install the premium tool so the `repointel` command is already on `PATH`, in which case this is usually enough:

```json
{
  "repoIntelligenceMode": "premium-native"
}
```

If `repointel` is not on `PATH`, `repointelBin` can point to the installed native executable, for example:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe"
}
```

For author same-parent local development, it is still valid to point `repointelBin` at the sibling private source build:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelEndpoint": "http://127.0.0.1:47891",
  "repointelBin": "C:\\path\\to\\KodaX-private\\packages\\repointel-cli\\dist\\index.js",
  "repoIntelligenceTrace": true
}
```

`repointelEndpoint` is optional in normal installs. It only tells KodaX which local premium daemon address to use, and the default `http://127.0.0.1:47891` is usually enough unless you deliberately run a non-default endpoint.

For same-parent author local development, `repointelBin` can still point to the sibling private build output.

These config values are loaded by both CLI mode and REPL mode, and they are bridged into the runtime environment automatically.

## Config template

The repo includes a user-facing config template:

- `config.example.jsonc`

Copy it to `~/.kodax/config.json`, then adjust provider and repo-intelligence settings as needed.

## Local same-parent development

The intended phase-1 development layout is to clone both repos under the same parent directory, for example:

- Public repo: `<parent>/KodaX`
- Private repo: `<parent>/KodaX-private`

Typical local workflow:

```powershell
# 1. Build the public repo
Set-Location <parent>\KodaX
npm install
npm run build

# 2. Build the private premium repo
Set-Location <parent>\KodaX-private
npm install
npm run build

# 3. Warm or start the premium daemon
node .\packages\repointel-cli\dist\index.js warm "{}"

# 4. Run KodaX in premium-native mode
Set-Location <parent>\KodaX
npm run dev -- --repo-intelligence premium-native --repo-intelligence-trace
```

## How KodaX behaves after the split

- If premium is unavailable, KodaX automatically falls back to the OSS baseline. Startup, imports, and public tools keep working.
- If premium is available, `premium-native` uses the daemon client directly and injects repo intelligence earlier than shared-host integrations.
- Trace-enabled runs can be used to compare `off`, `oss`, `premium-shared`, and `premium-native` on the same task, including mode, engine, bridge, daemon latency, cache hits, and capsule token estimates.

## External hosts

Codex, Claude Code, and OpenCode are intentionally thinner in phase 1:

- they install the shared Repointel skill
- they call the same local premium tool
- they do **not** ship a separate OSS fallback engine

Install the shared thin skill from the public repo:

```powershell
# Cross-platform primary entrypoint
node .\clients\repointel\scripts\install.mjs --host codex
node .\clients\repointel\scripts\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\scripts\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

Useful helper scripts:

- `clients/repointel/scripts/demo.mjs`: run a local premium demo flow against a temporary endpoint.
- `clients/repointel/scripts/doctor.mjs`: inspect local premium setup, bridge status, daemon reachability, and host skill installation.
- `clients/repointel/scripts/install.mjs`: install the shared thin skill into Codex / Claude / OpenCode host paths.

The installable shared skill itself lives at:

- `clients/repointel/SKILL.md`
