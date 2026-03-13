# Changelog

All notable changes to this project will be documented in this file.

## [0.5.33] - 2026-03-12

### Changed
- Version bump release

## [0.5.32] - 2026-03-12

### Fixed
- Build fixes and compilation errors

## [0.5.31] - 2026-03-12

### Fixed
- Build errors related to @kodax/ai module
- Import fixes for @kodax/ai package
- Compaction build error fixes

### Changed
- Reviewed and refined readonly whitelist changes
- Reviewed widened mode permissions

## [0.5.30] - 2026-03-12

### Fixed
- **Issue 084**: Silent stream interruption with no error
  - Added message_stop/finish_reason validation to detect incomplete responses
  - Implemented dual timeout mechanism: 10min hard + 60s idle timeout
  - Added StreamIncompleteError classification with 3 retries
  - Added [Interrupted] indicator for interrupted generations
- **Issue 085**: Read-only Bash command whitelist not reused in non-plan modes
  - Implemented unified readonly whitelist across all modes
- **Skill System**: Skill amnesia after compaction
  - Fixed skill registry reset bug after context compaction
  - Added APIUserAbortError handling
- **Network Errors**: Retry "Request was aborted" errors from network issues
  - Improved error classification for transient network failures

### Added
- **Tri-Layer Security for Plan Mode**
  - Implemented comprehensive permission control for plan mode
  - Fixed bash permission bugs across all layers
  - Enhanced security boundaries between modes

### Documentation
- Resolved Issue 070: Streaming output newlines preserved
- Resolved Issue 067: API rate limit retry mechanism fixed
- Resolved Issues 006, 060, 081 after code review
- Added FEATURE_017 design document
- Added FEATURE_018 CodeWiki design document
- Added Issue 083: Missing keyboard shortcuts system

## [0.5.29] - 2026-03-11

### Changed
- **ACP Protocol Architecture Refactoring**
  - Refactored Gemini CLI and Codex CLI providers to use new ACP (Agent Client Protocol) architecture
  - Added `KodaXAcpProvider` base class for all ACP-based providers
  - Added `AcpClient` for ACP protocol communication (supports both native process and in-memory streams)
  - Added `createPseudoAcpServer` for in-memory ACP server simulation

### Added
- **New Files**
  - `packages/ai/src/providers/acp-base.ts` - Base class for ACP providers
  - `packages/ai/src/cli-events/acp-client.ts` - ACP client implementation
  - `packages/ai/src/cli-events/pseudo-acp-server.ts` - In-memory ACP server

### Improved
- **Resource Management**
  - Proper abort signal propagation through all layers
  - Session mapping between KodaX and ACP session IDs
  - Clean disconnect with resource cleanup
- **Error Handling**
  - Errors now properly propagated through ACP protocol
  - CLI installation check before streaming
- **Type Safety**
  - Replaced `any` types with proper TypeScript types

## [0.5.28] - 2026-03-10

### Fixed
- **Compaction Indicator Issues**
  - Fixed thinking spinner incorrectly showing "Compacting" after compaction check
  - Added `onCompactEnd` callback to properly stop spinner in all cases
  - Removed redundant `needsBasicCompact` check (100k threshold) - now only uses intelligent compaction threshold (75%)
  - Proper separation of concerns: `onCompact` for message display, `onCompactEnd` for spinner control

## [0.5.27] - 2026-03-10

### Fixed
- **Rate Limit Message Display**
  - Fixed rate limit retry messages appearing 3 times after task completion
  - Changed from console.log to callback-based approach (`onRateLimit` callback)
  - UI layer now controls rate limit message display instead of provider layer
  - Added `onRateLimit` callback to `KodaXProviderStreamOptions` type

### Added
- **Auto-Compaction Notification**
  - Status bar now shows "✨ Compacting..." indicator during context compaction
  - Added `onCompactStart` callback to notify UI before compaction starts
  - Info message displays after compaction: "Context auto-compacted (was ~Xk tokens)"
  - Fixed StatusBar and MessageList state consistency for compaction indicator

## [0.5.26] - 2026-03-08

### Fixed
- **Message Rendering Issues**
  - Fixed user messages appearing twice after tool confirmation (removed `filter()` that violated Ink `<Static>` append-only constraint)
  - Fixed assistant messages disappearing after streaming ended (clear streaming state before adding to history)
  - Clear `streamingResponse` and `thinkingContent` before `addHistoryItem()` to prevent duplicate display

## [0.5.25] - 2026-03-08

### Added
- **Real-time Context Usage Updates**
  - Context usage now updates after each LLM iteration, not just after all iterations complete
  - Added `onIterationEnd` callback to `KodaXEvents` for iteration-level notifications

### Changed
- `contextUsage` useMemo now uses `liveTokenCount` during streaming for real-time display
- Added `liveTokenCount` state for tracking token usage during agent execution

## [0.5.24] - 2026-03-08

### Added
- **Context Usage Display** (Issue 070)
  - Status bar now shows real-time context token usage with color-coded progress bar
  - Green (< 50%): Safe zone
  - Yellow (50-75%): Warning zone
  - Red (≥ 75%): Critical zone - should trigger compaction
  - Banner displays context window size and compaction settings

### Fixed
- **Duplicate Message Issue**
  - Fixed ghost `[Interrupted]` messages appearing on new submissions
  - Added `clearResponse()` in finally block to clear stale buffer
  - Added concurrent execution prevention (`isLoading || confirmRequest` guard)
- **Agent Improvements**
  - Prevented duplicate message push into context
  - Unified intelligent compaction (removed legacy truncation fallback)
  - Added API hard timeout protection (3 minutes) to prevent infinite waits
  - Added basic safety threshold (100k tokens) for compaction

### Changed
- Banner now shows context window (e.g., "Context: 200k") and compaction status
- Compaction info loaded before Ink app renders to ensure banner displays correctly

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
