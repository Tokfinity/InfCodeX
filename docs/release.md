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

## v0.7.77 release-candidate verification

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.77`. The candidate adds
FEATURE_274 pattern-aware adaptive AMA, FEATURE_275 governed event-triggered
memory intervention, the public 1M `kimi-k3` route, prompt-cache diagnostics,
Runtime interrupt/default-model reliability fixes, and the final child-runtime
cache/context identity and Actor capability hardening.

The candidate is not yet a release. Before tagging, all of the following must
be true:

1. the deterministic local gate and exact tarball audit pass from a clean
   install;
2. the candidate commit's GitHub `CI` workflow is green for Node 20, Node 22,
   the Unix Runtime socket gate, and packaged Electron on Windows;
3. the `docs/features` submodule points at the reviewed v0.7.77 design commit
   and both repositories are clean;
4. the preregistered F274/F275 paid pilot is run only after explicit owner
   authorization and a frozen pre-call manifest, the main-session review is
   recorded, and the owner makes the joint ship decision.

No task-effect improvement may be claimed from deterministic tests alone.

Run the same deterministic shape as GitHub CI, followed by the exact package
inspection:

```bash
npm ci
npm run config:templates:check
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:full
node scripts/release.mjs --pack-only
```

`--pack-only` runs the production build, temporarily applies the publishable
`private: false` metadata, creates the exact candidate archive, audits the
bundled Sidecar prompt and budget bridge, and restores the development
manifest. Use `kodax-ai-kodax-0.7.77.tgz` for consumer validation; a real npm
publication sends those same audited bytes.

Final local candidate evidence on 2026-07-26: the clean-install deterministic
sequence above and the exact tarball audit passed. The packaged Electron
boundary remains a required check in the final GitHub CI matrix. The audited
`kodax-ai-kodax-0.7.77.tgz` SHA-256 is
`95DB1DA510840A918A3B55105F6CCF81D2871C363A2D21D2F20223382BCB17A8`.

For a focused v0.7.77 rerun:

```bash
npx vitest run \
  benchmark/datasets/feature-274/experiment-contract.test.ts \
  benchmark/datasets/feature-275/experiment-contract.test.ts \
  packages/agent/src/experimental-memory/memory-agent.test.ts \
  packages/coding/src/memory/intervention-selector.test.ts \
  packages/coding/src/orchestration/pattern-catalog.test.ts \
  packages/coding/src/orchestration/pattern-strategy.test.ts \
  packages/coding/src/orchestration/pattern-trace.test.ts \
  packages/coding/src/agent-runtime/run-substrate.memory-intervention.test.ts \
  packages/coding/src/agent-runtime/run-substrate.terminal-interrupt.test.ts \
  packages/coding/src/self-knowledge/registry.test.ts \
  packages/coding/src/tools/manual.test.ts \
  src/sdk-runtime.test.ts
```

The paid experiment declarations are contracts, not drivers. Their current
combined ceilings reach hundreds of provider calls and require explicit
authorization; do not infer permission from available environment keys. Raw
outputs and the blinded main-session review belong under the OS temp directory
specified by `benchmark/EVAL_GUIDELINES.md`, never in the repository.

With the relevant live credentials configured, the provider and cache probes
are optional operator checks:

```powershell
$env:KODAX_INTEGRATION_TEST = '1'
npm run test:integration -- packages/llm/src/providers/kimi-wire.integration.test.ts
npm run probe:prompt-cache
```

On Windows, after a successful build, run the packaged Electron boundary:

```bash
npm run test:electron-daemon:built
```

Packaged KodaX Space validation remains a non-blocking product follow-up. Install
the exact generated tarball and run
[`ISSUE_205_v0.7.75_REGRESSION_GUIDE.md`](test-guides/ISSUE_205_v0.7.75_REGRESSION_GUIDE.md)
on Windows 10 and Windows 11, recording the Space build, OS build, tarball hash,
tester, date, and outcome. Automated output must not pre-fill the human result.

After every gate above is satisfied, commit the complete candidate, verify a
clean status in both repositories, tag that exact commit `v0.7.77`, and let the
five-platform GitHub Release workflow build the binaries. npm publication
remains a separate manual operator action.

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
