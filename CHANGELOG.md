# Changelog

All notable changes to this project will be documented in this file.

## [0.5.23] - 2026-03-08

### Added
- **CLI Events Module** (`packages/ai/src/cli-events/`)
  - `types.ts` - Unified CLI event types (CLIEvent union)
  - `executor.ts` - Base CLIExecutor class with subprocess management
  - `gemini-parser.ts` - Gemini CLI JSON Lines parser
  - `codex-parser.ts` - Codex CLI JSON Lines parser
  - `session.ts` - CLISessionManager for KodaX↔CLI session mapping
  - `prompt-utils.ts` - Shared prompt building utility
  - `index.ts` - Barrel export

### Changed
- **gemini-cli provider** - Refactored to use CLI subprocess wrapper pattern
- **codex-cli provider** - Refactored to use CLI subprocess wrapper pattern
- Both providers now use `buildCLIPrompt()` shared utility
- Added stderr collection for error diagnostics
- Added `_installedCache` to avoid repeated spawn checks
- Added `exited` flag to prevent duplicate `child.kill()`

### Architecture
- **Delegate Pattern**: Tools are executed by CLI, not KodaX agent
- **Session Resume**: Multi-turn conversations via CLI session mapping
- **Zero Maintenance**: No need to track token format changes

### Documentation
- Added `FEATURE_016_CLI_PROVIDERS_TEST_GUIDE.md`
- Updated `v0.5.22.md` design document

## [0.5.22] - 2026-03-08

### Added
- CLI-based OAuth providers (gemini-cli, codex-cli) initial implementation

## [0.5.21] - 2026-03-08

### Fixed
- Chunked compression to avoid TPM rate limits
- Loop logic in cleanupIncompleteToolCalls
- Added ask-user-question tool

## [0.5.20] - 2026-03-07

### Added
- Project mode commands
- Context snapshot functionality
- Hot/cold track dual-track memory system
