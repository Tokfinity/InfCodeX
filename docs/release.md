# Release & Binary Distribution

InfCodeX is distributed as **standalone binaries** built with `bun build --compile`.
Target machines do **not** need Node.js or any runtime installed.

## Distribution layout

Each archive (`tar.gz` for Linux/macOS, `zip` for Windows) contains the
following side-by-side files. Extract it into a dedicated directory:

```
./
├── infcodex                       # Bun-compiled executable (~60 MB)
├── builtin/                       # Built-in skills
│   ├── code-review/SKILL.md
│   ├── tdd/SKILL.md
│   └── ...
├── provider-capabilities.json     # Provider metadata
├── semantic-worker.js             # Repo-intelligence Worker
├── runtime-worker.js              # SDK Runtime Worker
└── constructed-handler-worker.js  # Constructed-tool Worker
```

Run `./infcodex` (or `infcodex.exe`) from any working directory. The binary locates
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
dist/binary/linux-x64/infcodex --version
```

## Automated release (CI)

### Trigger paths

1. **Push a `v*` tag** → `release.yml` builds all 5 targets, creates a GitHub
   Release, and uploads archives + SHA256SUMS.

   ```bash
   # 1. Bump version in root package.json (and sync workspaces)
   # 2. Commit and merge to main, then:
   git tag -a v<version> -m "Release v<version>"
   git push origin v<version>
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
| `process.env.KODAX_VERSION`  | `<version>`            | Source of truth for `infcodex --version` (no fs read) |

These flags only exist in compiled binaries. **npm install / `npm link` /
`npm run dev` paths are completely unaffected** — they fall through to the
existing `__dirname`-based resolution.

## Code signing

**Currently unsigned**, matching common unsigned CLI distribution practice (Bun, Deno,
ripgrep, fd). Users will see warnings on first run:

- **macOS**: `xattr -d com.apple.quarantine infcodex` once after extraction.
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

**Binary runs but reports `infcodex 0.0.0`** — `KODAX_VERSION` define wasn't
injected. Check `scripts/build-binary.mjs` was used, not raw `bun build`.

**Skill discovery returns empty in compiled binary** — sidecar `builtin/`
directory is missing next to the executable. Verify the archive was extracted
intact; the binary alone is not enough.

**Worker mode fails in a compiled binary** - verify `semantic-worker.js`,
`runtime-worker.js`, and `constructed-handler-worker.js` are next to the
executable. `scripts/build-binary.mjs` fails the build when any source sidecar
is missing, but copying only the executable after extraction breaks Worker
resolution at runtime.
