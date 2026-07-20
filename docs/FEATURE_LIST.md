# Feature 总表

> 这是活跃 roadmap 与近期完成项索引：保留仍需计划/实现/验证的 feature，
> 并保留 archive cutoff 之后的近期发布项。更早的已发布、取消、吸收、搁置
> 历史见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.73` |
| Current package version | `@kodax-ai/kodax@0.7.73` |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `58` |
| InProgress | `1` |
| Planned | `11` |
| Completed | `39` |
| Reviewed out of active roadmap | `7` (`105, 108, 231, 232, 235, 238, 244`) |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 221, 224, 225, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| Completed | 39 | `271, 270, 266, 269, 268, 267, 260, 261, 259, 258, 253, 254, 255, 256, 257, 228, 251, 252, 250, 248, 249, 247, 246, 245, 243, 242, 241, 233, 240, 239, 224, 221, 174, 211, 237, 229, 230, 234, 236` | v0.7.73 is the current released baseline. |
| InProgress | 1 | `225` | `225` remains the bounded v0.7.100 cleanup. |
| Planned, near-term | 3 | `263, 264, 265` | `v0.7.75` -> `v0.7.85` |
| Planned, v0.8.x | 5 | `007, 030, 093, 113, 139` | `v0.8.5+` |
| Planned, v0.9.x | 1 | `262` | `v0.9.0` |
| Reviewed out, 2026-07-12 | 7 | `244, 231, 235, 238, 232, 105, 108` | Shelved, deferred, absorbed, or cancelled after the post-v0.7.70 roadmap review. |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, conservative retention, and durable source/provenance/resultSummary persistence; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.54` | `0` |
| `v0.7.55` | `0` |
| `v0.7.56` | `0` |
| `v0.7.57` | `0` |
| `v0.7.59` | `0` |
| `v0.7.61` | `0` |
| `v0.7.62` | `0` |
| `v0.7.63` | `0` |
| `v0.7.64` | `0` |
| `v0.7.65` | `0` |
| `v0.7.66` | `0` |
| `v0.7.67` | `0` |
| `v0.7.68` | `0` |
| `v0.7.69` | `3` |
| `v0.7.70` | `0` |
| `v0.7.71` | `0` |
| `v0.7.72` | `2` |
| `v0.7.73` | `1` |
| `v0.7.74` | `0` |
| `v0.7.75` | `1` |
| `v0.7.80` | `1` |
| `v0.7.85` | `1` |
| `v0.7.90` | `0` |
| `v0.7.95` | `0` |
| `v0.7.100` | `1` |
| `v0.8.5` | `3` |
| `v0.8.7` | `1` |
| `v0.8.25` | `1` |
| `v0.9.0` | `1` |

> Release cadence rule: every `v0.7.x` feature-bearing release normally leaves
> the next two patch versions for debug/patch releases. `v0.7.55` is intentionally
> left without a planned feature so it can be used for the temporary emergency
> release. `FEATURE_239` and `FEATURE_240` both moved to `v0.7.56`.
> `FEATURE_233`, `FEATURE_241`, `FEATURE_242`, and `FEATURE_243` shipped in
> `v0.7.57`; `v0.7.58` shipped 2026-07-02. `v0.7.59` (2026-07-03) shipped
> `FEATURE_248` (AMAW mode-level orchestration directive) + `FEATURE_249` (AMA
> natural-language workflow activation) as a rollup on top of the Space SDK R1-R6
> hardening and ark-coding lineup refresh.
>
> **Historical 2026-07-04 reschedule, superseded for active targets by the
> 2026-07-08 cadence update below**: at user request, every planned `v0.7.x`
> feature at `v0.7.60` and later was temporarily pushed back 3 minor versions,
> except `FEATURE_250` (stays `v0.7.60`) and `FEATURE_251` (stays `v0.7.61`).
> That temporary mapping is retained only as release-cadence history; use the
> 2026-07-08 cadence update below for every active target.
>
> **Historical 2026-07-08 runtime cadence update, superseded for future
> feature assignments by the 2026-07-12 roadmap review below**:
> `FEATURE_253`, `FEATURE_254`, and
> `FEATURE_255` reserve `v0.7.64`, `v0.7.65`, and `v0.7.66` for the KodaX
> runtime migration sprint: embedded runtime contract, host migration/control
> plane hardening, and local daemon. `v0.7.67`, `v0.7.68`, `v0.7.69`, and
> `v0.7.70` are reserved as feature-free runtime stabilization / bugfix slots.
> At that time, the previous `FEATURE_244` and `FEATURE_231` reschedule was:
> `244` +
> `231` + `235` -> `v0.7.75`, `238` -> `v0.7.80`, `232` -> `v0.7.85`,
> `105` -> `v0.7.90`, `108` -> `v0.7.95`, and `225` -> `v0.7.100`. All
> v0.8.x features remain unchanged.
>
> **2026-07-10 runtime release rollup**: the v0.7.64 and v0.7.65 development
> slots were not cut as standalone tags. FEATURE_253, FEATURE_254, and
> FEATURE_255 release together in v0.7.66 after the final context/tool exposure
> eval and release audit. The already implemented FEATURE_256 and FEATURE_257
> isolation follow-ups are also delivered early in v0.7.66; their former
> v0.7.71/v0.7.72 slots return to stabilization capacity.
>
> **2026-07-07 patch release**: `v0.7.63` is a no-planned-feature-slot
> patch/stability release for SDK session boundary hardening, deterministic
> transcript fixtures, `/reload` extension rediscovery, and feature-design index
> cleanup. After the 2026-07-08 cadence update, every slot before `v0.7.75`
> remains available as debug/patch buffer.
>
> **2026-07-09 runtime design addendum**: `FEATURE_254` now explicitly absorbs
> session-scoped runtime settings, stable rich-UI event payload families,
> config-boundary rules, runtime input/artifact parity, session-operation
> parity, daemon-prep permission/replay hardening, and the Hermes-like
> agent-performance/context-budget plane: runtime budget snapshots, tool
> exposure planning, portable `tool_search` / `tool_describe` / `tool_call`
> bridge semantics, skill/MCP metadata budgets, context-aware tool-result
> budgets, compaction anti-thrashing, small-window behavior, and report-only
> guardrails before pruning is enabled. `FEATURE_255` now explicitly absorbs
> daemon config/admin APIs, MCP/custom-provider admin APIs, command/skill
> catalogs, artifact upload/reference APIs, protocol initialization/versioning,
> protocol schemas, client identity/capabilities, session settings/history
> operations over transport, deterministic multi-client permission semantics,
> and daemon transport/diagnostics for the same context-budget/tool-exposure
> plane. No new feature ID or release slot is added.
>
> **2026-07-10 isolation follow-up (delivered early in v0.7.66)**: concrete SDK
> embedder demand added optional Worker-hosted embedded Runtime + hard disposal
> (FEATURE_256) and constructed-handler Worker fault isolation (FEATURE_257).
> Release review proved capability/configuration fail-closed behavior in all
> three Runtime forms and that constructed-handler revoke drains active/queued
> calls without Worker resurrection. Worker isolation remains explicitly not an
> untrusted-code sandbox and adds no generic arbitrary-code execution service.
>
> **2026-07-10 external-agent + build-loop efficiency exception**: two bounded
> features consume the first stabilization slot, `v0.7.67`. `FEATURE_258`
> delivers the protocol-neutral, host-injected executor plane, dispatchable
> catalog, task ledger, Worker child bridge, Workflow target, and
> Embedded/Daemon API. `FEATURE_259` applies a measured cost-discipline pass to
> the same multi-agent surface: truthful/smaller resident prompts, explicit
> tier intent, focused child/review handoffs, consolidated scope review, and
> conditional digest reuse. It adds no orchestration framework, model-price
> router, or protocol adapter. Concrete A2A, MCP Tasks, and governed HTTP
> adapters remain separate follow-ups so core KodaX does not acquire protocol
> SDK dependencies or overstate cancel/recovery semantics. At that point,
> `v0.7.68`-`v0.7.70` remained stabilization slots, and no third feature was
> planned for `v0.7.67`.
>
> **2026-07-11 Memory Agent schedule exception**: at explicit user direction,
> `FEATURE_260` consumes `v0.7.68`. It extends the released F228 Memory Control
> Plane with zero-wait proactive recall, bounded Outcome Digests, staged
> evidence-backed learning, exact cross-session applicability, cache-safe
> ephemeral reminders, and a thin experimental agent-layer `MemoryAgent` SDK.
> `v0.7.69`-`v0.7.70` remained stabilization slots until the Learning Center
> correction recorded below.
>
> **2026-07-12 post-v0.7.70 roadmap review**: the active `v0.7.x` roadmap now
> follows ADR-052. Memory carries facts/preferences/constraints, Skills carry
> reusable methods, Extensions carry repeated deterministic executable
> capability, and Workflows remain on-demand execution primitives rather than a
> learned carrier. `FEATURE_244`, `231`, `235`, `238`, `232`, `105`, and `108`
> leave the active roadmap. `FEATURE_266` establishes the shared Learning
> Center/control plane in `v0.7.70`; `FEATURE_263` closes the released F224
> Skill Loop in `v0.7.75`; `FEATURE_264` adds a trust-gated Extension learning
> loop in `v0.7.80`; `FEATURE_265` consolidates Hermes-parity work efficiency and
> coding assurance in `v0.7.85`. `v0.7.90` and `v0.7.95` return to stabilization
> capacity. `FEATURE_225` remains the bounded final cleanup in `v0.7.100`.
>
> **2026-07-12 Learning Center correction**: `FEATURE_266` now consumes
> `v0.7.70`. It establishes the shared agent-layer Learning Center, Learned
> Capability Area, durable lifecycle/events/client cursors, human-readable
> names, Runtime SDK parity, and real Ink/classic notification placement before
> F263/F264 author capabilities. It does not add a Workflow Loop, Skill
> reviewer, or Extension generator. The learning sequence is now F260
> (`v0.7.68`) -> F266 (`v0.7.70`) -> F263 (`v0.7.75`) -> F264 (`v0.7.80`) ->
> F265 (`v0.7.85`).
>
> **2026-07-13 A2A product/config closure**: `FEATURE_267` remains the same
> bidirectional A2A Feature, now explicitly including the missing no-TypeScript
> CLI/config/Runtime product surface and the ability to bind one admitted
> `~/.kodax/agents/<name>.md` through an owner-side, revision-pinned Runtime
> service. The completed design correction treats A2A as a general task-Agent
> surface—documents, presentations, databases, MCP, approved automation and
> Agent orchestration—while ACP owns coding workspace/editor/terminal
> collaboration. It binds trusted Runtime Skills (including
> `~/.agents/skills`), separates internal Skills from public Agent Card skills,
> and layers native tools, product-managed services, trusted narrow Extension
> tools, exact MCP allowlists, and exactly admitted isolated Skill scripts under a
> structured deployment `toolPolicy`. The isolation correction now makes this
> concrete rather than pluggable: `skillScripts` is a default-empty map from
> exact Skill names to exact `scripts/...` entrypoints. Skill instructions/resources
> remain usable with process denied,
> and admitted checked-in scripts use one exact-version, privacy-reviewed ASRT
> adapter with no Extension backend registry, credential injection, TLS MITM,
> ambient SRT settings, runtime download, or host-shell fallback. Managed
> context workspaces default below `~/kodax_a2a_server_workspace`; optional
> fixed resource roots remain host-selected. ASRT is local process containment,
> while hostile multi-tenant serving requires an outer container/VM. New
> `FEATURE_268` shares `v0.7.69` as its bounded substrate: one user-level file
> each for MCP, A2A, and Extensions, canonical core/MCP/A2A/Extension templates,
> migration, actual live reconciliation, last-known-good reload, and explicit
> restart-required status for inbound Agent/Skill/tool-policy/workspace binding
> changes. User `a2a.json` intentionally contains independent outbound `agents`
> and inbound `server` sections; no project integration scope is added.
> It adds neither one-file-per-link storage nor a generic plugin/config
> framework;
> `FEATURE_266` remains planned for `v0.7.70`.
>
> **2026-07-13 F267/F268 joint implementation checkpoint**: the bounded code
> path is complete and jointly verified with 158 focused tests at 80.55% line
> coverage, 9689/9689 full-suite assertions in 810 files, full TypeScript/
> bundle/DTS/template checks, npm dry-run contents, and four real daemon CLI
> smoke tests. The current Windows host correctly reports ASRT setup-required
> until its explicit one-time sandbox account provisioning is performed; there
> is no host-shell fallback. At this checkpoint both Features remained
> InProgress for independent A2A/TCK and cross-platform release evidence; the
> later v0.7.69 release closed the bounded implementation status without
> claiming official-TCK certification. Their original product paths are implemented; the F269
> insertion additionally requires the cross-Feature operation/revision
> integration recorded in the v0.7.69 design before they can ship together.
>
> **2026-07-16 F267/F268 standards-authentication and activation closure**:
> the v0.7.69 feature design now records this post-release amendment, implemented
> in the v0.7.71 patch; older v0.7.69 binaries did not contain these
> later OAuth profiles. KodaX outbound can obtain short-lived
> access tokens from an external Authorization Server with OAuth 2.0 Client
> Credentials; KodaX inbound can validate RFC 9068 JWT access tokens as a
> Resource Server. KodaX does not sign or issue production tokens. The same
> user-level `a2a.json` keeps every third-party declaration and adds one hot
> `agents.<name>.enabled` desired-state switch, managed by `a2a enable|disable`.
> Running owners apply disables/removals before network preparation, reconcile
> only source-owned changed/drifted entries, fence authority changes before
> parallel discovery, retry failed same-revision activation, preserve durable
> registration writes, and never cancel already admitted tasks. Card-level and
> Skill-level security requirements, token/interface origin separation,
> complete executor revisions, exact issuer/scope validation, compare-and-clear
> token refresh, and reflected-token redaction across successful/error/SSE paths are part of the
> closure; groups, schedules, priorities, and a second runtime-only switch are
> deliberately not added.
>
> **2026-07-13 shared-daemon priority insertion**: `FEATURE_269` joins
> `v0.7.69` as a third Critical Feature without automatically moving
> `FEATURE_267` or `FEATURE_268`. It closes the released F255 gaps required
> by Space v0.1.32's default Coder migration: atomic session observation and
> resync, durable operation ordering/idempotency, transport-safe AskUser and
> permission concurrency, run/provider-scoped Space credential brokerage,
> immutable run-bound Host Tools, explicit unknown/interrupted recovery, and a
> shared daemon/inline Coder owner fence with sticky rollback. Partner remains
> private embedded and Space Artifact remains Space-owned. The three
> v0.7.69 Features keep separate release gates so product can explicitly
> reschedule F267/F268 later without weakening F269.
>
> **2026-07-14 adaptive collaboration insertion**: `FEATURE_270` joins
> `v0.7.70` beside F266. It replaces KodaX's overlapping one-shot child,
> Workflow-local, and external-task collaboration authorities with one
> Runtime-owned actor tree and scheduler. AMA gains feedback-driven Agent
> delegation and recursion under the Codex V2 default of four total session
> slots including a reserved Root lane (three active non-root turns), explicit
> `AgentLimitReached` without a hidden capacity queue, direct-parent
> completion, reusable Actor identities with separate Turn lifecycles,
> safe-boundary follow-up, interruption, a root-owned work budget, and a
> canonical Ultra-aligned collaboration surface. F270 retires AMAW and F248's
> complexity-driven Workflow directive, leaving AMA as the single adaptive
> multi-Agent mode.
> F249's explicit natural-language Workflow request plus `/workflow`,
> `/review --workflow`, named, and SDK execution remain available; task
> complexity alone never activates Workflow in either prompt or tool-description
> bytes. Released Workflow product capabilities remain while their declared
> pending steps stay protocol state and child execution moves to the unified
> control plane; post-F270 use determines later retirement or evolution. The old
> model-visible task tool names are superseded rather than kept as a second
> orchestration system, and F269's released owner/recovery schema is a hard ship
> prerequisite.
>
> **2026-07-15 patch deferral**: `FEATURE_266` and `FEATURE_270` move together
> from `v0.7.70` to `v0.7.71` so `v0.7.70` remains a bounded, feature-free patch
> release. Scope, priority, dependencies, and acceptance criteria are unchanged.
> This schedule correction supersedes the earlier `v0.7.70` target references
> above without rewriting their historical record.
>
> **2026-07-16 second patch deferral**: `FEATURE_266` and `FEATURE_270` move
> together again from `v0.7.71` to `v0.7.72`. Their scope, priority,
> dependencies, and acceptance criteria remain unchanged. This is the current
> target and supersedes the 2026-07-15 `v0.7.71` assignment.
>
> **2026-07-15 F269 embedder patch**: the feature-free `v0.7.70` patch fixes
> logical daemon client accounting and adds a public, revisioned, atomic
> daemon-to-inline rollback contract. Process-distinct automation proves
> `1 -> 2 -> 1` clients, stale-commit rejection, detach-only `close()`, and two
> daemon/inline owner cycles. F269 remains assigned to `v0.7.69`; this is a
> compatibility fix, not a new Feature or a reschedule of F266/F270.
>
> **2026-07-15 v0.7.70 release hardening**: issues 161-164 close MCP physical-
> capacity/cache/pagination and multilingual zero-match defects, plus A2A
> provider-default, endpoint-trust, task-lifecycle, artifact, and protocol gaps.
> The release also begins the KAI-FCL-1.0 license boundary. These are bounded
> compatibility, correctness, and distribution changes; they do not add a new
> Feature or move F266/F270 back into this patch slot.
>
> **2026-07-17 v0.7.71 patch release**: issues 165 and 166 make packaged/asar
> Electron daemon auto-start execute through a bootstrap-only Node boundary,
> prevent a second GUI launch, scrub Electron Node mode before daemon and user
> child code loads, and document the `RunAsNode` fuse/attach-only boundary.
> Windows CRLF template checks are also normalized. The patch additionally
> carries the post-release F267/F268 OAuth/activation closure, Issues 167-170
> hardening, explicit stopped-server durable-owner migration, concurrent A2A
> admission, bounded executor/daemon lifecycle, and the public Kimi K2.7 plus
> Kimi For Coding K3 capability refresh. No new Feature ID enters the slot;
> F266/F270 remain scheduled together for v0.7.72.

> **2026-07-19 v0.7.73 first-run setup insertion**: `FEATURE_271` makes a
> fresh interactive CLI installation recoverable without requiring users to
> discover provider aliases, config-file schema, and environment-variable names
> from an eventual failed model call. It is intentionally coupled in release
> timing, but not in authority, with the Auto LLM classifier-model patch: the
> setup flow writes only non-secret provider/model configuration; Runtime Auto
> LLM continues to fail clearly when no valid classifier model is available.
> No API key is entered, persisted, or exposed by the wizard.
> The original implementation slice completed on 2026-07-20 after the matching 1.625 MB historical
> tool-result regression was bounded at the classifier API, implicit Auto LLM
> ownership was corrected, the four-call GLM-5.2 diagnostic probe completed,
> and the full 10,321-test suite passed. F271 was reopened the same day to close
> the public typed-settings resolver, Runtime speculative-window parity,
> capability-v3 daemon negotiation, and prompt-free sideQuery/guardrail
> diagnostics before release.
>
> **2026-07-12 F225 early cleanup slice**: the Classic readline
> reverse-video StatusBar was proven write-only (`update()` calls with no
> production `show()`/`toggle()`), internal-only, and independent of the live
> Ink StatusBar and Runtime SDK. Its module, dead-only tests, allocation,
> updates, and cleanup calls were removed. The auto-mode guardrail returns to
> its documented lazy first-use construction. F225 remains InProgress because
> the broader current-HEAD cleanup is still planned for `v0.7.100`.
>
> **2026-07-11 emergency session-recovery exception**: `FEATURE_261` is a
> bounded v0.7.67 corrective enhancement prompted by Issue 149. It replaces
> bare `-r` auto-resume with a searchable/paged TUI, adds SDK surface/cursor
> session listing, hides non-resumable zero-message placeholders, and provides
> preview-first reversible cleanup. It does not consume a new roadmap slot.
>
> **2026-07-12 v0.9.0 supply-chain security reactivation**: `FEATURE_262`
> reuses the otherwise empty `v0.9.0` milestone for npm 12 install-time
> security and npm trusted publishing. This does not move any feature out of
> the archived `v0.9.5` staging history. The feature keeps Node 20 runtime
> support, proves that KodaX builds without dependency lifecycle scripts, and
> migrates npm publication from long-lived/bypass-2FA credentials to GitHub
> Actions OIDC before the January 2027 publishing cutoff.

---

## 进行中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `225` | REPL Dead / Legacy Code Cleanup | Internal / Refactor + Tech Debt | Medium | `v0.7.100` | [v0.7.100](features/v0.7.100.md#feature_225-repl-dead--legacy-code-cleanup) |

---

## v0.7.73 Completion Record

`271` completed its original onboarding and classifier-input slice, then closed
the SDK public-contract work for the v0.7.73 release. A bare
interactive CLI with no valid provider selection or credential now enters a
metadata-only provider/model setup before Runtime startup; explicit
`kodax setup` reuses the same revision-checked atomic writer. Auto LLM now
rejects missing classifier identity before permission work, treats omitted
engine as the LLM default under Runtime ownership, and bounds historical
Runner context at the classifier API. The SDK closure is now implemented: root
and REPL entries export the typed resolver/loader, Session state owns the
speculative window (including zero), v3 capability negotiation safely upgrades
idle v1/v2 daemons while preserving minimum-version compatibility, and prompt-free
sideQuery diagnostics plus callback-lifetime guardrail spans make timeouts
observable. The classifier-input closure now also replaces historical results
with status-only metadata, deduplicates canonical history, unwraps portable
tool bridges, and gives MCP, constructed tools, and JavaScript extensions one
fail-closed semantic projection contract. High-impact built-ins expose bounded
operational facts rather than raw bodies; non-readonly empty projections require
an explicit exemption, common snake/camel SDK fields share one priority-safe
table, projector failures escalate, and Tier 0 runs before any opt-out. The
deterministic build, focused suites, full test suite, and GitHub release gates
completed the release validation on 2026-07-20.

---

## v0.7.72 Completion Record

`266` implementation and its zero-provider Layer 1 gate are complete: the
Runtime-owned Learning Center, learned-area store, lower-precedence learned
Skill discovery, daemon/Worker facade, `/learn`/status surfaces, notification
cursors, and hard-dispose persistence are covered by deterministic tests. It
shipped in v0.7.72 after the package, documentation, build, and release gates
were finalized.

`270` engineering implementation and release eval are complete:
native, Workflow-owned, and external Agent work share the Runtime-owned
Actor/Turn tree, scheduler, durable snapshot, canonical collaboration tools,
and output events. AMAW and the parallel legacy task lifecycles are retired. A
deletion/replacement review found and fixed native/external executor selection,
durable mailbox/history projection, capability-ceiling, shared-budget, and
stale-follow-up concurrency gaps, then closed accidental Workflow activation and
speculative Actor-output-read behavior found by the frozen eval. It also
corrected an unsafe migration premise:
pre-F270 native/default-Workflow active state was process-local and F258 records
lack exact session ownership, so recovery never guesses or re-parents legacy
work. The frozen Layer 2/3 driver, exact historical/current production-byte
fixtures, manifest-only gate, budget enforcement, raw-cell integrity checks,
and blind evidence packs are complete. The final isolated 227/227 focused suite
and full build pass. The authorized Layer 2 treatment is non-inferior in 29/30
blind pairs; Layer 3 is non-inferior in 5/6 journeys with no invalid-plan replay.
Estimated evaluated-revision spend is `$0.02550684`; engineering recommendation
is `recommend-ship`. F270 shipped in v0.7.72; the separate manual guide remains
evidence rather than a sign-off gate.

The 2026-07-18 Sidecar/Actor alignment follow-up is also complete. Terminal
verification now waits for both descendant termination and root-scoped
completion delivery, synthetic completion cannot replace real user intent, and
the verifier consumes bounded task/plan/tool/file evidence with explicit
confidence semantics. The final related Layer 1 gate passes 188/188; its
separate 32-call blind A/B is candidate 14/14 versus baseline 12/14 across the
seven valid cases and recommends ship without a credible false-revise
regression. The detailed raw-evidence paths and invalid-fixture analysis remain
in the v0.7.72 design document.

A post-implementation control-plane review also replaced the stale model-owned
`seen_by` forwarding field with Runtime-minted mailbox message IDs and
authenticated lineage, added cycle/depth/classification guards and per-turn
recipient limits, and made native/external Turn progress observable through the
existing Ink/Classic activity surface. Progress, list summaries, output
previews, and event retention are explicitly bounded; no legacy task registry,
second UI store, or duplicate compatibility tool was restored.
The post-review and interruption-cleanup gate passes 62/62 focused and 286/286
cross-layer tests, 88.79% core statement/line and 80.05% branch coverage, the
complete build, and the 2/2 zero-provider manifest check.

A final completeness audit keeps the seven-tool model command plane but makes
its observation and reversible-control semantics complete: `list_agents` now
offers visibility-safe filtering and bounded cursor pagination; `wait_agent`
returns a bounded, cursor-safe event batch; `agent_output` preserves legacy
artifact strings while adding executor-neutral metadata; and
`interrupt_agent(scope='subtree')` atomically cancels an invalidated branch
without retiring reusable Actor identities. Permanent subtree close is exposed
only through the trusted Runtime host. Pause, reopen, reparent, resource-budget
changes, and capability grants remain intentionally outside the model surface
because they respectively require a portable checkpoint, administrative
identity migration, user cost authority, or host security authority. The audit
also fixes the root-only ambiguity between the non-root `parent` alias and a
valid root child named `parent`.
The completeness-audit gate passes 62/62 focused, 285/285 Actor/Workflow/
storage/UI cross-layer, and 252/252 SDK/protocol regression tests. The five
core implementation files reach 89.47% statements/lines and 82.01% branches;
the complete package/bundle/Worker/DTS build and 2/2 zero-provider manifest
eval also pass.

The 2026-07-18 adversarial concurrency follow-up closed two final runtime
classes without restoring a legacy surface. F270 now installs each Turn's
AbortController in the same atomic start commit, makes closed Actors inert for
mailbox send/receive, skips terminal executor no-op persistence, advertises
`actorControlPlane v1`, and returns explicit SDK-upgrade/daemon-restart errors
for incompatible peers. The full and fallback Worker prompts now begin with an
authoritative current total/active Actor-capacity contract before any spawn
wave is announced, and explicit Workflow intent now
recognizes the product word in English, Chinese, Japanese, and Korean without
guessing from complexity. F266 now uses cursor read-register-recheck,
cancellable subscription waiters, and owner-scoped initialization without a
principal-to-facade cache. PID-reuse stale-lock handling remains deliberately
fail-closed pending a portable process-start identity contract. A six-call
`zhipu/glm51` follow-up pilot distinguishes the repaired prompt: treatment
starts three Actors for a fresh five-track request while the historical
baseline starts five; this diagnostic re-pilot does not replace the original
authorized Layer 2/3 result.

The same release closure makes Runtime Auto Mode a real permission
owner rather than a prompt/config preference: an auto session reuses one LLM or
rules guardrail across turns, executes guardrail -> permission bridge -> tool,
and persists a fallback to rules. Classifier model/timeout are durable session
settings and daemon capabilities. The surrounding permission boundary now
keeps `gitRoot` as a safety boundary, resolves relative operands from the
validated execution directory, avoids quoted-source false paths, emits bounded
credential-redacted JSON previews, and omits `exit_plan_mode` when no host
approval callback exists. The final REPL follow-up scopes queued prompts to the
session-root Actor, preserves original history timestamps, and closes the bare
resume picker cleanly: list startup stays lightweight, selecting a session
hands stdin to the REPL, and Esc immediately returns the invoking shell.

Recent completion notes:

`267`, `268`, and `269` shipped together in `v0.7.69`. The release provides the
bounded A2A 1.0 JSON-RPC/SSE client/server edge, no-code Agent management and
serving, exact Agent/Skill-script admission, three split integration files with
migration and last-known-good hot reload, plus the authoritative shared Coder
daemon with atomic observation, durable operations, transport-safe interaction,
run-scoped credential/Host Tool bridges, recovery facts, and owner fencing.
Their release evidence is historical and no source or publication gate remains.

`260` completed for `v0.7.68`: the thin experimental Memory Agent SDK,
zero-wait scoped recall, deliberate read-only `memory_recall`, trace-only
decision receipts, bounded Outcome Digests/review inbox, consult-before-write
promotion, and cache-safe policy-versioned provider integration are complete.
The fresh `f260-v0.7.68.2` 520-call panel passed every preregistered gate; the
earlier v1 99%-for-all panel remains diagnostic only.
Post-review hardening for Issue 152 additionally removes credential-bearing Git
remote identity, closes Windows/interpreter mutation-guard gaps, serializes
review/proposal/lifecycle persistence, and makes eval provenance/cache handling
fail-loud without changing the frozen prompt, tool schema, or policy bytes.
The bundled `kodax_manual` now routes memory-capability questions to a dedicated
F228/F260 topic, covers every built-in slash command through a two-way drift
test, and points SDK readers at the Runtime and experimental-memory contracts.
The schema-v2 manifest remains available, but Windows temporary-directory
cleanup reclaimed the earlier 520-cell raw/review artifacts during the final
full-suite validation; a renewed raw-evidence audit therefore requires an
explicitly authorized bounded rerun rather than reconstruction.

`261` shipped in `v0.7.67`: bare `-r`
opens a searchable keyboard-driven picker with the full selected ID; explicit
resume is ID-first, then exact-title with duplicate disambiguation; session listing supports exact
surface filtering and opaque cursor continuation across Embedded/Daemon SDK
forms; ACP handshake-only sessions remain provisional; and strict cleanup is
preview-first plus reversible archive.

`258` shipped in `v0.7.67`: protocol-neutral
host-injected executors, the policy-filtered catalog, durable task ledger,
Worker/Workflow routing, Embedded/Daemon parity, public in-process Daemon
factory bootstrap, and Reference Executor conformance are all implemented.

`253-257` shipped together in `v0.7.66`: the embedded Runtime contract, host
migration/control plane, local daemon transport, context-budget/tool-exposure
planner + portable bridge, Worker-hosted Runtime, and constructed-handler Worker
fault isolation. The release audit closed the bridge permission eval drift and
fixed GitHub binary archive sidecar omission before tagging.

`251`（Tool-Output Token Efficiency）在 `v0.7.61` 首次引入 body-only 命令过滤；2026-07-14 一条真实 review 记录显示自动摘要后发生 1 次 raw artifact 恢复读取及其额外 tool-result 循环，因此否定了“透明事后有损压缩默认开启即可直接视为端到端收益”的假设，但不据此虚构恢复率或 token 百分比。同一记录中的格式命令重跑有独立的 `%` 转义失败原因，不归因于压缩。当前源码已纠偏为完整采集、严格更短的契约等价无损规范化、下一次物理请求的批次单一 capacity owner，以及仅在完整批次确实放不下时使用 `KODAX_RESULT_INCOMPLETE` + 完整 artifact。旧 32KB / 600 行不再是 token policy，512KiB 仅是 Bash memory→spool 阈值；compiled/declarative 有损 filter 默认关闭。历史 compaction 同步改为物理容量触发：容量内不自动有损，默认 microcompaction/destructive fallback 关闭，真实压力下 summary-first，失败则 typed error 且不改 canonical history；静态提前百分比仅显式 opt-in。`252`（Workflow Quality Preflight）当前收窄为纯确定性合约 lint：启动前对未 await 的 workflow-command 真值判断、schema 顶层字段误用、静态 agent fanout 超 manifest/host 上限做硬失败；review/verifier/通用质量启发式刻意不作为模型可见告警发出。二者均为确定性代码，无 prompt 改动、无 LLM eval。`v0.7.61` 同时修复一处 workflow 启动崩溃：`typescript` 提升为 `@kodax-ai/agent` 运行时依赖（quality lint 在热路径使用 TS 编译器 API）。

> `249` shipped 2026-07-03 (Option A): widened `buildWorkflowToolHost`
> (`tool-execution-context.ts`) from `!== 'amaw'` to `!== 'amaw' && !== 'ama'`, so AMA
> and AMAW both host `run_workflow` — AMA activates it on an explicit natural-language
> request (tool available, LLM-native), AMAW additionally on complexity (the FEATURE_248
> `ORCHESTRATION DEFAULT` directive, which stays strictly amaw-only via the independent
> `amawOrchestrationAvailable` gate — verified structurally separate). SA unchanged
> (fails gate + `SA_SOLO_EXCLUDE_TOOLS`). No prompt change (run_workflow's own description
> is the request-driven surface). cap-048 CAP-TOOL-CTX-009/010 updated; FEATURE_248
> role-prompt boundary tests green unchanged. The AMA-turn token cost of the resident
> run_workflow description was found to be a broader gap (the deferred-tool mechanism is
> SA-path-only) → filed as `250`. See docs/features/v0.7.60.md §FEATURE_249.

> `248` narrowed-SHIP 2026-07-03: AMAW-gated, mode-level `ORCHESTRATION DEFAULT`
> standing directive in the Worker system prompt (mirrors the ultracode mechanism),
> leak-closed via a new optional `ManagedRolePromptContext.amawOrchestrationAvailable`
> field. Layer-1 green (role-prompt.test.ts, 28 tests). Eval history: the old
> tool-level lever (A run_workflow desc + B' dispatch nudge) was eval-falsified and
> reverted; the mode-level directive floored 0% on a mid-task real-session replay, but
> a deep multi-agent investigation found that fixture tested the WRONG moment (mid-task
> defection, not the turn-0 decision ultracode actually applies). The turn-0 eval
> (`workflow-activation-turn0.eval.ts`, 4 aliases) then showed a real lift on the same
> a2aDesign task (mid-task 0% -> turn-0 baseline 8% -> proposed 33%, +25%) with models
> causally citing the directive ("按照编排默认原则... 让多个 agent 交叉验证"). A follow-up
> flow-fix (PLAN-TIME COMMITMENT: front-load the orchestrate-vs-solo call to turn-0 +
> make plan items = the agents/stages) then added a causally-confirmed increment on top
> of the ambient directive (turn-0 3-variant: +8~+17% on 3/4 shapes, zero regression;
> pulls review off the floor) and was merged into `orchestrationDefault`. Shipped with
> acceptance NARROWED to task-inception activation; mid-task re-architecture is a
> documented non-goal. Absolute activation is model-ceiling-limited on current
> coding-plan aliases. See docs/features/v0.7.59.md §6/§6.1.

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `263` | Evidence-Gated Background Skill Learning Loop | Core / Skills + Self-Improvement | High | `v0.7.75` | [v0.7.75](features/v0.7.75.md#feature_263-evidence-gated-background-skill-learning-loop) |
| `264` | Evidence-Gated Extension Learning Loop | Core / Extensions + Self-Improvement | High | `v0.7.80` | [v0.7.80](features/v0.7.80.md#feature_264-evidence-gated-extension-learning-loop) |
| `265` | Work Fast Path + Coding Assurance Budget | Core / Performance + Agent Quality | High | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_265-work-fast-path--coding-assurance-budget) |
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_007-theme-system-consolidation) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_030-multi-surface-delivery) |
| `093` | Coding and REPL Internal Circular Dependency Decoupling | Internal | Medium | `v0.8.5` | [v0.8.5](features/v0.8.5.md#feature_093-coding-and-repl-internal-circular-dependency-decoupling) |
| `113` | TodoList JSON / CLI Surface | Enhancement | Medium | `v0.8.7` | [v0.8.7](features/v0.8.7.md#feature_113-todolist-json--cli-surface) |
| `139` | NotebookEdit Tool | Enhancement / Tool | Low | `v0.8.25` | [v0.8.25](features/v0.8.25.md#feature_139-notebookedit-tool--jupyter-cell-level-crud) |
| `262` | npm 12 Install-Time Security + Trusted Publishing Migration | Internal / Supply Chain Security | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_262-npm-12-install-time-security--trusted-publishing-migration) |

---

## 2026-07-12 Reviewed-Out Feature Records

| ID | Previous target | Decision | Design record |
|---|---|---|---|
| `244` | `v0.7.75` | Shelved; reopen only through F265's measured cold-module hot-path gate. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `231` | `v0.7.75` | Cross-process Workflow replay deferred out of active `v0.7.x`. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `235` | `v0.7.75` | Removed; current approval/save/revise lifecycle is sufficient without a Workflow Loop. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `238` | `v0.7.80` | Cancelled; Workflow remains execution-only, while Skills/Extensions are learned carriers. | [v0.7.80](features/v0.7.80.md#2026-07-12-roadmap-review) |
| `232` | `v0.7.85` | Removed as already absorbed by F246 pipeline + same-session reuse. | [v0.7.85](features/v0.7.85.md#2026-07-12-roadmap-review) |
| `105` | `v0.7.90` | Removed; specialist dispatch and existing judge/Sidecar paths cover concrete need. | [v0.7.90](features/v0.7.90.md#2026-07-12-roadmap-review) |
| `108` | `v0.7.95` | Removed; local learning belongs in Skills/Extensions and global prompt work stays engineering-led. | [v0.7.95](features/v0.7.95.md#2026-07-12-roadmap-review) |

---

## 阅读说明

- `FEATURE_LIST.md` 是活跃索引，不再承载长篇立项正文。
- 每个活跃 feature 在本表只保留：ID、标题、类别、优先级、目标版本、设计入口。
- 活跃项必须有明确版本和设计入口；`TBD` / parking-lot / 用户需求未成熟的项不进主表。
- archive cutoff 之前的已完成、取消、吸收、搁置项归档到 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)；cutoff 之后的近期完成项暂留本表以便发布审计。
- 新 feature 进入本表前，应先确认是否已有相同目标、是否可被现有 feature 吸收、是否需要单独设计文档。
- 发布后把对应行移到“已完成 Feature”，同步 [CHANGELOG.md](../CHANGELOG.md)；越过 archive cutoff 后再归档。
- Emergency patch absorption: Session Scratch Directory / `KODAX_SESSION_TMP` is tracked as a `FEATURE_071` workspace-discipline extension, not as a new active feature ID. The patch gives each session a repo-local `.agent/tmp/sessions/<session-id>/` scratch path and keeps temporary helper files out of shared roots.

---

## 已完成 Feature

| ID | Title | Released | Design | Notes |
|---|---|---|---|---|
| `271` | First-Run Provider Setup + Runtime Auto LLM Reliability Contract | `v0.7.73` | [v0.7.73](features/v0.7.73.md#feature_271-first-run-provider-setup-and-secure-restart-handoff) | Metadata-only pre-Runtime onboarding, typed Auto settings and diagnostics, bounded fail-closed classifier projection, Session speculative-window persistence, and monotonic daemon capability-v3 upgrade semantics with opaque exact permission grants. |
| `270` | Ultra-Aligned Adaptive Multi-Agent Actor Control Plane | `v0.7.72` | [v0.7.72](features/v0.7.72.md#feature_270-ultra-aligned-adaptive-multi-agent-actor-control-plane) | One Runtime-owned Actor/Turn tree and scheduler replaces the parallel child-task authorities; AMA gains bounded adaptive recursion, durable observation, safe follow-up/interruption, unified Workflow/external execution, and the canonical collaboration surface while AMAW retires. |
| `266` | Learning Center + Learned Capability Runtime Control Plane | `v0.7.72` | [v0.7.72](features/v0.7.72.md#feature_266-learning-center--learned-capability-runtime-control-plane) | Runtime-owned Learning Center, Learned Area lifecycle/events/cursors, lower-precedence learned Skills, governed actions, and inline/Worker/daemon SDK plus REPL parity. |
| `269` | Shared Daemon Multi-Client Consistency + Secure Host Bridges | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_269-shared-daemon-multi-client-consistency--secure-host-bridges) | Authoritative shared Coder daemon observation/resync, durable operations, transport-safe AskUser/permissions, run-scoped credential and Host Tool bridges, recovery facts, and daemon/inline owner fencing. |
| `268` | Hot-Reloadable Integration Configuration Split | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_268-hot-reloadable-integration-configuration-split) | Base split/template/migration/hot-reload scope shipped in v0.7.69; the v0.7.71 closure adds source-owned, fail-closed per-Agent hot `enabled` reconciliation without peer rediscovery. |
| `267` | Bidirectional A2A Client Executor + KodaX Agent Server | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_267-bidirectional-a2a-client-executor--kodax-agent-server) | Bounded A2A 1.0 client/server base shipped in v0.7.69; the v0.7.71 closure adds external-issuer OAuth Client Credentials/JWT Resource Server profiles and activation hardening alongside trusted Agent/Skill/tool admission, durable tasks, and explicit artifact publication. |
| `260` | KodaX Memory Agent — Proactive Execution Recall + Scoped Memory Consolidation | `v0.7.68` | [v0.7.68](features/v0.7.68.md#feature_260-kodax-memory-agent--proactive-execution-recall--scoped-memory-consolidation) | Thin experimental agent-layer Memory Agent over F228; exact scoped zero-wait recall, deliberate read-only query, trace-only decision receipts, bounded outcome/review lifecycle, consult-before-write promotion, policy-versioned cache-safe integration, deterministic safety gates, and passing v2 routing eval. |
| `261` | Searchable Session Resume TUI + Session Listing Pagination | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_261-searchable-session-resume-tui--session-listing-pagination) | Bare `-r` searchable/paged keyboard picker with full selected ID, deterministic ID-first/exact-title resume and duplicate disambiguation, meaningful ACP titles, Embedded/Daemon `surface` + cursor listing, zero-message suppression, isolated ACP tests, and preview-first reversible ACP pollution cleanup. |
| `259` | Cost-Disciplined Agent Build Loop + Review Handoff Optimization | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_259-cost-disciplined-agent-build-loop--review-handoff-optimization) | Layer 1 complete; Layer 2 shows material semantic value with no regression after retiring official Kimi; bounded Layer 3 passes 8/8 proposed vs 6/8 baseline, reduces total tokens 16.9%, standard-review median tokens 57.2%, primary starts 75%, and duplicate packet reads 83.3%. Main-session recommendation: `recommend-ship`. |
| `258` | External Agent Executor Plane + Dispatchable Agent Catalog | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_258-external-agent-executor-plane--dispatchable-agent-catalog) | Protocol-neutral host-injected executor plane, redacted/policy-filtered catalog, durable task ledger, Worker and Workflow routing, Embedded/Daemon parity, public in-process Daemon factory bootstrap, Reference Executor, and security/recovery conformance. |
| `257` | Constructed Handler Worker Fault Isolation | `v0.7.66` | [v0.7.72](features/v0.7.72.md#feature_257-constructed-handler-worker-fault-isolation) | Delivered ahead of the original v0.7.72 slot. Constructed JavaScript handlers run in persistent per-handler Workers, use reverse host tool RPC, hard-terminate CPU loops, and cannot resurrect active/queued work after revoke. |
| `256` | Worker-Hosted Embedded Runtime + Hard Disposal | `v0.7.66` | [v0.7.71](features/v0.7.71.md#feature_256-worker-hosted-embedded-runtime--hard-disposal) | Delivered ahead of the original v0.7.71 slot. Adds optional embedded Worker ownership, MessagePort protocol reuse, hard-dispose capability negotiation, DTO-only transport, and release sidecar packaging. |
| `255` | KodaX Runtime Daemon + Local Transport | `v0.7.66` | [v0.7.66](features/v0.7.66.md#feature_255-kodax-runtime-daemon--local-transport) | Local named-pipe/Unix-socket daemon, detached ownership, multi-client sessions/runs/events/permissions/config/catalog/artifact/diagnostic services, schema-validated protocol, and CLI/SDK host parity. |
| `254` | Runtime Host Migration + Control Plane Hardening | `v0.7.66` | [v0.7.65](features/v0.7.65.md#feature_254-runtime-host-migration--control-plane-hardening) | Host/runtime consolidation plus context budgets, small-window tool exposure planning, `tool_search` / `tool_describe` / `tool_call` reachability, target-only permission checks, result budgets, compaction pressure, and deterministic 6/6 exposure evals. |
| `253` | KodaX Runtime Contract + Embedded Runtime API | `v0.7.66` | [v0.7.64](features/v0.7.64.md#feature_253-kodax-runtime-contract--embedded-runtime-api) | Embedded Runtime sessions/runs/events/permissions/workflows facade and public `/runtime` subpath, developed in the v0.7.64 slot and released in the combined v0.7.66 cut. |
| `228` | Unified Memory Control Plane + Memory Governance | `v0.7.62` | [v0.7.62](features/v0.7.62.md#feature_228-unified-memory-control-plane--memory-governance) | Released in `v0.7.62` (2026-07-06). Reuses the F224 learning proposal store for memory handoffs, adds agent-layer typed memory refs/snapshots/previews, fingerprint-guarded approval writes, thin `/memory` REPL commands, deterministic task-aware memory packs, bounded prompt memory-index injection, governance/curator reports with a 200-report cap, feedback-triggered review contracts, and host trace metadata for selected memory refs. No vector DB, embeddings, or second memory database. |
| `252` | Workflow Quality Preflight + Review/Audit Verification Lints | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_252-workflow-quality-preflight--reviewaudit-verification-lints) | Released in `v0.7.61` (2026-07-06). Phase A (deterministic contract lint only): `quality-lint.ts` (`lintRestrictedWorkflowSource` / `assertRestrictedWorkflowQuality`) runs in restricted workflow module materialization + the coding host with host `maxAgents`, hard-failing three contract classes before a run starts — unawaited workflow-command variable in a boolean position (no Proxy trap for object truthiness), top-level structured-output field access that belongs under `result.structured`, and literal `[...]`/`.map()` agent fanout above manifest/host caps. Review/verifier/generic quality heuristics intentionally NOT emitted as model-visible warnings (false-positive review narrowed the feature). Layer 2 strengthens review/audit templates to make verifier stages explicit. Layer 3 (gated strong-tier LLM reviewer) deferred behind future policy/eval. Deterministic — no LLM eval. |
| `251` | Tool-Output Token Efficiency（rtk 参考，2026-07-14 纠偏） | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_251-tool-output-semantic-compression-rtk-style-token-killer) | Original command-aware body compression released in `v0.7.61` (2026-07-06); corrected after one replay showed an automatic lossy summary followed by one attributable raw recovery read/additional tool-result cycle (a separate format-command rerun had its own escaping failure; no unsupported population/token percentages are claimed). Authoritative tool behavior: collect full output; apply only contract-equivalent normalization when strictly shorter; keep compiled/declarative lossy filters off by default; use zero semantic adapters for compound Bash; decide once for the complete parallel-result batch using the largest final input `Pmax` satisfying `Pmax + provider output reserve + max(2048, ceil(Pmax * 3%)) <= contextWindow`, then admit at most `Pmax - current physical input`; return all results verbatim when they fit, otherwise persist full content once and emit an idempotent `KODAX_RESULT_INCOMPLETE` continuation. History is capacity-only by default: no lossy microcompaction below capacity, summary-first at real pressure, typed failure without canonical-history mutation, and static early percentages only as explicit opt-ins. 32KB/600 lines are not token policy; 512KiB is only memory→spool. rtk informs request shaping/command awareness, not transparent lossy post-processing. |
| `250` | Progressive Disclosure for the AMA/AMAW Managed Tool Path | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_250-progressive-disclosure-for-the-amaamaw-managed-tool-path) | Released in `v0.7.60` (2026-07-04). Brings deferred-tool progressive disclosure (previously SA-path-only) to the AMA/AMAW managed path: `buildAgentToolsFromRegistry` hint-swaps the 13 non-mcp deferred tools (repo-intel + web/code + goal) to their `DEFERRED_TOOL_HINTS` one-liner with `input_schema` unchanged (stay directly callable; full description via `tool_search`). `mcp_*` stay resident (mutation risk + un-eval'd); `run_workflow` untouched. `tool_search` plus the 3 goal tool receipts are protected in `PRUNE_PROTECTED_TOOLS`. Two eval panels (5-alias): DEFER_SAFE 5/5, 0% read/grep fallback; V_teach 100% adoption after a 2-line `code_search`/`semantic_lookup` teaching block (strictly non-negative, +25pp on the floor alias). |
| `249` | AMA Natural-Language Workflow Activation | `v0.7.59` | [v0.7.60](features/v0.7.60.md#feature_249-ama-natural-language-workflow-activation) | Released in `v0.7.59` (2026-07-03). Widened `buildWorkflowToolHost` so AMA also hosts `run_workflow` on an explicit natural-language request; AMAW additionally self-activates on complexity via the FEATURE_248 directive (independent `amawOrchestrationAvailable` gate, verified structurally separate). SA unchanged. Design doc filed under v0.7.60; shipped early in the v0.7.59 rollup. |
| `248` | AMAW Mode-Level Orchestration Directive | `v0.7.59` | [v0.7.59](features/v0.7.59.md#feature_248-amaw-mode-level-orchestration-directive) | Released in `v0.7.59` (2026-07-03). AMAW-gated mode-level `ORCHESTRATION DEFAULT` standing directive + PLAN-TIME COMMITMENT flow-fix (prompt-only, narrowed-SHIP: task-inception activation; mid-task re-architecture a documented non-goal). Leak-closed via optional `ManagedRolePromptContext.amawOrchestrationAvailable`. See v0.7.59.md §6/§6.1. |
| `247` | SDK Agent-Profile Surface (KodaX-Space Partner) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_247-sdk-agent-profile-surface-kodax-space-partner) | Released in `v0.7.58` (2026-07-02). Profile-gated `KodaXAgentProfile` (R1–R9): identity/instruction injection, tool-visibility policy, Sidecar Verifier binding + verdict attribution, `onEffectiveConfig` snapshot, structured profile/runtime metadata across `fork()`, imperative `compactSession()`, session/profile/toolCall attribution, and a `reads-network` side-effect class. Default Coding Agent byte-identical when no profile is set. Built on the concurrent `feature/partner-sdk-support` branch. |
| `246` | Claude-Code-Parity Workflow (inline authoring + structured output + streaming pipeline + same-session resume; absorbs `232`, parity subset of `231`) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_246-claude-code-parity-workflow--inline-authoring--structured-output--streaming-pipeline--same-session-resume) | Released in `v0.7.58` (2026-07-02). Model-callable `run_workflow` inline authoring (scout-then-author; `sideQuery` generator demoted to headless/SA fallback), structured child output via `outputSchema`, no-barrier `wf.pipeline`, same-session resume via `resumeFromRunId` (content-addressed result cache; `Date.now`/`Math.random` now throw in-sandbox), nested `wf.workflow`, per-agent phase + per-child effort, `/workflow` command intelligence, and mode-distinct SA/AMA/AMAW activation. ADR-044/046/047/048. Neutral run-lifecycle manager lifted to `@kodax-ai/agent`. |
| `245` | Workflow Generation Robustness + Runtime Partial-Result Salvage | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_245-workflow-generation-robustness--runtime-partial-result-salvage) | Released in `v0.7.58` (2026-07-02). Generation-time: static literal-taskId rejection, smoke asserts taskId/evidenceRefs identity, adversarial smoke, taskId randomization, and repair hardening. Runtime: mid-run failures surface completed-child outputs instead of a bare failure. Cross-process replay was once deferred to F231 and was removed from active v0.7.x by the 2026-07-12 review. |
| `221` | White-Labelable Self-Knowledge Manual | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_221-white-labelable-self-knowledge-manual) | Released in `v0.7.58` (2026-07-02). `selfManual.baseTopics` (seed all/none/subset) + `KODAX_UNDERLYING_CAPABILITY_TOPICS` + `MANUAL_REGISTRY` export; `kodax_manual` tool description + self-knowledge routing rule re-branded from `selfManual.productName` (config-path clauses gated to the default product). Extends FEATURE_218; default output byte-identical. |
| `243` | Built-in Repository Intelligence + Codebase Mastery Parity | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_243-built-in-repository-intelligence--codebase-mastery-parity) | Released v0.7.57 (2026-06-28). Replaces external Repointel runtime with built-in full/light repo-intelligence, semantic worker sidecar, `relationship_scan`, repo-explorer agent, and `/repo-intel` controls. |
| `242` | Lean Review + Project Instructions Bootstrap | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_242-lean-review--project-instructions-bootstrap) | Released v0.7.57 (2026-06-28). Adds lean review command path and project instruction bootstrap updates for the current Worker + Sidecar architecture. |
| `241` | SDK Timeout Control Surface | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_241-sdk-timeout-control-surface) | Released v0.7.57 (2026-06-28). Adds seconds-based SDK timeout config; LLM request timeout normalization lives in `@kodax-ai/llm`, with coding adapting it to provider resilience. |
| `233` | Effort-First Reasoning Control System | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_233-effort-first-reasoning-control-system) | Released v0.7.57 (2026-06-28). Makes `effort` the primary reasoning control, keeps legacy `reasoningMode`/`--reasoning` as compatibility input, adds `zai-coding`, and documents LLM-layer passive effort learning semantics with the agent-layer default capability cache. |
| `240` | Cross-Protocol `stopReason` Normalization + Terminal Semantics Dispatch | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_240-cross-protocol-stopreason-normalization--terminal-semantics-dispatch) | Implemented 2026-06-24. Adds provider-neutral stop-reason classifier in `@kodax-ai/llm`, wires max-token and managed-protocol gates through it, and gives `pause_turn`, refusal/content-filter, and unknown values explicit terminal handling. |
| `239` | SDK Multimodal Input + Clipboard Image Public API | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_239-sdk-multimodal-input--clipboard-image-public-api) | Implemented 2026-06-24; expanded 2026-06-25 for Space and relayered in v0.7.57. Adds `@kodax-ai/kodax/media`, canonical `@kodax-ai/agent/media`, `@kodax-ai/coding/media` compatibility re-exports, shared image clipboard/normalization/persistence helpers, stable image/file/video input artifact contracts, model-level input capabilities, runtime artifact validation, GIF boundary docs, and queued follow-up artifacts. |
| `224` | Self-Improvement Skill Loop (procedural learning triage + SkillCurator v1) | `v0.7.54` | [v0.7.54](features/v0.7.54.md#feature_224-self-improvement-skill-loop) | Released v0.7.54 (2026-06-23). Turn-level learning triage → durable proposal store + usage/trust ledgers → governed, snapshot-safe skill apply via `/learn` (`pending`/`diff`/`approve [--ack-impact]`/`reject`). Approve-apply orchestration exposed from `@kodax-ai/agent` as `approveStoredLearningProposal`. Shipped alongside session recovery, extension discovery + runtime composition, ACP capability multiplexing, and a GLM model refresh. |
| `174` | `kodax sessions dedupe` | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_174-kodax-sessions-dedupe) | Released v0.7.53 (npm + tag + GitHub Release, 2026-06-19). Dry-run-first ghost-session cleanup; only uniquely-matched `runner-*` ghosts move to a reversible `.dedupe-archive`. |
| `211` | Interactive-Mode Extension/MCP Session State Cross-Resume Persistence | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_211-interactive-mode-extensionmcp-session-state-cross-resume-persistence) | Released v0.7.53 (2026-06-19). Runtime extension state snapshotted back to the REPL host and restored across `-r` / `-c`; preserves the FEATURE_173 single-writer invariant. |
| `237` | Todo-drift nudge (warn-only unclaimed-work reminder) | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_237-todo-drift-nudge-warn-only-unclaimed-work-reminder) | Released v0.7.53 (2026-06-19). Warn-only observer arms a one-shot `<system-reminder>` + `onTodoDriftWarning` telemetry when work starts with pending-but-unclaimed todos; paired prompt eval. |
| `236` | Workflow Inline Skill Reference Propagation | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_236-workflow-inline-skill-reference-propagation) | Released v0.7.51 (2026-06-17). Workflow generator expands inline `/skill:<name>` and known bare slash skill references before harness generation; child briefings fail closed to the `skill` tool for unexpanded references. |
| `234` | Workflow Run Host Attribution (`hostMetadata`) | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_234-workflow-run-host-attribution-hostmetadata) | Released v0.7.51 (2026-06-17). Additive `hostMetadata?: Record<string,string>` on workflow snapshot/options; eval non-trigger. |
| `230` | Durable TUI Tool Transcript Replay | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_230-durable-tui-tool-transcript-replay) | Released v0.7.51 (2026-06-17). Terminal `tool_group` replay cache + message-derived fallback + SDK transcript contract. |
| `229` | Workflow Process Events + SDK/System Progress Surface | `v0.7.50` | [v0.7.50](features/v0.7.50.md#feature_229-workflow-process-events--sdksystem-progress-surface) | Released v0.7.50 (npm + tag + GitHub Release, 2026-06-17). |

---

## 相关文档入口

- [Product Requirements](PRD.md)
- [Architecture Decision Records](ADR.md)
- [High-Level Design](HLD.md)
- [Detailed Design](DD.md)
- [Archived Features](FEATURES_ARCHIVED.md)
- [Known Issues](KNOWN_ISSUES.md)
