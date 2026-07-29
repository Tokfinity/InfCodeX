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
├── sandbox-workspace-session.js   # ASRT workspace session
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

## v0.7.78 release verification

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.78`. The release contains:

- FEATURE_263 evidence-gated background Skill learning: Memory-first review,
  immutable project-scoped canaries, canonical record-gated discovery,
  exact-revision outcome attribution, and Learning Center control;
- FEATURE_276 complete first-run split-configuration setup without overwriting
  existing core/MCP/Extensions/A2A configuration or collecting secrets;
- FEATURE_277 intent-aligned Auto[LLM] permission behavior, bounded
  classifier retry/Accept-edits fallback, optional ASRT containment, explicit
  `/sandbox` diagnostics, and the standalone `/sandbox` SDK subpath;
- Runtime Actor ownership, daemon lifecycle, integration resilience, and
  packaged shell/sandbox hardening recorded in the v0.7.78 changelog;
- release-candidate closure for Skill promotion, Edit/Plan Skill admission,
  governed AMA Memory intent, unbounded Workflow Actor polling, and the
  `runtimeAutoModeGuardrail` v4 non-persistent fallback contract.

The release must be cut from one integrated commit after concurrent fix tasks
have landed. Evidence produced against an earlier working tree is preliminary
and must not be reused as the final release decision.

Before tagging, all of the following must be true:

1. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
2. a clean-install-equivalent deterministic gate passes on the exact candidate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

3. the exact publish-shaped `kodax-ai-kodax-0.7.78.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths; `/sandbox` declarations and
   `dist/sandbox-workspace-session.js` must be present;
4. FEATURE_263's preregistered paid semantic gate runs only after explicit
   owner authorization. Frozen revision `f263-v0.7.78.2` uses a four-call
   reviewer pilot, an inclusive 54-cell safety panel, and a 24-cell blinded
   downstream comparison. Its ceiling is 78 calls, 850,000 tokens, estimated
   `$0.78-$7.80`, and a hard `$10` external-spend cap. Raw output and blind
   main-session review stay outside the repository as required by
   `benchmark/EVAL_GUIDELINES.md`; the owner records the final ship decision.
   The entry point is `tests/feature-263-learning-release.eval.ts`;
5. FEATURE_277's required classifier semantic eval has a frozen experiment
   revision `f277-v0.7.78.2`, production-byte fixtures, budgets, raw dump, and
   blind review contract before any provider call. It uses a four-call pilot
   and an inclusive 60-cell panel with a 300,000-token ceiling, estimated
   `$0.60-$6.00`, and hard `$6` external-spend cap. Existing v0.7.33/v0.7.73
   evals are regression evidence, not a substitute for the v0.7.78 permission
   policy. The entry point is
   `tests/feature-277-permission-policy.eval.ts`;
6. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
7. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
8. only then is that exact commit tagged `v0.7.78`. The tag-triggered workflow
   must finish green and the GitHub Release must contain all five archives plus
   `SHA256SUMS`.

npm publication is deliberately outside this checklist's automated actions.
The maintainer publishes the already audited bytes with:

```bash
node scripts/release.mjs
```

Use `--otp=<code>` when npm 2FA requires it. Do not use bare `npm publish`;
the development manifest intentionally remains `private: true`.

The human verification guides are
[`FEATURE_263_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_263_v0.7.78_TEST_GUIDE.md),
[`FEATURE_276_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_276_v0.7.78_TEST_GUIDE.md),
and
[`FEATURE_277_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_277_v0.7.78_TEST_GUIDE.md).

## v0.7.77 release verification

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.77`. The candidate adds
FEATURE_274 pattern-aware adaptive AMA, FEATURE_275 governed event-triggered
memory intervention, the public 1M `kimi-k3` route, prompt-cache diagnostics,
Runtime interrupt/default-model reliability fixes, and the final child-runtime
cache/context identity and Actor capability hardening. Release hardening also
adds the host-configurable Shell Execution Contract, compaction-safe
request-only managed context, stable logical-context Provider cache affinity,
official Codex/Gemini CLI cache-usage preservation, ACP/native-CLI session
isolation with restartable pseudo transports and fail-closed process exits, and
terminal/schema/memory integrity fixes.

The version was tagged, released on GitHub, and published to npm on
2026-07-27. Its completed pre-tag gates were:

1. the deterministic local gate and exact tarball audit pass from a clean
   install;
2. the candidate commit's GitHub `CI` workflow is green for Node 20, Node 22,
   the Unix Runtime socket gate, the dedicated Windows Shell Contract gate,
   and packaged Electron on Windows;
3. the `docs/features` submodule points at the reviewed v0.7.77 design commit
   and both repositories are clean;
4. the preregistered F274/F275 paid evaluation is run only after explicit owner
   authorization and a frozen pre-call manifest, the main-session review is
   recorded, and the owner makes the joint ship decision. This gate completed
   on 2026-07-27 with a joint `SHIP` decision.

No task-effect improvement is claimed from deterministic tests or the bounded
release pilots.

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

Final local candidate evidence on 2026-07-27: the clean-install template,
package build, bundle, declaration, fast/unit/contract/system, packaged
Electron, and exact tarball audit gates passed. The final audited
`kodax-ai-kodax-0.7.77.tgz` is 4,144,186 bytes with SHA-256
`E30B447059F1C237B81E5896E51698D3FFD7987A8C5E1CF15F9F2354C846F63C`.
It was produced by `node scripts/release.mjs --pack-only`, including the
production build and exact Sidecar archive audit. Archive-level declaration
inspection confirmed `promptCacheKey`, `promptCacheAffinityHash`, and optional
cache read/write fields; production bundles retain the Kimi/OpenAI affinity and
Codex/Gemini cache-usage parser wire fields. The final release-evidence commit
passed Node 20, Node 22 (including the Unix Runtime socket gate), the dedicated
Windows Shell Contract job, and packaged Electron before tagging.

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
  packages/coding/src/child-executor.test.ts \
  packages/coding/src/orchestration/pattern-result.test.ts \
  packages/coding/src/shell-execution/contract.test.ts \
  packages/coding/src/shell-execution/environment.test.ts \
  packages/coding/src/shell-execution/resolver.test.ts \
  packages/coding/src/agent-runtime/prompt-cache-affinity.test.ts \
  packages/coding/src/agent-runtime/recursive-actor-integration.test.ts \
  packages/coding/src/agent-runtime/__contract-tests__/cap-071-non-streaming-fallback.contract.test.ts \
  packages/coding/src/agent-runtime/tool-execution-context.test.ts \
  packages/coding/src/task-engine/runner-driven.compaction-context.test.ts \
  packages/coding/src/task-engine/_internal/managed-task/llm-adapter.cache-affinity.test.ts \
  packages/coding/src/tools/bash.test.ts \
  packages/coding/src/workflows/structured-output.test.ts \
  packages/coding/src/self-knowledge/registry.test.ts \
  packages/coding/src/tools/manual.test.ts \
  packages/llm/src/providers/anthropic-message-serialization.test.ts \
  packages/llm/src/providers/openai-reasoning-capability.test.ts \
  packages/llm/src/providers/image-serialization.test.ts \
  packages/llm/src/cli-events/codex-parser.test.ts \
  packages/llm/src/cli-events/gemini-parser.test.ts \
  packages/llm/src/cli-events/executor.test.ts \
  packages/llm/src/cli-events/acp-client.test.ts \
  packages/llm/src/cli-events/pseudo-acp-server.test.ts \
  packages/llm/src/providers/acp-base.test.ts \
  packages/llm/src/providers/runtime-registry.test.ts \
  src/runtime-daemon/process.test.ts \
  src/runtime-permission-scope.test.ts \
  src/sdk-runtime.test.ts
```

The real concurrent-owner readiness boundary is covered separately:

```bash
npx vitest run src/kodax_cli.daemon-smoke.test.ts \
  -t "does not become ready before initial A2A reconciliation completes"
```

The focused human/host contracts are
[`ISSUE_212_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_212_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_213_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_213_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_214_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_215_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_215_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_216_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_216_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_217_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_217_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_218_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_218_v0.7.77_REGRESSION_GUIDE.md),
and
[`ISSUE_219_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_219_v0.7.77_REGRESSION_GUIDE.md).

The paid runners require explicit authorization in addition to available
credentials and persist resumable raw cells outside the repository. The frozen
release runs completed against clean commit
`25d5521e3eadc20ff1da2bd69d171736724bbcba`:

- F274 `f274-v0.7.77.6`: 96 Layer 2 calls and 40 Layer 3 calls, 820,432 tokens,
  estimated `$0.02122291`; blinded recommendation `recommend-ship`.
- F275 `f275-v0.7.77.3`: 16 pilot calls, 7,113 tokens, estimated
  `$0.00022152`; blinded recommendation `recommend-ship`.
- Joint decision: `SHIP` deterministic F274/F275 behavior. F275 semantic
  selection remains experimental/host opt-in; the 144-call validation is not
  run because v0.7.77 makes no semantic default-on or task-effect claim.

Raw outputs and blinded reviews remain under the OS temp directory specified
by `benchmark/EVAL_GUIDELINES.md`, never in the repository.
The immutable review bindings and post-review count corrections are recorded
in `%TEMP%/kodax-eval-dumps/v0.7.77-review-integrity-addendum.json` (SHA-256
`7600C403CAF159B65528FDFCA01FF51ACFA33F3B806A47BDD00F072957E0EBF9`);
the original blinded review files were not rewritten.

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

After every gate above was satisfied, the complete candidate was tagged
`v0.7.77`; the five-platform GitHub Release workflow built its binaries. npm
publication was completed separately by the maintainer.

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

**Worker or sandbox mode fails in a compiled binary** - verify
`semantic-worker.js`, `runtime-worker.js`, `sandbox-workspace-session.js`, and
`constructed-handler-worker.js` are next to the executable.
`scripts/build-binary.mjs` fails the build when any source sidecar is missing,
but copying only the executable after extraction breaks sidecar resolution at
runtime.
