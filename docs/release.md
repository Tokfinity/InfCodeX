# Release & Binary Distribution

KodaX is distributed as **standalone binaries** built with `bun build --compile`.
Target machines do **not** need Node.js or any runtime installed.

## Distribution layout

Each archive (`tar.gz` for Linux/macOS, `zip` for Windows) contains the
following side-by-side files. Extract it into a dedicated directory:

```
./
├── kodax                          # Bun-compiled executable (~60 MB)
├── builtin/                       # Built-in skills
│   ├── code-review/SKILL.md
│   ├── tdd/SKILL.md
│   └── ...
├── provider-capabilities.json     # Provider metadata
├── semantic-worker.js             # Repo-intelligence Worker
├── runtime-worker.js              # SDK Runtime Worker
└── constructed-handler-worker.js  # Constructed-tool Worker
```

Run `./kodax` (or `kodax.exe`) from any working directory. The binary locates
all sidecars relative to `process.execPath`, so the extracted files must be
moved or archived as one unit.

## Supported targets

| Target          | OS / Arch                       | CI runner          |
| --------------- | ------------------------------- | ------------------ |
| `win-x64`       | Windows 10 1809+ / x64          | `windows-latest`   |
| `linux-x64`     | Linux glibc 2.27+ / x64         | `ubuntu-latest`    |
| `linux-arm64`   | Linux glibc 2.27+ / aarch64     | `ubuntu-latest` (cross) |
| `darwin-x64`    | macOS 11+ / Intel               | `macos-14` (cross) |
| `darwin-arm64`  | macOS 11+ / Apple Silicon       | `macos-14`         |

Win7 and pre-glibc-2.27 distros (NeoKylin v7, CentOS 6/7) are **not supported**.
LoongArch64 / MIPS are **not supported** (Bun has no toolchain for them).

## Local builds (manual testing)

### Prerequisites

- Node.js 20+ (for build orchestration)
- Bun on PATH:
  ```
  Windows : scoop install bun       # or: npm i -g bun
  macOS   : brew install bun        # or: npm i -g bun
  Linux   : curl -fsSL https://bun.sh/install | bash
  ```
- `npm ci` at repo root

### Commands

```bash
# Current platform only (fastest)
npm run build:binary

# Specific target (Bun cross-compiles from any host)
node scripts/build-binary.mjs --target=linux-arm64

# All 5 targets in sequence (one machine, ~3-5 min)
npm run build:binary:all

# Reuse existing dist/ (skip TypeScript rebuild)
node scripts/build-binary.mjs --skip-tsc

# Clean prior outputs first
node scripts/build-binary.mjs --clean
```

Output lives under `dist/binary/<target>/`. Smoke-test with:

```bash
dist/binary/linux-x64/kodax --version
```

## v0.7.74 release verification

Release state: package version `0.7.74`, code, tests, and documentation are
committed together. The `v0.7.74` tag triggers the five-platform GitHub Release
workflow; npm publication remains a separate manual operator step.

Run the template drift check and full deterministic gate, then refresh the
normal build artifact used by a globally linked `kodax` command.

```bash
npm run config:templates:check
npm run test:full
npm run build
npm pack --dry-run
```

The full deterministic gate is authoritative. If a v0.7.74 area fails and needs
a focused rerun, use the matching group below:

```bash
# Always-on compaction, exact-history durability, and bounded recovery
npx vitest run packages/agent/src/session-lineage \
  packages/coding/src/tools/session-history.test.ts \
  packages/coding/src/agent-runtime/durable-compaction.test.ts \
  packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts \
  packages/repl/src/interactive/storage.test.ts \
  packages/repl/src/session/public-api.test.ts \
  src/sdk-runtime.test.ts

# Mailbox-driven Agent wait, delivery recovery, and Goal-wrapper propagation
npx vitest run packages/agent/src/actors/controller.test.ts \
  packages/agent/src/messaging/drain.test.ts \
  packages/agent/src/orchestration/idle-yield.test.ts \
  packages/agent/src/primitives/runner.test.ts \
  packages/coding/src/agent-runtime/actor-runtime.test.ts \
  packages/coding/src/tools/agent-collaboration.test.ts \
  packages/coding/src/task-engine/runner-driven.test.ts \
  packages/coding/src/task-engine/runner-goal-adapter.test.ts

# Active-run interrupt input across embedded Runtime and daemon boundaries
npx vitest run src/sdk-runtime.test.ts src/runtime-daemon/client.test.ts \
  src/runtime-daemon/server.test.ts src/runtime-event.test.ts

# Release-candidate checkpoint topology and PowerShell bracket-wildcard guard
npx vitest run packages/agent/src/session-lineage/kodax-session-lineage.test.ts \
  packages/repl/src/permission/powershell-mutation.test.ts \
  packages/repl/src/permission/auto-rules.test.ts

# Continue-most-recent and Auto mode-switch ordering
npx vitest run packages/repl/src/session/resumable-session.test.ts \
  packages/repl/src/interactive/repl-startup-session.test.ts \
  packages/coding/src/agent-runtime/__contract-tests__/cap-043-auto-resume.contract.test.ts \
  packages/repl/src/ui/view-models/surface-status.test.ts \
  src/kodax_cli.runtime-runner.test.ts

# External-review low-impact debt closures
npx vitest run packages/repl/src/session/compact-session.test.ts \
  src/sdk-runtime.test.ts

# README/kodax_manual/config drift guards
npx vitest run packages/coding/src/self-knowledge/registry.test.ts \
  packages/coding/src/self-knowledge/resolver.test.ts \
  packages/repl/src/interactive/commands-manual-drift.test.ts \
  packages/repl/src/common/example-config.test.ts
```

Before tagging, complete the two human release guides against an isolated
`KODAX_HOME` and a disposable project/Session:

- [`FEATURE_272_v0.7.74_TEST_GUIDE.md`](test-guides/FEATURE_272_v0.7.74_TEST_GUIDE.md)
  covers threshold policy, full-prefix/query retention, root/child attribution,
  daemon frame bounds, exact-history durability, and revision-bound recovery.
- [`FEATURE_273_v0.7.74_TEST_GUIDE.md`](test-guides/FEATURE_273_v0.7.74_TEST_GUIDE.md)
  covers progress storms, token-free long waits, synthetic/user authorship,
  restart delivery, timeout/interruption, and unchanged SDK event telemetry.
- [`ISSUE_105_v0.7.74_REGRESSION_GUIDE.md`](test-guides/ISSUE_105_v0.7.74_REGRESSION_GUIDE.md)
  covers empty-placeholder skipping, explicit-ID priority, Classic/Ink parity,
  and saved-workspace restoration.
- [`ISSUE_204_v0.7.74_REGRESSION_GUIDE.md`](test-guides/ISSUE_204_v0.7.74_REGRESSION_GUIDE.md)
  covers Shift-Tab cycling, immediate engine labels, rapid last-action-wins
  ordering, newline input, and sticky rules fallback.

The guides intentionally leave tester/date/result fields for release evidence;
do not mark their checkboxes from automated test output alone.

## Automated release (CI)

### Trigger paths

1. **Push a `v*` tag** → `release.yml` builds all 5 targets, creates a GitHub
   Release, and uploads archives + SHA256SUMS.

   ```bash
   # 1. Bump version in root package.json (and sync workspaces)
   # 2. Commit, then:
   git tag v<version>
   git push --tags
   ```

   Release notes are auto-generated from `git log <prev-tag>..<this-tag>`.
   Tags matching `*-rc*` / `*-beta*` / `*-alpha*` are flagged as pre-release.

2. **Manual via GitHub Actions UI** (`workflow_dispatch`) → builds without
   creating a release. Useful for testing the pipeline before tagging.

   - Repo → Actions → Release → Run workflow
   - Pick `target` (default `all`)
   - Artifacts available for 14 days under the workflow run

### Pipeline stages

```
on: push tag v*  ─┐
                  ├─→ build matrix (5 targets, native runners)
on: workflow_dispatch ─┘     │
                             ├─→ smoke test (--version)
                             ├─→ archive (tar.gz / zip + .sha256)
                             └─→ upload-artifact

                             [tag push only]
                             └─→ release job
                                 ├─→ download all artifacts
                                 ├─→ aggregate SHA256SUMS
                                 ├─→ generate notes from git log
                                 └─→ softprops/action-gh-release
```

## Build-time defines

`scripts/build-binary.mjs` injects three constants via Bun `--define`,
substituted at compile time as string literals:

| Define                       | Value                  | Purpose                                          |
| ---------------------------- | ---------------------- | ------------------------------------------------ |
| `process.env.NODE_ENV`       | `"production"`         | React strips dev-only profiling code (saves ~100 MB/turn) |
| `process.env.KODAX_BUNDLED`  | `"true"`               | Switches `getDefaultSkillPaths()` to sidecar mode |
| `process.env.KODAX_VERSION`  | `<version>`            | Source of truth for `kodax --version` (no fs read) |

These flags only exist in compiled binaries. **npm install / `npm link` /
`npm run dev` paths are completely unaffected** — they fall through to the
existing `__dirname`-based resolution.

## Code signing

**Currently unsigned**, matching common unsigned CLI distribution practice (Bun, Deno,
ripgrep, fd). Users will see warnings on first run:

- **macOS**: `xattr -d com.apple.quarantine kodax` once after extraction.
- **Windows**: SmartScreen "More info → Run anyway" once.
- **Linux**: no warning.

If signing is added later, hooks would slot into the `release.yml` build job
between `Build binary` and `Package archive`, gated on platform:

- macOS: `codesign` + `xcrun notarytool` (requires Apple Developer Program $99/yr)
- Windows: `signtool` (requires OV/EV cert $80–500/yr)

## Troubleshooting

**`bun: command not found` from `npm run build:binary`** — Bun isn't on PATH.
The script prints install hints and exits with code 1. Install Bun and retry.

**`Missing packages/agent/dist/capabilities/skills/builtin`** — `npm run build`
did not run, or the agent package's `copy:builtin` step failed. Run
`npm run build` or `npm run copy:builtin -w @kodax-ai/agent` to verify, then
retry.

**Binary runs but reports `kodax 0.0.0`** — `KODAX_VERSION` define wasn't
injected. Check `scripts/build-binary.mjs` was used, not raw `bun build`.

**Skill discovery returns empty in compiled binary** — sidecar `builtin/`
directory is missing next to the executable. Verify the archive was extracted
intact; the binary alone is not enough.

**Worker mode fails in a compiled binary** - verify `semantic-worker.js`,
`runtime-worker.js`, and `constructed-handler-worker.js` are next to the
executable. `scripts/build-binary.mjs` fails the build when any source sidecar
is missing, but copying only the executable after extraction breaks Worker
resolution at runtime.
