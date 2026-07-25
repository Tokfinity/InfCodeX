# Known Issues

_Last Updated: 2026-07-25_

---

> **Archive Notice**: Historical issue records are maintained in `docs/ISSUES_ARCHIVED.md`.
> This file tracks the active issue backlog plus recently resolved issue records that have not yet been archived.

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 207 | Medium | Resolved | Provider-only model selection leaves Runtime Auto LLM without the provider default model | v0.7.73 Runtime Auto preflight | v0.7.77 development | 2026-07-25 | 2026-07-25 |
| 206 | Medium | Resolved | Static provider model catalogs duplicated default models in REPL completion and SDK listings | v0.7.43 static model catalog; expanded v0.7.76 | v0.7.77 development | 2026-07-25 | 2026-07-25 |
| 204 | Medium | Resolved | Auto mode could render without an engine and rapid permission-mode writes could settle out of order | v0.7.72 Runtime REPL bridge | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 203 | High | Resolved | Compaction recovery guidance detached the compaction entry from the active lineage | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 202 | High | Resolved | PowerShell bracket wildcards could bypass protected-path auto-mode review | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 201 | Medium | Resolved | Model wait treated Runtime system reminders as mailbox activity and Workflow guidance still implied progress waiting | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 200 | High | Resolved | Restored unacknowledged Agent completions did not repopulate the model mailbox | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 199 | High | Resolved | Runtime accepts interrupt input after the final safe boundary and terminalizes it without delivery | v0.7.74 development | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 198 | High | Resolved | Compaction could evict exact history before durable persistence and offered no model-facing recovery | v0.7.46; exposed by v0.7.74 review | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 197 | Medium | Resolved | User-shaped compaction checkpoints caused round-exit query and final duplication | v0.7.74 development | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 196 | High | Resolved | Physical-only tool-result admission let pathological grep output dominate large contexts | v0.7.69 | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 195 | High | Resolved | Auto-mode sent safe static reads to the LLM while sensitive reads bypassed deterministic review | v0.7.33; exposed by v0.7.74 review | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 194 | High | Resolved | Agent coordination could reject local specialists, amplify progress polling, duplicate terminal output, and corrupt resumed tool history | v0.7.72-v0.7.74 | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 193 | Medium | Resolved | Runtime daemon rejects interrupt input instead of injecting it into the active Run | v0.7.69 | v0.7.73 development | 2026-07-21 | 2026-07-21 |
| 192 | High | Resolved | Large compaction used the model window for protection, covered only one rolling chunk, and exposed ambiguous/unbounded SDK state | v0.7.73 and earlier | v0.7.74 | 2026-07-21 | 2026-07-21 |
| 191 | High | Resolved | Auto permission review lacked a complete, compact mutation model | v0.7.33 | v0.7.73 | 2026-07-21 | 2026-07-21 |
| 190 | High | Resolved | Legacy matcherless grants and escaped JSON credentials bypassed new safety boundaries | v0.7.72 and earlier; expanded v0.7.73 RC | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 189 | High | Resolved | Auto sidecar effort, Runtime session settings, and reasoning command state could diverge | v0.7.33; expanded v0.7.73 | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 188 | High | Resolved | Auto classifier projection, transcript boundaries, and first-run environment ordering were incomplete | v0.7.33; expanded v0.7.72 RC | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 187 | High | Resolved | Shared-daemon Auto permission ownership, upgrade fencing, preview bounds, and SDK compatibility were incomplete | v0.7.72 RC | v0.7.72 | 2026-07-19 | 2026-07-19 |
| 186 | High | Resolved | Daemon event subscriptions had no readiness boundary and could miss the first cross-client event | v0.7.66 | v0.7.72 | 2026-07-19 | 2026-07-19 |
| 185 | Medium | Open | Learning lock crash recovery can time out before stale ownership is reclaimable | v0.7.68; expanded v0.7.72 RC | - | 2026-07-19 | - |
| 184 | High | Open | `sed` side effects can bypass plan-mode write classification | v0.5.36 | - | 2026-07-19 | - |
| 183 | High | Resolved | CLI daemon startup failures and forced test exits could leave detached Node processes | v0.7.66-v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 182 | Medium | Resolved | Windows lifecycle lock contention surfaced as fatal `EPERM` during concurrent memory forgets | v0.7.68 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 181 | Medium | Resolved | MiniMax M3 default upgrade left the media capability regression stale | v0.7.72-dev | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 180 | High | Resolved | Queued user input used a different root scope and could not wake `wait_agent` | v0.7.72-dev | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 179 | High | Resolved | Auto[LLM] eight-second timeout and readonly projections caused spurious approvals | v0.7.33 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 178 | Medium | Resolved | Bare `-r` cancellation retained terminal input until another keypress | v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 177 | Medium | Resolved | Worker announced and attempted an oversized fresh spawn wave before Actor capacity rejection | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 176 | High | Resolved | Learning subscription could lose a wake, retain a waiter after disconnect, and cache transient principals without bound | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 175 | High | Resolved | Actor start/interrupt race could launch with a fresh cancellation handle; closed Actors still accepted mailbox traffic | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 174 | Medium | Resolved | Bare `-r` session picker exited as cancelled before accepting input | v0.7.69 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 173 | Medium | Resolved | REPL batch history commit collapsed distinct reply times into one timestamp | v0.7.45 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 172 | High | Resolved | Daemon Runtime bypassed auto-mode guardrails and treated quoted source text as protected paths | v0.7.64-v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-17 | 2026-07-18 |
| 171 | High | Resolved | Verified Ark Coding image inputs were rejected before provider dispatch | v0.7.57 | v0.7.72-hotfix.0 | 2026-07-17 | 2026-07-17 |
| 170 | High | Resolved | A2A realm-key upgrade hid durable tasks and global admission serialized slow preparation | v0.7.71 | v0.7.71 | 2026-07-17 | 2026-07-17 |
| 169 | High | Resolved | Executor shutdown and daemon auto-start could wait indefinitely or leak startup children | v0.7.67-v0.7.71 | v0.7.71 | 2026-07-17 | 2026-07-17 |
| 168 | High | Resolved | A2A post-closure review found executor shutdown, daemon ownership, and server admission gaps | v0.7.69 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 167 | High | Resolved | A2A OAuth and hot-activation closure could leak credentials or mutate stale registrations | v0.7.69 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 166 | High | Resolved | Electron daemon bootstrap mode leaks into user child processes | v0.7.71 RC | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 165 | High | Resolved | Packaged Electron auto-start relaunches the app instead of executing the daemon CLI | v0.7.70 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 164 | High | Resolved | MCP cross-language zero matches can force an avoidable second model/tool round | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 163 | High | Resolved | A2A review found endpoint trust, task lifecycle, artifact, and protocol gaps | v0.7.69 | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 162 | High | Resolved | A2A serve drops Runtime defaults and Markdown Agent provider | v0.7.69 | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 161 | High | Resolved | MCP complete discovery can exceed result capacity or trust malformed pagination/cache state | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 160 | High | Resolved | Shared-daemon rollback omits reverse-bridge mutations and daemon-owned background work | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 159 | High | Resolved | Windows process cleanup can lose descendants when `taskkill /t` fails under load | v0.7.67 | v0.7.69 | 2026-07-15 | 2026-07-15 |
| 158 | High | Resolved | Post-hoc output/history loss hides evidence and can increase end-to-end token use | v0.7.61 | v0.7.69 | 2026-07-14 | 2026-07-15 |
| 157 | High | Resolved | F267/F269 review found durability, network, concurrency, and diagnostic gaps | v0.7.69 RC | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 156 | Medium | Resolved | Bare `kodax -r` repeatedly full-reads large session sets before opening the picker | v0.7.68 | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 155 | High | Resolved | Bare `kodax -r` exits after selection during the picker-to-TUI handoff | v0.7.68 | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 154 | High | Resolved | FEATURE_267/268 review found remote execution and hot-reload reliability gaps | v0.7.69 RC | v0.7.69 | 2026-07-13 | 2026-07-13 |
| 153 | High | Resolved | FEATURE_260 post-release review found memory guard bypass and persistence isolation gaps | v0.7.68 | v0.7.69 | 2026-07-12 | 2026-07-12 |
| 152 | High | Resolved | FEATURE_260 review found credential, mutation-guard, concurrent persistence, and eval-integrity gaps | v0.7.68 RC | v0.7.68 | 2026-07-12 | 2026-07-12 |
| 151 | High | Resolved | Runtime config tests leak detached daemon processes and interrupted background fixtures can survive | v0.7.67 RC | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 150 | High | Resolved | v0.7.67 外部 Agent 脚本路由与执行平面关闭契约存在发布阻断缺口 | v0.7.67 RC | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 149 | High | Resolved | ACP tests persist empty sessions into the real user store | v0.7.66 | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 148 | High | Resolved | FEATURE_258 外部任务在持久化失败、配置热更新和并发回调下可能失联或状态回退 | v0.7.67 RC | v0.7.67 | 2026-07-10 | 2026-07-10 |
| 082 | Low | Open | packages/llm 缺少单元测试 | v0.5.21 | - | 2026-03-08 | - |

| 091 | High | Open | 缺少一等公民 MCP / Web Search / Code Search 工具体系 | v0.6.10 | - | 2026-03-18 | - |
| 092 | High | Open | Team 模式已暴露但原生多 Agent 架构仍未闭环 | v0.6.10 | - | 2026-03-18 | - |
| 093 | Low | Open | 缺少 IDE / Desktop / Web 一体化分发表面 (Vibe Coding 时代已降级) | v0.6.10 | - | 2026-03-18 | - |
| 094 | Medium | Open | 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 | v0.6.13 | - | 2026-03-22 | - |
| 095 | Medium | Open | Agent / REPL 主流程仍存在重复编排与手写运行时流程 | v0.6.13 | - | 2026-03-22 | - |
| 096 | Low | Open | 类型边界过宽且共享可变状态较多 | v0.6.13 | - | 2026-03-22 | - |
| 097 | Medium | Open | 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 | v0.6.13 | - | 2026-03-22 | - |
| 098 | Low | Open | 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 | v0.6.13 | - | 2026-03-22 | - |
| 099 | Low | Open | 测试辅助代码重复，局部验证资产需要收敛 | v0.6.13 | - | 2026-03-22 | - |


| 105 | Medium | Resolved | kodax -c 可选择空 ACP 占位 session，classic REPL 还会忽略 resume | v0.7.14 | v0.7.74 | 2026-04-03 | 2026-07-23 |
| 106 | High | Open | Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift | v0.7.14 | - | 2026-04-08 | - |
| 107 | Medium | Open | harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition | v0.7.16 | - | 2026-04-11 | - |

| 110 | Low | Open | 缺少 /mcp status 和 /mcp refresh REPL 命令 | v0.7.16 | - | 2026-04-11 | - |
| 112 | High | Resolved | ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式 | v0.7.18 | v0.7.62 | 2026-04-12 | 2026-07-06 |
| 118 | Medium | Open | esbuild 打包替代 tsc 直接运行 — 消除运行时模块开销与 React dev 模式 | v0.7.19 | - | 2026-04-17 | - |
| 119 | High | Open | Scout 升级 H0→H1 后残留 pre-Scout mutationSurface — Generator 被错误锁为 docs-only | v0.7.20 | - | 2026-04-19 | - |
| 120 | High | Open | Skill / Plan-mode 调用路径下流式注入 prompt 失效 — `canQueueFollowUps` 未开启 | 一直存在 | - | 2026-04-20 | - |
| 122 | Medium | Open | edit / multi_edit 错误消息在 v0.7.26 过度精简 — 丢失关键信息载体导致 LLM 恢复失败 | v0.7.26 | - | 2026-04-23 | - |
| 124 | High | Open | AMA 子 Agent dispatch 实际触发率偏低 — Controller fanout gate + H1 工具白名单串联收得过紧 | v0.7.18 | - | 2026-04-26 | - |
| 125 | Low | Open | Thinking-mode cross-provider replay — 三个不可测 OpenAI-compat 与 anthropic 官方 strict mode 待实证 | v0.7.28 | - | 2026-04-26 | - |
| 126 | Low | Open | tmux 默认不透传 OSC 8 超链接 — kodax 输出中的 file:// / docs URL 在 tmux 内不可点击 | 一直存在 | - | 2026-04-28 | - |
| 133 | Low | Open | `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake under heavy parallel load — failure mode not yet captured | 待调研 | - | 2026-05-16 | - |
| 136 | Low | Open | 流式 / 滚动时 spinner 动画卡顿 + 计时变慢 — 根因在 CPU 侧每帧渲染（React reconciliation + outputToScreen 全量重建），**非**终端写入字节量（cell-diff + DECSTBM 两次否证 I/O 假设） | 待调研 | - | 2026-05-31 | - |
| 139 | High | Resolved | SDK session full transcript hidden by active-lineage load + error snapshots can orphan activeEntryId | long-standing | v0.7.49 | 2026-06-16 | 2026-06-16 |
| 138 | High | Resolved | Workflow host RPC 边界对对象载荷零校验 — `synthesize` 传非数组 inputs 崩裸 TypeError + `runAgent`/`spawnAgent` 缺 name/prompt 静默烧 token | v0.7.49 | v0.7.49 | 2026-06-15 | 2026-06-15 |
| 140 | High | Resolved | Published bundle leaves computed `./agent.js` child-executor import, breaking workflow child agents | v0.7.37 bundle distribution; confirmed v0.7.48-v0.7.50 | v0.7.52 | 2026-06-17 | 2026-06-18 |
| 141 | Medium | Open | CI workflow long-red on Linux: cross-platform test bugs (storage list() runtime-inspection, bash background-process, h2 spawn env, skill-creator API-key-at-load) | long-standing (pre-v0.7.49) | - | 2026-06-18 | - |
| 142 | High | Resolved | kimi-code thinking-only completion can terminate Worker with only `[Worker]` visible | v0.7.56 | v0.7.56 | 2026-06-25 | 2026-06-25 |
| 144 | High | Resolved | Worker misreads task_output block wait expiry as child-agent timeout and writes final report before children complete | v0.7.45 | v0.7.57 | 2026-06-26 | 2026-06-26 |
| 143 | High | Resolved | Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框，auto 模式形同虚设 | v0.7.39 | v0.7.57 | 2026-06-25 | 2026-06-25 |
| 145 | High | Resolved | Runtime daemon / SDK 边界存在生命周期、事件、权限与协议一致性缺口 | v0.7.64-v0.7.66 | v0.7.66 | 2026-07-10 | 2026-07-10 |
| 146 | Medium | Resolved | 图片路径粘贴处理失败时吞掉原始输入且无可见反馈 | v0.7.40 | v0.7.66 | 2026-07-10 | 2026-07-10 |
| 147 | High | Resolved | GitHub Release 二进制归档遗漏 Runtime 与工具 Worker sidecar | v0.7.66 RC | v0.7.66 | 2026-07-10 | 2026-07-10 |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->

### 207: Provider-only model selection leaves Runtime Auto LLM without the provider default model

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.73 Runtime Auto preflight
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-25
- **Resolved**: 2026-07-25

#### Original Problem

`/model zai-coding` intentionally selects the provider while leaving the model
unset so the provider's current default remains authoritative. The REPL status
bar and ordinary provider execution resolve that selection to `glm-5.2`, but a
Runtime-owned `Auto[LLM]` run rejects it before launch with
`auto_mode_classifier_model_required`.

An explicit `/model zai-coding/glm-5.2` or leaving Auto mode avoids the error,
but provider-only selection must work consistently in every permission mode.

#### Root Cause

Runtime run admission checked only the run's explicit model and
`runtime.defaultModel`. Provider execution resolved the selected provider's
default later, after the Auto LLM preflight, so the two paths disagreed about
whether an effective model existed.

#### Solution Implemented

- Runtime run admission now resolves the selected provider's credential-free
  static default as the final model fallback, after `modelOverride`, the
  Session/run model, and `runtime.defaultModel`.
- Keep unknown providers without a resolvable default on the existing fail-fast
  path.
- The resolved model is recorded and passed to both the Runtime-owned Auto
  guardrail and coding execution, so preflight, status events, and launch agree.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`

#### Verification

- TDD regression reproduced the original
  `auto_mode_classifier_model_required` failure before implementation.
- Focused known/unknown Provider boundary: 2 tests passed.
- Complete Runtime suite: 133 tests passed.
- Provider capability and CLI Runtime bridge suites: 46 tests passed.
- Full production build passed, including config-template validation, workspace
  TypeScript builds, SDK/CLI bundles, worker audits, and declaration bundles.

---

### 206: Static provider model catalogs duplicated default models in REPL completion and SDK listings

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.43 static model catalog; expanded v0.7.76
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-25
- **Resolved**: 2026-07-25

#### Original Problem

Two-stage `/model <provider>/` completion showed the default model twice when
the provider also declared a descriptor for that model. The visible cases were
`kimi-code/k3-256k`, `zhipu-coding/glm-5.2`, and
`zai-coding/glm-5.2`; the same catalog shape also affected
`ark-coding/glm-5.2`. Each logical `provider/model` route should appear once.

#### Root Cause

The descriptor and Provider-instance paths already treated a default model
descriptor as the canonical default entry. The older static helpers instead
prepended `snapshot.model` and then appended every `snapshot.models[]` ID.
That duplicated defaults carrying per-model context or reasoning overrides.
REPL completion consumed this older helper directly, and the SDK capability
listing repeated the same construction independently.

#### Solution Implemented

- Make `getProviderModels()` derive IDs from the existing default-aware
  `getProviderModelDescriptors()` result.
- Make `getProviderList().models` reuse `getProviderModels()`.
- Make `listBuiltinModelCapabilities()` enumerate the same canonical
  descriptors, preserving default-first catalog order and per-model metadata.
- Add whole-catalog uniqueness and four-alias REPL completion regressions.

#### Files Changed

- `packages/llm/src/providers/registry.ts`
- `packages/llm/src/providers/capability-profile.test.ts`
- `packages/llm/src/providers/model-capabilities.test.ts`
- `packages/repl/src/interactive/completers/argument-completer.test.ts`

#### Verification

- Focused provider catalog, SDK capability, and REPL completion suite:
  90 tests passed.

---

### 204: Auto mode could render without an engine and rapid permission-mode writes could settle out of order

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.72 Runtime REPL bridge
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

A user could enter Auto and briefly see bare `Auto` rather than `Auto[LLM]` or
`Auto[RULES]`. Cycling the three permission modes could later make the expected
engine label appear, which made Auto look like it had an unexplained fourth
state. Rapid mode changes also launched overlapping Runtime settings updates,
so a slower earlier write could finish after the user's final selection.

The default mode-cycle binding is Shift-Tab. Shift+Enter remains the newline
binding; terminal remapping can make the physical key report confusing, but it
does not change the underlying mode-state defect.

#### Root Cause

- Ink updated `permissionMode` synchronously, but the Runtime-backed engine
  state started as `undefined` until asynchronous stats arrived.
- `syncSettings()` and `/auto-engine` writes had no per-Session ordering, so
  concurrent calls relied on transport completion order rather than input order.

#### Solution Implemented

- Resolve the status-bar engine from observed Runtime state or the configured
  engine while statistics are pending; Auto now always renders a known engine.
- Serialize settings and explicit engine writes per Session so the last user
  action is also the last persisted action.
- Preserve the existing semantic distinction: `Auto[RULES]` is a valid sticky
  automatic/manual fallback, and `/auto-engine llm` explicitly restores LLM
  classification.

#### Files Changed

- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/view-models/surface-status.ts`
- `packages/repl/src/ui/view-models/surface-status.test.ts`
- `src/kodax_cli.ts`
- `src/kodax_cli.runtime-runner.test.ts`
- `docs/test-guides/ISSUE_204_v0.7.74_REGRESSION_GUIDE.md`

#### Verification

- The view-model regression pins configured-engine fallback, observed-engine
  precedence, and non-Auto clearing.
- The Runtime bridge regression blocks an earlier write and proves the later
  mode cannot overtake it.
- Human checks cover Shift-Tab, Shift+Enter, normal/rapid cycling, and sticky
  rules fallback.

---

### 203: Compaction recovery guidance detached the compaction entry from the active lineage

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

The compaction producer appended exact-history recovery guidance to its
synthetic checkpoint message, but Session lineage matched only the summary
prefix and summary text. `applySessionCompaction()` therefore persisted the
real checkpoint as a sibling message instead of reusing the new compaction
entry. The active path bypassed that entry, left `firstKeptEntryId` undefined,
and omitted its post-compact attachments from derived context.

#### Root Cause

The producer and lineage each owned a different checkpoint wire format. The
lineage copy had an empty suffix and used strict byte equality, so adding
recovery guidance to the producer silently broke structural matching.

#### Solution Implemented

- Reuse the producer's exported prefix and recovery-guidance constants when
  lineage renders or recognizes a compaction checkpoint.
- Render current checkpoints with the canonical recovery guidance while still
  accepting legacy suffix-free checkpoints during Session resume.
- Lock the topology contract to the exact producer bytes: the compaction entry
  remains on the active path, owns a first-kept pointer, and emits attachments
  immediately after the checkpoint without a duplicate message entry.
- Reconcile imperative manual compaction against the exact flat message
  snapshot before applying the compaction entry, so a legacy/stale lineage
  cannot omit history from later exact transcript search.

#### Files Changed

- `packages/agent/src/session-lineage/kodax-session-lineage.ts`
- `packages/agent/src/session-lineage/kodax-session-lineage.test.ts`
- `packages/repl/src/session/compact-session.ts`
- `packages/repl/src/session/compact-session.test.ts`

#### Tests Added

- Exact producer checkpoint plus attachment reconstructs as
  `compaction -> kept message`, with no synthetic checkpoint message sibling.
- Existing suffix-free checkpoint fixtures continue to match and are rendered
  in the current canonical form.

### 202: PowerShell bracket wildcards could bypass protected-path auto-mode review

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

PowerShell `-Path` supports bracket wildcard expressions. A target such as
`[.]kodax/config.json` can resolve to `.kodax/config.json`, but the mutation
analyzer treated the lexical bracket-bearing path as an exact in-workspace
target. Rules-mode Auto could therefore allow a write that should have reached
protected-path confirmation.

#### Root Cause

The ambiguity guard covered `*`, `?`, variables, arrays, and provider paths but
omitted PowerShell's `[...]` wildcard syntax. The analyzer no longer has shell
quote provenance after argument parsing, so it cannot safely reinterpret a
wildcard-bearing `Path` as a literal filename.

#### Solution Implemented

- Mark bracket syntax on bound path-bearing parameters as incomplete before
  filesystem boundary classification, forcing deterministic escalation.
- Preserve exact `LiteralPath`/`PSPath` semantics so legitimate filenames such
  as `file[12].txt` remain fully modeled and auto-allowable in the workspace.

#### Files Changed

- `packages/repl/src/permission/powershell-mutation.ts`
- `packages/repl/src/permission/powershell-mutation.test.ts`
- `packages/repl/src/permission/auto-rules.test.ts`

#### Tests Added

- Low-level mutation analysis rejects `[.]kodax/config.json` through `-Path`
  but accepts `build/file[12].txt` through `-LiteralPath`.
- End-to-end Auto rules escalate the wildcard form and continue to allow the
  exact literal-path control case.

### 201: Model wait treated Runtime system reminders as mailbox activity and Workflow guidance still implied progress waiting

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

The first mailbox subscription matched every scoped `MessageQueue` mode. A
queued `system-reminder` could therefore end `wait_agent` even though the fixed
wake matrix permits only Agent mailbox evidence, root user input, interruption,
or timeout. Separately, the `run_workflow` result still told the model to use
`wait_agent` to observe progress after progress events had moved out of the
model wait channel.

#### Root Cause

Priority and routing filters were applied, but the activity probe had no
delivery-mode allowlist. Workflow guidance was outside the main Worker prompt
and tool-description update set, so its historical wording survived.

#### Solution Implemented

- Restrict wait activity to `prompt`, `agent-message`, and
  `task-notification`; a system reminder can be delivered at the next safe
  boundary but cannot independently wake the model.
- Tell Workflow callers to inspect progress with `list_agents`, use
  `wait_agent` only for critical mailbox evidence, and use `agent_output` for
  the known Workflow result.

#### Files Changed

- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/tools/agent-collaboration.test.ts`
- `packages/coding/src/tools/run-workflow.ts`
- `packages/coding/src/tools/run-workflow.test.ts`
- `packages/coding/src/tools/tool-definitions.ts`

#### Tests Added

- A progress storm and a scoped system reminder both leave one wait pending;
  a subsequent Agent completion notification settles it once.
- Workflow start output distinguishes progress inspection from mailbox waiting.

### 200: Restored unacknowledged Agent completions did not repopulate the model mailbox

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

FEATURE_273 makes the model-facing `wait_agent` depend exclusively on the
caller-scoped `MessageQueue`. Actor snapshots durably preserve completion
messages and their post-transcript acknowledgement receipts, but the queue is
intentionally process-local. If a process stopped after a child completion was
persisted and before the parent transcript committed that notification, session
restore loaded the durable completion without publishing it into the new queue.
The parent could then wait until timeout even though the child was terminal.

A same-process Runtime Registry rebuild exposed a related idempotency edge: a
naive restore replay could enqueue a second copy while the original process
queue entry was still present.

#### Root Cause

`AgentActorController.initialize()` restored mailboxes and acknowledgement IDs,
then recovered unfinished turns, but `onMessageCommitted` only ran for new
mutations. The Coding Runtime projection also had no queue-level `turnId`
deduplication because normal durable commits publish only once. Inferring
pending delivery from every unacknowledged mailbox completion would also have
made pre-receipt snapshots replay historical results after upgrade.

#### Solution Implemented

- Persist an explicit set of root completion `turnId`s awaiting transcript
  acknowledgement and republish only that set before unmatched-turn recovery.
- Treat an absent set as a legacy snapshot with no inferred replay work, so an
  upgrade cannot resurrect historical completion mail.
- Keep ordinary historical Actor messages out of replay; their generic delivery
  contract is unchanged and they have no completion receipt.
- Deduplicate projected root completion notifications by session/Actor route and
  structured child-task `taskId`, preserving exactly one pending queue entry for
  both hard restart and same-process registry rebuild.
- Keep acknowledgement post-transcript-commit; once persisted, later restores
  no longer replay the completion.

#### Files Changed

- `packages/agent/src/actors/controller.ts`
- `packages/agent/src/actors/controller.test.ts`
- `packages/agent/src/actors/types.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/agent-runtime/actor-runtime.test.ts`
- `docs/test-guides/FEATURE_273_v0.7.74_TEST_GUIDE.md`

#### Tests Added

- Controller restart test: unacknowledged root completion is republished once;
  acknowledged completion is not replayed on a later restart.
- Legacy snapshot test: missing delivery state never infers stale replay work
  from historical completion messages.
- Coding Runtime integration test: a soft rebuild does not duplicate a queued
  `turnId`, while a fresh process queue is repopulated from the same snapshot.

### 199: Runtime accepts interrupt input after the final safe boundary and terminalizes it without delivery

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

`runtime.runs.submitInput({ delivery: 'interrupt' })` can return `accepted: true`
after a managed task has published its terminal managed-task status but before
the outer Runtime Run settles. No Runner/LLM safe boundary remains in that
interval. The accepted input emits `run.input.queued`, then normal Run cleanup
removes its queue entry and changes the status to `terminal` without ever
emitting `run.input.delivered`.

The reproduced Run accepted an interrupt at `03:54:10.073Z`, 2.739 seconds
after `managed_task_status.phase: completed`, then completed 1.44 seconds later.
Its durable log contains the queued event and terminal input status but no
delivery event, proving the input never entered an LLM request.

Expected behavior:

- Runtime closes interrupt admission as soon as the active execution has no
  future safe boundary.
- A late submission receives a factual retryable rejection and is never added
  to the Actor queue.
- Inputs accepted immediately before closure still reach an explicit terminal
  outcome through the owning Run status, so clients can distinguish delivery
  from non-delivery without guessing from transcript text.
- Runtime never silently changes `interrupt` into `after_turn`.

#### Root Cause

Interrupt admission checks only the outer Run phase, active-Run ownership, and
presence of an Actor Session. During managed-task finalization those facts still
look active after the managed task has emitted its final `completed` status.
The Runtime record does not represent whether the Runner's interrupt window is
still open. `terminalizeQueuedInterruptInputs()` correctly prevents cross-Run
leakage, but exposes the missing admission state by terminalizing accepted work
that never had another consumption point.

#### Solution Implemented

- Track one internal interrupt-admission flag on each active Runtime Run.
- Close it on the final managed-task status, and on the ordinary coding
  completion/error callback or external abort before the result promise settles.
- Keep non-terminal observer diagnostics off the terminal `onError` channel so
  they cannot close a still-consumable window.
- Terminalize synchronous coding and managed-task launch failures instead of
  leaving a started Run active without a result handle.
- Reject submissions after closure with `interrupt_window_closed` before
  normalizing or enqueueing the input.
- Preserve current terminal cleanup for cancellation, failure, restart, and
  the residual event-loop race; clients reconcile those terminal input records
  by public `inputId`.

#### Implementation and Verification

| File | Change | Expected Outcome | Risks and Guardrails | Tests |
|------|--------|------------------|----------------------|-------|
| `src/sdk-runtime.ts` | Add the internal admission flag, close it from terminal execution callbacks and external abort, release abort listeners on every Runtime-owned termination path, terminalize synchronous launch failures, and add the typed rejection reason | Late input is rejected before queue mutation; accepted input lifecycle remains unchanged; failed launches cannot remain active | Do not close on intermediate managed worker turns; do not alter `after_turn`; do not retain host signals | Managed and ordinary coding completion/abort/launch-failure tests |
| `src/sdk-runtime.test.ts` | Reproduce completion/error/external-abort and synchronous-launch windows; assert rejection, zero queue growth, accepted-before-close delivery, listener cleanup, and failed terminal status | Regression is deterministic and independent of timing | Settle/abort every fake Run so tests do not leak | Focused and complete Runtime Vitest suite |
| `packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-recorder-bridge.ts` and adjacent test | Report a Sidecar message sink failure through diagnostics instead of terminal `onError` | An observer failure remains visible without terminating interrupt admission | Preserve verifier behavior and never swallow the diagnostic | Full bridge Vitest suite |
| `docs/SDK_EMBEDDER_GUIDE.md`, `docs/DD.md` | Document the new factual rejection and client retry behavior | Embedders do not silently downgrade delivery intent | Keep capability semantics and existing reasons intact | Documentation review |
| `docs/KNOWN_ISSUES.md` | Track Issue 199 through resolution | Runtime ownership and verification remain auditable | Preserve the original report | Index/detail/summary consistency |

#### Resolution

Added an internal `interruptInputOpen` fence to every Runtime Run record. The
fence opens only when a Run with an Actor Session starts, and closes before the
outer result settles when ordinary coding emits `onComplete` or `onError`, or
when a managed task reports its final `phase: completed`. A supplied external
abort signal now closes the fence synchronously for both coding and managed-task
Runs; the Runtime-owned listener is released by normal completion, Runtime
abort, and shutdown even if the underlying operation never settles.
`markRunTerminal()` also closes the fence defensively for cancellation, failure,
recovery, and shutdown.

The Sidecar verifier no longer forwards a host `onSidecarMessage` sink exception
to terminal `onError`. It emits the existing `coding:sidecar-verifier` diagnostic
instead, so a non-terminal observer failure remains visible without prematurely
closing interrupt admission.

If persistence of the exact `run.input.delivered` batch fails after the Actor
queue has been consumed, Runtime now emits a bounded `runtime.warning` carrying
only the input IDs and persistence error. It leaves the public input state
`queued` and rethrows the original error; it never falsely publishes delivery
or copies the input body into diagnostics.

Synchronous exceptions from coding or managed-task launch now use the same
failure classification and terminal cleanup as asynchronous rejection. The
original `runs.start()` rejection remains unchanged, while the observable Run
is persisted as `failed`, releases its active ownership, and cannot accept input.

`runtime.runs.submitInput({ delivery: 'interrupt' })` now checks this fence
before input normalization, cloning, or MessageQueue mutation. A late request
returns the typed factual result `accepted:false` with
`reason:'interrupt_window_closed'`; it is never converted to `after_turn`.
Existing terminal input records remain the authoritative residual-race/recovery
outcome for clients to reconcile by `inputId`.

Validation:

- The complete Runtime SDK suite passed (130/130), including deterministic
  completion/error/external-abort regressions for coding and managed-task Runs,
  zero queue growth after closure, listener cleanup on Runtime cancellation, and
  accepted-before-close delivery, plus synchronous launch-failure cleanup.
- The complete Sidecar verifier bridge suite passed (17/17), including proof
  that an observer sink exception emits a diagnostic without calling terminal
  `onError`.
- The complete KodaX package build, TypeScript project build, SDK bundle, and
  declaration bundle passed.

### 198: Compaction could evict exact history before durable persistence and offered no model-facing recovery

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.46 archival lifecycle; exposed by v0.7.74 review
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

After a successful major compaction, `applySessionCompaction()` immediately
replaced old-island message bodies with `[compacted]`. Full-save and fallback
paths could then publish that slim in-memory lineage before the exact old
messages reached the island sidecar. A structural inspection of Session
`20260721_233332` found 125 persisted placeholders (64 user and 61 assistant),
only five remaining raw user entries, and no island sidecar. The UI summary and
query ledger survived, but they are not an exact substitute for assistant/tool
details.

The callback also carried only the replacement messages. Messages created in
the active Run but removed by the same compaction were not guaranteed to exist
in the host's prior lineage, so changing only the file-write order could not
close the gap. Finally, a compacted Agent had no native Session-transcript
search/read tool: it could use the summary and exact query ledger, but could not
intelligently retrieve an omitted persisted detail.

#### Root Cause

- In-memory reclamation and durable archival were coupled inside
  `applySessionCompaction`, before the asynchronous host persistence boundary.
- `CompactionUpdate` omitted the exact pre-compaction message snapshot needed
  to reconcile messages created during the current Run.
- Storage maintenance wrote sidecar before main, but ordinary full-save paths
  did not enforce the same archive-before-slim invariant.
- Maintenance reset append watermarks to the slim persisted count even though
  the live caller retained old entry skeletons, allowing later delta slicing to
  start at the wrong position.
- Root and child compaction callbacks shared the same host callback; event
  identity existed, but the root lineage mutation did not reject child scope.
- Transcript page/chunk APIs served hosts, while the Action LLM had no bounded,
  cited current-Session recovery surface.
- The original history-tool binding and durable-compaction wrapper were wired
  only through the SA substrate. Default AMA could advertise the tools without
  a loader and could compact without the same archive-before-evict owner.
- Child Runs did not inherit the parent's compaction overrides, suppressed
  child compaction telemetry, and had no isolated durable lineage from which
  omitted child detail could be recovered safely.

#### Resolution

The FEATURE_272 durable-recovery closure now:

- carry `preCompactionMessages` as host-only transaction data;
- reconcile and durably commit exact entries before in-memory eviction;
- flush sidecar batches before atomically replacing the slim main JSONL and
  deduplicate main/sidecar overlap by stable entry ID;
- preserve live append watermarks across storage-only maintenance;
- reject child compaction as a root Session mutation;
- add deterministic revision-bound transcript search and exact chunk reads to
  root Agent, isolated persistent-child, Session SDK, Runtime, and daemon
  surfaces without embeddings or background extraction;
- bind the same history loader and durable-compaction owner through SA and AMA,
  and hide the history-tool pair atomically when the loader or either tool is
  unavailable;
- forward the resolved parent compaction policy into child Runs, preserve
  child identity on compaction telemetry, and persist each durable child's
  recoverable history in a separately minted hidden `managed-task-worker`
  Session that never grants root-lineage access;
- atomically seeds a new headless Session when first-run compaction precedes
  its routine snapshot, while still rejecting an unseeded missing Session;
- keeps Runtime as the only persistence writer after that boundary and rolls
  back a tentative context revision when durability rejects;
- excludes system/hidden evidence, current and legacy checkpoints, and
  unrecoverable `[compacted]` placeholders from both search and direct reads,
  without scoring short query terms against random entry IDs.

#### Verification

- automatic and imperative compaction, first-save and append-hot paths;
- failure after sidecar append and before main replacement;
- repeated compactions, maintenance, restart, and duplicate cleanup;
- old user/assistant/tool detail search plus stale-revision exact reads;
- SA/AMA tool binding and durable-before-evict parity;
- child compaction-policy inheritance, context-scoped telemetry, isolated
  history recovery, root-lineage denial, and bounded tool/daemon responses;
- structural replay of an incident-shaped Session with more than 100 old
  entries and an island sidecar.

Automated verification completed with 361 Agent/Coding compaction tests, 162
REPL/Session/UI tests, and 210 Runtime/daemon tests. A read-only replay of
Session `20260721_233332` loaded 145 lineage entries and 16 active messages;
legacy checkpoints/system/placeholders produced zero directly readable model
entries, while surviving exact tool evidence remained searchable. Source and
isolated-copy SHA-256 values matched before the temporary copy was removed.
The final SA/AMA/child closure then passed another 323 focused tests across 15
files (plus 2 declared existing todos), root TypeScript no-emit, canonical
config-template validation, package compilation, all SDK/CLI bundles, and DTS
bundling.

### 197: User-shaped compaction checkpoints caused round-exit query and final duplication

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

After automatic compaction, the runtime emits the checkpoint as a synthetic
`role: user` message with `_source: 'compaction-checkpoint'`, and repository
intelligence can precede it with a system message. Round-exit reshaping only
recognized a prefixed system message at index zero. It therefore appended the
original query after an already completed assistant answer and then appended
the same final answer again.

#### Root Cause and Resolution

The round boundary inferred compaction identity from role and position instead
of the checkpoint's structured provenance. A shared predicate now recognizes
the current `_source` marker and the legacy system-prefix form. A user-shaped
checkpoint itself supplies the user boundary; a legacy system summary retains
the prior requirement that some user boundary survives. Normal non-compacted
rounds and system-summary-only sessions keep their existing append behavior.

#### Verification

- `packages/coding/src/task-engine/_internal/round-boundary.test.ts`
- Runtime-shaped regression: repo system -> user checkpoint -> tool chain ->
  existing final; the original query occurs zero times and final occurs once.

### 196: Physical-only tool-result admission let pathological grep output dominate large contexts

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.69
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

Session `20260721_233332` captured a grep result of roughly 1.1 MB / 339k
estimated tokens. On a one-million-token model the request still fit physical
capacity, so the result was admitted as one atomic history group. The next few
tool calls appeared to jump directly to the compaction threshold (about 526k
tokens before compaction), even though the visible interaction was short.

#### Root Cause and Resolution

Issue 158 correctly removed universal post-hoc truncation and made one batch
owner enforce physical next-request capacity with recoverable artifacts. That
closure did not provide a separate model-attention bound, so very large context
windows could admit a result that fit physically but was not useful as one
model input. The fix preserves the Issue 158 architecture and adds:

- grep source shaping: at most 500 characters per rendered content entry,
  about 50 KiB per page, and explicit `offset` plus `read`/`line_offset`
  continuation hints;
- independent admission limits at the existing sole batch owner: 16k tokens
  per result and 48k tokens per batch, capped again by the physical remainder;
- full artifact persistence and explicit preview/full byte markers whenever
  attention admission spills a result.

The prior approximately 12,577-byte Issue 158 git-log reproduction remains
verbatim, and command-aware lossy filters plus default microcompaction remain
disabled. This is an additive attention boundary, not a rollback of Issue 158.

#### Post-resolution Review Closure

The first implementation left two physical-capacity fast paths in managed
Runner results and background completion envelopes, so those paths never
reached the attention policy when a large model window could hold the raw
payload. It also charged edit-recovery messages against the 48k tool-attention
ledger and converted artifact persistence failure into a fatal attention error.
The closure:

- routes standard dispatch, managed Runner, child evidence, and background
  envelopes through the same batch owner even when physical capacity is ample;
- keeps physical next-request capacity (including edit recovery and non-string
  siblings) separate from the 16k/48k tool-result attention ledger;
- treats physical overflow as the only hard admission failure, while a failed
  attention spill remains fully inline with a visible diagnostic when it still
  fits physically;
- preserves one artifact/marker when re-admitting an already guarded result.

#### Verification

- `packages/coding/src/tools/grep.test.ts`
- `packages/coding/src/tools/tool-result-policy.test.ts`
- `packages/coding/src/tools/envelope-budget.test.ts`
- `packages/coding/src/task-engine/runner-tool-result-batch.test.ts`
- `packages/coding/src/agent-runtime/__contract-tests__/cap-077-tool-dispatch-parallel.contract.test.ts`
- `packages/coding/src/agent-runtime/__contract-tests__/cap-079-final-tool-result-capacity.contract.test.ts`
- Regressions cover long lines, 50 KiB paging, per-result and batch attention
  spill across every production entry, recovery-message dual accounting,
  persistence failure, full artifact recovery, and the unchanged moderate case.

### 195: Auto-mode sent safe static reads to the LLM while sensitive reads bypassed deterministic review

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.33; exposed by v0.7.74 review
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

In session `20260721_233332`, deterministic analysis identified `git show` as
complete, exact, read-only, and risk-free, but Auto[LLM] still invoked the
classifier. The classifier rejected the command with no useful reason, wasting
tokens and blocking a safe inspection. Conversely, direct `read`/`grep`/`glob`
calls used an empty projection and bypassed analysis entirely, while
`isBashReadCommand` allowed reads such as `cat ~/.ssh/id_ed25519` and secret
environment-variable expansion without a separate sensitive-data gate.

#### Root Cause and Resolution

The deterministic review was only serialized as classifier evidence after the
empty-projection fast path; it was not itself an allow decision. Read-only
syntax and sensitive-data access were also treated as the same concern. The
fix keeps mutation classification separate and applies one deterministic read
review before the LLM:

- complete, exact, risk-free `read` operations and read-only shell execution
  (`options.readOnly`) are allowed with zero classifier calls;
- direct read tools and shell paths share sensitive-path classification for
  SSH/GPG, cloud and Kubernetes credentials, Docker/CLI credential stores,
  `.env` and package credentials, private-key names, and `/proc/*/environ`;
- `.env.example`, `.env.sample`, and `.env.template` remain readable unless
  they are located inside another protected directory;
- sensitive environment references, enumeration, and credential-bearing
  `git config --get` keys require explicit user confirmation before the LLM.

#### Post-resolution Review Closure

The first implementation still missed sensitive shell operands that did not
look path-shaped to the shared extractor, including `cat .env`,
`Get-Content .env`, `git diff -- .env`, and Git object reads such as
`git show HEAD:.env`. Public SDK consumers could also omit `analyzeCall` and
retain the old empty-projection allow. The closure adds command-aware sensitive
operand binding for positional and regex readers (including mixed read/write
pipelines) and Git `REV:path`/`-- path` forms, while excluding regex patterns,
format, delimiter, and pickaxe arguments. Direct
`read`/`grep`/`glob` calls now require deterministic analysis or explicit user
confirmation; the Runtime continues to inject the analyzer, so exact safe reads
remain zero-LLM-cost.

#### Verification

- `packages/repl/src/permission/auto-rules.test.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- Regressions prove `git show` makes no classifier request, bare/Git-object and
  piped/redirected secrets reach user confirmation without classifier use,
  non-path operands do not false-positive, and analyzer-less SDK reads fail
  closed.

### 194: Agent coordination could reject local specialists, amplify progress polling, duplicate terminal output, and corrupt resumed tool history

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.72-v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

An npm-linked v0.7.74 REPL session exposed several coupled coordination and
resume failures:

- `spawn_agent(agent_id="repo-explorer")` was rejected because a local
  constructed specialist incorrectly required an external Runtime executor
  catalog. Retrying without `agent_id` started generic children and silently
  lost the requested specialist semantics.
- `wait_agent` woke the parent model for ordinary `turn_progress` events. Three
  children produced dozens of parent model turns even though only three
  terminal results affected the review.
- Results already observed through terminal Actor APIs were later injected
  again as full `<agent-completed>` notifications, duplicating large child
  outputs in model context.
- Quitting and resuming with `kodax -c` appended previously rendered tool calls
  to the end of the transcript. Repeated resumes persisted and multiplied the
  duplicates in `uiHistory`.
- Auto-mode could reject a command before execution with an empty reason, which
  rendered as an ambiguous tool error and led the model to misdiagnose the
  failure as a shell output-capture problem.
- Tool-result messages lacked execution-time timestamps and collapsed to the
  later session-accounting timestamp.

Expected behavior:

- Prompted local specialist IDs are dispatchable without an external plane and
  never silently degrade to a generic Agent.
- Parent coordination can wait for terminal events without consuming every UI
  progress update; queued user input still interrupts promptly.
- Each child turn's terminal body enters model context at most once.
- Session restoration is tool-ID based and idempotent across arbitrary UI-only
  commands and repeated resume/save cycles.
- Pre-execution policy denials carry an explicit non-empty reason, and every
  message retains its real finalize-time timestamp.

#### Context

Affected components:

- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/tools/list-dispatchable-agents.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/repl/src/ui/utils/restore-history.ts`
- `packages/coding/src/guardrails/auto-mode/parse-output.ts`
- `packages/agent/src/primitives/runner-tool-loop.ts`

#### Root Cause

Agent selector resolution required the external executor plane before attempting
local catalog resolution. The wait API exposed one undifferentiated event
stream to both the UI and the parent model. Terminal results were projected
independently into Actor output and the background message queue without a
shared observation identity. Session restoration aligned persisted and derived
history by visible user-round counts instead of stable tool IDs, so UI-only
commands shifted the merge boundary. Finally, policy and tool-result message
builders allowed missing diagnostic/timestamp fields that the persistence layer
could only repair ambiguously.

#### Proposed Solution

- Resolve Native/Constructed catalog entries before consulting the external
  executor plane; make prompt, list, and spawn share the same dispatchable IDs.
- Add a backwards-compatible terminal-only wait mode and use it in the built-in
  Worker prompt while retaining raw event mode for SDK progress consumers.
- Track terminal observation by turn ID so explicit output retrieval and
  background completion delivery form one exactly-once channel.
- Deduplicate and enrich restored tool groups by tool-use ID, preserving
  persisted order and repairing already polluted snapshots idempotently.
- Require non-empty auto-mode denial reasons and stamp tool-result messages when
  their batch completes.
- Cover the fixes with contract tests plus repeated resume/save/restore and
  multi-child progress/terminal integration tests.

#### Resolution

- Local Native/Constructed descriptors are resolved before the optional
  external executor plane. `list_dispatchable_agents`, the specialist prompt,
  short aliases, canonical IDs, and `spawn_agent` now share one catalog.
- `wait_agent(return_on="terminal")` skips progress events internally, preserves
  raw event mode for compatibility, returns bounded `terminalOutputs`, and
  remains interruptible by scoped user input. The Worker prompt uses this mode
  and yields text-only to the existing idle-yield path instead of polling an
  expired wait.
- The Actor snapshot records explicit completion acknowledgements by `turnId`.
  Acknowledgement is selective, durable, restricted to completions already in
  the direct parent's mailbox, and filters later mailbox drains without
  consuming earlier evidence. Root and nested completion projections carry the
  same task-result identity. `wait_agent`, `agent_output`, and host-delivered
  synthetic results acknowledge and remove the matching notification only
  after the authoritative transcript/session message commits; persistence
  failure therefore leaves the result replayable. Event snapshots suppress an
  acknowledged direct-child terminal event without deleting audit history.
- Resume restoration deduplicates globally by tool-use ID, aligns canonical
  text anchors backwards from the latest persisted suffix, repositions
  canonical tool groups while retaining richer persisted tool details, and
  replaces legacy tool summaries only when they are not canonical anchors. It
  remains bounded to the persisted window and idempotent across repeated
  resume/save cycles.
- Auto-mode block decisions synthesize a non-empty diagnostic when the
  classifier omits its reason. The shared guardrail result now explicitly says
  the call was blocked before execution. Tool-result messages are timestamped
  when the result batch is built.

FEATURE_273 subsequently supersedes the model-facing terminal/event selector
described above. `wait_agent` is now a mailbox yield with only `timeout_ms`;
raw progress replay and long-poll remain on the existing SDK/daemon Actor event
APIs. This removes model resampling on progress without removing the capability
that SDK telemetry consumers previously obtained from `return_on="event"`.

The post-implementation review found that the first closure still acknowledged
terminal results inside the tool handler, before Runner/session persistence,
and that forward-greedy text alignment could bind a trimmed repeated suffix to
an older canonical round. The post-commit receipt hook, direct-child event
filtering, and tail-biased canonical alignment close both gaps.

#### Files Changed

- `packages/agent/src/actors/controller.ts`, `packages/agent/src/actors/types.ts`
- `packages/agent/src/primitives/guardrail.ts`, `packages/agent/src/primitives/runner-tool-loop.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/external-agents/local-catalog.ts`
- `packages/coding/src/guardrails/auto-mode/parse-output.ts`
- `packages/coding/src/prompts/capability-sections.ts`
- `packages/coding/src/tools/agent-collaboration.ts`, `packages/coding/src/tools/list-dispatchable-agents.ts`, `packages/coding/src/tools/tool-definitions.ts`
- `packages/repl/src/ui/utils/restore-history.ts`
- Corresponding colocated tests, `docs/KNOWN_ISSUES.md`, and `CHANGELOG.md`

#### Verification

- `npx tsc --noEmit`
- `npm run build`
- 201 Agent/compaction tests, 1,057 coding/tool/guardrail tests, 921
  REPL/permission tests, and 120 SDK Runtime tests passed (2,299 total; one
  pre-existing platform skip).
- A read-only replay of session `20260721_233332` recovered all 45 unique tool
  calls, removed all 33 duplicate occurrences, and left no orphan tool group
  after the first `/quit` marker.

### 193: Runtime daemon rejects interrupt input instead of injecting it into the active Run

- **Priority**: Medium
- **Status**: **Resolved**
- **Introduced**: v0.7.69
- **Fixed**: v0.7.73 development
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

`runtime.runs.submitInput({ delivery: 'interrupt' })` is part of the public
request type, but both embedded Runtime and the shared daemon return
`unsupported_capability`. The daemon deliberately omits `interruptInput` from
its capability record. A client therefore cannot deliver input to an active
Coder Run at the next safe Runner/LLM boundary and must wait for an
`after_turn` continuation Run instead.

Expected behavior:

- Runtime and daemon advertise `interruptInput` version 1.
- Interrupt input is scoped to the supplied Session and currently active Run.
- Inputs accepted before one safe boundary drain together in FIFO order, retain
  separate user-message boundaries, and enter one next LLM request.
- Interrupt submission does not create continuation Runs.
- Snapshot and typed events expose queued and delivered input state, including
  one complete ordered delivery batch.
- Exact `operationId` retries are idempotent; stale Run and unsupported active
  execution modes fail explicitly; `after_turn` behavior does not change.

#### Context

Affected components:

- `src/sdk-runtime.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-event.ts`
- `packages/agent/src/messaging/queue.ts`
- `packages/coding/src/task-engine/runner-driven.ts`

#### Root Cause

FEATURE_269 modeled queued input only as a new `after_turn` Run. Although the
Coding Runner already drains its Actor-scoped `MessageQueue` at a safe boundary
and converts the whole FIFO batch into separate user messages, Runtime has no
interrupt input record, no daemon-to-Actor queue bridge, and no queued/delivered
event contract. The capability was therefore intentionally withheld and both
submission paths fail closed.

#### Proposed Solution

- Reuse the active Run's canonical Actor queue instead of adding another queue.
- Track interrupt input identity, origin, preview, timestamps, and lifecycle on
  the owning Run; persist that projection into Run status and observations.
- Emit one typed queued event per accepted input and one typed delivered event
  containing the exact ordered batch consumed at the safe boundary.
- Terminalize and remove undelivered queue entries when their owning Run ends so
  they cannot leak into a later continuation.
- Route daemon requests through the existing operation journal and ownership
  checks, then advertise the versioned capability only after the contract tests
  pass.

#### Resolution

- Embedded Runtime and the shared daemon now advertise `interruptInput` version
  1. The daemon binds a trusted input identity and authenticated operation
  origin, while its existing control journal returns the canonical result for
  an exact `operationId` retry.
- Active Actor Runs enqueue interrupt input on their canonical Session root
  queue. The existing Runner safe-boundary drain preserves FIFO order and each
  user-message boundary, so all inputs accumulated before that boundary enter
  one next LLM request without creating continuation Runs.
- Run status and Session observation expose each interrupt as
  `queued`/`delivered`/`terminal`. `run.input.queued` records acceptance, and one
  `run.input.delivered` event carries the exact complete ordered batch consumed
  at the boundary.
- Terminal Runs remove their still-queued message IDs and mark those input
  records terminal, preventing cross-Run leakage. Restart recovery likewise
  terminalizes a persisted queued projection because the process-local queue is
  intentionally non-durable.
- Safe-boundary callbacks now carry the exact queue message IDs consumed by both
  the ordinary tool boundary and idle-yield resume path. Runtime marks only that
  ordered batch delivered, so an interrupt arriving while idle-yield awaits
  aggregate-budget work remains queued for the following boundary.
- Runtime clones and validates the complete interrupt input before mutating the
  Actor queue, preventing rejected embedded-SDK input from leaving an
  untracked queue entry.
- The complete `run.input.delivered` batch is synchronously persisted before
  status changes to `delivered`. Restart recovery reconciles a stale queued
  projection from that durable fact; if the event cannot be written, delivery
  confirmation fails without publishing a false delivered state.
- Session ownership, current-active-Run checks, `stale_run`, per-Run
  `unsupported_capability` for execution without a safe Actor boundary, and
  existing `after_turn` continuation semantics remain unchanged.

#### Files Changed

- `src/sdk-runtime.ts`, `src/index.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-event.ts`
- `packages/coding/src/types.ts`, `packages/coding/src/task-engine/runner-driven.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/agent/src/orchestration/runner-with-idle-yield.ts`
- `src/sdk-runtime.test.ts`, `src/runtime-daemon/server.test.ts`
- `packages/agent/src/orchestration/idle-yield.test.ts`
- `src/runtime-event.test.ts`, `packages/agent/src/primitives/runner.test.ts`
- `docs/DD.md`, `docs/SDK_EMBEDDER_GUIDE.md`, `docs/features/v0.7.69.md`
- `docs/KNOWN_ISSUES.md`, `CHANGELOG.md`

#### Verification

- `npx tsc --noEmit`
- `npm run build`
- `npx vitest run src/runtime-daemon/server.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/protocol.test.ts src/runtime-daemon/schema.test.ts src/runtime-event.test.ts packages/agent/src/primitives/runner.test.ts`
- Focused SDK regression coverage verifies FIFO batch delivery, no continuation
  Run, snapshot/event lifecycle, SA unsupported behavior, stale/cross-Session
  fencing, terminal queue cleanup, exact consumed-message acknowledgement,
  clone-failure rollback, durable-event failure, and restart reconciliation.

### 192: Large compaction used the model window for protection, covered only one rolling chunk, and exposed ambiguous/unbounded SDK state

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.73 and earlier
- **Fixed**: v0.7.74
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

A KodaX SDK host reported a manual/automatic-looking compaction transition of
`322,973 -> 222,460` tokens. The compaction notification indicated success, but
only about 100k tokens disappeared, while the host UI continued to display a
330k-class value that kept growing. The product requirement also differs from
the implementation: automatic compaction must never be disabled; its percentage
must default to 75 and remain within 15-90; an optional absolute token threshold
must participate by minimum; and recent protection must be based on the
effective trigger rather than 20% of a one-million-token model window.

Further investigation found two adjacent correctness risks. Parent and child
iteration events shared session-level presentation state without a stable
context owner, so a child could replace the root token count. Runtime
observation also embedded a complete transcript in a transport with an 8 MiB
frame limit.

#### Expected Behavior

- Automatic large compaction is always active.
- Percentage and optional absolute thresholds have one public SDK contract;
  the smaller active threshold wins and protection is 20% of it.
- Manual and automatic large compaction cover the full eligible prefix once,
  preserve recent raw context and every genuine user query, and commit atomically.
- Summary generation reuses the stable main-request prefix where supported.
- Root/child token and compaction events have unambiguous context identity.
- Observation of arbitrarily large persisted transcripts is bounded and
  explicitly pageable rather than silently truncated or sent in one frame.

#### Root Cause

- The imperative SDK compact path forced `triggerPercent: 100`.
- Protection and rolling chunk budgets were derived independently from the full
  model context window (`20%` and `10%`). On a one-million-token model this
  protected about 200k and summarized one roughly 100k chunk, explaining the
  observed transition.
- The rolling summarizer could install partial progress after a later failure
  and repeatedly summarized earlier material through serial summary chaining.
- Summary requests used a separate system/tools shape instead of the main
  request prefix, losing available KV/prompt-cache reuse.
- User-query preservation was prompt guidance rather than a mechanically
  validated invariant.
- Session-level event/UI state did not carry a stable root/child context key.
- Runtime snapshots embedded the complete transcript despite the daemon's
  fixed maximum frame size.

#### Resolution

Implemented `FEATURE_272` as specified in
[`v0.7.74`](features/v0.7.74.md#feature_272-reliable-full-coverage-context-compaction-and-sdk-observability): shared
threshold normalization, coverage-driven atomic compaction, a canonical user
query ledger, exact-prefix cache reuse, context-scoped canonical events, and
bounded transcript pagination through the SDK/daemon and KodaX Space.

The final adversarial implementation review found and fixed five integration
drifts before release: the managed-task hook reported the pre-compact count and
omitted the canonical completion event/report; its summary request did not use
the exact active system/tools/reasoning cache prefix; protected-tail queries
were duplicated into the exact ledger; persisted anchors excluded admitted
post-compact attachments; and Space attempted the legacy monolithic transcript
method before falling back to pages. Space compact start/end and activity/cost
consumers now also preserve and filter child context identity, so child work
cannot transiently replace root UI state. The closing review additionally
found that imperative Runtime compaction emitted only `finished`; it now emits
one ordered `started -> finished -> ended` lifecycle even for unchanged or
failed attempts. Space now consumes the SDK-resolved effective threshold,
including physical capacity, and clamps every percentage entry point to 15-90.
The post-implementation fallback review also removed a false-success path: a
new array reference is not evidence of pruning. Success now requires a strict
token reduction and a physically valid complete request; otherwise the original
history is returned and no successful compatibility stats are emitted.

#### Verification

Focused policy/core/query-ledger/manual compact tests, lineage and JSONL
round-trips, root/child event isolation, daemon legacy-frame rejection, 9 MiB
SDK page/chunk recovery, and KodaX Space paging/projection tests pass. Root and
Space typechecks pass, as does the complete 0.7.74 package/bundle/DTS build.
The post-review run passed 352 focused core/caller/REPL tests, 51 daemon tests,
the canonical-event and 9 MiB SDK probes, 103 Space adapter/telemetry/config tests, the
published Runtime compatibility probe, and the Space renderer/main smoke build.
Manual UI and semantic summary checks are tracked in the v0.7.74 human test
guide.

### 191: Auto permission review lacked a complete, compact mutation model

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33
- **Fixed**: v0.7.73
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

`createAutoModeToolGuardrail` documented a deterministic Tier-2 rules layer,
but the `rules` engine only implemented Tier 1. Every non-Tier-1 call was
therefore escalated to `askUser`, including `write`, `edit`, and `multi_edit`
calls whose normalized targets were inside the Runtime project boundary. SDK
embedders such as KodaX Space consequently received `permission.requested`
events for ordinary workspace edits in explicit `Auto[rules]` mode.

The shared reason string also claimed that the engine was "downgraded" even
when the user had explicitly selected `rules`.

Release review then exposed the unsafe inverse: Tier 2 reused a generic target
collector as if it were an exhaustive authorization model. PowerShell named
and positional binding was command-dependent, so the following commands could
bind their real outside-workspace target to a later argument while Tier 2
validated an earlier value and returned `allow`: `Copy-Item`, `Move-Item`,
`Set-Content`, `Out-File`, `New-Item`, and `Remove-Item`.

The LLM path also forwarded a bounded session transcript plus AGENTS.md and a
raw action projection. That input was larger and less precise than the facts
needed for authorization, and a byte-budget overflow escalated directly to the
user instead of changing evidence strategy.

#### Expected Behavior

- Deterministic file mutations inside the Runtime workspace or a system temp
  directory are allowed without a prompt, except for protected KodaX/config
  zones.
- Read-only shell commands are allowed regardless of their target directory.
- In explicit rules mode, writes outside workspace/temp, unresolved paths,
  link escapes, unknown tools, and unmodelled/high-risk shell operations are
  never auto-allowed. In LLM mode these facts go to the permission reviewer.
- Runtime remains the sole permission decision owner; embedders must not add
  unconditional per-tool bypasses.
- The permission LLM receives the user's authority plus complete, atomic
  mutation facts. An outside-workspace boundary is evidence for that reviewer,
  not an automatic request for human confirmation.
- Explicit `rules` mode remains LLM-free by definition: it may auto-allow only
  fully resolved in-boundary operations and otherwise uses its existing
  confirmation path.
- Input size alone never triggers a confirmation dialog in the compact review
  path. Oversized intent and operation lists become explicit, content-addressed
  targeted evidence; if even that contract is violated, the call fails closed.

#### Root Cause

The common guardrail stopped after Tier 1 whenever its engine was `rules` and
immediately escalated. The original Tier-2 design had never been connected to
the REPL's canonical path and shell-AST utilities. Because those utilities
belong to `@kodax-ai/repl`, implementing the missing decision directly inside
`@kodax-ai/coding` would either duplicate parsing logic or violate package
layer independence.

The first Tier-2 implementation then treated
`collectDeterministicBashWriteTargets()` as complete. Its PowerShell helper
recognized only a few target-looking flags and otherwise selected the first
non-flag token. It did not model which parameters consume values or the
source/destination relationship of copy, move, and rename operations.

Separately, the classifier prompt conflated conversational history with
authorization evidence. Truncating that mixed payload reduced precision, while
overflow escalation converted an internal representation limit into user work.

#### Resolution

- Add a typed Tier-2 evaluator hook to the common guardrail and inject the
  deterministic implementation from the Runtime bootstrap. The guardrail is
  still the single authorization decision point; a direct SDK consumer that
  omits the hook continues to fail closed.
- Allow `write`, `edit`, `multi_edit`, and `insert_after_anchor` only when the
  canonical target is inside the Runtime project or a system temp directory.
  Resolve the deepest existing prefix through symlinks/junctions so a lexical
  in-workspace path cannot hide an external target.
- In explicit rules mode, escalate missing/unresolvable paths, link escapes,
  sensitive config or credential paths, out-of-boundary writes, unknown tools,
  high-risk shell patterns, dynamic shell targets, partially unmodelled
  compound commands, and effects whose actual mutation cannot be determined.
- In rules mode, allow established read-only shell commands outside the
  project. Allow fully modeled shell writes (including compounds and
  pipelines) only when every deterministic mutation target passes the same
  canonical project/temp boundary.
- Replace the unconditional "downgraded" copy with neutral rules-engine text;
  automatic transition logs still accurately say "downgraded" at the moment
  a denial/circuit threshold causes that transition.
- Replace PowerShell target guessing with command-specific parameter models.
  Named parameters bind before positional arguments; known value/switch
  parameters, unambiguous abbreviations, `-Path`/`-LiteralPath`, destination,
  and command-specific fields are modeled explicitly. Unknown, ambiguous,
  dynamic, wildcard, array, non-filesystem provider, or remote-session syntax
  is marked incomplete and cannot be rules-auto-allowed.
- Match supported PowerShell positional metadata and aliases such as
  `-PSPath`, `-Type`, `-UseTx`, and `-NoOverwrite`. Preserve `-WhatIf` as a
  non-mutating fact, while link-producing `New-Item` types remain incomplete
  until their target relationship can be represented atomically.
- Represent move/copy/rename as atomic source-to-destination operations. The
  review preserves operation kind, canonical boundary, force/recursive/
  overwrite facts, and risks such as source removal, cross-boundary mutation,
  protected paths, and possible destination overwrite.
- Feed the LLM a compact JSON permission review plus user-only intent evidence.
  Assistant prose, tool-result bodies, and AGENTS.md are excluded. Oversized
  user intent and unusually large operation lists are locally selected into
  bounded evidence with source byte counts and SHA-256 identity; budget alone
  does not ask the user to decide.
- Large operation summaries prioritize outside/protected/unresolved and
  destructive operations instead of sampling only the list edges. A local
  compact-evidence budget block does not count as a model denial and therefore
  cannot indirectly downgrade the session to rules mode.
- When deterministic analysis is incomplete, retain a bounded command
  projection (complete up to 1.5 KiB, otherwise head/tail targeted evidence)
  plus byte counts and SHA-256 identity. This keeps the reviewer informed about
  unmodelled commands without restoring the full raw-context payload.
- Keep the legacy classifier API backward compatible for external callers that
  do not inject a deterministic analyzer. Runtime and REPL paths always inject
  the new analyzer.

#### Files Modified

- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/coding/src/index.ts`
- `packages/repl/src/permission/auto-rules.ts`
- `packages/repl/src/permission/auto-rules.test.ts`
- `packages/repl/src/permission/powershell-mutation.ts`
- `packages/repl/src/permission/powershell-mutation.test.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/permission.test.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- `packages/repl/src/common/permission-config.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/view-models/status-bar.ts`
- `packages/repl/src/ui/view-models/status-bar.test.ts`
- `packages/coding/src/guardrails/auto-mode/permission-intent.ts`
- `packages/coding/src/guardrails/auto-mode/permission-intent.test.ts`
- `packages/coding/src/guardrails/auto-mode/classifier-prompt.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `docs/test-guides/ISSUE_191_v0.7.73_REGRESSION_GUIDE.md`

#### Verification

- RED: the Tier-2 suite first reproduced the missing evaluator. The PowerShell
  regression then failed all six reported forms because no command-level
  assessment existed. Compact-review tests reproduced transcript/AGENTS.md
  forwarding and the 16 KiB action-overflow escalation.
- Final focused permission regression: 9 files, 390 passed, 1 existing
  platform skip.
- `npm test --workspace @kodax-ai/repl -- --reporter=dot`
  (final run: 221 files passed / 2496 tests passed / 1 skipped, plus one
  unrelated session hook timeout under concurrent package load; the isolated
  session file then passed 35/35)
- `npm test --workspace @kodax-ai/coding -- --reporter=dot`
  (final run: 385 files passed / 4048 tests passed / 21 todo, plus one
  unrelated delayed-stream timing assertion; the isolated assertion then
  passed 1/1)
- Focused V8 coverage over the four core modules: 92.42% statements/lines,
  85.31% branches, and 97.36% functions.
- `npx vitest run src/sdk-runtime.test.ts -t "runs explicit auto engines inside Runtime|derives Runtime auto path context|executes the Runtime auto guardrail before|activates the Runtime-owned Auto guardrail" --reporter=dot`
  (4 passed)
- `npx tsc -b tsconfig.build.json --pretty false`

### 190: Legacy matcherless grants and escaped JSON credentials bypassed new safety boundaries

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.72 and earlier; expanded v0.7.73 RC
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

Permission grants written before concrete Runtime matchers were introduced had
only `toolName` and optional `sessionId`. The v0.7.73 reader retained these
records as persistent grants, and the matching path treated a missing matcher
as an unconditional match. A legacy Bash grant could therefore authorize a
different or dynamically expanded command without passing the new exact-call
boundary.

The same review questioned the new MCP classifier projection and credential
redaction. Comparison with v0.7.72 confirmed that the older priority projection
could hide a long `command` behind `method`; the new all-recognized-field
projection closes that gap and is retained. Common credential forms were
redacted before the classifier request, but an explicitly named credential in
shell-escaped JSON, such as `{\"token\":\"...\"}`, was not.

#### Root Cause

Backward-compatible grant parsing was incorrectly coupled to authorization:
management compatibility for legacy records implicitly became execution
compatibility. Classifier redaction recognized ordinary JSON key/value syntax
but not the escaped representation commonly embedded in shell arguments.

#### Resolution

- Keep matcherless legacy grants loadable, listable, and revocable, but never
  let them authorize a concrete call. The next invocation requires a fresh
  Runtime-issued matcher and approval.
- Preserve the current MCP projection. It retains all bounded recognized risk
  fields, represents bodies by size and unknown values by shape, and prevents
  the reproducible priority-hiding behavior from v0.7.72.
- Redact values for explicit credential keys in shell-escaped JSON before the
  classifier side-provider request. The surrounding command, URL, and ordinary
  operational fields remain visible.
- Document redaction as defense in depth rather than an entropy detector.
  Unlabelled Base64/hex strings are not blindly removed because they are
  indistinguishable from legitimate hashes, identifiers, and file digests.

#### Files Modified

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`
- `packages/coding/src/tools/classifier-projection.ts`
- `packages/coding/src/tools/classifier-projection.test.ts`
- `packages/coding/src/guardrails/auto-mode/classify.test.ts`

#### Verification

- RED: the legacy coarse-grant test reproduced implicit authorization before
  the matcherless-grant fix.
- RED: the classifier provider-capture test reproduced escaped JSON credential
  disclosure before the redaction fix.
- `npx vitest run src/sdk-runtime.test.ts -t "Runtime-issued concrete grant|legacy allow_always|persistent grant|persisted dynamic command grant|grant labels|coalesces concurrent|legacy coarse grants|session grants"`
  (11 passed)
- `npx vitest run packages/coding/src/tools/classifier-projection.test.ts packages/coding/src/guardrails/auto-mode/classify.test.ts packages/coding/src/guardrails/auto-mode/transcript-strip.test.ts packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
  (121 passed before the added negative control; focused projection/classifier
  rerun: 40 passed)
- `npx vitest run src/runtime-permission-scope.test.ts packages/repl/src/runtime-permission.test.ts`
  (14 passed)
- `npx tsc -b tsconfig.build.json --pretty false`

### 189: Auto sidecar effort, Runtime session settings, and reasoning command state could diverge

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33; expanded v0.7.73
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

Auto classifier and bash-prefix side queries always sent explicit reasoning
effort `none`. Always-thinking models such as Qwen Token Plan
`qwen3.8-max-preview` rejected that value, which caused classifier failures,
could downgrade Auto to `rules`, and produced avoidable permission prompts.
The main status bar still showed the user's main-model effort (for example
`high`), making the unrelated sidecar failure look like a failed status update.

`/thinking` and `/reasoning` exposed the older
`off|auto|quick|balanced|deep` vocabulary while `/effort` and the status bar
used native provider efforts. Selecting `deep` did not replace an existing
explicit `max`, so the command reported one mode while the status bar correctly
continued to show another. Always-thinking models could also accept and persist
an invalid explicit disable request before the provider rejected it.

Runtime-backed REPL sessions loaded `KODAX_AUTO_MODE_CLASSIFIER_MODEL` for the
legacy local guardrail but did not forward its effective value into Runtime
Session settings. `/mode auto` updated React/classic REPL state before Runtime,
so an immediate `/auto-engine llm` could report that the Session was not in
Auto mode. Runs whose Auto engine was omitted displayed the documented `llm`
default in diagnostics, but some permission-ownership paths still treated the
missing field as “Runtime does not own Auto”; a Tier-1-exempt internal tool such
as `todo_create` could then fall through to the generic permission broker.

Finally, assistant text can stream before a tool call from the same model turn.
A sentence such as “review complete” could therefore appear immediately before
that tool's approval prompt even though the Runtime run was still active,
making the prompt look as if it arrived after the task had terminated.

A follow-up review found four remaining gaps in that first closure. The Ink
command adapter discarded the asynchronous `/mode` synchronization promise; a
fresh REPL control overwrote a persisted Auto engine with its startup default;
side queries treated `disabledEfforts` as unsupported instead of as valid
thinking-off rungs; and the Anthropic adapter omitted
`thinking: { type: "disabled" }` for provider-budget Qwen 3.7 profiles. Parallel
tool preparation could also present two confirmations concurrently and replace
the first dialog resolver, leaving one tool call waiting forever.

#### Root Cause

Side-query policy was hard-coded at each caller instead of resolving the active
model's reasoning profile. Three slash commands wrote two different state
models. REPL Auto configuration stopped at the process-local bootstrap boundary
instead of crossing the Runtime Session API, and the mode callback was
synchronous even though Runtime synchronization is asynchronous. Runtime's
documented omitted-engine default was applied in stats/bootstrap but not in
every live run record and permission-ownership check. The approval UI also did
not explicitly say that an unresolved Runtime permission keeps the run active.
The follow-up gaps came from conflating a valid disabling effort with a rejected
effort, adapting an async callback through a void wrapper, using process-local
initialization as the only persistence signal, and storing only one active
confirmation resolver while tool preparation is parallel.

#### Resolution

- Make an omitted side-query effort capability-aware: use `none` when the model
  advertises disable support, including profiles whose `disabledEfforts`
  explicitly identify the thinking-off rung; otherwise use its lowest visible
  enabled effort, and omit the field when no safe advertised rung exists.
  Explicit caller requests remain strict; no retry ladder hides invalid
  requests.
- When a capability explicitly advertises disabled thinking, send
  `thinking: { type: "disabled" }` on Anthropic-compatible requests regardless
  of whether enabled thinking uses a toggle, effort, adaptive, or budget shape.
- Remove hard-coded `none` from the Auto classifier and bash-prefix extractor.
  This keeps the classifier on Qwen's lowest valid rung without changing the
  main model's status-bar effort.
- Route `/thinking`, `/think`, `/t`, `/reasoning`, `/reason`, and `/effort`
  through one native effort writer with canonical
  `none|auto|low|medium|high|xhigh|max` completion/help. Legacy inputs remain
  accepted as hidden aliases. Reject `none` before persistence when the active
  model cannot disable reasoning.
- Resolve environment-over-file classifier configuration once and explicitly
  synchronize permission mode, classifier model, timeout, and speculative
  window into each Runtime Session. Initialize the engine only when persisted
  Session settings do not already contain one, so manual changes and automatic
  downgrades survive a control/process restart. `/mode` passes the async Runtime
  callback through intact and waits before publishing/saving the new mode.
- Normalize omitted Auto engines to `llm` in live run records and guardrail
  refreshes, preserving the existing Tier-1 empty-projection bypass for
  internal non-file-mutating tools. `/auto-engine` now reports a configured
  session classifier model for direct verification when one is present.
- State in Runtime approval prompts that the run remains active until the
  approval is resolved, and add a bridge regression proving a runner cannot
  report completion while an earlier permission event remains unresolved.
- Serialize Ink confirmation presentation with a small promise tail so parallel
  tool preparation cannot overwrite the active resolver; a rejected presenter
  does not stall later confirmations.

#### Files Modified

- `packages/llm/src/side-query.ts`
- `packages/llm/src/providers/anthropic.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.ts`
- `packages/repl/src/runtime-permission.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/confirmation-dialog-queue.ts`
- `scripts/probe-reasoning.ts`
- `src/kodax_cli.ts`
- `src/sdk-runtime.ts`

#### Verification

- `packages/llm/src/side-query.test.ts`
- `packages/llm/src/providers/anthropic-reasoning-capability.test.ts`
- `packages/llm/src/providers/registry.test.ts`
- `packages/coding/src/guardrails/auto-mode/classify.test.ts`
- `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.test.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/repl/src/interactive/effort-command.test.ts`
- `packages/repl/src/interactive/completers/argument-completer.test.ts`
- `packages/repl/src/interactive/commands-status.test.ts`
- `packages/repl/src/interactive/prompts.test.ts`
- `packages/repl/src/ui/utils/confirmation-dialog-queue.test.ts`
- `src/kodax_cli.runtime-runner.test.ts`
- `src/sdk-runtime.test.ts`
- `npx tsc -b tsconfig.build.json --pretty false`
- Live single-turn probes confirmed disabled thinking with zero thinking output
  for Qwen Token Plan Qwen 3.7 Max/Plus and Qwen 3.6 Flash, GLM-5.2,
  DeepSeek V4 Pro/Flash, Kimi K3, MiniMax M3, and their tested Ark routes.
  Controls confirmed Qwen 3.8 Max Preview, Kimi K2.7 Code, and MiniMax M2.7
  remain always-thinking. MiMo could not be revalidated because the configured
  public account had insufficient balance and the coding-plan credential was
  rejected; its existing capability declaration remains unchanged.

### 188: Auto classifier projection, transcript boundaries, and first-run environment ordering were incomplete

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33; expanded v0.7.72 RC
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

The Auto[LLM] side-provider transcript retained complete assistant `tool_use`
arguments. Write/edit bodies and credentials could therefore leave the main
provider. The first local correction overcompensated by removing all arguments,
including paths, targets, command intent, and scope that the classifier needs
to interpret later actions. When the transcript exceeded its byte budget, an
oversized current tool call or tool result could also consume the recent-context
allocation and drop the user's newest explicit constraint.

The first bounded correction still retained raw `tool_result` text up to 2 KiB,
duplicated canonical action fields in historical metadata, and relied on every
tool author to provide complete classifier metadata. Constructed tools and
JavaScript extensions could therefore serialize arbitrary input or silently
skip classification when metadata was absent. MCP projection also hid a long
path or a second action field while forwarding unrelated short scalar values.

Separately, interactive first-run provider readiness inspected `process.env`
before Runtime preparation hydrated login-shell and config-backed credentials.
Users whose provider credential existed only in that environment projection
could be sent through setup even though normal Runtime startup was ready.

#### Root Cause

Transcript projection originally treated tool identity and raw arguments as one
factual record; the first correction then treated identity as sufficient. The
missing middle layer was the existing per-tool classifier projection plus a
fixed, bounded metadata projection. Budgeting also anchored only the first
`user` role and greedily truncated the newest oversized message. Tool-result
envelopes use the `user` role, so role alone cannot identify a genuine user
constraint. The first-run setup gate had been placed before the one existing
Runtime configuration preparation call.

The registry contract was compile-time only: JavaScript registrations could
omit `sideEffect` or `toClassifierInput`, and an empty non-readonly projection
had no auditable justification. Tier 0 also ran after the empty-projection
shortcut, so a faulty exemption could bypass deterministic denial. MCP used a
single priority action field plus opportunistic scalar previews instead of a
field-semantics projection.

#### Resolution

- Project assistant tool history through exactly one canonical
  `toClassifierInput` summary. Historical metadata no longer repeats paths or
  commands already represented by that summary; it adds only body sizes and
  collection counts. Portable `tool_call` history is unwrapped to the concrete
  target before projection.
- Replace every historical `tool_result` body, including errors and content
  below the old 2 KiB threshold, with bounded status metadata: tool identity,
  success/error, text character/byte counts, and media count. Result text,
  image paths, and media payloads never reach the classifier.
- Add one semantic fallback for constructed and extension tools. It retains
  bounded operational locators, commands/scripts/argument arrays and control
  flags; converts known free-form bodies to character counts; and describes
  unknown values only by type/shape. MCP uses the same field semantics, keeps
  every populated action field, and never forwards arbitrary short scalars.
  Common snake_case/camelCase SDK fields share that table, recognized fields
  are emitted before unknown shapes, and long locators preserve both their
  beginning and final target segment.
- Normalize runtime registrations: missing/invalid side effects become
  `mutates-state`, missing non-readonly projectors receive the safe fallback,
  and accidental empty non-readonly projections no longer bypass the
  classifier. Intentional non-readonly exemptions require a documented
  `classifierExemptReason`.
- Run deterministic Tier 0 checks before projection opt-out. Missing projectors
  fall back safely; throwing or invalid projectors escalate without disclosing
  exception text. Local read-only tools keep the zero-cost bypass, while
  network egress and remote provider-backed searches expose bounded query,
  locator, provider, and capability facts.
- Anchor the first and latest genuine user-intent messages before adding recent
  factual context. Tool-result-only envelopes are excluded from intent anchors,
  and only the remaining budget may hold a bounded snapshot of the newest
  oversized factual message. The serialized UTF-8 budget remains exact.
- Prepare Runtime configuration once after subcommand handling but before
  first-run readiness, then reuse that same configuration for session startup.

#### Verification

Regression tests cover useful path/command/query retention, write/edit body
non-disclosure, raw result non-disclosure, header/URL/CLI credential redaction,
MCP multi-action/long-path retention, constructed/extension fallback,
non-readonly exemption auditing, projector failure escalation, Tier-0 ordering,
portable bridge unwrapping, first/latest intent retention across an oversized
tool call and a tool-result envelope, exact transcript byte bounds, and
login-shell credential hydration before provider readiness without launching
the setup wizard.

### 187: Shared-daemon Auto permission ownership, upgrade fencing, preview bounds, and SDK compatibility were incomplete

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72
- **Fixed**: v0.7.72
- **Created**: 2026-07-19
- **Resolved**: 2026-07-19

#### Original Problem

The v0.7.72 Runtime Auto guardrail fix did not give SDK clients a complete
semantic upgrade or compatibility contract. An SDK client could reuse a healthy
older daemon that did not advertise Runtime-owned Auto classification; Session
fallback and settings updates could race or leave queued turns bound to a stale
cwd/engine; several Windows path checks remained case-sensitive; Bash writes to
the user `.kodax` credential zone were classifier-overridable; and permission
previews traversed and serialized more caller input than an approval UI needs.

The same SDK cut also removed the `amaw` input spelling, expanded `SkillSource`
with `learned`, and renamed daemon preflight task fields without a 0.7.x
compatibility surface. KodaX Space consequently encountered compile-time
breakage even though AMAW's runtime behavior had already merged into AMA.

#### Root Cause

Daemon health was treated as sufficient compatibility evidence, while the
permission owner contract had no dedicated capability. Auto guardrails were
cached as configuration snapshots instead of resolving the serialized Session
permission state at execution time. Path containment and preview construction
were duplicated across layers, and release-time type migrations changed
consumer-facing unions/fields rather than separating legacy input types from
new resolved runtime output.

#### Resolution

- Added `runtimeAutoModeGuardrail:1`; auto-start clients safely replace an old
  daemon only through revision/owner-policy fenced preflight when no active,
  queued, workflow, Agent-turn, permission, user-input, or second-client work
  exists. Attach-only and busy cases fail with a typed recoverable error.
- Added one serialized per-Session settings owner. Active and queued runs follow
  permission/engine/classifier/timeout updates; fallback merges the latest
  revision, persists rules state, and cannot reuse a downgraded LLM cache entry.
  Context-specific guardrails share the Session's engine, denial tracker, and
  circuit breaker without capturing another queued turn's cwd.
- Kept execution cwd in each guardrail cache identity and resolve relative tool
  and plan-mode paths from that cwd while treating git root only as the safety
  boundary and plan-document anchor.
- Unified permission-related path containment with Windows case-insensitive,
  segment-safe semantics and made proven direct/nested-shell writes to the user
  `.kodax` credential zone a deterministic Tier-0 denial, including redirects
  recoverable from otherwise unparseable shell input. Quoted Python and
  regular-expression source remains data rather than a path.
- Replaced recursive input serialization with a fixed-field, scan-bounded JSON
  summary. Write/edit bodies are omitted; strings, arrays, JSON/YAML secrets,
  headers, CLI credentials, URLs, and PEM blocks are bounded/redacted.
- Restored deprecated 0.7.x input aliases without restoring retired behavior:
  `amaw` normalizes to `ama`; legacy `SkillSource` stays exhaustive while
  `ResolvedSkillSource` adds `learned`; `activeAgentTasks` aliases current Agent
  turns alongside canonical `activeAgentTurns`.
- Runtime runs without an executable plan-exit callback do not expose
  `exit_plan_mode` to the model.

#### Verification

Regression coverage includes guardrail-before-hook execution order, read-only
and ordinary verification commands without pending permissions, exactly one
request on classifier escalation, active mode switching, concurrent
settings/fallback mutation, different-cwd queued turns, fallback then explicit
LLM re-entry, Windows case variants, execution-cwd-relative plan paths, direct
and nested Bash redirects (including unparseable surrounding syntax), source
text false-positive protection, valid bounded large-write previews, YAML/JSON/
PEM redaction, daemon capability advertisement/fail-closed attachment, plan-exit
tool hiding, and legacy SDK type aliases.

### 186: Daemon event subscriptions had no readiness boundary and could miss the first cross-client event

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.66
- **Fixed**: v0.7.72
- **Created**: 2026-07-19
- **Resolved**: 2026-07-19

#### Original Problem

The daemon client returned `RuntimeSubscription` synchronously while it created
the corresponding server subscription in an unobservable background request.
Its notification buffer covered events received before the subscribe response,
but it could not cover an event emitted before the server had processed the
subscribe request. A second client could therefore start a permission request
immediately after `events.subscribe()` and lose `permission.requested`, leaving
the request pending until timeout or shutdown.

Release CI reproduced the race on both Node 20 and Node 22. The test cleanup's
correct refusal to stop a daemon with an active `permission.request` initially
masked the earlier subscription-handshake timeout.

#### Expected Behavior

- A daemon host can explicitly wait until a remote event/workflow subscription
  is installed before another client starts work.
- Notifications received after installation but before the response remain
  buffered and are delivered once the remote subscription ID is known.
- Handshake failure is observable without producing an unhandled rejection for
  existing callers that do not use the new readiness boundary.
- Local embedded subscriptions remain synchronous and unchanged.

#### Root Cause

`subscribeToDaemonNotification()` started an asynchronous RPC and discarded its
promise. `RuntimeSubscription` exposed only `close()`, so callers had no way to
establish a happens-before relationship across two daemon connections.

#### Resolution

- Added the optional `RuntimeSubscription.ready` promise for remote
  event/workflow subscription handshakes.
- Preserved pre-response notification buffering and close-before-ready remote
  cleanup.
- Propagated handshake rejection through `ready` while attaching an internal
  rejection handler for backward-compatible callers that ignore it.
- Updated SDK permission examples to await readiness before triggering
  cross-client work, with focused success/failure regressions.

### 185: Learning lock crash recovery can time out before stale ownership is reclaimable

- **Priority**: Medium
- **Status**: **Open**
- **Introduced**: v0.7.68; expanded v0.7.72 RC
- **Created**: 2026-07-19

#### Original Problem

Both learning lock implementations stop waiting after 5 seconds, but refuse to
test the recorded owner's liveness until the lock file is more than 30 seconds
old. When a process crashes after writing a valid owner record, learning
proposal and Learned Area operations started during that 5-to-30-second window
can therefore fail with a lock timeout even though no live owner remains.

The two thresholds serve different purposes: a bounded acquisition timeout is
appropriate for live contention, while stale-owner recovery handles a crashed
owner. Raising the acquisition timeout to 30 seconds would hide the mismatch by
turning a recoverable crash into a long user-visible stall. Slow storage can
also make concurrent operations exceed the current waiting budget, but this is
contention behavior rather than proof that both thresholds must be identical.

The same lock protocol is duplicated in the F224/F228 proposal store and the
new F266 Learned Area helper. Their error messages differ and future fixes can
drift. The current stale path also performs a check followed by an unconditional
`rm`; multiple contenders reclaiming one crashed lock could race with creation
of a successor lock unless stale ownership is claimed atomically.

#### Expected Behavior

- A valid lock whose owner is demonstrably alive is never stolen.
- A valid lock whose owner is demonstrably dead can be reclaimed promptly,
  without first forcing callers through repeated five-second failures.
- Empty, partially written, malformed, inaccessible, or otherwise unverifiable
  ownership remains fail-closed.
- Live contention stays bounded and does not become a 30-second UI stall.
- Concurrent stale-lock contenders cannot remove a successor's lock.

#### Context

- **Feature ownership**: FEATURE_266, reusing the earlier F224/F228 proposal
  store protocol
- **Affected components**: `packages/agent/src/learning/store-lock.ts`,
  `packages/agent/src/learning/store.ts`, Learning Center/Learned Area writes
- **Trigger**: owner crash followed by a learning operation within 30 seconds;
  slow or highly contended storage increases the visible failure rate
- **Impact**: bounded learning-operation failure or delay; no normal-path data
  corruption has been reproduced
- **Release decision**: accepted as a non-blocking v0.7.72 deferral; fix in the
  F266 reliability follow-up rather than changing the lock protocol during the
  release cut
- **Workaround**: retry after the stale threshold; manually remove a lock only
  after independently confirming that its recorded owner is no longer alive

#### Root Cause

Owner liveness is nested behind a file-age gate, coupling crash recovery to a
30-second grace period even when the stored PID can already be checked safely.
The protocol was copied instead of routing proposal-store and Learned Area
writes through one implementation, and stale deletion is not an atomic claim.

#### Proposed Solution

- Consolidate proposal-store and Learned Area writes on one lock helper while
  preserving package-layer independence and existing token-fenced release.
- Separate live-contention timeout from stale-owner recovery; inspect a complete
  parseable owner record before the age threshold and reclaim only after an
  unambiguous dead-process result.
- Claim a stale lock atomically before removal so only one contender can win;
  never use a check-then-unconditional-delete sequence that can target a
  successor lock.
- Preserve fail-closed handling for malformed records and filesystem sharing
  errors rather than guessing ownership.
- Add crash-child, live-owner, malformed/partial-record, successor-token,
  simultaneous-contender, and Windows sharing-error regression tests.

### 184: `sed` side effects can bypass plan-mode write classification

- **Priority**: High
- **Status**: **Open**
- **Introduced**: v0.5.36
- **Created**: 2026-07-19

#### Original Problem

`sed` is listed as a safe read command, but the plan-mode write classifier does
not recognize its file-writing forms. The existing read-side check only scans
space-split text for a subset of `-i` forms, while `isBashWriteCommand()` does
not classify `sed` as writing. SDK and ACP plan-mode paths can therefore treat
an in-place invocation as allowed because they consume the write classifier's
result directly. The traditional REPL retains an additional shell confirmation
layer, so the observable behavior is inconsistent across hosts.

The gap is broader than a bare `sed -i`: GNU/BusyBox/BSD accept multiple
in-place option forms, and sed programs can write through `w`, `W`, or the
`s///w` flag; GNU `e` can execute a command. A script supplied with `-f` is
opaque to a command-line-only classifier. Conversely, adding every `sed`
invocation to the write-command list would regress legitimate read-only uses
such as `sed -n` and `sed -e`.

#### Expected Behavior

All Runtime surfaces should apply one effect-aware classification before a
plan-mode decision. Clearly read-only sed invocations should remain available;
known write effects should be blocked in plan mode and use the normal
guardrail/permission chain elsewhere; opaque or ambiguous programs must not be
silently treated as read-only.

#### Context

- **Affected components**: REPL permission classification, SDK Runtime, ACP
- **Affected scenarios**: plan mode and any host that trusts the shared bash
  read/write classifiers as an immutability boundary
- **Release decision**: accepted as a documented deferral for v0.7.72 while an
  effect model that avoids read-command regressions is designed
- **Workaround**: hosts requiring a hard read-only boundary should omit the
  shell tool or enforce filesystem immutability outside the command classifier

#### Root Cause

Read admission and write detection are separate boolean heuristics. The
read-side sed exception parses reconstructed command text rather than the shell
AST's argument roles, and the write-side classifier has no sed semantics. The
model cannot represent an opaque/unknown effect without incorrectly mapping it
to either read-only or writing.

#### Proposed Solution

- Classify parsed sed arguments rather than scanning arbitrary text; honor
  `--` and the arguments consumed by `-e`/`-f`.
- Recognize documented GNU, BusyBox, and BSD in-place forms without matching
  `-i` inside scripts, regular expressions, replacement text, or operands.
- Detect direct script write/execute commands and treat external `-f` programs
  as unknown unless their contents can be safely inspected.
- Introduce `readOnly` / `writes` / `unknown` effect outcomes shared by REPL,
  SDK, and ACP, with table-driven cross-surface regression tests.

### 183: CLI daemon startup failures and forced test exits could leave detached Node processes

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.66-v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Windows process inspection found detached `kodax daemon serve` Node processes
whose launching test workers no longer existed. Normal daemon persistence was
initially conflated with leakage: a healthy shared daemon intentionally survives
client `close()`, and a live/reachable daemon is not stale merely because its
original client or parent exited.

Two real lifecycle gaps remained. `kodax daemon start` detached its child before
health confirmation and retained no handle, so timeout, startup failure, owner
race, or Ctrl+C could not reclaim that exact candidate. Separately, daemon tests
performed explicit shutdown in `finally`, but a forcibly terminated Vitest
worker cannot run JavaScript teardown and could leave its test daemon alive.
The report's claimed `mock-provider` tight loop had no supporting stack or CPU
profile and was not used as a basis for a speculative provider change.

#### Root Cause

- CLI and SDK startup used different process lifecycle implementations. The SDK
  path retained and fenced its child, while the CLI path called `unref()`
  immediately and then polled health independently.
- The test harness had normal-path shutdown but no out-of-process fallback tied
  to the actual Vitest worker lifetime.
- A universal zero-client/idle reaper would violate the documented shared-daemon
  contract and the proposed `unowned` condition cannot describe a live owner,
  because a live daemon holds its own owner lock.

#### Resolution

- CLI and SDK now share one startup primitive. The exact candidate stays
  referenced until its own PID publishes healthy state; child exit, timeout,
  identity mismatch, competing-owner loss, and startup cancellation reclaim
  only that candidate and its descendants. Successfully healthy daemons remain
  detached and persistent.
- CLI startup installs bounded SIGINT/SIGTERM cancellation only while startup is
  pending and removes those listeners on every exit path. Known startup failure
  remains structured in JSON results; cleanup failure still propagates.
- Vitest records its worker PID in an internal inherited marker. A daemon checks
  that marker only when explicitly present and performs normal owner shutdown if
  the worker disappears. Production launches have no parent timer or idle
  reaper, and external tests must still use explicit `runtime.shutdown`/daemon
  stop during normal teardown.
- Startup termination uses the existing cross-platform process-tree cleanup so
  a partially initialized candidate cannot leave MCP/A2A descendants behind.

#### Files Changed

- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/kodax_cli.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `vitest.setup.queue.ts`
- `docs/HLD.md`
- `docs/DD.md`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_183_v0.7.72_REGRESSION_GUIDE.md`
- `CHANGELOG.md`

#### Tests Added / Verification Coverage

- Cancellation rejects promptly, terminates once, and never unreferences the
  pending candidate.
- A real SDK-started daemon shuts down, removes state/lock, and exits after its
  explicitly watched parent process terminates without closing the client.
- Existing regressions continue proving that a healthy daemon survives ordinary
  client detach, concurrent starters converge, and CLI start/restart/stop works.
- Strict TypeScript compilation passes and the final Windows process inventory
  contains no KodaX daemon residue.

### 182: Windows lifecycle lock contention surfaced as fatal `EPERM` during concurrent memory forgets

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.68
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

The memory lifecycle lock retried only `EEXIST`. Under concurrent forgets,
Windows can report a short-lived `EPERM`, `EACCES`, or `EBUSY` while another
owner closes or removes the lock file. That valid contention path escaped
immediately and made the full Agent suite intermittently fail even though the
lock owner was live and the five-second acquisition deadline had not expired.

#### Resolution

- Treats Windows sharing-denial errors and cross-platform `EBUSY` as bounded
  lock contention, using the existing stale-owner check, retry interval, and
  five-second deadline. Other filesystem errors still propagate immediately.
- The 24-way concurrent-forget regression passed five consecutive focused runs
  after reproducing the original failure.

#### Files

- `packages/agent/src/memory-control/lifecycle.ts`
- `packages/agent/src/memory-control/memory-control.test.ts`

### 181: MiniMax M3 default upgrade left the media capability regression stale

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

The current provider snapshot changed `minimax-coding`'s default from
MiniMax M2.7 to the verified image-capable MiniMax M3 route. Model-specific
media regressions were updated, but one default-provider assertion still
expected image input to be unsupported, leaving the full Agent suite red even
though production capability resolution was correct.

#### Resolution

- Updated the stale assertion to pin the current MiniMax M3 default's supported
  image capability while retaining the nearby unsupported-route checks.
- Re-ran the full Agent suite so the capability source, default-model snapshot,
  and regression contract agree.

#### Files

- `packages/agent/src/media/capabilities.test.ts`
- `packages/coding/src/media/capabilities.test.ts`

### 180: Queued user input used a different root scope and could not wake `wait_agent`

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

While the root Agent repeatedly called `wait_agent`, a user follow-up could
remain in the visible Queue across many tool/LLM steps and even after the child
Agent completed. The UI queued prompts without an `agentId`, while the new Actor
runner drained `actor:<sessionId>:/root`; exact queue routing meant neither side
could see the other. `wait_agent` also waited only for Actor events and the UI
used whole-run abort as its historical wake mechanism.

#### Resolution

- Added one canonical Actor queue-id helper and routed REPL producers, AMA/SA
  consumers, cancellation terminals, and goal deferral through the session root.
- Preserved the legacy unscoped SA route. The public media enqueue helper now
  accepts `sessionId`, automatically binds old single-Actor calls to the sole
  active root, and rejects ambiguous multi-session calls instead of crossing
  sessions. Runtime and Runner own reference-counted route registration from
  start through every terminal path; Runtime commits registration only after
  the underlying launch object exists, so synchronous startup failure cannot
  leak a stale active route.
- `wait_agent` now races Actor events against a non-consuming queue subscription
  using read-register-recheck, returning `user_input_pending` at the next safe
  boundary without aborting unrelated parallel tools.
- Idle-yield now uses the same lossless subscription pattern instead of polling.
- Session isolation, pre-existing input, registration-gap input, abort, timeout,
  synchronous launch failure, and queue-retention behavior have deterministic
  regression coverage.

#### Files

- `packages/coding/src/agent-runtime/actor-queue.ts`
- `packages/agent/src/messaging/routing.ts`
- `packages/agent/src/media/queue.ts`
- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/repl/src/ui/contexts/StreamingContext.tsx`
- `src/sdk-runtime.ts`

### 179: Auto[LLM] eight-second timeout and readonly projections caused spurious approvals

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.33
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Auto[LLM] escalated classifier timeouts into confirmation dialogs. The fixed
eight-second default was below historical P90 classifier latency, so timeouts
were frequent rather than exceptional. Several locally readonly observation
tools also emitted non-empty classifier projections and unnecessarily paid the
LLM latency/failure path.

#### Resolution

- Raised the bounded default classifier timeout to 20 seconds; explicit user
  settings still override it and non-readonly failures remain fail-closed.
- Enforced empty classifier projections for pure readonly invocations, covering
  Actor observation, ordinary semantic lookup, and LSP document symbols without
  weakening write/network policy. `semantic_lookup(refresh:true)` remains a
  deliberate exception because it rebuilds the on-disk derived index.
- Added SDK/daemon session settings for classifier model and timeout, positive
  integer validation, persistence, capability advertisement, and cache-key
  invalidation when either setting changes.

#### Files

- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/server.ts`

### 178: Bare `-r` cancellation retained terminal input until another keypress

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

After `npm link`, running `kodax -r` and pressing Esc displayed
`Session resume cancelled.` but did not immediately return to the PowerShell
prompt. Pressing another key, such as Space, allowed the command to finish.

Expected behavior: explicit picker cancellation must restore the terminal and
return to the invoking shell without requiring any additional input.

#### Root Cause

The searchable picker resumes stdin so it can receive raw terminal input. Its
renderer correctly removed listeners and restored raw mode, but the bootstrap
handled the resulting `kind: 'exit'` route with an immediate return. Unlike the
successful handoff and error paths, that branch never paused or unreferenced
stdin, so Windows could keep the linked Node process attached to terminal input
until another keypress woke the stream.

#### Resolution

- The bare-resume bootstrap now pauses and unreferences stdin before returning
  from an explicit cancellation.
- Successful selection still uses the existing pause/ref handoff before the
  full REPL takes ownership, so resumed sessions retain working input.
- A focused regression asserts cancellation releases stdin without loading the
  full CLI or referencing input again.

#### Files

- `src/kodax_bootstrap.ts`
- `src/kodax_bootstrap.test.ts`

#### Verification

- Bootstrap, picker, runner, renderer, and resume-handoff suites: 36/36 tests
  passed across 6 test files.
- Full `npm run build` passed, including the linked CLI bootstrap bundle.

### 177: Worker announced and attempted an oversized fresh spawn wave before Actor capacity rejection

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

On a fresh four-slot Actor tree, a request containing five independent review
tracks could make the root say it would dispatch five Agents and emit five
`spawn_agent` calls. The scheduler correctly admitted only three non-root
Turns, after which the root explained the capacity failure and took over work.
Safety was preserved, but the visible plan, tool batch, and actual execution
disagreed.

#### Root Cause

The scheduler capacity fact existed only at tool execution time. The first
prompt revision also placed correct capacity guidance deep inside a long
collaboration section, and the no-routing-plan fallback retained static
instructions. A paid `fresh_capacity` pilot reproduced five structured starts,
showing that tool-layer rejection plus a buried sentence was not an adequate
experience contract.

#### Resolution

- Full routing-plan and no-plan fallback prompts read the current Actor tree on
  every LLM round.
- Both paths reuse one authoritative first-section capacity contract with the
  exact total, active, and available slots; it limits both visible prose and
  `spawn_agent` calls for the current response.
- Overflow remains root-owned or is named as a later refill wave. No hidden
  scheduler queue, second lifecycle, or increased concurrency limit was added.
- Deterministic full/fallback prompt tests and the smallest affected six-call
  re-pilot verify three starts for the fresh five-track treatment case.

#### Files

- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/_internal/managed-task/{agent-chain,role-prompt,role-prompts}.ts`
- `benchmark/datasets/feature-270/*`

### 176: Learning subscription could lose a wake, retain a waiter after disconnect, and cache transient principals without bound

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

`subscribe()` read durable events before registering its in-process waiter. An
event committed in that gap was neither in the first read nor delivered to the
not-yet-registered waiter, so the subscriber remained blocked until a later
event. Returning an async generator while it awaited that waiter could not
cancel the wait promptly. Runtime Learning also cached one facade per daemon
principal, allowing a long-lived daemon with changing principals to grow an
unbounded Map.

#### Root Cause

The subscription combined a durable file cursor with a non-atomic in-memory
notification hub but lacked read-register-recheck. Async-generator `return()`
cannot enter `finally` until its current awaited promise resolves. The Runtime
owner conflated durable client identity with object-facade identity.

#### Resolution

- Subscription uses read-register-recheck and advances one durable sequence at
  a time.
- A cancellable async iterator owns its waiter; `return()` removes and resolves
  it immediately.
- Runtime retains no per-principal facade Map. It creates lightweight facades
  on demand, shares owner-level learned-area initialization, and continues to
  hash stable client identities into durable cursor files.
- Deterministic tests pause the first read across a concurrent commit, verify
  prompt cancellation without a subsequent event, and prove repeated binding
  does not return a retained facade.

#### Files

- `packages/agent/src/learning/learning-center-service.ts`
- `packages/agent/src/learning/learning-center.test.ts`
- `src/runtime-learning.ts`
- `src/sdk-runtime.learning.test.ts`

### 175: Actor start/interrupt race could launch with a fresh cancellation handle; closed Actors still accepted mailbox traffic

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Actor start persisted the running Turn before `launch()` created its
AbortController. An interrupt could commit in between, observe no controller,
and then allow launch to install a fresh un-aborted handle. Closed Actors also
passed relationship authorization for mailbox send/drain, leaving messages in
an identity that would not execute again. Late successful executor callbacks
performed a no-op mutation that still advanced snapshot revision and saved.

#### Root Cause

Cancellation ownership was attached to execution launch instead of the atomic
Turn-start state transition. Messaging authorization checked only tree
relationships, not terminal Actor identity state. The mutation primitive had
no explicit unchanged-result path.

#### Resolution

- `commitStart()` atomically creates and stores the controller; `launch()` only
  consumes that exact handle.
- Closed identities remain inspectable but reject send, receive/drain, spawn,
  and follow-up with `actor_closed`.
- Completion, failure, and progress callbacks on terminal Turns skip revision
  increment and persistence.
- The daemon advertises versioned `actorControlPlane v1`; incompatible new
  SDK/old daemon and old SDK/new daemon pairs receive explicit upgrade/restart
  errors without restoring `agentTasks` as an executable alias.
- Deterministic save-gated race, late completion, closed mailbox, and protocol
  compatibility tests cover the repaired boundaries.

#### Files

- `packages/agent/src/actors/controller.ts`
- `packages/agent/src/actors/controller.test.ts`
- `src/runtime-daemon/{client,protocol,schema,server}.ts`
- `src/sdk-runtime.ts`

### 174: Bare `-r` session picker exited as cancelled before accepting input

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.69
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Running `kodax -r` or `npm run dev -- -r` paused during startup and then
printed `Session resume cancelled.` without displaying a usable searchable
session picker. The explicit `-r <session-id-or-title>` path remained a
workaround.

Expected behavior: in an interactive terminal, bare `-r` remains alive until
the user selects a session or explicitly cancels. In a non-interactive process,
the CLI should report that an exact ID or title is required instead of claiming
that the user cancelled.

#### Root Cause

- The v0.7.69 picker migration from upstream Ink to the local TUI called the
  new renderer without terminal streams. The local renderer therefore used its
  inert fallback stdin/stdout/stderr: no picker was visible and no input could
  reach it.
- The local input runtime also enabled raw mode and attached a data listener
  without taking ownership of an unreferenced stdin handle.
- During early CLI startup the picker can be the only component expected to
  keep the process alive. Node therefore reached `beforeExit`, unmounted the
  picker, and resolved `waitUntilExit()` without a selection.
- `runSessionPicker()` represented both explicit cancellation and unexpected
  lifecycle exit as `undefined`, so the CLI printed the misleading cancellation
  message.
- The local `useInput()` compatibility layer also discarded Ctrl+C before the
  picker could handle it, breaking one of its documented cancellation paths.

#### Resolution

- `runSessionPicker()` now binds the owned renderer to the real process terminal
  streams, so the picker is visible and receives input.
- The terminal input controller now references stdin while at least one input
  subscriber is active and releases that reference after the final subscriber
  detaches. Raw-mode ownership remains shared across subscribers and is restored
  during cleanup.
- Ctrl+C is delivered through the local `useInput()` contract, allowing the
  picker to cancel and restore raw mode normally.
- The picker tracks explicit cancellation separately, reports unexpected exits
  as errors, rejects non-interactive bare resume with an actionable ID/title
  instruction, and always unmounts/cleans up in `finally`.
- After Enter, the picker remains mounted in a visible loading state while the
  full CLI module is prepared. Bootstrap memoizes that import, then pauses and
  re-references interactive stdin before the REPL renderer takes ownership, so
  the picker-to-REPL transition has no unowned input or process-liveness gap.
- Selection preparation failures preserve the original error, clean up the
  picker terminal lifecycle, and never retain stdin.

#### Files

- `packages/repl/src/tui/renderer-runtime.tsx`
- `packages/repl/src/tui/renderer-runtime.test.ts`
- `packages/repl/src/ui/SessionPicker.tsx`
- `packages/repl/src/ui/SessionPicker.test.tsx`
- `packages/repl/src/ui/SessionPicker.runner.test.tsx`
- `packages/repl/src/cli-resume.ts`
- `src/kodax_bootstrap.ts`
- `src/kodax_bootstrap.test.ts`
- `src/kodax_resume.ts`
- `src/kodax_resume.test.ts`

#### Verification

- TUI, picker, and dialog regression suite: 34 files, 400 tests passed.
- Root CLI suite: 1 file, 65 tests passed.
- `npm run build --workspace=@kodax-ai/repl` passed.
- A built-artifact terminal-stream simulation rendered the picker, selected the
  requested session through Enter, and restored raw mode (`raw=false`).
- Rebuilt `@kodax-ai/repl`; non-interactive bare `-r` now reports the required
  exact ID/title rather than `Session resume cancelled.`
- Focused picker/bootstrap/resume transition suite: 6 files, 36 tests passed,
  including async preload failure cleanup; full TypeScript checking passed.
- The complete package, CLI/resume/bootstrap bundle, Worker sidecar, and all 12
  public SDK declaration builds passed.

### 173: REPL batch history commit collapsed distinct reply times into one timestamp

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.45
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

After one long user query, every committed Assistant, Thinking, and Tools block
could display the same completion-time clock value even though the replies were
produced minutes apart. Session `20260718_105849` demonstrated the failure: its
canonical assistant lineage retained distinct timestamps from 11:00 through
11:17, while the persisted `uiHistory` entries had no timestamps and the final
batch render showed the response blocks at 11:17.

Expected behavior: each history block keeps the time at which that event was
created. Batching history updates may reduce renders, but must not replace
event metadata with the batch commit time.

#### Root Cause

- `CreatableHistoryItem` removed both `id` and `timestamp`, so converting live
  managed-foreground items to bulk additions discarded their original times.
- `KodaXSessionUiHistoryItem` and its serializer did not persist a history-item
  timestamp.
- `addHistoryItems()` called `createHistoryItem()` for the whole array, and
  `createHistoryItem()` unconditionally used `Date.now()`. All entries created
  in the same synchronous batch therefore received the same value.
- Resume treated `uiHistory` as authoritative but did not use the canonical
  messages' per-message timestamps to repair older timestamp-less snapshots.

#### Resolution

- UI history records and creatable items now carry an optional, validated epoch
  timestamp. Live-to-durable conversion, text/tool-group serialization, JSON
  loading, restore, and bulk commit preserve it end to end.
- `createHistoryItem()` uses the supplied event time and only falls back to the
  current clock for genuinely new or invalid timestamp-less items.
- Legacy `uiHistory` is repaired on restore by stable round/order matching
  against canonical messages. This restores the distinct assistant times in
  session `20260718_105849`; sessions whose old canonical messages also lack a
  timestamp remain best-effort because their exact historical times cannot be
  reconstructed.
- Added regression coverage for distinct batch timestamps, durable round trips,
  legacy recovery, malformed persisted timestamps, and ambiguous suffixes.

#### Files

- `packages/agent/src/types.ts`
- `packages/repl/src/interactive/json-guards.ts`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/contexts/UIStateContext.tsx`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/message-utils.ts`
- `packages/repl/src/ui/utils/restore-history.ts`

#### Verification

- Relevant regression suite: 7 files, 173 tests passed.
- Full `npm run build` passed, including package TypeScript compilation, CLI/SDK
  bundles, and declaration bundles.
- Loading session `20260718_105849` through `FileSessionStorage` restored 32
  Assistant items with 32 distinct timestamps.

### 172: Daemon Runtime bypassed auto-mode guardrails and treated quoted source text as protected paths

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.64-v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-17
- **Resolved**: 2026-07-18

#### Original Problem

KodaX Space ran a shared-daemon Coder Session with `permissionMode=auto` and
`autoModeEngine=llm`, but ordinary Bash-backed OCR/Python work repeatedly
created permission requests. The inspected Session
`s_d13b9f93...` / run `run_mroh9tzn_71aa4afb` contained 18 Bash calls, 15
permission prompts, and four five-minute permission timeouts. The request
events already carried the command and description in `inputPreview`, so the
repetition was not caused by the renderer losing the decision response.

Expected behavior: an explicit Runtime auto engine must classify each tool
call through the same auto-mode guardrail used by the REPL. Only a deliberate
guardrail escalation should enter the shared permission broker. Quoted Python
source, regular expressions, and other non-path arguments must not be treated
as protected filesystem paths.

#### Root Cause

- Runtime persisted `autoModeEngine` but never bootstrapped or installed an
  `AutoModeToolGuardrail`; its event-level fallback therefore applied the
  static permission policy before any LLM/rules classifier could decide.
- The legacy raw-command scan added every quoted string as a path. Python
  `-c` source and search expressions consequently reached protected/outside
  path checks as false path candidates.
- Relative candidates were resolved against the daemon process cwd instead of
  the run's execution cwd (with the project root kept as the security
  boundary), so daemon launch location could create additional false matches.
- Runtime runs exposed `exit_plan_mode` even when their host supplied no
  `exitPlanMode` approval callback. The tool first entered the generic
  permission broker and then failed as interactive-REPL-only.
- Permission previews truncated serialized JSON at an arbitrary character,
  producing invalid input for large writes and hiding the target/operation from
  downstream clients.

#### Resolution

- Runtime now bootstraps the selected `llm` or `rules` auto engine once per
  Session/root context, reuses the stateful tool guardrail across turns, and
  persists automatic fallback to `rules`. Session deletion and Runtime close
  release cached guardrail state.
- Managed-task now forwards Runtime guardrails into the real `Runner`. Runtime
  issues a one-shot decision receipt only after guardrail allow and requires an
  exact call-id/tool/input match before the permission hook can run; missing,
  changed, or replayed receipts fail closed.
- `tool_call` resolution is shared by the guardrail and dispatcher, so signals,
  Tier 0, projection, classification, permission, and execution all refer to
  the same concrete target. Only the guardrail's explicit `askUser` escalation
  enters the shared permission service, including with
  `permissionBroker=client`.
- `gitRoot` is now only the project security boundary, while relative command
  and file paths resolve from the run's separate `executionCwd`. Session
  metadata supplies both defaults when run options omit them, run-level
  overrides cannot widen the Session boundary, and both direct REPL surfaces
  pass their detected execution directory into auto-mode.
- Command argument roles distinguish inline Python/regex/program text from file
  operands and path-valued flags, including attached forms. Ordinary-prefix
  traversal remains a path candidate, while nested source literals do not.
- Runtime rejects a caller-supplied duplicate auto-mode guardrail when it owns
  explicit auto mode.
- Runtime removes `exit_plan_mode` from the model-visible tool set unless the
  caller supplied its approval callback, while preserving caller exclusions.
- Permission previews now remain valid bounded JSON, redact credential-bearing
  keys and inline shell secrets, fall back to a compact command/path summary,
  carry the effective execution directory, and normalize caller-supplied
  previews through the same registry boundary. The daemon accepts legacy large
  preview inputs for Runtime normalization but keeps observable response
  previews capped at 8192 characters.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/runtime-daemon/schema.ts`
- `src/runtime-daemon/schema.test.ts`
- `src/sdk-runtime.test.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`
- `packages/coding/src/guardrails/auto-mode/absolute-denylist.ts`
- `packages/coding/src/guardrails/auto-mode/file-signals.test.ts`
- `packages/coding/src/guardrails/auto-mode/file-signals.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/coding/src/guardrails/auto-mode/signals.test.ts`
- `packages/coding/src/guardrails/auto-mode/signals.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/runner-driven.test.ts`
- `packages/coding/src/tools/tool-bridge.ts`
- `packages/coding/src/tools/index.ts`
- `packages/coding/src/index.ts`
- `packages/repl/src/index.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/permission.test.ts`
- `packages/repl/src/permission/repl-bash-signals.test.ts`
- `packages/repl/src/permission/repl-bash-signals.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `docs/KNOWN_ISSUES.md`

#### Tests Added

- Runtime explicit-auto regressions covering guardrail installation, actual
  Runner execution order, managed-task propagation, exact concrete-call
  receipts, replay/mutation rejection, broker escalation, Session reuse/cache
  release, client-broker and host-hook compatibility, queued-turn fallback,
  duplicate rejection, Session-derived path context, and execution cwd.
- Runtime tool-exposure regression covering both the no-callback exclusion and
  the explicitly wired `exitPlanMode` path.
- Quoted/nested Python source, regex/program source and option-value roles,
  attached source/path flags, Windows paths with spaces, ordinary-prefix
  traversal, and project-root/execution-cwd path-resolution regressions.
- Large-write and caller-supplied preview regressions proving bounded,
  credential-redacted, valid JSON with an effective execution directory.
- Daemon schema validation for the `executionCwd` permission field, legacy
  oversized input compatibility, and the 8192-character response ceiling.

#### Verification

- `npm run build` passed, including package type-check, SDK/CLI bundles, worker
  sidecars, and declaration bundles; `git diff --check` passed.
- Full Runtime SDK suite passed 80/80, including real daemon lifecycle tests.
- Permission, auto-mode, managed Runner, bridge contract, bootstrap, and daemon
  schema suites passed 572 tests, with one platform-dependent skip and two
  existing todos.

### 171: Verified Ark Coding image inputs were rejected before provider dispatch

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.57
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

KodaX SDK 0.7.71 reported image input as unsupported for all five documented
Ark Coding image routes and `validateInputArtifactsForModel()` therefore
raised `MODEL_INPUT_UNSUPPORTED` before requests reached the provider. The
affected models were `doubao-seed-2.0-code`, `doubao-seed-2.0-pro`,
`kimi-k2.7-code`, `kimi-k2.6`, and `MiniMax-M3`.

Live probes against the Ark Coding Anthropic-compatible endpoint confirmed
that every exact route accepts a base64 16×16 PNG content block and returns a
normal response. The SDK capability results were therefore false negatives.

#### Root Cause

The source-backed native-media allowlist omitted the separately routed Ark
Coding provider/model pairs. Negative tests encoded some of those omissions as
intended behavior even though the shared Anthropic provider serializer already
preserved image blocks correctly.

#### Resolution

Added only the five normalized `ark-coding/<model>` pairs listed above to the
source-backed image route set. No provider-wide Ark Coding capability or video
capability was enabled; unlisted Ark models remain unsupported until
independently verified.

#### Files Changed

- `packages/agent/src/media/capabilities.ts`
- `packages/agent/src/media/capabilities.test.ts`
- `packages/agent/src/media/validation.test.ts`
- `packages/coding/src/media/capabilities.test.ts`
- `packages/coding/src/media/validation.test.ts`
- `packages/llm/src/providers/anthropic-message-serialization.test.ts`
- `packages/llm/src/providers/ark-coding-image-routes.integration.test.ts`
- `docs/KNOWN_ISSUES.md`

#### Tests Added / Verification Coverage

- Capability tests require image support and video rejection for all five exact
  routes while preserving fail-closed results for nearby unverified routes.
- Validation tests require image artifacts to pass for the exact route through
  both the Agent owner package and the Coding compatibility surface.
- Provider serialization coverage binds all five models to their exact wire ids
  and verifies an Anthropic base64 image content block reaches each final
  request payload.
- An opt-in real-gateway integration smoke sends one bounded 16×16 PNG request
  per route, runs sequentially, and preserves raw responses under the OS temp
  directory. All five live probes completed successfully before release.

### 170: A2A realm-key upgrade hid durable tasks and global admission serialized slow preparation

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.71
- **Fixed**: v0.7.71
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

The v0.7.71 authority hardening changed durable inbound task ownership from
`SHA-256(subject + NUL + tenant)` to a canonical
`SHA-256([securityRealm, subject, tenant])` tuple. This correctly prevented an
authentication-authority switch from adopting another authority's tasks, but
the file store retained only the opaque hash and provided no explicit upgrade
path. After an upgrade, a known v0.7.70 owner could therefore no longer get,
subscribe to, cancel, or deduplicate its retained tasks. Recovery could still
finish an in-flight Runtime run, leaving its result inaccessible to that
client.

The same review found that the global `SendMessage` admission tail remained
held across workspace preparation, Runtime session creation, and run startup.
A slow principal could consequently head-of-line block unrelated principals
even when the server had more than one available concurrency slot.

#### Root Cause

Durable task records had no principal-key scheme marker, and the security fix
intentionally avoided unsafe automatic legacy fallback without replacing it
with an operator-supplied offline rekey. Admission fixed the cross-principal
check-then-act race with a promise mutex, but its protected operation was the
whole asynchronous preparation path rather than only capacity reservation.

#### Resolution

New task records carry the non-secret `realm-subject-tenant-v1` key-scheme
marker. Pre-realm records remain fail-closed by default; KodaX never guesses an
authority and never dual-reads the legacy key during normal RPC handling. With
the server stopped, `kodax a2a migrate-tasks` performs a byte-preserving dry
run, while `--apply --confirm-server-stopped` atomically rekeys only the exact
configured Bearer owner. OAuth requires an explicit `--subject`. The public
`migrateA2ALegacyTaskOwners()` SDK accepts one or more explicit
subject/tenant/realm mappings for custom hosts. Ambiguous mappings, unknown key
schemes, and a live store owner fail closed; unmatched records are preserved.

Global capacity now uses a synchronous pending-admission reservation. The
active-count check and increment contain no `await`, so JavaScript's run-to-
completion turn closes the race without a global asynchronous lock. The
reservation becomes a persisted submitted task before it is released, and a
`finally` path releases it when preparation fails. Per-principal ordering and
deduplication remain unchanged, while cross-principal workspace/session/run I/O
proceeds concurrently up to the configured capacity.

#### Files Changed

- `src/a2a/principal-key.ts`
- `src/a2a/task-migration.ts`
- `src/a2a/task-store.ts`
- `src/a2a/server.ts`
- `src/a2a/index.ts`
- `src/integration-cli.ts`
- `src/a2a/task-migration.test.ts`
- `src/a2a/a2a.test.ts`
- `src/integration-cli.test.ts`
- `src/sdk-a2a.test.ts`

#### Tests Added / Verification Coverage

- Offline-migration tests cover byte-preserving dry-run, atomic exact rekey,
  current-key marker backfill, unmatched retention, idempotency, ambiguous
  mappings, and live-store exclusion.
- End-to-end server coverage proves a pre-realm task is inaccessible before
  migration, becomes accessible afterward, and a retried message remains
  deduplicated to the original task.
- Admission regressions prove a full single-slot server rejects another
  principal without waiting for slow preparation, two slots prepare
  concurrently, a third is rejected, and failed preparation releases its
  reservation.
- CLI and SDK-surface tests cover dry-run/apply confirmation and the public
  migration API.

### 169: Executor shutdown and daemon auto-start could wait indefinitely or leak startup children

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.67-v0.7.71
- **Fixed**: v0.7.71
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

A post-release review found that `AgentExecutorPlane.close()` waited without an
upper bound for admitted operations, custom executor disposal, and event-pump
exit. A custom executor returning a never-settling promise could therefore hang
host shutdown indefinitely. Registration upsert/removal also awaited obsolete
executor disposal while holding the global registration mutation lane, so one
slow disposer could freeze unrelated registration changes. The in-memory map
of every seen `(agentId, configurationRevision)` retained complete cloned
registrations forever in a long-running daemon.

Runtime daemon auto-start polled health for up to 60 seconds without observing
the spawned child's exit. An immediately failing child therefore produced a
full timeout, while a child still running after timeout or an ownership race
was detached without deterministic reclamation. The same review identified
duplicate release builds and uncached Electron smoke dependencies. Its claim
that `.electron-smoke/` currently appeared as hundreds of megabytes of
untracked Git content was not reproducible because the contents were already
covered by `node_modules/`, but the toolchain root was not explicitly ignored.

#### Context

The executor plane must still drain normal short operations and wait for event
iterators; the fix cannot turn close into immediate best-effort disposal.
Revision immutability must remain exact for the current registration and every
route retained by a non-terminal durable task. Daemon cleanup must target only
the child spawned by the current acquisition attempt, never kill a healthy
unrelated owner, and must preserve the intended long-lived detached daemon once
that exact child publishes healthy state.

The review's three SDK compatibility items were intentional v0.7.71
strictness, not regressions: `AgentRegistrationService.setEnabled` is required,
executor configuration/reference metadata is JSON-safe, and omitted SDK
`homeDir` follows `KODAX_HOME`. They required explicit migration notes rather
than behavioral rollback.

#### Root Cause

Close implemented complete drainage but had no deadline around the aggregate
operation. Registration mutation and resource cleanup shared one async critical
section. Revision-reuse protection stored full registrations with no retention
policy. Daemon spawning discarded the live child handle immediately after the
`spawn` event and waited only on filesystem/socket health observations.
Release jobs composed two scripts that each performed the full TypeScript and
bundle build, and Electron's version-pinned toolchain was reinstalled on every
Windows job.

#### Resolution

Executor close now uses one idempotent overall deadline with a 30-second default
and optional positive finite `closeTimeoutMs`; timeout rejects visibly while
the already-admitted cleanup may still finish in the background. Registration
persistence/publication remains serialized, but obsolete-executor collection
is awaited only after releasing that lane. Revision history stores canonical
SHA-256 execution fingerprints and retains at most 4,096 recent tombstones;
current registration and durable task-snapshot checks remain independent and
exact even after an old unreferenced tombstone is evicted.

Daemon auto-start retains a process handle and races every health poll/delay
against child exit. Early exit reports its code or signal immediately. Timeout,
identity mismatch, and other startup failure terminate the exact spawned child,
escalate to forced termination if needed, and surface an aggregate cleanup
error rather than silently orphaning it. The child is unreferenced only after
its own PID publishes healthy state; if another daemon wins, the spawned child
is reclaimed before attaching to the winner. A candidate that exits after
observing a different owner PID is treated as having relinquished the race, so
its SDK caller continues waiting for that owner to become healthy; an exit with
no competing owner still fails immediately.

Release jobs now run `npm run build` once, execute the Electron smoke directly,
and package with `--skip-tsc`. CI and release cache the exact Electron 42.5.0 /
electron-builder 25.1.8 toolchain, and `.electron-smoke/` is explicitly ignored.
The v0.7.71 changelog now calls out all three intentional SDK compatibility
changes and their migration paths.

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/executor-plane.test.ts`
- `packages/agent/src/external-agents/types.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `tests/release-workflow.test.ts`
- `.gitignore`
- `CHANGELOG.md`

#### Tests Added / Verification Coverage

- Executor regressions prove the close deadline, registration-lane release
  before slow disposal, bounded history eviction, and retained recent revision
  reuse rejection while preserving the existing full-drain tests.
- Daemon regressions prove immediate exit-code reporting, timeout cleanup,
  delayed unref until the spawned PID is healthy, and cleanup when another PID
  wins startup.
- Workflow regressions parse both YAML files and require one release build,
  `--skip-tsc` packaging, direct Electron smoke execution, cache keys/paths, and
  install-on-cache-miss conditions.

### 168: A2A post-closure review found executor shutdown, daemon ownership, and server admission gaps

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The final upstream/downstream A2A review found several independent paths where
the implementation could violate its documented safety or usability contract.
Executor start/input/cancel/reconcile work could race shutdown or executor
disposal; an arbitrary `KODAX_HOME` could resolve to different daemon/config
identities and a daemon could publish ready before initial A2A reconciliation.
An older healthy daemon could also remain on last-known-good registrations
after a successful-looking config mutation.

Protocol edges were inconsistent as well. Configured document Agents had no
usable artifact-reference policy even though the SDK correctly defaulted
materialization to deny, while unsupported required Agent Card extensions could
be registered as if supported. `a2a add --allow-private` could persist a target
that automatic Runtime activation would always reject. Inbound starts from
different principals were not globally atomic, Runtime replay/subscription had
event-loss windows, request authentication happened after bounded body
allocation, media checks accepted substring lookalikes, server close could
overtake admitted handlers, and SSE subscribers had no aggregate or byte queue
ceiling.

#### Context

- A2A remains the general Agent protocol; these fixes must not introduce ACP,
  a gateway, an extension registry, an artifact downloader, or unrestricted
  private-network discovery.
- F258 owns protocol-neutral executor durability/lifecycle. F267 owns A2A wire
  semantics. F268 owns declarative A2A v2 config and activation. F269 owns the
  shared-daemon capability/ownership boundary.
- Legal presentation/document Parts can approach the 16 MiB inbound Part limit
  and expand under base64/JSON/SSE framing, so discovery limits and task-response
  limits cannot be one value.

#### Root Cause

Lifecycle accounting covered cached executor ownership but did not treat every
admitted task mutation and event iterator as a close-drained lease. Daemon paths
were partly derived from a CLI-style home and partly from the resolved config
home; readiness and config mutation lacked a complete capability/reconciliation
barrier. A2A Card extensions and configured artifact references were parsed but
not closed at the discovery/host-policy boundaries.

Inbound task admission used narrower principal lanes without one short global
reservation transaction. Runtime recovery replayed before subscribing, and
HTTP lifecycle accounting stopped before all response/handler work had drained.
The stream producer enqueued without per-task/global admission or a
byte-measured slow-consumer budget. Media validation used substring matching,
and authentication was coupled to the already-parsed RPC body.

#### Resolution

The executor plane now serializes each task's mutating operations, leases every
executor operation, shares one idempotent close promise, rejects new admission
after the close fence, drains admitted writes/starts/short operations, aborts
owned streams, waits for iterators, and disposes once. Captured inputs,
executor config, and reference metadata are JSON-safe; durable registration,
task, directory, task-ID, and event-sequence conflicts fail closed; persistence
precedes in-memory publication.

Daemon startup and mutation use the exact resolved config home, persist that
identity, reconcile A2A before ready, and require every healthy target owner to
advertise both `externalAgentAdmin: 1` and the independent
`a2aConfigReconciler: 1`. The daemon strips A2A ownership fields from arbitrary
capability overrides and derives them from installed owner state, so a client or
embedder cannot forge config-reconciler ownership. Non-empty A2A v1 files
require the explicit stopped-owner migration; v2 migration is an idempotent
read-only no-op. Failed initial reconciliation closes the Runtime/controller
before ownership release.

Agent Card extensions are validated and any unsupported required extension
rejects discovery. Configured A2A Runtime wiring admits only bounded A2A-
provenance `data:`/HTTP(S) references and never downloads remote URLs; the
general SDK remains default-deny. Direct `kodax a2a call` now uses the same
restricted reference-only policy. Its task RPC/SSE response budget is 32 MiB,
while Card/interface/OAuth/security metadata remains under the 2 MiB CLI network
budget. The non-persistent private-network override was removed from `a2a add`;
explicit one-shot test/call and SDK policies retain their deliberate operator
boundary. Public `@kodax-ai/kodax/a2a` configuration exports are limited to
parse/read/inspect/classify helpers; raw migration and mutation writers remain
inside the capability-fenced CLI owner.

Inbound authentication now requires a non-empty stable `securityRealm`, and the
task owner key is the SHA-256 of the canonical `(securityRealm, subject, tenant)`
tuple. Built-in Bearer derives its realm from the token environment-variable
name; built-in OAuth derives it from the exact validated issuer. Secret/JWKS
rotation within one realm and same-realm restart preserve realm-aware task
access. Changing authority cannot inherit tasks by reusing a subject, custom SDK
authentication without a realm fails at server creation/hot update, and
pre-realm persisted task records are not heuristically adopted.

Inbound `SendMessage` now uses one short global dedup/limit/reservation critical
section while retaining per-principal ordering outside Runtime execution.
Runtime attachment subscribes first, buffers live events, merges durable replay
by sequence, and then switches live. Authentication occurs before reading the
bounded request body; authorization remains method/scope specific afterward.
JSON/SSE media types are matched exactly. Close rejects new work and awaits
preparation plus admitted handler tails before resources close. SSE is capped at
four streams per task, eight per server, and 24 MiB encoded queue bytes per
stream; overflow or disconnect closes only that stream and releases its slot.
Configured task responses use a separate 32 MiB limit while Card/OAuth/JWKS
traffic retains its smaller safe-network ceiling.

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/memory-store.ts`
- `packages/agent/src/external-agents/types.ts`
- `src/runtime-agent-store.ts`
- `src/a2a/client-executor.ts`
- `src/a2a/index.ts`
- `src/a2a/product.ts`
- `src/a2a/schemas.ts`
- `src/a2a/server.ts`
- `src/a2a/server-auth.ts`
- `src/a2a/types.ts`
- `src/a2a/config.ts`
- `src/a2a/runtime-config.ts`
- `src/sdk-a2a.ts`
- `src/integration-cli.ts`
- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/manager.ts`
- `src/runtime-daemon/host.ts`
- `src/runtime-daemon/server.ts`
- `src/sdk-runtime.ts`

#### Tests Added / Verification Coverage

- Executor/store regressions cover concurrent close callers, admitted
  registration/task writes, in-flight start/cancel/reconcile, event iterator
  drain, invalid JSON capture, persistence failure, duplicate durable IDs,
  directory hashes, and strict event task/sequence identity.
- Daemon/config regressions cover arbitrary `KODAX_HOME`, explicit `homeDir`,
  multi-profile ownership, capability refusal, readiness fencing, stopped-owner
  v1 migration, idempotent v2 migration, initial-reconcile cleanup, the
  independent `a2aConfigReconciler` requirement, and rejection of forged A2A
  ownership capability overrides.
- A2A protocol regressions cover required/optional Card extensions, configured
  inline/remote artifact references without fetch, exact JSON/SSE media types,
  authentication-before-body, cross-principal admission, subscribe-first replay,
  admitted-handler close drain, per-task/global stream caps, HTTP disconnect,
  slow-consumer isolation, and near-limit presentation artifacts.
- Authentication regressions cover issuer hot switch, Bearer-to-OAuth authority
  change, same-realm/same-`dataDir` restart, secret/JWKS rotation, pre-realm task
  isolation, and missing custom-auth `securityRealm` at creation and hot update.
- CLI coverage rejects the removed non-persistent `a2a add --allow-private`
  path, proves direct-call reference-only/no-fetch behavior, and keeps task
  responses at 32 MiB while rejecting oversized metadata at 2 MiB.
- SDK-surface coverage proves public `/a2a` exposes read-only config helpers but
  not raw writer/migration functions. Final server-boundary coverage pins the
  global admission reservation, subscribe-first replay, authentication-before-
  body, exact media matching, close drain, and 4/8/24 MiB SSE contract.

### 167: A2A OAuth and hot-activation closure could leak credentials or mutate stale registrations

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The standards-aligned OAuth closure and per-Agent hot activation review found
several security and authority gaps. Rotated bearer tokens reflected by a slow
remote response could outlive the bounded redaction history; direct SDK callers
could bypass the integration-file OAuth URL validation; an authority-changing
refresh could leave an old registration dispatchable after discovery failure;
and a config reconciler could disable or remove a same-ID SDK replacement
between its list and mutation operations.

#### Context

- KodaX is the OAuth client for outbound A2A calls and a resource server for
  inbound calls; token issuance remains the responsibility of an external
  Authorization Server.
- `enabled` is desired configuration. The Runtime owner applies it to the
  durable registration plane and must fence new dispatch before replacing
  credentials, endpoints, or effects.
- Disabling a registration must preserve its complete executor payload so an
  already-admitted durable task can still resume.
- Config-owned registrations coexist with registrations created directly by
  SDK embedders.

#### Root Cause

Token redaction remembered only a small number of recently used values without
retaining the credential used by every in-flight JSON-RPC attempt. OAuth URL
checks lived primarily in the config parser instead of the public auth
factories. Config reconciliation inferred ownership from a revision marker and
performed list-then-mutate operations by Agent ID without a mutation-time
revision condition. Its original disabled fence also reconstructed a partial
registration from a summary, dropping durable executor details.

#### Resolution

Each ordinary RPC attempt and SSE stream now retains its exact Authorization
value through response parsing and redaction, then releases it in `finally`;
successful messages, tasks, artifacts, streams, and errors are redacted. A
compare-and-clear retry prevents one 401 from invalidating a newer token.
Shared OAuth validators enforce issuer, token endpoint, JWKS endpoint, scope,
and resource syntax at config and direct-SDK boundaries while preserving exact
issuer comparison.

The registration plane now supports persistence-first, serialized mutations
conditioned on both the observed revision and management owner, plus an atomic
enabled mutation that preserves the full registration. Config reconciliation
records explicit management ownership, fences changed authority before
discovery, repairs live drift, leaves unrelated SDK registrations intact, and
performs independent Agent discovery in parallel. Disabling blocks new
admission without canceling an admitted task.

Before task admission the plane durably retains an internal immutable full
route snapshot. It validates that snapshot against the public task summary on
restart, keeps update/removed routes usable for input, cancellation, and
reconciliation, and garbage-collects only after terminal task persistence.
The snapshot is not exposed through task/daemon DTOs and contains references,
not resolved credentials. Same-revision execution-content reuse is rejected;
management owner, enabled state, and health remain independently mutable.

The final review also closed shared-plane races around this path. Global task
ID uniqueness is rechecked inside serialized admission; task state is
published to memory only after the durable write succeeds; terminal event
failure still settles waiters and releases snapshots; summaries are detached
from live registration objects; and executor cache keys use structured tuples
rather than delimiter concatenation. Reconciliation isolates per-entry owner
conflicts and observer failures and awaits every refresh it starts.

#### Files Changed

- `src/a2a/client-auth.ts`
- `src/a2a/client-executor.ts`
- `src/a2a/security.ts`
- `src/a2a/server-auth.ts`
- `src/a2a/config.ts`
- `src/a2a/runtime-config.ts`
- `packages/agent/src/external-agents/types.ts`
- `packages/agent/src/external-agents/executor-plane.ts`
- `src/runtime-daemon/protocol.ts`
- `src/runtime-daemon/schema.ts`
- `src/runtime-daemon/client.ts`
- `src/runtime-daemon/server.ts`

#### Verification

- OAuth tests cover client-credentials authentication, exact issuer/audience
  validation, scope and URL rejection, token caching/singleflight, concurrent
  401 recovery, and direct SDK construction.
- Redaction tests hold slow message/task/artifact responses across at least five
  token rotations and cover SSE lifecycle cleanup.
- Registration tests cover persistence failure, durable-task continuation,
  update/removal plus restart recovery, snapshot crash-window cleanup,
  revision-and-owner conflicts, live drift, fail-closed authority changes,
  parallel discovery, disabled zero-fetch behavior, and same-ID replacement
  races. Adversarial coverage also exercises cross-Agent/local task-ID
  collisions, caller mutation of returned/input objects, terminal event-store
  failure, per-entry owner isolation, observer failure, and delimiter-bearing
  cache identities.
- Runtime-daemon tests exercise the new conditional registration mutation path
  across its protocol boundary.

### 166: Electron daemon bootstrap mode leaks into user child processes

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.71 RC
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The packaged Electron daemon auto-start fix correctly starts the application
executable in Node mode, but leaves `ELECTRON_RUN_AS_NODE=1` in the long-lived
daemon environment. Bash, MCP, LSP, sandbox, and other external processes can
inherit that environment. A user command which launches an Electron program
may therefore start it in Node mode instead of its normal application mode.

#### Context

- The variable is needed only while the Electron executable bootstraps the
  daemon or another trusted internal Node entry.
- Deleting it only after daemon startup is insufficient unless trusted internal
  `process.execPath` launches retain a bounded Node bootstrap path.
- Electron's `RunAsNode` fuse may disable this mechanism and must be an explicit
  compatibility boundary.
- The real Windows packaged/asar smoke currently runs manually and is not a
  required CI or release gate.

#### Root Cause

`createRuntimeDaemonServeEnvironment()` adds `ELECTRON_RUN_AS_NODE=1` to the
daemon child environment, and the daemon retains that copied environment for
its full lifetime. No preload consumes the bootstrap-only variable before
Runtime initialization or user process spawning.

#### Proposed Solution

Introduce one internal Node launch contract which temporarily enables Electron
Node mode and prepends a bootstrap preload that removes the variable before the
target module executes. Use it for the daemon and every trusted internal
`process.execPath` child, while ordinary user process environments remain
clean. Extend the packaged Windows smoke to observe the daemon environment and
a daemon-spawned external child, document the fuse boundary, and require the
smoke in CI and release workflows.

#### Resolution

All trusted `process.execPath` children now use one internal launch contract.
For a packaged Electron executable it sets `ELECTRON_RUN_AS_NODE=1` only at the
OS exec boundary and prepends a Node import which deletes the variable before
the target entrypoint loads. Runtime startup also removes the variable as a
non-optional invariant. Ordinary Node launches keep their arguments unchanged,
and user Bash, MCP, native LSP, sandbox, and external child environments remain
clean.

Daemon auto-start, CLI daemon start, JavaScript LSP, Skill CLI, and sandbox
broker/interpreter entrypoints use the bounded contract. The public guide now
states that packaged auto-start requires Electron's default-enabled `RunAsNode`
fuse; a deliberately disabled fuse must use an ordinary Node/CLI daemon with
attach-only SDK mode, and packaged timeout diagnostics name that boundary.

The Windows Electron 42.5.0 + asar smoke now loads a daemon extension which
observes both daemon and daemon-spawned external-process environments. It is a
required Windows CI job and a release gate for the `win-x64` build.

#### Files Changed

- `packages/agent/src/runtime/process-hardening.ts`
- `packages/agent/src/runtime/process-hardening.test.ts`
- `packages/agent/src/index.ts`
- `packages/coding/src/lsp/spawn.ts`
- `packages/coding/src/lsp/spawn.test.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/kodax_cli.ts`
- `src/sandbox-runtime.ts`
- `src/skill_cli.ts`
- `scripts/test-electron-daemon-smoke.mjs`
- `tests/fixtures/electron-daemon-smoke/main.cjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_166_v0.7.71_REGRESSION_GUIDE.md`

#### Verification

- Unit/process tests prove the bootstrap switch is consumed before target code,
  including when optional process hardening is disabled.
- Packaged Windows Electron 42.5.0 + asar smoke passed: daemon cold-started,
  Main ran once, daemon and external-child probes both reported the variable
  absent, Node attached to the same Runtime, detach semantics held, and two
  owner transitions completed.
- Full repository suite passed: 835 files and 10,007 tests, with only the
  repository's declared skips/todos remaining.
- Workspace TypeScript build, SDK bundle, declarations, and workflow YAML
  validation passed.

### 165: Packaged Electron auto-start relaunches the app instead of executing the daemon CLI

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.70
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

In a Windows packaged Electron application using asar,
`connectKodaXRuntime({ autoStart: true })` timed out after the full daemon
startup budget on a fresh profile. Attaching to a daemon started beforehand by
ordinary Node worked, proving that transport, authentication, packaged CLI
files, and the shared Runtime were healthy. The packaged app could only start
the daemon when its child executable was explicitly placed in Electron's Node
execution mode. SDK embedders must not need to mutate their global environment,
resolve private CLI paths, or duplicate owner logic.

#### Context

- Reproduced on Windows 10 x64 with Electron 42.5.0 and asar packaging.
- Ordinary Node CLI/SDK auto-start is unaffected.
- `ConnectKodaXRuntimeOptions.homeDir` is also easy to confuse with
  `KODAX_HOME`: the option is the base directory that owns `.kodax`, while the
  environment variable points directly at the `.kodax` data directory.

#### Root Cause

The SDK spawned `process.execPath`. In Node this is the Node executable, but in
a packaged Electron Main process it is the packaged application executable.
The child inherited normal Electron application mode and therefore did not
execute the resolved daemon CLI entry as a Node script.

#### Proposed Solution

Enable Node execution mode only in the spawned daemon child when the host is
Electron, without mutating the parent environment. Preserve the existing Node
spawn path and daemon ownership semantics. Add focused environment tests,
Windows Electron/asar smoke coverage, and explicit public documentation for
`homeDir`, CLI `--home`, and `KODAX_HOME` path meanings.

#### Resolution

SDK auto-start now detects an Electron host and uses a bounded Node bootstrap
for the detached daemon child. The parent Electron environment is not mutated,
the bootstrap switch is removed before daemon code loads, and ordinary Node
launch behavior remains unchanged. The SDK also validates the resolved daemon
CLI sidecar before spawn, so an incorrectly bundled embedder fails immediately
with an actionable error instead of waiting for the startup timeout.

The public option comments and Embedder Guide now state that SDK `homeDir` and
CLI `--home` identify the base directory which owns `.kodax`, whereas
`KODAX_HOME` already identifies the `.kodax` data directory.

#### Files Changed

- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/sdk-runtime.ts`
- `scripts/test-electron-daemon-smoke.mjs`
- `tests/fixtures/electron-daemon-smoke/`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_165_v0.7.71_REGRESSION_GUIDE.md`

#### Verification

- Packaged Windows Electron 42.5.0 + asar smoke: passed, including cold start,
  one GUI Main entry, same-runtime Node attach, logical `1 -> 2 -> 1` client
  convergence, detach-only close, and two daemon/inline owner transitions.
- Runtime daemon and process-distinct CLI regression: 156/156 passed.
- SDK Runtime facade/config regression: 69/69 passed.
- TypeScript `tsc --noEmit` and the publish bundle build passed.

### 164: MCP cross-language zero matches can force an avoidable second model/tool round

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

`mcp_search` used lexical matching only. A Chinese query against a provider whose
catalog metadata is English could therefore return a truthful but unhelpful zero
result even though the requested capability existed. The model then had to infer
that the query vocabulary was wrong and issue another search or inventory call.
This made progressive disclosure less accurate and could spend more tokens and
latency than returning a compact, exact recovery in the first result.

#### Context

The issue affects cross-language or vocabulary-mismatched searches, especially
large English MCP catalogs queried by Chinese users. Successful lexical searches
were already efficient and should not pay any permanent prompt text, embedding,
translation, or extra lookup cost. A fallback also must not expose an order-biased
prefix or exceed the physical tool-result capacity.

#### Root Cause

- Query tokenization split punctuation and whitespace but not compact CJK words.
- A non-empty zero result did not distinguish an actually empty filtered catalog
  from a query/catalog vocabulary mismatch.
- The search facade had no cost-admitted, lossless zero-match recovery path.

#### Resolution

- Added `Intl.Segmenter` word segmentation for CJK query tokens. This improves
  same-language CJK metadata matching without pretending to translate languages.
- On a non-empty zero match only, `mcp_search` reads the same filtered inventory
  through the already validated runtime snapshot. The MCP runtime reuses its
  in-memory live catalog unless a dirty signal invalidated it, so this adds no
  second model/tool round and no normal-path discovery work.
- When every exact id can be represented losslessly as a shared canonical prefix
  plus all suffixes, the tool returns that complete known-snapshot inventory only
  if it costs no more than a normal default eight-item search page and fits the
  current physical result capacity.
- If either admission check fails, the tool emits a compact catalog-language retry
  signal with no partial id list or cursor. A revision change between the zero
  result and recovery inventory fails closed with `MCP_CATALOG_CHANGED_RESTART`.
- No embeddings, model translation, bilingual dictionary, permanent language
  instruction, static byte threshold, or lossy artifact was added.
- A fully unavailable catalog is no longer mistaken for a lexical zero match,
  avoiding a duplicate discovery/connection attempt. Stale or mixed grouped
  recovery retains the affected server and bounded failure reason.

#### Files Changed

- `packages/agent/src/capabilities/mcp/catalog.ts`
- `packages/coding/src/tools/mcp-search.ts`
- Adjacent MCP catalog/tool tests and FEATURE_035 design/test documentation

#### Tests Added

- Compact CJK same-language ranking
- Successful-search single-pass invariant
- Lossless grouped zero-match recovery with preserved server/kind filters
- Dynamic normal-page and physical-capacity admission
- Revision-change fail-closed behavior and no order-biased oversized fallback
- Fully unavailable single-pass behavior and preserved grouped failure diagnostics
- Real local GitHub snapshot: 26/26 exact ids reconstructed; grouped recovery
  214 tokens versus 353 for literal inventory (39.4% reduction)

### 163: A2A review found endpoint trust, task lifecycle, artifact, and protocol gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.69
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

Post-fix review found that outbound discovery trusted an Agent Card's selected
interface without binding it to the trusted Card origin; the no-code Bearer
Card used a pre-1.0 authentication shape; recursive remote reads did not
revalidate every concrete file; `INPUT_REQUIRED` started another Runtime run
instead of answering the pending interaction; terminal records were never
pruned; and generated file artifacts were not returned over A2A. Additional
lifecycle and interoperability gaps left failed starts or subscriptions live,
accepted absent protocol versions as 1.0, ignored bounded history/list filters,
and failed to poll after a premature normal stream EOF.

#### Context

These defects affect configured outbound Agents, inbound no-code serving,
fixed workspaces, long-lived principals, interactive tasks, and the document or
presentation scenarios that motivated the general-Agent A2A surface. Existing
happy-path tests passed because they did not exercise these boundaries.

#### Root Cause

- Discovery validated the Card fetch and later endpoint independently instead
  of pinning the selected interface to the discovery trust decision.
- Remote read guardrails authorized only the requested search root, while the
  grep/glob handlers enumerated additional concrete paths internally.
- The server mapped Runtime state names but did not bridge Runtime interaction,
  artifact, pruning, or cleanup ownership into A2A task semantics.
- Product Card construction and several request fields were tested only against
  internal parsers rather than the frozen A2A 1.0 ProtoJSON contract.

#### Proposed Solution

Add boundary-first regression tests, then minimally bind selected interfaces to
the trusted origin and advertised Bearer scheme; revalidate concrete read paths;
bridge pending Runtime user input into the same task/run; prune only oldest
terminal records; publish explicitly staged run artifacts; close terminal
subscriptions and fail starts safely; and implement the missing bounded A2A 1.0
request/version/stream semantics. Avoid new storage engines, generic credential
frameworks, or public artifact hosting.

#### Resolution

- Bound Card-selected interfaces to the trusted discovery origin, required
  advertised A2A 1.0 Bearer security before credential use, completed private
  address classification, and preserved DNS-pinned transport behavior.
- Revalidated every concrete `read`/`grep`/`glob` path, propagated the read,
  tool, Skill, and Skill-script ceilings to child runs, and kept staged output
  paths inside the bound workspace.
- Resumed pending Runtime input on the original run, redacted private defaults
  and task paths, cleaned terminal subscriptions, failed start errors safely,
  and pruned only oldest terminal records.
- Added bounded history/list/version validation, accepted-output negotiation,
  explicit staged document artifacts, successful admitted Skill-script output
  promotion, streaming artifact updates, inline remote artifact authorization,
  and polling fallback after premature stream EOF. Declared-but-failed Skill
  outputs and ordinary workspace writes are never published implicitly.
- Restored authenticated SSE through the credential broker, validated JSON-RPC
  correlation and task/context scope, accumulated `artifactUpdate.append`
  chunks by artifact ID, preserved direct-Message file Parts, replaced offset
  pagination with the designed stable opaque task cursor, and supplied
  sanitized context/input modes to host authorization.
- Tightened Part/task forward-compatible parsing and optional-operation errors,
  kept successful tasks successful when a staged output disappears, and stopped
  treating an access-denied live-process probe as a stale Windows store lock.
- Kept the implementation on the existing file store, Runtime interaction
  service, artifact ledger, `.kodax-a2a-staging` broker, and ASRT promotion
  result; no task database, generic OAuth framework, or public artifact host was
  introduced.

#### Files Changed

- `src/a2a/{server,task-store,client-executor,safe-fetch,schemas,product}.ts`
- `src/runtime-agent-binding.ts`
- `packages/agent/src/session-lineage/compaction/file-tracker.ts`
- `packages/coding/src/{types,child-executor}.ts`
- `packages/coding/src/agent-runtime/tool-execution-context.ts`
- `packages/coding/src/tools/{read,grep,glob}.ts`
- Adjacent A2A, binding, tool, child-executor, CLI, and protocol tests

#### Tests Added

- Added regressions for same-origin endpoint trust, A2A 1.0 Bearer Card shape,
  mapped/private address handling, per-file read guards, child policy
  inheritance, input continuation, retention, cleanup, history/list validation,
  staged/Skill/direct/remote artifacts, failed Skill output, non-published
  ordinary writes, authenticated SSE, cross-task/mismatched JSON-RPC responses,
  appended artifact chunks, stable cursor pagination, authorization scope, lock
  ownership, redaction, failed starts, and early stream EOF.

### 162: A2A serve drops Runtime defaults and Markdown Agent provider

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.69
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

`kodax a2a serve --provider zai-coding` could start listening but fail the
first inbound run with `runtime.runs.start requires input.options.provider or
runtime defaultProvider`. Declaring the same provider in the selected user
Markdown Agent did not help. The expected behavior is that an admitted local
Agent uses its explicit provider, while an Agent without one falls back through
the serving Runtime's CLI, environment, core config, and built-in defaults.

#### Context

The failure blocked both `runtime-default` and user Markdown Agent A2A serving
when no other provider happened to reach the Runtime. The same Commander option
ownership pattern could silently drop prefixed provider/model/reasoning options
from daemon, ACP, and Skill subcommands. It failed closed and did not expose
credentials or expand remote authority.

#### Root Cause

- Commander stored duplicated root/subcommand options on the root command,
  while affected actions read only their local option object.
- A root option before a subcommand bypassed the raw `argv[0]` early-return
  check and could fall through into the ordinary CLI after the subcommand.
- `a2a serve` did not run the normal environment/config/default Runtime
  provider and provider-compatible model selection.
- The Markdown loader supported model and effort but omitted the already
  supported `AgentContent.provider` field.
- Integration tests configured only a bare command and therefore did not
  reproduce the real root/subcommand collision.

#### Resolution

Affected actions now merge accepted global and local options explicitly, with
the selected command's values authoritative, without changing Commander's
existing option-position compatibility. Parsed command identity, rather than
raw argument position, prevents subcommand fallthrough. `a2a serve` now applies
the same CLI/environment/config/default provider precedence and model-provider
compatibility rule as other hosted Runtime entry points. Markdown Agent
`provider` is trimmed, validated, admitted, discoverable, and passed to local
Runtime runs; remote requests still cannot override provider or model.

#### Files Changed

- `src/cli_option_helpers.ts`
- `src/kodax_cli.ts`
- `src/integration-cli.ts`
- `packages/coding/src/construction/markdown-loader.ts`
- Related CLI, integration, Markdown loader, and Runtime binding tests

#### Tests Added

- Root/subcommand duplicate option positions and subcommand fallthrough
- A2A CLI, environment, config, model compatibility, and override precedence
- Markdown provider pass-through, discovery, validation, and Runtime binding

### 161: MCP complete discovery can exceed result capacity or trust malformed pagination/cache state

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

The progressive MCP catalog implementation can return a page larger than the
reported `toolResultCapacityTokens` when even one rendered capability does not
fit. At the provider boundary, structurally invalid cache files can prevent a
healthy live server from recovering, and invalid or cyclic MCP list pagination
can be accepted as complete or can keep discovery paging indefinitely.

#### Context

These failures affect `mcp_search` inventory/search results, first-use live
catalog validation, stale-cache fallback, and any MCP server whose list results
are paginated. They violate the feature's complete-or-explicitly-incomplete and
capacity-bounded contracts.

#### Root Cause

- Capacity fitting returned the one-item candidate without checking whether it
  actually fit.
- Cache loading trusted TypeScript casts instead of validating the two persisted
  catalog files as one coherent snapshot.
- MCP list parsing treated malformed payloads as empty lists and did not reject
  repeated cursors or duplicate capabilities across pages.
- A successful live refresh was marked stale when only optional cache
  persistence failed.

#### Proposed Solution

Reject or explicitly report an unrenderable page without consuming an item;
validate cache structure and cross-file consistency; fail boundedly on malformed
or cyclic pagination while deduplicating stable capability ids; and keep live
catalog truth independent from best-effort cache persistence.

#### Resolution

Capacity fitting now returns a bounded no-consumption marker when even one item
cannot fit, and reports context exhaustion rather than an oversized item when
an empty result's metadata cannot fit. Search ranking uses complete-token
coverage as a dominant sort key.
List parsing rejects malformed containers, entries, identifiers, resource URIs,
explicit null or repeated cursors while deduplicating ids across pages. A
`list_changed` notification received during pagination invalidates the in-flight
transaction instead of being overwritten by its result. Concurrent first-use
discovery calls share one refresh, and kind-filtered cursors use a revision scoped
to that filtered catalog. Cache reads validate
both files as one coherent snapshot, so corrupt state falls through to live
recovery. Live discovery remains complete when only best-effort cache
persistence fails; the error is emitted and retained in diagnostics. Inventory
and ranked results both mark provider data as untrusted.

#### Files Changed

- `packages/agent/src/capabilities/mcp/catalog.ts`
- `packages/agent/src/capabilities/mcp/runtime.ts`
- `packages/agent/src/capabilities/mcp/catalog.test.ts`
- `packages/agent/src/capabilities/mcp/runtime.test.ts`
- `packages/agent/src/capabilities/mcp/provider.test.ts`
- `packages/coding/src/tools/mcp-search.ts`
- `packages/coding/src/tools/mcp-tools.test.ts`
- `docs/features/v0.8.5.md`
- `docs/test-guides/FEATURE_035_v0.7.70_TEST_GUIDE.md`

#### Tests Added

- Single-item capacity overflow, empty-result exhaustion, and no-consumption behavior.
- Long-query complete-token ranking dominance.
- Malformed list shape/entry/id/URI rejection, repeated-cursor rejection, and
  explicit-null cursor rejection, cross-page id deduplication, and in-flight
  `list_changed` invalidation.
- Corrupt-cache live recovery and cache-write-failure live truth.
- Concurrent discovery coalescing and kind-scoped catalog revisions.
- Untrusted-data labeling on inventory output.

### 160: Shared-daemon rollback omits reverse-bridge mutations and daemon-owned background work

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

The revisioned daemon-to-inline rollback fence did not classify credential and
Host Tool register/revoke/completion requests as draining-sensitive mutations.
Those requests could still alter reverse-bridge state after rollback draining
began. Stop preflight also ignored non-terminal Workflow and External Agent
tasks, so `canStop` could be true while daemon-owned background work remained.

#### Root Cause

The protocol mutation classifier was reused as the management draining fence
but omitted reverse-bridge control methods. Runtime preflight projected only
ordinary runs and pending interactions, while management revision observed
ordinary Runtime events rather than every daemon-owned background lifecycle.

#### Proposed Solution

Fence all reverse-bridge state changes without persisting credentials, expose
active Workflow and AgentTask state in typed preflight, fail closed on active or
uncertain work, and make rollback CAS observe background lifecycle changes.
Add race tests that mutate each state after inspection and require `conflict`.

#### Resolution

Reverse-bridge register/revoke/supply/completion requests now use a dedicated
draining-sensitive classifier. This keeps them inside the atomic stop fence
without adding credential or Host Tool result frames to the durable operation
journal. Typed preflight now exposes active Workflows and AgentTasks, treats
unknown/future non-terminal states conservatively, and reports dedicated
blockers. Management fingerprints each authoritative preflight projection, so
background lifecycle changes advance the rollback revision even when they do
not emit a normal Runtime event.

#### Files Changed

- `src/runtime-daemon/protocol.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-daemon/management.ts`
- `src/sdk-runtime.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/features/v0.7.70.md`
- `docs/test-guides/ISSUE_F269_v0.7.70_REGRESSION_GUIDE.md`

#### Tests Added

- All six credential/Host Tool state-changing methods are rejected by the
  management fence during draining while remaining outside durable operations.
- Running/paused Workflow and non-terminal/unknown AgentTask states block stop
  and clear only after reaching terminal states.
- A background lifecycle change after management inspection advances revision
  and rejects the stale rollback without changing owner policy.

### 159: Windows process cleanup can lose descendants when `taskkill /t` fails under load

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.67
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.69

#### Original Problem

Windows subprocess cleanup treated completion of `taskkill /t` as if the tree
had been terminated, even when the command timed out or exited non-zero. The
fallback then depended on CIM/WMIC parent queries, which can themselves fail
under the same management-service load. A surviving descendant could therefore
outlive its direct parent and accumulate across release-test runs.

#### Root Cause

The helper discarded the `taskkill` exit status and had no native parent graph
that was independent of Windows management services. The agent runtime and LLM
CLI-event copies repeated the same assumption.

#### Resolution

`taskkill` now reports success explicitly. When it does not finish successfully,
cleanup captures the process parent graph with Toolhelp32 through a bounded,
non-interactive PowerShell helper before directly terminating the root. The
existing CIM/WMIC path remains a compatibility fallback only. Descendants are
then terminated leaf-first and the helper waits for the complete target set.
Both production copies use the same escalation contract.

#### Files Changed

- `packages/agent/src/runtime/process-tree.ts`
- `packages/agent/src/runtime/process-tree.test.ts`
- `packages/llm/src/cli-events/process-tree.ts`
- `docs/test-guides/ISSUE_159_v0.7.69_REGRESSION_GUIDE.md`

#### Tests Added

- A Windows-only integration regression starts a real parent and nested Node
  child, invokes process-tree cleanup, and verifies the descendant exits.

### 158: Post-hoc output/history loss hides evidence and can increase end-to-end token use

- **Priority**: High
- **Status**: **Resolved** (reopened and corrected after implementation review)
- **Introduced**: v0.7.61
- **Created**: 2026-07-14
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.69

#### Original Problem

FEATURE_251 applied command-aware lossy filters and fixed per-tool truncation
before the model's next request. In a real `git log --stat` review, the Worker
received a compressed result, announced that it needed to read the raw artifact,
and performed that recovery read. The intended one-round token saving therefore
added a second tool-result cycle, while the first response no longer contained
all decision-relevant evidence. A separate malformed `git log --format` command
was also rerun in the trace, but that rerun is not attributed to compression.

The same failure mode existed beyond Bash: fixed caps or shortened fields in
`grep`, `glob`, `code_search`, retrieval rendering, long-line `read`, completed
`task_output`, and independently guarded SA/AMA dispatch paths could omit data
before the system knew whether the complete result fit the real context window.
The old 32 KiB / 600-line threshold was an empirical preview size, not a valid
model-capacity boundary.

The audit found the same policy error in history compaction. Default
microcompaction could clear ordinary tool results below physical capacity, and
the semantic compactor could prune tool results or crop user messages before
asking the summary model. Static trigger/target percentages ignored the final
provider system prompt, tool schema, output reserve, and fixed request overhead.
Those operations could discard exact evidence when the next request still fit.

#### Root Cause

- A local `never_worse` comparison optimized only the current string; it did
  not price recovery calls, an extra inference round, or evidence loss.
- Bash semantic filters ran transparently after execution, so the model could
  not choose a task-preserving projection before producing the data.
- Multiple layers owned truncation independently: Bash, retrieval helpers,
  bridge dispatch, and the AMA Runner. Their fixed byte/line caps ignored the
  aggregate tool-result batch and the physical next-request capacity.
- History compaction treated a percentage of the advertised context window as
  the decision boundary and used destructive pre-summary/fallback pruning. It
  did not stop as soon as the final physical provider request fit.
- The 512 KiB Bash capture constant was an irreversible tail cap rather than a
  memory-to-disk transition. Long lines also lacked an exact continuation
  coordinate.
- Anthropic cache-read/write tokens were included in total input and then
  charged again, distorting the cost signal used to assess the optimization.

#### Evidence

The evidence is one captured production-shaped review, not a population
benchmark:

- Session: `C:\Users\iceto\.kodax\sessions\c-works-gitworks-kodax-author-kodax-66910f2fd8\20260714_174750.jsonl`
- Raw artifact: `C:\Users\iceto\.kodax\tool-results\2026-07-14T09-52-03-904Z-KodaX-bash-output-raw-6qsktp.txt`

The first `git log v0.7.68..HEAD --oneline --stat` result was replaced with
`[git log summarized: showing 30 of 207 lines]`. The Worker then said it needed
the complete raw output and read the 12,577-byte artifact. It also repaired and
reran a separate `%`-escaping-broken `git log --format` command. This establishes
one recovery read and its additional tool-result cycle after automatic lossy
filtering; it does not establish that compression caused the format-command
rerun. It also does **not** establish a recovery frequency, percentage token
penalty, or break-even rate; earlier percentage claims had no supporting sample
set and were removed.

#### Reopened Review Findings (2026-07-15)

The first corrective implementation established the intended aggregate-capacity
direction, but review found unresolved correctness and resource regressions:

- untrusted tool text could forge the internal incomplete-result marker and a
  recovery path;
- batch-capacity failures did not carry a recoverable transcript and could save
  an empty authoritative session;
- AMA observers and the stall sidecar consumed raw results before batch
  admission;
- child evidence and removed acquisition/concurrency limits bypassed the
  next-request capacity owner;
- Bash spool finalization still materialized the complete output in memory, and
  generic ANSI removal was not contract-equivalent;
- public compatibility, reference-aware artifact cleanup, and documentation
  claims were incomplete.

#### Final Resolution After Review

- Incomplete-result idempotence now requires trusted structured `outputPath`
  metadata. Raw tool text containing a forged marker is treated as ordinary
  content and, when necessary, receives a new canonical artifact.
- SA and AMA capacity failures attach the last legal transcript; empty error
  carriers cannot overwrite a valid stored session. AMA result observers and
  stall-sidecar inputs fire only after batch admission.
- Child evidence is admitted against the actual routed provider/model initial
  request, including system prompt and active tool schemas. Acquisition work is
  bounded without silent loss: grep/code-search return `scan_offset` after 512
  candidates, and changed-diff bundles reject more than 64 unique paths while
  running Git subprocesses four at a time.
- ANSI normalization strips SGR styling and terminal metadata but preserves
  cursor-control sequences it cannot render losslessly. Bash tracks total bytes,
  releases raw buffers after decode, avoids a redundant spool copy, and directly
  seals a recovery artifact only when the cl100k token-byte upper bound proves
  the output cannot fit the active request. Its canonical manifest path is
  propagated as trusted tool-call metadata on both SA and AMA paths, and the
  terminal marker remains last so final admission reuses rather than nests it.
- Bash spools now live under the managed tool-results directory. REPL session
  startup scans active and archived JSONL references and removes only old,
  unreferenced artifacts; reference discovery failure performs no deletion.
- Legacy public budget builders/clamps were restored for SDK source
  compatibility. Internal admission still consumes only the fixed-point
  aggregate token capacity, so the compatibility surface is not a second owner.

#### Initial Resolution (incomplete; retained for audit history)

- Tool handlers now capture and return complete results. Bash keeps output from
  the first byte and changes from memory to a temporary spool at 512 KiB; that
  value is no longer an output limit. Completed background tasks return their
  full terminal output.
- Default Bash processing is limited to contract-equivalent terminal
  normalization. Command-specific compiled/declarative lossy filters remain
  available only for explicit use and are not selected by the default registry;
  compound commands receive no semantic adapter.
- One aggregate batch owner now decides delivery after every tool call in the
  batch settles. If the complete batch fits the actual next-request budget, it
  is delivered unchanged. Only overflow of the final operational budget
  (physical request, output reserve, and estimation safety) persists the
  complete value and emits one idempotent `KODAX_RESULT_INCOMPLETE` preview. An
  unrepresentable minimum marker fails explicitly instead of overfilling the
  request.
- Capacity first solves the largest final input `Pmax` satisfying
  `Pmax + providerReservedOutputTokens + max(2048, ceil(Pmax * 3%)) <=
  contextWindow`, then admits at most `Cbatch = max(0, Pmax -
  currentPhysicalRequestTokens)`. Computing the margin from the smaller
  pre-batch request is incorrect. Cache tokens remain part of physical context
  occupancy. The margin is an uncertainty guardrail, not a token-saving claim,
  and must be calibrated against estimate-vs-actual/recovery evidence rather
  than copied into per-tool caps.
- `read` has exact Unicode-safe `line_offset` continuation. Hidden result caps
  were removed from `grep`, `glob`, `code_search`, and retrieval rendering;
  unreadable or acquisition-limited sources carry `SOURCE_INCOMPLETE`. Local
  and provider code search, semantic lookup, keyword tool search, MCP search,
  web search, read, and grep use a true one-extra-item probe before claiming a
  limit was reached. Invalid negative `grep.head_limit` is rejected rather than
  becoming `0=unlimited`.
- Public guards without physical-capacity context are pass-through. MCP keeps
  genuinely distinct text/structured channels (including the fallback path)
  without duplicating an ordinary
  resource body into both, and rejects incomplete pagination instead of caching
  partial pages. Explicit search limits probe one extra item so the limit marker
  is truthful. Exact self-knowledge topics return full content. Bash cancellation
  first waits a bounded interval for process-tree termination and stream closure.
  If close is delayed, capture ownership moves to live recovery artifacts and
  the result exposes `KODAX_CAPTURE_INCOMPLETE`; only the later
  `KODAX_CAPTURE_COMPLETE` footer proves drain completion. A spool-read failure
  emits the same incomplete contract and a recovery locator instead of hanging
  or pretending completion. Live/paged/acquisition-limited results remain
  allowed only when their incompleteness and continuation contract are explicit.
- Hidden preview caps were also removed from changed-diff bundles, inline edit
  receipts, relationship supplemental evidence, exact tool selection, child
  evidence refs, and child completion envelopes. Their explicit schema limits
  remain valid query contracts; aggregate delivery belongs to the next-request
  batch/envelope capacity owner.
- Cache cost now splits uncached input, cache read, and cache write tokens and
  charges each token exactly once.
- Physical fallback accounting uses the final system prompt exactly once,
  includes active tool schemas and same-request synthetic recovery messages,
  and remains available when a provider omits usage. Provider-reported usage,
  when valid, remains authoritative. The misleading pre-batch
  instantaneous-slack behavior is not used internally; append capacity has one
  fixed-point implementation. Legacy snapshot/byte helpers remain exported only
  for SDK source compatibility.
- Recovery artifacts are canonical evidence for resumable sessions and are not
  deleted by an age-only TTL. REPL session startup performs reference-aware GC
  over active and archived JSONL, deleting only old unreferenced artifacts and
  failing closed if references cannot be discovered. The legacy age-only helper
  remains an explicit host/operator compatibility action. REPL
  startup likewise no longer deletes 24-hour-old pasted images referenced by
  session messages. The explicitly transient managed-task checkpoint window is
  measured from its latest successful write, not the task's original creation.
- Automatic history compaction now uses the same physical-capacity invariant.
  Default microcompaction and destructive graceful pruning are disabled.
  Below capacity, history remains exact; at actual pressure, semantic summary
  is attempted first over complete atomic message/tool pairs and stops when the
  next physical request fits. A failed, empty, or insufficient summary leaves
  canonical history unchanged and raises a typed capacity error instead of
  silently deleting messages. The immutable leading Worker system prompt is
  retained byte-for-byte; invalid summaries consume no source chunk, and hard
  capacity errors carry the latest recoverable transcript for persistence.
- The default automatic trigger is capacity-only. A static trigger below 100%
  is an explicit opt-in policy, and manual `/compact` remains an explicit force
  operation; neither is presented as guaranteed token optimization.

The two history-compaction bullets above record the `v0.7.69` closure state.
FEATURE_272 (`v0.7.74`) supersedes only that large-compaction trigger policy:
automatic large compaction is now always enabled with the percentage/absolute/
physical minimum described by Issue 192. The tool-result, microcompaction, and
artifact-recovery conclusions of this issue remain current.

#### Files Changed

- `packages/coding/src/tools/bash.ts`, `bash-output-collector.ts`,
  `output-filters/`, `read.ts`, `grep.ts`, `glob.ts`, `code-search.ts`,
  `semantic-lookup.ts`, `retrieval.ts`, `web-fetch.ts`, `web-search.ts`,
  `task-output.ts`
- `packages/coding/src/tools/mcp-call.ts`, `mcp-read-resource.ts`,
  `mcp-get-prompt.ts`, `packages/coding/src/self-knowledge/resolver.ts`
- `packages/coding/src/tools/changed-diff.ts`, `edit.ts`, `tool-search.ts`,
  `relationship-scan.ts`, `envelope-budget.ts`,
  `packages/coding/src/child-executor.ts`
- `packages/coding/src/tools/tool-result-budget.ts`, `tool-result-policy.ts`
- `packages/coding/src/tools/tool-output-gc.ts`,
  `packages/repl/src/session/public-api.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/_internal/managed-task/checkpoint.ts`
- `packages/agent/src/context-capacity.ts`, `primitives/runner.ts`,
  `primitives/runner-tool-loop.ts`, `capabilities/mcp/runtime.ts`,
  `session-lineage/compaction/`
- `packages/coding/src/compaction-config.ts`,
  `agent-runtime/middleware/compaction-orchestration.ts`,
  `task-engine/_internal/managed-task/compaction.ts`
- `packages/llm/src/cost-rates.ts`, `cost-tracker.ts`
- `packages/repl/src/interactive/repl.ts`, `ui/InkREPL.tsx`

#### Tests Added

- Raw Bash fidelity for git/test/JSON/compound commands, OSC 8 URLs, and
  stdout/stderr larger than 512 KiB.
- Aggregate fit/spill behavior, one-marker idempotence, SA/AMA parity, and
  explicit minimum-marker capacity failure.
- Forged marker rejection, recovery-transcript persistence, post-admission AMA
  observation, routed child-briefing capacity, bounded acquisition continuation,
  Bash guaranteed-oversize artifacts, semantic ANSI preservation, public budget
  compatibility, and reference-aware artifact retention.
- Exact long-line continuation, complete terminal task output, and removal of
  hidden grep/glob/code-search/retrieval caps.
- N/N+1 boundaries for semantic/code/tool/MCP/web search and grep; MCP direct
  and fallback channel fidelity; delayed Bash drain recovery; pasted-image and
  long-task checkpoint retention.
- Source-incomplete diagnostics for unreadable files and bounded network
  acquisition, plus cache read/write single-charge accounting.
- Capacity-only history triggers, default microcompaction no-op, summary-first
  compaction, preserved atomic tool pairs/fixed overhead, and typed failure
  without mutation when no recoverable compacted request can fit.

#### Design Record

The corrective decision and regression matrix are recorded in ADR-050,
`docs/features/v0.7.61.md`, and
`docs/test-guides/FEATURE_251_v0.7.61_TEST_GUIDE.md`.

### 157: F267/F269 review found durability, network, concurrency, and diagnostic gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.69 RC
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

An external review reported 25 possible defects across the shared Runtime
daemon, A2A transport, governed memory, and SDK documentation. Reproduction and
source-to-sink validation confirmed that daemon state and owner locks were not
fsynced; A2A streams could remain blocked after idle/dispose; blocking A2A calls
had no wait bound; request handling could mix hot configurations; default A2A
fetch validated and connected through separate DNS resolutions; concurrent
memory forgets restored deleted index entries; expired credential leases and
malformed stale learning locks were retained or reclaimed unsafely; and corrupt
best-effort records were skipped without internal diagnostics.

#### Root Cause

- Two new daemon files did not reuse the existing `0600` plus fsync pattern.
- Streaming and blocking A2A paths lacked explicit lifecycle bounds, and hot
  options were read repeatedly across asynchronous request steps.
- URL policy validation preceded a second resolver inside global `fetch`.
- Memory index mutation occurred outside the lifecycle lock with a direct
  read-modify-write, while malformed locks were treated as provably abandoned.
- Best-effort public APIs preserved availability but did not emit a redacted
  diagnostic when they skipped invalid persisted input.

#### Resolution

Daemon state staging and owner locks now use `0600` file descriptors and fsync
before publication. A2A event streams have connection/idle aborts tied to
executor disposal, blocking calls return the current task after a configurable
wait, each request and its run capture one hot-options snapshot, and the default
HTTP(S) transport pins the validated address while retaining the hostname for
Host/TLS verification. Memory forget now serializes file removal, atomic index
replacement, and tombstone update under the lifecycle lock. Expired credential
leases are pruned on registration, malformed stale locks fail closed, and
invalid review/session records plus A2A fallback/recovery failures emit redacted
diagnostics without changing their public fail-soft result.
Windows lock probes also treat transient `EPERM`/`EACCES`/`EBUSY` during
concurrent removal as non-stale and retry instead of reclaiming ownership or
leaking the raw filesystem race.
Root-level static validation also exposes the server's implemented
`whenReady()` method, returns a structurally narrowed DNS address, and derives
safe request-body input from `RequestInit` instead of an unavailable DOM-only
type name.

#### Files Changed

- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/reverse-bridge.ts`
- `src/a2a/client-executor.ts`, `safe-fetch.ts`, `server.ts`, `types.ts`, `config.ts`
- `packages/agent/src/memory-control/lifecycle.ts`, `review-inbox.ts`
- `packages/agent/src/learning/store.ts`
- `packages/repl/src/session/public-api.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`, `docs/features/v0.7.69.md`

#### Tests Added

- File-descriptor fsync and restrictive daemon-file modes.
- Stream disposal/idle abort, bounded blocking waits, and hot-option snapshots.
- DNS address pinning against a hostname unavailable to the system resolver.
- Root `tsc --noEmit` plus safe-fetch and server readiness/hot-option tests.
- Concurrent direct lifecycle forgets, malformed stale locks, lease renewal,
  and diagnostics for invalid persisted records.

#### Review Disposition

The remaining report items were not changed when they described intentional
fail-closed behavior, documented sandbox limits, bounded synchronous storage,
or lifecycle ownership: credential errors are already normalized before public
serialization; no-code A2A is explicitly single-principal; daemon startup and
ownership timers intentionally keep work alive; transport close intentionally
rejects pending RPCs; socket `EADDRINUSE` remains authoritative; detached daemon
survival is required; PowerShell aliases and symlinks are rejected/skipped
fail-closed; and the memory shell guard's process-isolation limit is already
recorded under Issue 153.

### 156: Bare `kodax -r` repeatedly full-reads large session sets before opening the picker

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

Opening bare `kodax -r` becomes noticeably slow as the session store grows.
On a real Windows store containing 1174 session files and about 221 MB of data,
the picker waited roughly 13.8 seconds before becoming interactive.

#### Root Cause

The CLI requested up to 1000 sessions in pages of 100. Every project-scoped
cursor request entered the general `listSessions` path, which traversed the
session tree, read every candidate JSONL file in full, sorted the complete set,
and only then sliced one page. Up to ten pages therefore repeated the same
directory scan and transcript reads.

#### Resolution

The picker now requests its bounded 1000-session dataset in one pass. The
general list path reads only the metadata first line for modern sessions, in
batches of 48, and falls back to a full read only for legacy metadata that lacks
`activeMessageCount` or for a pathological metadata line over 64 KiB. It still
scans project aliases so old sessions are not hidden.

On the same 755 matching sessions, the published v0.7.68 path took about
13.8 seconds. The worktree source completed in about 0.47 seconds and the
publish-shaped bundle in about 0.77 seconds, while returning the same 755 IDs.

#### Files Changed

- `src/kodax_cli.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/session/public-api.test.ts`
- `tests/kodax_cli.test.ts`

#### Tests Added

- Project-scoped listing must not full-read a modern session transcript.
- The CLI resume picker dataset must be loaded with one bounded list pass.
- Real-store source and publish-bundle timings retain the complete result set.

### 155: Bare `kodax -r` exits after selection during the picker-to-TUI handoff

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

Running bare `kodax -r` opens the searchable session picker and allows normal
keyboard navigation, but pressing Enter briefly opens the main KodaX UI and
then exits the process before the resumed transcript is rendered. The failure
reproduces for both new and old sessions. Resuming the same session with
`kodax -r <session-id>` works because that path bypasses the picker.

#### Root Cause

The picker uses the external Ink renderer while the main KodaX UI uses the
project-owned renderer. External Ink releases raw input ownership on picker
unmount by calling `process.stdin.unref()`. The owned renderer then enables raw
mode and attaches its data listener, but it does not restore the stream
reference. With no referenced event-loop handle left, its `beforeExit` handler
immediately unmounts the newly rendered main UI.

#### Proposed Solution

Use the project-owned renderer for the session picker too, keeping input
ownership inside one renderer lifecycle. Add a regression that exercises the
Enter-to-resumed-UI transition, not only picker filtering and static rendering.
Keep direct ID/title resume and Escape/Ctrl+C cancellation behavior unchanged.

#### Resolution

`SessionPicker` now imports `render`, `useApp`, and `useInput` from KodaX's
owned TUI facade. Picker selection and the resumed REPL therefore share one
input-ownership model and no external Ink teardown can unref stdin between the
two surfaces.

#### Workaround

List sessions with `kodax -s list`, then resume explicitly with
`kodax -r <session-id>`. `kodax -c` also remains available for the most recent
session.

#### Affected Files

- `packages/repl/src/ui/SessionPicker.tsx`
- `packages/repl/src/ui/SessionPicker.test.tsx`

#### Test Gap

The v0.7.68 tests verify filtering, paging, hints, and static rendering, but do
not start a second interactive renderer after the picker exits. The human guide
contains the expected Enter-resume behavior, but it was not enforced by an
automated lifecycle test.

#### Tests Added

- A simulated TTY renders the picker through the owned renderer, sends Enter,
  and verifies that the highlighted session is selected through that lifecycle.
- Existing filtering, paging, rendering, and terminal-input controller tests
  remain green.

### 154: FEATURE_267/268 review found remote execution and hot-reload reliability gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.69 RC
- **Created**: 2026-07-13
- **Resolved**: 2026-07-13
- **Fixed**: v0.7.69

#### Original Problem

Joint review found that inbound A2A tool execution could wait for an interactive
permission response after its deployment guardrail had already authorized the
call; lexical workspace checks allowed a symlink/Junction to escape; and the
no-code CLI returned the initial submitted A2A task instead of following it to a
stable state. F268 replacement also treated a failed MCP prewarm as usable,
could reject after a successful provider swap when old cleanup failed, and
copied subscriber/watch exceptions into user-visible diagnostics.

#### Root Cause

- The remote Runtime binding supplied neither a headless permission decision nor
  a permission-mode default.
- Workspace containment used `path.resolve` without resolving the existing
  target or nearest existing parent.
- `a2a call` sent one JSON-RPC request outside the F258 task lifecycle.
- MCP prewarm deliberately used fail-soft startup semantics for replacement too.
- Provider swap and old-instance disposal shared one rejection result, while the
  config controller classified validation and activation in one catch block.

#### Proposed Solution

Add failing regression tests first, then keep the pinned guardrail as the remote
authority while supplying deterministic headless approval, add real-path
containment, route CLI calls through F258, make replacement prewarm strict, and
separate swap success from cleanup diagnostics. Never expose raw activation or
watcher exceptions.

#### Resolution

The Runtime binding now checks lexical plus real containment for existing and
future targets and proceeds without interactive approval only after its pinned
guardrail. The CLI discovers an `external:<name>` registration, starts it on the
F258 plane, and waits through submitted/working states. MCP replacement rejects
and disposes a broken candidate while retaining the previous provider. Failed
old-provider cleanup records a generic `dispose` diagnostic without rolling back
the new instance or poisoning later shutdown. Integration validation,
activation, and watcher degradation now have distinct generic diagnostics.

#### Files Changed

- `src/runtime-agent-binding.ts`
- `src/integration-cli.ts`
- `packages/agent/src/capabilities/mcp/provider.ts`
- `packages/coding/src/capabilities/providers/mcp-adapter.ts`
- `packages/coding/src/extensions/runtime.ts`
- `packages/repl/src/common/integration-config.ts`

#### Tests Added

- Existing and future targets below a symlink/Junction are denied.
- Headless remote calls do not enter the interactive permission wait.
- CLI polling observes submitted, working, and completed A2A states.
- Broken MCP candidates retain the active provider.
- Cleanup failures retain the replacement and redact secret/path canaries.
- Activation diagnostics retain the prior snapshot and redact exception data.

#### Remaining Risk

Real-path validation is defense in depth against stable links; ASRT or an outer
container/VM remains the process-isolation boundary for admitted scripts and
hostile tenants. Independent A2A TCK/client evidence, POSIX release validation,
and a provisioned Windows ASRT run remain release gates rather than code gaps.

### 153: FEATURE_260 post-release review found memory guard bypass and persistence isolation gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-12
- **Resolved**: 2026-07-12
- **Fixed**: v0.7.69

#### Original Problem

Post-release adversarial review showed that the governed-memory shell guard can
be bypassed by chaining a permitted read with an interpreter write, or by using
home-relative and environment-relative paths. Separately, malformed approval
metadata can be dropped without a warning and allow a later proposal write to
replace the remaining store; a review drain without `projectId` can claim
project-owned work; and stale lock recovery can remove a successor owner's lock.

Expected behavior is fail-closed protection of governed memory at the Bash tool
boundary, fail-loud preservation of corrupt proposal stores, exact project
ownership during drains, and owner-checked release of recovered file locks.

#### Root Cause

- The shell guard recognizes literal configured roots but treats any command
  beginning with a read verb as read-only, even when later commands mutate.
- Five approval fields return an invalid proposal without appending a warning.
- Missing drain filters behave as wildcards for project-owned entries.
- Lock files contain no owner token and are removed unconditionally by path.

#### Proposed Solution

Add failing boundary tests first, then enforce single read-only shell commands,
warn on every invalid stored field, make project-less drains defer project-owned
reviews, and release locks only when their owner token still matches. Preserve
tenant-wide listing, legitimate read-only inspection, and normal project-scoped
drains.

#### Resolution

The Bash guard now recognizes scoped and legacy memory paths in absolute,
home-relative, and environment-relative forms, and permits only a single simple
read-only inspection when governed memory is addressed. Every invalid approval
field now emits a warning, so proposal writes refuse to replace a corrupt store.
Project-less drains defer project-owned reviews while retaining tenant-wide list
and project-less owner behavior. Proposal and lifecycle locks now persist PID and
random owner tokens, check process liveness before stale recovery, and remove a
lock only when the releasing token still owns it. Lifecycle state writes and
review inbox writes also use cleaned-up atomic temporary files, and persisted
outcome evidence receives complete runtime shape validation.

#### Files Changed

- `packages/coding/src/tools/memory-mutation-guard.ts`
- `packages/agent/src/learning/store.ts`
- `packages/agent/src/memory-control/review-inbox.ts`
- `packages/agent/src/memory-control/lifecycle.ts`

#### Tests Added

- Chained, piped, home-relative, environment-relative, and legacy memory shell paths.
- All five approval metadata corruption fields plus fail-closed rewrite preservation.
- Project-owned versus project-less review drain ownership.
- Successor lock token preservation and malformed outcome evidence rejection.

#### Remaining Risk

The Bash check is deterministic defense-in-depth for commands that directly
address recognized governed-memory paths. It is not an OS filesystem sandbox:
an intentionally obfuscated program can construct a path without including the
protected literal in its command text. Preventing that broader same-user process
authority requires process-level filesystem isolation or a privileged memory
writer boundary, which is outside this minimal patch.

### 152: FEATURE_260 review found credential, mutation-guard, concurrent persistence, and eval-integrity gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.68)
- **Introduced**: v0.7.68 release candidate
- **Created**: 2026-07-12
- **Resolved**: 2026-07-12
- **Fixed**: v0.7.68

#### Original Problem

The post-implementation FEATURE_260 review found five release-integrity gaps:
raw Git remotes could retain embedded HTTP credentials in project identity and
legacy storage paths; structured and shell memory guards were case-sensitive or
allowed interpreter-based mutation; concurrent inbox drains could review one
episode twice while proposal/lifecycle read-modify-write operations lost sibling
updates; the eval manifest omitted untracked candidate files; and malformed raw
eval JSON was silently treated as a missing cache cell.

The final routing result remained valid for policy behavior, but these gaps made
the current working tree unsafe to publish as-is and weakened its audit trail.

#### Root Cause

- Repository identity reused `remote.origin.url` before canonical redaction.
- Mutation protection relied on `.md` suffixes and a mutating-command allowlist.
- Shared JSON stores and episode drains had atomic writes but no serialization or
  atomic work claim.
- Eval provenance hashed only `git diff HEAD`, which excludes untracked files.
- Cache recovery grouped `SyntaxError` with `ENOENT`, allowing regeneration.

#### Resolution

Repository identities now canonicalize HTTPS/SSH remotes without userinfo,
query strings, or raw fallback bytes. Managed-path checks are Windows-safe and
protect governance sidecars; shell commands that address a managed root are
fail-closed except for a narrow read-only inspection set. Pending reviews move
atomically into a processing claim with stale-claim recovery, and proposal plus
lifecycle stores serialize cross-process read-modify-write sections with bounded
stale locks. The eval manifest schema now binds tracked submodule-aware diffs and
untracked file path/content hashes. Malformed cache JSON fails loudly, and the
summary declares the main-session review as a separate artifact rather than a
permanently pending field.

The post-review documentation pass also split governed memory out of the legacy
sessions manual topic, added all-command drift coverage for `kodax_manual`, and
documented direct `/experimental-memory` SDK ownership and safety boundaries.

#### Files Changed

- `packages/coding/src/memory-runtime.ts`
- `packages/coding/src/tools/memory-mutation-guard.ts`
- `packages/agent/src/memory/paths.ts`
- `packages/agent/src/memory-control/review-inbox.ts`
- `packages/agent/src/memory-control/lifecycle.ts`
- `packages/agent/src/learning/store.ts`
- `benchmark/datasets/feature-260/experiment-contract.ts`
- `benchmark/datasets/feature-260/runner.ts`
- `packages/coding/src/self-knowledge/registry.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Tests Added

- Credential-bearing HTTPS and equivalent SSH repository identity.
- Windows path casing, interpreter shell mutation, and governance-sidecar guards.
- Concurrent review claim, proposal upsert, and lifecycle tombstone persistence.
- Untracked source-snapshot hashing and fail-loud malformed eval cache handling.
- Memory/manual query routing and full built-in-command drift coverage.

### 151: Runtime config tests leak detached daemon processes and interrupted background fixtures can survive

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Windows Task Manager showed many long-lived Node processes after KodaX test
runs. Process ownership/command-line inspection separated 26 Codex-owned MCP
servers from four real KodaX residues: three `config-*` daemon processes whose
test parents were gone, and one background command fixture whose test parent
had been forcibly terminated.

The daemon behavior itself is intentional: a process daemon survives client
detach and stops only through explicit shutdown. The defect is that
`sdk-runtime.config.test.ts` creates that persistent owner but only closes the
client before deleting its temporary home. Separately, infinite-loop child
fixtures assume Vitest always reaches `afterEach`; a forced runner timeout can
prevent cleanup.

#### Root Cause

- The config test treated client `close()` as daemon shutdown, contrary to the
  explicit daemon ownership contract.
- Long-running process fixtures had no parent-liveness watchdog for abnormal
  test-runner termination.
- Task Manager also groups Codex MCP servers under Node.js, which made the KodaX
  residue appear much larger than it was.

#### Proposed Solution

- Track the config test's daemon profile, explicitly request
  `runtime.shutdown`, and verify daemon state disappears before deleting the
  temporary home; keep an `afterEach` fallback for failed assertions.
- Make infinite background test fixtures exit when their original parent
  process no longer exists, without changing production background jobs.
- Document that daemon mode is persistent by design and provide the explicit
  `kodax daemon stop` cleanup command; do not kill unrelated Node/Codex MCP
  processes.

#### Resolution

The runtime config suite now records the exact daemon `homeDir + profile`, sends
an authenticated `runtime.shutdown`, waits until owner state disappears, and
keeps an `afterEach` fallback for assertion failures. Its regression run passed
3/3 with a before/after process diff of `NEW_NODE_PIDS=none`. Infinite child
fixtures in the Bash and managed-process suites now poll their original parent
and self-exit if a forcibly terminated test runner cannot reach normal cleanup.

A v0.7.68 full-suite follow-up exposed one remaining race: daemon state was
rewritten by truncating `daemon.json` in place, so a shutdown poll could observe
an empty/partial file as transiently missing and return before the subsequent
`stopping` state became readable. State updates now use a same-directory staging
file plus atomic rename. The config shutdown case passed three repeated runs,
and the final process/staging-file audit found no residue.

Five already-orphaned, command-line-verified KodaX test processes were stopped.
The 26 Node processes owned by the active `codex.exe` parent were identified as
Codex MCP servers and intentionally left untouched.

#### Files Changed

- `src/sdk-runtime.config.test.ts`
- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/state.test.ts`
- `packages/coding/src/tools/bash.test.ts`
- `packages/agent/src/runtime/managed-child-processes.test.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Tests Added or Hardened

- Auto-started config daemon state must disappear after explicit test shutdown.
- The daemon test run must leave no new Node PID after completion.
- State replacement is atomic and leaves no staging file behind.
- Long-lived process fixtures have an abnormal-parent-exit fallback while
  retaining normal managed cleanup assertions.

### 150: v0.7.67 外部 Agent 脚本路由与执行平面关闭契约存在发布阻断缺口

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Post-release review found that `WorkflowSpawnAgentInput.target` was present in
the public Agent type and consumed by the Workflow runtime, but the restricted
script host boundary silently omitted it. The same whitelist also omitted the
public `phase` field. Therefore a model-authored `run_workflow` script could not
route a child through FEATURE_258's shared dispatchable-agent catalog even
though direct/built-in Workflow calls could.

The same review found deterministic lifecycle gaps in the executor plane:
`close()` disposed executors without settling pending `tasks.wait()` promises,
and every registration/catalog/task method remained callable after close.
Adjacent trust-boundary hardening gaps affected scoped-review structured values,
Feature 259 baseline reconstruction, and non-authoritative local-ledger updates.

#### Context

- Affected components: restricted Workflow script RPC, external Agent executor
  plane lifecycle, built-in scoped review, Feature 259 eval contract, local task
  ledger mirroring.
- Reproduction: run a restricted script with
  `target: {agentId:'external:...'}` and inspect the `WorkflowApi.runAgent`
  input; start `tasks.wait(id)` without a timeout and close the plane.
- Expected: every public spawn field crosses the script boundary with validation;
  close is terminal and settles pending waits; ancillary validation/ledger
  failures cannot silently corrupt authoritative results.

#### Root Cause

The restricted-script whitelist was updated for Feature 259 briefing fields but
not Feature 258's target or the existing phase field. The executor plane had no
closed state and modeled waiters as resolve-only callbacks. The remaining gaps
were local trust-boundary assumptions that lacked fail-loud assertions.

#### Proposed Solution

- Parse and validate `phase` and `target` at the restricted-script boundary.
- Make executor-plane close idempotent and terminal, reject all pending waiters,
  and reject all service calls after close.
- Validate built-in scoped-review structured values against their declared
  schemas.
- Make every Feature 259 baseline prompt rewrite required and byte-auditable.
- Keep local-ledger mirroring best-effort without replacing child results/errors.

#### Resolution

The v0.7.67 GitHub release and tag were withdrawn before npm publication. The
restricted script boundary now validates and forwards both `phase` and
`target`; malformed external targets fail before dispatch. Executor-plane
closure is idempotent and terminal, rejects every pending waiter, and rejects
all subsequent registration/catalog/task service calls. Scoped-review values
are checked against the declared schemas, Feature 259 baseline reconstruction
uses fail-loud exact replacements and no longer leaks proposed-only fields, and
local ledger mirror failures are diagnostic-only.

#### Files Changed

- `packages/agent/src/workflow/script-runner.ts`
- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/coding/src/workflows/builtin/scoped-review.ts`
- `packages/coding/src/tools/dispatch-child-tasks.ts`
- `benchmark/datasets/feature-259/cases.ts`

#### Tests Added

- Restricted scripts preserve `phase`, `target.agentId`, and configuration
  revision, while rejecting blank target IDs.
- Closing an executor plane rejects an unbounded waiter, rejects every service
  surface after close, and remains safe when called twice.
- Malformed scoped-review output fails with a schema diagnostic.
- Local ledger mirror failure cannot replace an authoritative child result.
- Frozen Feature 259 baselines exclude candidate-only briefing fields and the
  previously malformed schema fragment.

### 149: ACP tests persist empty sessions into the real user store

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.66 (`7dc5df52`, 2026-07-09)
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Running the ACP test suites created batches of empty, user-scope `ACP Session`
files in the real `~/.kodax/sessions` project bucket. These zero-message records
polluted KodaX and SDK-consumer history, statistics, and recent-session windows.
The affected machine accumulated 304 broad title/surface/message matches; 285
also met the stricter no-lineage/no-artifact/no-extension cleanup predicate.

#### Context

- Affected components: ACP server lifecycle, both ACP test harnesses, Runtime
  persistence home, session SDK list contract, CLI resume/list UX.
- Reproduction: run `tests/acp_server.test.ts` from v0.7.66 and inspect the
  current project's `~/.kodax/sessions` bucket.
- Expected: protocol handshakes and tests that never submit a prompt leave no
  durable user session or Runtime run evidence.

#### Root Cause

Commit `7dc5df52` added eager `runtime.sessions.create()` inside ACP
`newSession()`. The main integration harness did not inject storage; a later
optional injection covered only one test. The second ACP unit harness used an
isolated `sessionsDir` in one case but left Runtime persistence on a shared
home. `dispose()` correctly stopped runs but had no basis to delete already
persisted empty sessions.

#### Resolution

- ACP sessions remain provisional until the first valid prompt, which creates
  the Runtime session once and titles it from that prompt.
- Both ACP suites now use temporary session and Runtime homes; the integration
  harness fails immediately if a resolved path enters the real user state root.
- SDK and Runtime listing gained exact `surface` filtering and opaque cursor
  continuation, including Daemon schema parity.
- Bare `-r` now opens a searchable/paged TUI; `-s list` omits non-resumable
  zero-message entries.
- `-s cleanup-acp` performs a strict preview. The separately confirmed
  `--apply-session-cleanup` action archives matched records reversibly and is
  never run automatically.

#### Files Changed

- `src/acp_server.ts`
- `src/acp_server.test.ts`
- `tests/acp_server.test.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/ui/SessionPicker.tsx`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/schema.ts`
- `src/kodax_cli.ts`
- `src/acp_session_cleanup.ts`

#### Tests Added

- Provisional ACP session persistence and isolated storage/runtime-home guards.
- Session surface filtering and cursor continuation at public SDK and Runtime layers.
- Daemon protocol schema coverage for surface/cursor fields.
- Session picker filtering/paging render contracts and strict cleanup predicate tests.
- Full ACP integration regression: real-user pollution count remained unchanged.

### 148: FEATURE_258 外部任务在持久化失败、配置热更新和并发回调下可能失联或状态回退

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.67

#### Original Problem

FEATURE_258 review 发现四个相互关联的生命周期缺陷：远端 Start 已成功后若本地事件账本写入失败，任务会丢失远端句柄并错误落为 `failed`；registration 从旧 revision 更新后，在途任务无法继续 input/cancel/reconcile；慢 continuation 与终态事件并发时，旧快照可把 `completed` 覆盖回 `working`；Workflow external 分支忽略 `wait(..., { timeoutMs })`。

#### Context

- Components: external Agent executor plane、统一 task ledger、Workflow external adapter。
- Impact: 远端任务可能成为无法取消或恢复的孤儿任务，终态可能回退，Workflow 可能无限等待。
- Reproduction: fault-injection event store、registration 热更新、受控 continuation/event 并发，以及 input-required external Workflow timeout。

#### Root Cause

远端 Start 与其后的本地持久化共用同一个失败分支；后续控制根据当前 registration 而非任务启动时绑定的 executor 路由；异步调用完成后直接写回调用前捕获的快照；Workflow external wait 提前返回，绕过了 timeout 归一化和透传。

#### Resolution

- 远端引用返回后进入独立 accepted 阶段，后续账本异常保留引用并记为 `unknown`。
- 活动任务保存不可变 executor binding，registration 更新或删除不再重定向在途任务。
- 所有事件和远端 continuation/cancel/reconcile 回写通过任务级 mutation queue 读取最新快照，终态不再回退。
- Workflow external wait 校验并透传 `timeoutMs`。

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/executor-plane.test.ts`
- `packages/coding/src/workflows/agent-adapter.ts`
- `packages/coding/src/workflows/external-agent-adapter.test.ts`

#### Tests Added

- accepted Start 后账本失败仍保留远端句柄。
- registration revision 更新后旧任务仍可 continuation。
- completion 与 continuation 并发时终态保持单调。
- Workflow external wait 正确执行超时和参数校验。

### 147: GitHub Release 二进制归档遗漏 Runtime 与工具 Worker sidecar

- **Priority**: High
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.66 release candidate
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

`scripts/build-binary.mjs` 已将 `provider-capabilities.json`、
`semantic-worker.js`、`runtime-worker.js` 和
`constructed-handler-worker.js` 复制到每个 standalone binary 目录，运行时也按
`process.execPath` 从同目录加载这些文件；但 `.github/workflows/release.yml`
仍只把 executable 与 `builtin/` 放入 GitHub Release 压缩包。打 tag 后生成的下载版
会丢失 provider metadata、repo-intelligence Worker、Worker-hosted Runtime 和
constructed-handler Worker。

#### Context

- Components: standalone binary GitHub Release pipeline.
- Impact: npm 包不受影响，但 GitHub 下载的免 Node 版本会静默降级或无法启用
  v0.7.66 的 Worker Runtime / constructed handler 隔离能力。
- Reproduction: 对比 `dist/binary/<target>/` 的构建产物与 release workflow 的
  `Compress-Archive` / `tar` 输入清单。

#### Root Cause

新增 Worker sidecar 时只更新了 build/copy guard 和发布文档，没有同步历史 release
archive 白名单，也没有确定性测试锁定该白名单。

#### Resolution

- release workflow 在打包前逐项检查所有 sidecar，缺失时立即失败。
- Windows zip 与 Unix tar 清单都包含 provider metadata 和三个 Worker sidecar。
- GitHub Release notes 与 binary distribution 文档同步说明完整内容。

#### Files Changed

- `.github/workflows/release.yml`
- `docs/release.md`
- `tests/release-workflow.test.ts`

#### Tests Added

- `tests/release-workflow.test.ts` 解析真实 YAML，断言 `Package archive` 步骤包含
  四个运行时 sidecar；测试在修复前失败、修复后通过。

### 146: 图片路径粘贴处理失败时吞掉原始输入且无可见反馈

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.40 (FEATURE_134)
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

在 REPL 输入框粘贴以 `.png` 等图片扩展名结尾的路径时，FEATURE_134 会先消费原始粘贴事件并异步读取、解码图片。若文件不存在、不可读或图片处理失败，错误分支只发出默认不可见的 diagnostic，既不恢复原始路径，也不给用户可见反馈；用户看到的结果是粘贴内容静默消失。去掉扩展名最后一个字符后不会触发图片分支，因此可以按普通文本粘贴。

#### Context

- Components: `packages/repl/src/ui/utils/prompt-input-controller.ts`, `packages/repl/src/ui/components/InputPrompt.tsx`, `packages/repl/src/ui/InkREPL.tsx`.
- Impact: 图片路径粘贴失败会丢失当前输入，用户无法判断失败原因；有效图片粘贴不受影响。
- Workaround before fix: 先粘贴不完整扩展名，再手动输入最后一个字符。

#### Root Cause

`handleKey` 在扩展名匹配后立即把 paste 标记为 handled；`insertImageRefsFromPaste` 的 `outcome.kind === "error"` 分支只调用 `emitKodaXDiagnostic`。交互式 REPL 默认没有 diagnostic UI sink，且 diagnostics 不写历史，所以该错误既不可见也没有文本 fallback。

#### Resolution

- 图片路径处理失败时，以 `paste: false` 将原始粘贴内容恢复到当前输入框，避免再次触发图片识别。
- 通过局部 `onPasteFallback` 回调复用现有两秒 `ClipboardToastSurface`，显示 `Image paste failed; inserted as plain text.` 警告。
- Toast 只存在于 React 临时状态，不追加 history、不持久化，也不进入 LLM 上下文；技术 diagnostic 继续保留供调试使用。
- 有效图片仍转换为 `@<temporary-image-path>`，普通文本粘贴行为不变。

#### Files Changed

- `packages/repl/src/ui/utils/prompt-input-controller.ts`
- `packages/repl/src/ui/components/InputPrompt.tsx`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/InkREPL.tsx`

#### Tests Added

- `packages/repl/src/ui/utils/prompt-input-controller.test.ts`: 验证错误时恢复原路径、触发临时通知，且不提交、不写历史。
- Existing paste/InputPrompt/ClipboardToast regression suites remain green.

### 145: Runtime daemon / SDK 边界存在生命周期、事件、权限与协议一致性缺口

- **Priority**: High
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.64-v0.7.66 (FEATURE_254 / FEATURE_255)
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

对 v0.7.63 之后的 embedded runtime 与 local daemon 进行跨提交审查时，发现若干在单实例 happy path 中不明显、但会破坏多客户端和长生命周期宿主的边界缺口：首个 auto-start client 关闭会连带终止共享 daemon；持久化事件序号在 runtime 重建后回退；事件消费者异常会逃逸到生产者；活动 run 与会话历史变更缺少冲突保护；`permissionMode` 未真正约束 runtime 工具执行；CLI daemon REPL 会把含函数、`AbortSignal` 和进程内对象的 options 直接跨 JSON 发送；wire error、frame 大小、订阅建连竞态、artifact 路径和核心 schema 参数也缺少完整的边界处理。

#### Context

- Components: `src/sdk-runtime.ts`, `src/runtime-daemon/*`, CLI/ACP host adapters, diagnostic sink, LSP shutdown cleanup.
- Impact: daemon peer clients can unexpectedly断连；重连 replay 可漏事件；权限请求可能挂起或重复；失败结果在 socket client 侧退化为 `{}`；异常/畸形输入可跨越协议边界。
- Scope: 修复现有 FEATURE_254 / FEATURE_255 contract，不引入第二套 runtime 或假想配置层。

#### Resolution

- auto-start daemon host 与首个 SDK client 解耦；`close()` 只断开 client，显式 shutdown 才释放 host，peer client 在 owner 断开后继续可用。
- event sequence 从持久化 cursor / event log 恢复；listener 异常隔离；delta 继续全量 replay，但按 tick/阈值批量落盘并限制单 run 日志体积。
- active run 阻止 rewind / active-entry / compact；runtime permission policy、client broker、bridge meta-tool 单次授权和 protected-path 规则统一。
- `run.await` Error 增加 wire codec；frame/buffer 限制为 8 MiB；订阅早到事件缓冲；dispatcher 按方法 schema 校验 params/result。
- artifact create 校验可读普通文件与 256 MiB 上限；CLI daemon REPL 使用显式 JSON-safe DTO，桥接流式事件、权限和 abort。
- ACP 共用注入 session storage 根；diagnostic sink 支持非 LIFO restore；LSP managed-child 在 stdio close 后才注销。

#### Files Changed

- `src/sdk-runtime.ts`, `src/runtime-daemon/*`, `src/kodax_cli.ts`, `src/acp_server.ts`
- `packages/agent/src/diagnostics.ts`, `packages/agent/src/runtime/managed-child-processes.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`, `packages/coding/src/lsp/client.ts`
- `packages/repl/src/index.ts`, `packages/repl/src/interactive/*`, `packages/repl/src/ui/InkREPL.tsx`

#### Verification

- Runtime/daemon/host/ACP/LSP/diagnostic/bridge targeted suites passed.
- Root TypeScript check and package build passed.
- Full local suite reached 9,420 passed; its only codebase-owned failure was this tracker summary before the resolved count was updated. The other failure scanned the developer machine's mutable real-session corpus and is re-run under a clean CI-style home.

### 144: Worker misreads task_output block wait expiry as child-agent timeout and writes final report before children complete

- **Priority**: High
- **Status**: **Resolved** (v0.7.57)
- **Introduced**: v0.7.45 (FEATURE_177 `task_output`)
- **Created**: 2026-06-26
- **Resolved**: 2026-06-26
- **Fixed**: v0.7.57

#### Original Problem

When the Worker used `task_output({ block:true })` while child agents were still running, the bounded read window could expire after 30s and return:

```xml
<retrieval_status>timeout</retrieval_status>
<status>running</status>
```

The child agent itself was still healthy, but the `timeout` label made the Worker summarize pending children as "timed out". In review fan-out flows, this could cascade into the Worker writing a final-looking review/report before all dispatched children had produced their matching `<task-completed>` blocks.

#### Context

- Component: `task_output` child-progress snapshot tool.
- Affected flow: Worker-driven parallel review / audit / exploration with async child agents.
- User-visible symptom: transcript says child agents are "timed out" even though child activity continues, and the Worker appears to finish from partial evidence.

#### Root Cause

`task_output` overloaded `retrieval_status=timeout` to mean "the synchronous read window expired". In agent language, `timeout` strongly implies task failure or cancellation, especially when shown next to a still-running child. The Worker prompt also allowed terminal summary once plan items were complete without explicitly requiring every dispatched child to have returned `<task-completed>`.

#### Resolution

- Renamed the bounded read-window result from `timeout` to `wait_expired`.
- Added a result note clarifying that the child task has not timed out and callers must read the `status` field.
- Updated `task_output` schema wording so normal Worker usage is `task_output({task_id})` / `block:false`, and `timeout_ms` is documented as a read-window cap rather than child lifetime.
- Added Worker prompt guidance: pending children are not final evidence; while any dispatched child lacks a matching `<task-completed>` block, the Worker must idle-yield with a short waiting status rather than write a final report.
- **Added an anti-block-peek Worker rule** ("waiting is idle-yield, not a blocking peek"). The first real pilot run exposed a *second* failure mode the initial wording missed: after `wait_expired`, models escalated to `task_output(block:true, timeout_ms:120000)` to "wait harder" — freezing the turn instead of idle-yielding. The rule explains why (a blocking peek holds the whole turn open and blocks chat-while-waiting) and redirects to text-only idle-yield.
- Adjacent fix: `resolveEvidenceRef` no longer tells a *child* agent to poll a still-running sibling with `task_output` (coordinator-only) or to await a `<task-completed>` block (a parent-only mechanic) — it now states plainly that the sibling result is not available yet.
- Added regression tests for runtime output, schema wording, Worker prompt gating, the pending-child gate, the child-facing sibling briefing, and Worker tool-surface preservation.
- Added a pilot eval fixture (`tests/feature-177-wait-expired-idle-yield-pilot.eval.ts`) for the `wait_expired + status=running` cascade.

#### Eval Result (2026-06-26, real provider runs)

- Pilot `zhipu/glm51` 3/3 PASS — model explicitly refuses to fabricate pending reports and idle-yields text-only ("I'll wait … rather than block on them" / "rather than peek again").
- 5-alias panel on the same case confirmed the acute bug is gone everywhere with data: no alias claimed a child timed out, none wrote a premature report, none re-issued the turn-freezing `block:true`. Weak "flash" aliases (ark/v4flash, ark/v4pro) downgrade to harmless `block:false` peeks / read-only re-scans instead of pure idle-yield — a known weak-model floor, validated by dump inspection.
- Eval-quality fix during review: the `judgeNoFinalReport` regex matched the bare token "findings", false-failing clean waiting messages that mention the one completed child ("no blocking findings"); tightened to match overall-verdict structure only.
- Adjacent infra bug surfaced **and fixed** in the same pass: any caller that omitted `reasoning` (e.g. the eval harness) crashed `kimi-code` / `minimax-coding` with `does not support reasoning effort "none"`. These are always-on-thinking models (`localRejectEfforts: ['none','minimal']`, no `supportsDisabledThinking`); `normalizeReasoningRequest(undefined)` produces an implicit legacy effort `none`, and `resolveReasoningProfileIntent` hard-threw on it without checking `effortSource`. Fix in `packages/llm/src/providers/base.ts`: hard-reject a `localRejectEfforts` effort **only when explicitly requested** (mirrors `validateExplicitReasoningEffort`); an implicit/default `none` now falls back to the model's `defaultEffort` so the model simply thinks. Verified: 5-alias panel re-run — `kimi` and `mmx/m27` now produce data (previously zero); `mmx/m27` 3/3, `kimi` idle-yields correctly (judge-undercounted, see below). Regression test: `packages/llm/src/providers/base.test.ts` (`resolveReasoningProfileIntent — always-on-thinking models`).
- Eval judge tightening (this pilot): `judgeNoFinalReport` no longer trips on the bare token "findings"; `judgeWaitingStatus` broadened to recognize natural waiting phrasings ("I will wait … to finish/complete", "until their reports arrive") that were false-failing correct idle-yields (kimi/zhipu).

#### Files Changed

- `packages/coding/src/tools/task-output.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/tools/task-output.test.ts`
- `packages/coding/src/agents/worker-role-prompt.test.ts`
- `packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts`
- `tests/feature-177-wait-expired-idle-yield-pilot.eval.ts`

#### Tests Added / Run

- `npm test -- packages/coding/src/tools/task-output.test.ts packages/coding/src/agents/worker-role-prompt.test.ts packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts`
- `ARK_CODING_API_KEY='' npm run test:eval -- feature-177-wait-expired-idle-yield-pilot` (skip-path compile check; real provider pilot intentionally not run automatically)

### 143: Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框，auto 模式形同虚设

- **Priority**: High
- **Status**: **Resolved** (v0.7.57)
- **Introduced**: v0.7.39（FEATURE_158 / ADR-025，commit `97e99d7d`；0.7.39 之前完整 await classify，只在真 block/escalate 才弹）
- **Created**: 2026-06-25
- **Resolved**: 2026-06-25
- **Fixed**: v0.7.57

#### Original Problem

SDK 用户报告：在 `auto[llm]` 模式下，几乎每个经过 classifier 的非 Tier-1 工具调用
（bash 跑的 cat/ls/grep、write/edit、web_fetch、mcp_call、semantic_lookup 等以及重型
repo-intelligence 工具）都会弹出确认框。只读类 Tier-1（read/grep/glob/repo_overview
投影为 `''`）不弹，但凡需要 classifier 裁决的调用近乎 100% 误弹。等于 auto 模式形同虚设。

复现条件：远程 provider / 走代理 / 较大模型——classifier 是一次真实 LLM sideQuery，
单次往返典型 1–5s，几乎不可能在 500ms 投机窗口内返回。

#### Context

- 组件：`AutoModeToolGuardrail` 的 speculative classify。
- 受影响表面：REPL 与 Space 都中招——
  [`auto-mode-bootstrap.ts:137-198`](../packages/repl/src/interactive/auto-mode-bootstrap.ts#L137-L198)
  构造 guardrail 时传了 `timeoutMs` 却**没传 `speculativeWindowMs`**，两个 host 都退回
  env / 默认值。这是 guardrail 默认值层面的问题，不是某个 surface 的接线遗漏。
- 配置面缺失：[`config.example.jsonc`](../config.example.jsonc#L244-L247) 的 `autoMode`
  段暴露了 `engine` / `classifierModel` / `timeoutMs`，**唯独 speculative window 没有
  config.json 面**，只能靠 `KODAX_AUTO_SPECULATIVE_WINDOW_MS` 环境变量，普通用户无从调。

#### Root Cause

三个根因叠加，按严重度排序：

1. **late verdict 被硬丢弃（核心放大器）**。窗口过期后后台 classify 仍在跑且**不**被
   abort，但其裁决在 v1 被明确丢弃。三处代码互证：
   [`speculative.ts:13-17`](../packages/coding/src/guardrails/auto-mode/speculative.ts#L13-L17)、
   [`guardrail.ts:443-449`](../packages/coding/src/guardrails/auto-mode/guardrail.ts#L443-L449)
   （注释 *"its result is dropped in v1"*，直接 `escalateOrAsk(...)`）、
   接口文档 [`guardrail.ts:257-268`](../packages/coding/src/guardrails/auto-mode/guardrail.ts#L257-L268)
   （*"its eventual result is discarded in v1 (UI doesn't adopt late verdicts yet)"*）。
   因此即便 200ms 后 classifier 返回 allow 也没用——窗口一过就是一个必须人点的硬弹窗。
   CC 的 `peekSpeculativeClassifierCheck` 对应能力在 KodaX 未接。

2. **500ms 是占位值，micro-bench 从未回填**。设计稿
   [`v0.7.39.md` commit 4](features/v0.7.39.md#L711) 承诺 "Anthropic/DeepSeek/Zhipu
   micro-bench 报告附在文档末尾"，但文档末尾（结尾第 769 行）没有任何 bench 报告；
   release gate [`v0.7.39.md:729`](features/v0.7.39.md#L729) "Speculative classify
   p50/p95 < 1500ms p95" 是 `[ ]` 未勾选；`benchmark/` 下搜不到任何 speculative /
   classifier-latency 数据集或结果。代码注释
   [`speculative.ts:21-23`](../packages/coding/src/guardrails/auto-mode/speculative.ts#L21-L23)
   自承 "finalized after micro-bench in commit body"——那个 bench 不存在。

3. **窗口与 timeout 的 16× 内部矛盾**。同一 guardrail 内 classifier sideQuery 的
   `timeoutMs` 默认 **8000ms**（[`guardrail.ts:306`](../packages/coding/src/guardrails/auto-mode/guardrail.ts#L306)），
   speculative 窗口默认 **500ms**。设计上允许 classifier 跑 8s，却只给它 500ms 自证，
   远程/慢 provider 的 p95 必然秒级 → 误弹是数学必然，非偶发。

补充事实（影响修复设计）：cost-tracker 在
[`classify.ts:96-98`](../packages/coding/src/guardrails/auto-mode/classify.ts#L96-L98)
内部、sideQuery 返回时结算，每次 classify 恰好一次，与窗口是否过期无关——**采纳 late
verdict 不会 double-settle cost**。当前窗口过期路径不记录 denial-tracker/breaker（裁决被丢），
这是采纳 late verdict 时需要补齐的点。

#### Proposed Solution（完整修复，非治标；按 KodaX 极简原则裁掉冗余 knob）

分 5 个 workstream，WS1 治本、WS2 把 SDK/非交互路径一并修对、WS3 补可配置面、WS4 还文档债、
WS5 是 WS1 内的验证项。**显式 descope**：原报告建议的"provider/latency-aware 默认窗口表"
不做——一旦 WS1 采纳 late verdict，慢 provider 只意味着确认框先出现再自动消失，per-provider
调参变成多余的 knob（违反 YAGNI / 无 3+ 用例不抽象）。这是比加 knob 更合理的完整方案。

- **WS1（核心）— 采纳 late verdict / peek 模式**。窗口从"是否硬弹一个需人点的框"降级为
  "是否先显示一个 pending（analyzing…）UI"。guardrail 不再丢弃 `classifyPromise`，把它
  透传到 escalate 路径；`AutoModeAskUser` 契约扩展为可接收一个 late-verdict promise（或
  AbortSignal + resolver），REPL 确认框 race 两件事：(a) 用户手动作答，(b) 迟到裁决。迟到
  `allow` → 自动放行并关框；迟到 `block` → 自动关框并 block（带 reason）；迟到 `escalate`
  → 保持等待用户（这才是真正需要人判的场景）；用户先作答 → 以用户为准。无论哪条路径，
  `classifyPromise` 结算时按裁决补记 denial-tracker/breaker（reset/increment），且保证
  user-answer 与 late-verdict 两条路径不重复记录（WS5）。

- **WS2 — host/surface-aware 策略：无 askUser ⇒ 不投机**。speculative race 只在"有人会因此
  干等"时才有意义。非交互 / SDK / 无 askUser 表面下，窗口过期提前 escalate 是纯伤害（没有人
  可被抢答，还把 transient 的早退当裁决）。规则：无 `askUser` 时禁用 speculative，退回完整
  await classify（即 0.7.39 之前行为）。这一条单独就修对 SDK / 非交互路径，并把原报告的
  "GUI/非交互默认"收敛成一条干净规则。

- **WS3 — 补 config 面 + 合理默认**。`autoMode.speculativeWindowMs` 加入 config.json（与
  `timeoutMs` 并列），bootstrap 透传到 guardrail 与 Space。采纳 WS1 后默认窗口只决定"几 ms 后
  显示 pending UI"，把默认提到一个不靠运气、又不至于让快裁决闪一下 pending 的值（候选由 WS4
  实测）。

- **WS4 — 回填并固化 micro-bench**。按 canonical 5-alias provider panel 实测 classifier
  sideQuery 的 p50/p95，据此定 WS3 默认值，更新 `v0.7.39.md` 文档末尾报告并勾掉 release gate；
  落 `benchmark/` 永久回归。

- **WS5 — 防 double-record / double-settle 验证**。证实 cost-tracker 仍恰好结算一次；
  新增 denial-tracker/breaker 记录在 "user 先答" 与 "late verdict 先到" 两条路径下互斥不重复；
  late verdict 抵达后若用户已作答则只结算 cost + 记 tracker，不再触发 UI。

#### Expected Outcome

`auto[llm]` 模式在远程/慢 provider 下恢复可用：classifier 判 allow 的调用不再弹框（快则
无感、慢则先显 pending 再自动放行），只有 classifier 真正判 escalate / 用户需介入时才落人工
确认框。SDK / 非交互路径行为正确（完整 await，不再因 500ms 早退假弹）。speculative window 既
可经 env 也可经 config.json 调整。default 值由实测固化、release gate 勾齐。

#### Resolution

实施分 5 个 workstream（全部完成）。**WS1 落地时对原 Proposed Solution 做了一处精炼**：
原计划走「窗口过期即弹 pending 确认框，迟到 allow 再 auto-dismiss（peek-race）」；实现时改为
更简洁且更正确的**「窗口过期 → `await` 同一 classifyPromise → 采纳裁决」**——allow/block 直接
落地不弹框，只有真正 `escalate` 才弹框。后者无需 auto-dismiss、无需扩 askUser 契约、无需碰
readline/Ink UI（现有 agent spinner 覆盖等待期），无弹框闪烁，且 allow 裁决产生**零**弹框，
正是对症修复。

- **WS1（核心，late-verdict 采纳）**：`packages/coding/src/guardrails/auto-mode/guardrail.ts`
  `beforeTool` —— `speculativeRace` 返回 `window-expired` 时不再 `escalateOrAsk`，改为
  `decision = await classifyPromise` 后走既有 switch（allow→allow / block→block / escalate→弹框）。
  迟到 block 现在正确喂 denial-tracker（旧路径丢弃，曾被误记为 breaker error）。cost-tracker 在
  `classify.ts:96-98` 内部结算恰好一次，二次 await 不 double-settle（reviewer code-trace 证实）。
- **WS2（host-aware）**：同文件 —— 无 `askUser` 表面（SDK / 非交互 / 子 Agent）时强制窗口为 0，
  直接 await 完整裁决，不再因 500ms 早退把 transient timeout 当裁决。
- **WS3（config 面）**：`packages/repl/src/common/permission-config.ts` 新增
  `autoMode.speculativeWindowMs`（env `KODAX_AUTO_SPECULATIVE_WINDOW_MS` 覆盖，0 合法=禁用，
  env>file）；`packages/repl/src/interactive/auto-mode-bootstrap.ts` 透传到 guardrail（REPL +
  Space 同时生效）；`config.example.jsonc` 文档化。
- **WS4（文档对账）**：`docs/features/v0.7.39.md` —— 记录 late-verdict 采纳使原「Commit 4
  micro-bench → 固化默认值」失去正确性意义（任何窗口值都不再造成误 escalate），按
  EVAL_GUIDELINES Layer 1 纪律不补跑无决策价值的付费 bench；release gate p95 项标记 obviated。
- **WS5（防退化验证）**：double-settle / double-record 由 WS1 单测覆盖（「late block 恰好记一次」
  + 「窗口过期后 abort 仍正确传播」）；coding 全包 3570 passed（1 项 `orchestration.test.ts`
  maxConcurrent 并发计时 flaky，隔离复跑绿，与本修复无关）、repl 全包 2135 passed、coding+repl
  `tsc -b` clean。

**Files Changed**：
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`（WS1 窗口过期采纳 + WS2 host-aware 窗口 + 接口/注释更正）
- `packages/coding/src/guardrails/auto-mode/speculative.ts`（模块文档更正：late-verdict 采纳 + WS2 说明）
- `packages/repl/src/common/permission-config.ts`（WS3：`speculativeWindowMs` 解析 + `parseSpeculativeWindow`）
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`（WS3：透传 `speculativeWindowMs`）
- `config.example.jsonc`（WS3 文档化）
- `docs/features/v0.7.39.md`（WS4 对账）

**Tests Added**：
- `guardrail.test.ts`：WS2×2（无 askUser 慢分类器 allow / block）、WS1×4（采纳迟到 allow / block、
  真 escalate 仍弹框、late block 喂 denial-tracker 恰好一次）、WS1 abort-after-window-expiry×1
- `permission-config.test.ts`：WS3×8（默认 undefined / file 读取 / 0 合法 / env>file / env 0 / 负数 clamp / 非数字回落 / 取整）
- `auto-mode-bootstrap.test.ts`：WS3×2（透传 1500 / 省略转 undefined，capturing-spy）

#### Related

- FEATURE_158 / ADR-025（v0.7.39）：speculative classify 的引入版本。
- Issue 131（v0.7.39，已修）：同 feature 的 Windows-flag 误判；本 issue 是同 feature 的
  另一类回归（投机窗口默认值 + late-verdict 丢弃），独立成项。
- 参考实现：Claude Code `peekSpeculativeClassifierCheck` 模式（WS1 对标对象；KodaX 采用更简洁的
  await-adopt 变体）。

---

### 142: kimi-code thinking-only completion can terminate Worker with only `[Worker]` visible

- **Priority**: High
- **Status**: **Resolved** (v0.7.56)
- **Introduced**: v0.7.56
- **Created**: 2026-06-25
- **Resolved**: 2026-06-25
- **Fixed**: v0.7.56

#### Original Problem

In v0.7.56, users can intermittently see an Assistant turn that contains only
the managed role label, for example:

```text
Assistant [04:33 AM]
[Worker]
```

The reported repro used `/model kimi-code` followed by a trivial Chinese
greeting (`你好`). The first run produced a visible Thinking block but no
assistant answer after `[Worker]`; sending the same greeting again produced a
normal Chinese response. This makes the CLI look like it finished successfully
while giving no user-facing answer.

#### Context

- Affected provider path: `kimi-code`, which uses the Anthropic-compatible
  coding endpoint and supports thinking blocks.
- Affected runtime path: managed Worker / Runner-driven adapter.
- The symptom is intermittent because it depends on whether the upstream
  reasoning model emits final public text after its thinking block.
- Probe evidence: a scripted-provider reproduction with `thinkingBlocks`
  present, empty `textBlocks`, empty `toolBlocks`, and stop reason `end_turn`
  returns `text === ''` and does not consume the retry sentinel.

#### Root Cause

The current empty-completion retry guard in
`packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts`
classifies a turn as empty only when text, tool calls, and thinking blocks are
all absent. A thinking-only completion therefore bypasses the retry branch even
though it has no user-visible answer and no tool action.

Downstream, the Runner treats `toolCalls.length === 0` as a valid text-only
terminal turn. The final assistant text is empty, but the REPL managed
foreground renderer may have already created an assistant block with the
`[Worker]` prefix, so the transcript shows a role label with no body.

#### Proposed Solution

Treat "no user-visible text and no tool calls" as a degraded empty completion,
even when thinking blocks are present. Let the existing bounded re-stream
mechanism retry the same turn, while preserving thinking blocks for legitimate
history replay when a real assistant turn exists.

Implementation guardrails:

1. Change the adapter predicate to trim concatenated `textBlocks` and ignore
   `thinkingBlocks` for empty-output detection.
2. Keep `stopReason === 'max_tokens'` excluded so max-token continuation and
   escalation keep owning that path.
3. Do not use thinking content as fallback public output.
4. Keep the retry inside the adapter before the Runner commits the assistant
   turn, so the failed attempt's empty public output never becomes model-facing
   history.
5. Add UI defensive handling so leading whitespace deltas do not create a
   managed assistant ledger item containing only `[Worker]`.
6. If the bounded retries are exhausted, fail the turn with a local provider
   empty-output notice instead of committing an empty or thinking-only
   assistant message to the model-facing transcript.
7. Add regression tests for thinking-only, whitespace-text-only,
   normal text-only, tool-only, and max-token cases.

#### Expected Outcome

When kimi-code or another reasoning provider emits a thinking-only or
whitespace-only final turn, KodaX retries transparently. If a retry returns real
public text or a tool call, the user sees the normal answer/tool flow. If the
bounded retries are exhausted, the run should surface an explicit local
empty-output failure rather than a bare `[Worker]` line, and the next user turn
must not replay a malformed empty assistant message to the provider.

#### Resolution

- `packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts` now
  treats empty/whitespace public text plus no tool calls as a degraded empty
  completion even when thinking blocks are present.
- The existing bounded same-turn re-stream path handles recoverable
  thinking-only completions. If all retries are exhausted, the adapter throws a
  local provider error and preserves only the safe pre-turn provider messages,
  so no empty or thinking-only assistant turn is committed for the next request.
- `packages/repl/src/ui/InkREPL.tsx` now avoids opening a managed assistant
  block from leading whitespace deltas and treats a bare `[Worker]` prefix as
  non-substantive assistant text during finalization.
- Regression tests were added in
  `packages/coding/src/task-engine/runner-driven.test.ts` and
  `packages/repl/src/ui/InkREPL.managed-transcript.test.ts`.

---

### 141: CI workflow long-red on Linux — cross-platform test bugs

- **Priority**: Medium
- **Status**: **Open** (partially fixed — see Progress)
- **Introduced**: long-standing; CI `ci.yml` has been red on the `KodaX` branch across many releases (v0.7.48–v0.7.51) while the product itself is unaffected
- **Created**: 2026-06-18
- **Fixed**: -

#### Overview

The GitHub Actions `CI` workflow (`.github/workflows/ci.yml`, Ubuntu, full
`npm test`) has been failing on every push for 40+ runs. This is **not a
product regression** — the suite is green locally on Windows and the
tag-triggered `Release` workflow (binaries + GitHub Release) succeeds
independently. The red is a cluster of **cross-platform / environment test
bugs** that only surface on the Linux CI runner.

#### Root Causes (diagnosed 2026-06-18 via CI as the repro environment)

1. **`packages/repl/src/interactive/storage.test.ts` (6 tests)** — `FileSessionStorage.list()` (`storage.ts:~1307`) derives the per-project session key from a **live** `inspectWorkspaceRuntime({ cwd: gitRoot })`, whereas `save()` derives it from the persisted session data. When the test's `gitRoot` is a non-existent directory, the `git`-spawn-with-bad-cwd fallback diverges between Windows and Linux, so the list-time key ≠ the save-time key and `list()` returns `[]`. **A portable-path fix was tried and DISPROVEN by CI** — the failure is the runtime-inspection layer, not path format. **Robust fix:** mock `inspectWorkspaceRuntime` in these 6 tests (as the passing "lists sibling workspace sessions" test already does) so the key derivation is deterministic on all platforms. Needs a Linux repro to verify.
2. **`benchmark/harness/h2-boundary-runner.test.ts` (3 tests)** — env propagation to the spawned fake-kodax process (`KODAX_FORCE_MAX_HARNESS`, `KODAX_PLANNER_INPUTFILTER`) + `mustNotTouchViolations` forbidden-path detection behave differently under the Linux spawn/path semantics.
3. **`packages/coding/src/tools/bash.test.ts` (2 tests)** — "registers background commands for managed cleanup" / "stops background commands when the caller aborts": background-process registration + kill/abort lifecycle differs on Linux (process-tree semantics). (The third bash failure, "keeps the tail for large command output", was a shell-quoting bug and is **fixed**.)
4. **`packages/agent/src/capabilities/skills/skill-creator-tools.test.ts` (collection failure)** — the file throws at module-load time: `agent-task-runner: API key env DEEPSEEK_API_KEY not set for alias ds/v4flash`. **Fix:** skip (or lazily construct) when the API key is absent, so the suite collects without provider credentials.

#### Progress (fixed and CI-confirmed, 2026-06-17→18)

- **Node 18 floor dropped** (commit `f9ab5596`): a `v`-flag RegExp (unicodeSets, requires Node 20+) in a dependency made ~65 of 71 node-18 test files fail to even load. `engines.node` raised to `>=20.0.0` (root + 4 packages), `ci.yml` matrix reduced to `['20','22']`, README/AGENTS/CLAUDE tech-stack tables synced. This eliminated the bulk of the red.
- **`bash.test.ts` large-output** (`e9b88a95`): backtick/`${}` in a `node -e` script was expanded by POSIX `sh`; switched to single-quoted concatenation.
- **`terminalCapabilities.test.ts`** + **`workspace-runtime.test.ts`** (`8344a13a`): `isScreenReader()` treats `CI` as a signal (Actions sets `CI=true`) — test now clears it; `resolveSessionRuntimeInfo` normalizes via `path.resolve`, so the legacy-gitRoot case now uses a both-absolute root.

Net: node 22 went from **71 failed files → 4 failed files / 11 failed tests**.

#### Why this is tracked rather than fixed now

The remaining failures (storage `list()`, h2 spawn, bash background) are Linux
runtime/process/workspace behaviors that **cannot be fixed confidently without a
Linux reproduction environment** — the one blind hypothesis attempted (storage
portable path) was disproven by CI. The dev machine has no Docker and no
installed WSL distro, and `node_modules` deps were wiped post-publish
(`npm ls` = empty), so local verification is currently impossible.

#### Proposed Solution

Pick up with a Linux repro env (WSL distro / Docker / Linux box):
1. Mock `inspectWorkspaceRuntime` in the 6 storage `list()` tests.
2. Make `skill-creator-tools.test.ts` skip when `DEEPSEEK_API_KEY` is absent.
3. Reproduce + fix the h2-boundary-runner env-propagation and bash background-process tests on Linux.
4. Verify the full matrix (node 20 + 22) goes green, then keep CI green as a gate.

#### Context

- Full per-root-cause diagnosis captured in this session; the analysis is the hard part — once on Linux the fixes are largely mechanical.
- `Release` workflow is independent of `CI` and remains green.

---

### 140: Published bundle leaves computed `./agent.js` child-executor import, breaking workflow child agents

- **Priority**: High
- **Status**: **Resolved** (v0.7.52)
- **Introduced**: v0.7.37 bundle distribution; confirmed in published `0.7.48`, `0.7.49`, and `0.7.50`
- **Created**: 2026-06-17
- **Resolved**: 2026-06-18
- **Fixed**: v0.7.52

#### Original Problem

When a locally linked or published `kodax` package runs a workflow that dispatches child agents, the run can fail with:

```text
[child-executor] Failed to lazy-load agent module (`./agent.js`) for dispatch_child_task. This usually means the @kodax-ai/coding build is broken or out of date. Underlying cause: Cannot find module '...\dist\agent.js' imported from ...\dist\kodax_cli.js
```

The npm `@kodax-ai/kodax@0.7.50` tarball has the same failure signature: `package/dist/agent.js` is absent, while `package/dist/kodax_cli.js` and an SDK shared chunk still contain a runtime `./agent.js` dynamic import.

#### Root Cause

`packages/coding/src/child-executor.ts` used a computed dynamic import (`const spec = './agent.js'; await import(spec)`) to hide the `child-executor -> agent` edge from circular dependency tooling. That works in `packages/coding/dist`, where `agent.js` is a sibling file.

In the bundled root distribution, esbuild cannot statically see the computed import and leaves it as a runtime import. At runtime it resolves relative to `dist/kodax_cli.js`, so Node looks for root `dist/agent.js`, which is not shipped.

#### Proposed Solution

- Keep the import lazy, but make the import target a string literal (`await import('./agent.js')`) so esbuild bundles the target into `dist/kodax_cli.js` / SDK chunks instead of leaving a raw runtime import.
- Add a build/package regression guard that fails if built `dist/kodax_cli.js` or `dist/chunks/*.js` still contain the child-executor lazy-load error plus a raw `./agent.js` import.
- Verify the fix against the packed tarball, not only TypeScript unit tests: `npm run build`, `npm pack`, inspect/extract the tarball, then run/grep the generated bundle.

#### Resolution

v0.7.52 changed the child-executor lazy load to a literal `import('./agent.js')`
while keeping the import lazy, and added bundle/release guards so raw
child-executor `./agent.js` imports fail the build or release check before
publishing. The fixed release line was verified against the packaged bundle
rather than only against TypeScript source output.

#### Context

- Reproduced from a local `npm link` workflow run on 2026-06-17.
- Confirmed against the online npm package `@kodax-ai/kodax@0.7.50` tarball on 2026-06-17.
- Spot-checked published `0.7.49` and `0.7.48`; both have the same missing `dist/agent.js` plus raw `./agent.js` import signature.
- Fixed release line: v0.7.52.

---

### 139: SDK session full transcript hidden by active-lineage load + error snapshots can orphan activeEntryId

- **Priority**: High
- **Status**: **Resolved** (v0.7.49)
- **Introduced**: long-standing / pre-existing
- **Created**: 2026-06-16
- **Resolved**: 2026-06-16
- **Fixed**: v0.7.49

#### Original Problem

KodaX Space renders SDK sessions through public `loadSession(id)`. For a session compacted four times, on-disk lineage contained 164 entries, but `loadSession` returned only the active branch's 10 messages. The earlier entries remained on disk, but users saw most conversation history disappear.

The same session ended with an error snapshot whose first message was an assistant `tool_use`, not a clean system/user start. The provider rejected the request with zhipu code 1214, then the error snapshot advanced active lineage to that malformed tool-loop fragment.

#### Root Cause

- `loadSession` exposes active model context, not append-order full transcript.
- Headless SDK persistence does not write TUI-style `uiHistory`.
- Error snapshots can persist in-flight provider messages that are unsafe as authoritative session history.
- Runner-driven compaction can drop the compaction anchor when no artifact ledger is present.

#### Resolution

- Added public `loadFullTranscript(id)` / `createSessionManager().loadFullTranscript(id)` for append-order UI scrollback while keeping `loadSession` active-context semantics.
- Guarded error snapshots so malformed provider transcripts may record `errorMetadata` but cannot update active lineage.
- Changed Runner-driven compaction to pass compaction anchors whenever they exist, independent of artifact ledger presence.

#### Files Changed

- `packages/coding/src/agent-runtime/middleware/session-snapshot.ts`
- `packages/coding/src/task-engine/_internal/managed-task/compaction.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/index.ts`
- `src/sdk-session.ts`
- Regression tests in the matching `*.test.ts` files.

#### Tests Added

- Error snapshot guard tests for valid user-starting transcripts and invalid assistant-tool fragments.
- Public API tests proving `loadFullTranscript` returns append-order entries across disconnected lineage roots, including `.islands.jsonl` sidecar entries, while `loadSession` stays active-only.
- Compaction hook test proving anchor propagation without artifact ledger.

#### Follow-up hardening (v0.7.63)

- Rewind audit entries now use a dedicated `rewind_marker` lineage type instead
  of overloading compaction entries. Host scrollback sees the marker through
  `loadFullTranscript().transcriptEntries`; model context and
  `loadFullTranscript().messages` do not include it.
- `/rewind` previous-turn selection skips synthetic user entries and
  tool-result-only user messages, so the target is the previous real user
  prompt rather than protocol plumbing.
- `startKodaX()` generated handle IDs are threaded into run options only when
  they will not override auto-resume/resume discovery, and they no longer
  trigger the caller-provided `session.id` without storage warning.
- `@kodax-ai/kodax/session` now re-exports `compactSession` and its public
  types, with an SDK subpath regression test.

#### Verification

- `npx vitest run packages/coding/src/agent-runtime/middleware/session-snapshot.test.ts packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts packages/repl/src/session/public-api.test.ts` -> 61 passed.
- `npm run build:packages` -> passed.
- `npm run build:dts` -> passed; bundled SDK declarations include `loadFullTranscript`.
- `git diff --check` -> passed.

Additional suite observations:

- `npx vitest run packages/repl` exposed the existing workflow-command parallel-suite flake; `npx vitest run packages/repl/src/commands/workflow-command.test.ts` passed in isolation.
- `npx vitest run packages/coding` exposed the existing Issue 133 repo-intelligence atomic rename flake; `npx vitest run packages/coding/src/repo-intelligence/runtime.test.ts` passed in isolation.

#### Context

Evidence session: `C:\Users\iceto\.kodax\sessions\c-works-gitworks-kodax-author-kodax-space-fad022fc3b\s_8b5c4bc1-4034-438a-8258-04e0eb5d4723.jsonl`.

---
### 138: Workflow host RPC 边界对对象载荷零校验 — `synthesize` 传非数组 inputs 崩裸 TypeError + `runAgent`/`spawnAgent` 缺 name/prompt 静默烧 token

- **Priority**: High（畸形的生成脚本会让整轮 workflow 在合成阶段全损，或静默派发空 objective 的子 Agent 消耗预算）
- **Status**: **Resolved**（v0.7.49）
- **Introduced**: v0.7.49（FEATURE_217 dynamic workflow invocation）
- **Created**: 2026-06-15
- **Resolved**: 2026-06-15
- **Fixed**: v0.7.49

#### Original Problem

`/workflow create` 生成的动态 workflow 在合成阶段失败，报错 `restricted workflow script failed: Error: input.inputs.map is not a function`。三个 investigator 子 Agent 全部成功完成（摘要已产出），却在最后一步整轮丢弃，且抛出的是一条看似内部崩溃的裸 `TypeError`。

复现信号：

- 生成脚本把 findings 先 `.map().join()` 拼成一份带标题的可读文档，再 `wf.synthesize({ inputs: combined, rubric })` —— `combined` 是字符串，不是数组。
- 事件时间线：3× `agent_completed` → `phase_started(synthesize)` → 1ms 内 `workflow_failed`，**没有** `agent_spawned(synthesize)`，说明崩在 prompt 构造，连合成 Agent 都没起。

#### Root Cause

Workflow host RPC 边界对**标量字符串参数**（taskId/name/content/reason）在沙箱 + host 两层都有校验和友好报错，但对**对象载荷**（`runAgent`/`spawnAgent` 的 input、`synthesize` 的 input、`log` 的 event）只检查"是不是对象"，随即 `readRecord(input) as unknown as X` 强转放行，字段形状零校验。同源缺陷的三个表现：

- `synthesize`：`buildSynthesisPrompt` 同步 `input.inputs.map(...)` → 非数组直接崩裸 `TypeError`，整轮全损（本 issue 的触发点）。
- `runAgent`/`spawnAgent`：`name`/`prompt` 为 `undefined` 时静默流入真实 child 派发，烧 token 跑空 objective 的子 Agent，事件/UI 里 `name=undefined`（比崩溃更隐蔽）。
- `log`：`message` 为 `undefined` 时产生 UI 垃圾行。

同 runtime 的 `wf.parallel` 反而做对了（`Array.isArray` + 逐项 function 检查 + 清晰报错），证明这是"host 边界缺一个复合载荷校验 helper"导致的系统性遗漏，而非逐点疏忽。静态校验（`validateGeneratedWorkflowSource` 正则）无法拦——`inputs` 是运行时值。

#### Resolution

按"放宽契约 + 边界统一校验"两路修复：

- **容忍单值**（runtime）：`WorkflowSynthesizeInput.inputs` 拓宽为 `array | string | object`；`normalizeSynthesisInputs` 把字符串/对象归一为数组，`normalizeSynthesisRubric` 校验 rubric 非空。从源头消除"模型先拼成串"这个几乎必然复发的陷阱。
- **host 边界校验**（script-runner）：新增 `readSpawnAgentInput` / `readSynthesizeInput` / `readLogEvent`，替换 `handleCommand` 中 `runAgent`/`spawnAgent`/`synthesize`/`log` 的 4 处 `as unknown as` 裸转。强制 name/prompt 非空串（堵静默烧 token）、`readOnly` 必须 boolean（read-only 白名单为安全相关 flag）、rubric 非空、inputs 形状合法；畸形输入以"哪个调用、哪个字段"的明确信息在边界失败。
- **prompt 提示**（generator）：`wf.synthesize` 说明 inputs 可为数组 / 单个已拼接字符串 / 命名对象，减少模型生成错误形状。
- `wait` 的 opts 裸转刻意保留——仅 `{ timeoutMs? }`，downstream `normalizeWaitTimeoutMs` 已校验并给友好报错，不属于崩溃/烧钱类。

#### Files Changed

- `packages/agent/src/workflow/script-runner.ts`（host 边界校验器 + 接线）
- `packages/agent/src/workflow/script-runner.test.ts`（6 个边界拒绝/接受测试）
- `packages/agent/src/workflow/runtime.ts`（`normalizeSynthesisInputs/Rubric`）
- `packages/agent/src/workflow/types.ts`（`WorkflowSynthesizeInput.inputs` 拓宽）
- `packages/agent/src/workflow/runtime.test.ts`（命名对象 / 已格式化字符串两个 synthesize 测试）
- `packages/coding/src/workflows/generator.ts`（synthesize prompt 提示）
- `docs/KNOWN_ISSUES.md`

#### Tests Added

- script-runner：缺 prompt 拒绝、空 name 拒绝、`readOnly` 非布尔拒绝、缺 rubric 拒绝、`inputs: 42` 拒绝、单字符串 inputs 接受（验证不再误报）。
- runtime：synthesize 接受命名对象（转 `{name,value}` 列表）+ 已格式化字符串（包进 `## Input 1`）。

#### Verification

- `npx vitest run packages/coding/src/workflows/ packages/agent/src/workflow/` → 135 passed
- `npx tsc --noEmit -p packages/agent/tsconfig.json` + `packages/coding/tsconfig.json` → clean
- `npm run build:packages` → success

---


### 136: 流式 / 滚动时 spinner 动画卡顿 + 计时变慢 — 瓶颈在 CPU 侧每帧渲染，非终端写入字节量

- **Priority**: Low（用户实测"影响不大"；不阻塞功能，纯视觉/手感）
- **Status**: **Open**（根因待 trace 确认）
- **Introduced**: 待调研（疑似一直存在；v0.7.41 spinner stats 尾巴 `58682cbf` 让每 tick 输出变化，可能放大可见度）
- **Created**: 2026-05-31

#### Symptom

流式输出过程中、以及上下文很长时滚动过程中，spinner 动画明显卡顿、计时变慢（驱动 spinner 的 `setInterval` 回调被推迟，帧率不稳）。注意：**打字卡顿是另一个独立症状，已由 FEATURE_212 cell-diff（`60c38896`）修复**；本 issue 的 spinner 卡顿独立存在，未被修复。

#### Investigation — 已排除的假设（两次 I/O 否证）

- ❌ **假设 1「全屏每帧整屏重画（~6KB ANSI 写）是瓶颈」** → FEATURE_212 fullscreen cell-diff（`60c38896`，default ON）把打字时的写入量从整屏降到只画变化的格子，**打字卡顿消失**，但 spinner 卡顿无变化。
- ❌ **假设 2「滚动时 cell-diff 退化成近整屏写」** → FEATURE_212 DECSTBM 硬件滚动快路径（`870f59aa`→`424b1a34`，default ON）把滚动写入量降到只画滚进来的行（terminal-model gate 证明逐字节重建正确），**实测 spinner 卡顿仍无变化**。
- **结论**：两次都否证了「终端写入字节量（I/O 侧）是瓶颈」。DECSTBM 对本症状无效（见下方 Related 的回滚评估）。

#### Likely root cause（待 trace 确认）

瓶颈在 **CPU 侧每帧渲染工作**，不在 I/O 字节量：

- 流式每个 token 到达 / 滚动每帧都触发 React reconciliation 重建整棵 transcript 子树；
- `outputToScreen` / `Output.getGrid` 全量重建 Screen 网格（参考 FEATURE_172 Phase A 诊断 + Issue 094 的"核心渲染文件过大/耦合"）；
- 上述同步 CPU 工作（叠加同步 stdout 写）占满主线程 → 驱动 spinner 动画的 `setInterval` 回调被推迟 → 动画帧率不稳 + 计时变慢。

DECSTBM 只优化了「把字节写到终端」这一 I/O 步，没有触碰上面的 CPU 侧重建——这正解释了为何它对 spinner 无效。

#### Next

- 用 `KODAX_RENDER_TRACE` + 多 agent 并行 trace（参考 `feedback_render_pipeline_full_trace`）定位 CPU 侧热点，**端到端测 wall-time**（参考 `feedback_bench_must_be_end_to_end`，不要只测 inner function）。
- 对照 `C:/Works/claudecode` 的 spinner 机制：是否用不受 render 阻塞的独立 timer，或对流式 render 做节流（throttle / coalesce）。

#### Related

- **FEATURE_212**：`60c38896`（cell-diff）有效修复打字卡顿，保留。DECSTBM 部分（`870f59aa`→`424b1a34`）对本 issue（spinner）**无效**——它只降低滚动帧的 I/O 写入量，不碰 CPU 侧重建。但用户实测**滚动本身手感有改善**（I/O 写入量下降的预期效果，与 spinner 症状独立）→ **保留**（2026-05-31，escape hatch `KODAX_SCROLL_DECSTBM=0`）。本 issue 的 spinner 卡顿仍 **Open**，需 CPU 侧 trace。
- [FEATURE_172](FEATURE_LIST.md#feature_172) / ADR-028 — render pipeline 底层瓶颈（真实瓶颈在 ink 底层 ~80%，非数据层）。
- Issue 094 — 核心渲染文件过大、职责耦合。

---


### 133: `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake

- **Priority**: Low（测试 flake only；不影响 user-facing 行为，仅在并行 suite 高负载下偶发）
- **Status**: Open（调研已展开，**暂未复现**，候选根因 narrowed）
- **Introduced**: 待调研（commit history 显示文件最近一次改动是 v0.7.37 FEATURE_142 `a840f22b`，但 flake 表现实际何时起飞需调研）
- **Created**: 2026-05-16

#### Current Behavior

跑 `npm test` 全套（512 files / 5,935 tests，Windows 并行模式）偶尔出现这个 case 失败；单独 `npx vitest run packages/coding/src/repo-intelligence/runtime.test.ts` 始终通过（5 tests / 288ms）。多次 full-suite 跑结果跳跃（pass → fail → pass）。

**2026-05-16 复现尝试**：连续 5 次 full-suite run **0/5 复现**；本次调研期间反而稳定通过。可能性：
- (a) 本次 PR 加的全局 `vitest.setup.queue.ts` `_resetMessageQueueForTests()` 间接降低了 worker 内 module-state 污染概率（不直接相关但环境变了）
- (b) Flake 本身概率极低（之前 ~6 次中触发 1 次 ≈ 17%），5 次未复现仍可能 just lucky
- (c) 失败模式可能与 specific worker 调度顺序相关，难以稳定 trigger

#### Code Reading 发现的候选根因（**code-read 已确认存在；race trigger 未实证**）

在 [`packages/coding/src/repo-intelligence/runtime.ts:57-62`](../packages/coding/src/repo-intelligence/runtime.ts#L57-L62) 有 **module-level 单例 cache**：

```typescript
const PRETURN_CACHE_TTL_MS = 1_500;
const premiumPreturnCache = new Map<string, { expiresAt: number; promise: Promise<PremiumPreturnResult | null>; }>();
```

Cache key（[runtime.ts:296-305](../packages/coding/src/repo-intelligence/runtime.ts#L296-L305)）由 `mode / endpoint / bin / executionCwd / gitRoot / targetPath / refresh / trace` 组成。

**关键观察**：每个 test 用 `mkdtempSync` 创建独立 `tempDir` → cache key 中 `executionCwd` 不同 → 同文件内 test 间 cache key **理论不冲突**。但：

1. **gitRoot 未在 test context 中显式设**：测试只传 `{ executionCwd: tempDir }`，没传 gitRoot。Cache key 用 `context.gitRoot ?? ''`。但如果 `tryPremiumPreturn` 内部隐式 resolve gitRoot 为 `process.cwd()` 的 git root（在 vitest worker 中是 monorepo root），则**所有 test 共享同一个 gitRoot 段**——但 cacheKey 看的是 `context.gitRoot`，不是 resolved value，所以仍是 ''
2. **Promise 是 cached**（不只 result）：cache 存 `Promise<PremiumPreturnResult | null>`。如果 test A 的 mock 返回的 promise 被存进 cache，test B 复用了同一个 cacheKey（极小可能 — 需要相同 tempDir，几乎不可能），就会拿到 test A 的 mock 结果
3. **`vi.mock('./premium-client.js')` 是 file-scoped**：vitest 的 vi.mock hoist 到文件顶部，正常情况不会跨 file 污染——除非 worker 复用时模块状态部分泄漏

#### 暂不复现 → 暂不修

无法实证复现路径，**贸然修代码风险大于收益**（可能引入新 bug，或修了非 root cause）。建议留作 dormant tracking：
- 后续如再次复现，捕获完整 stderr/stdout + cache 状态 dump
- 在 `beforeEach` 加 `premiumPreturnCache.clear()` 是低成本防御性 fix 但属非测试代码改动；当前不做

#### Workaround

- 跑测试时若复现，单独 `npx vitest run` 该文件验证；不构成实际功能问题
- 若高频复现可在 [runtime.ts](../packages/coding/src/repo-intelligence/runtime.ts) export 一个 `_resetPremiumPreturnCacheForTests()` 并在测试 beforeEach 调用（test helper 模式）—— 同 `_resetMessageQueueForTests` 的做法

#### Related

- Issue 132（同期 known flake，h2-boundary-runner.test.ts）—— 两个 flake 都在 heavy parallel load 下偶发，但失败模式 root cause 不同（132 是 Windows fs visibility，133 是 module cache 假设）
- precedent commit `d4a47bc9`（v0.7.37）—— "logic is sound — single-test runs always pass" 同款判断

---


### 126: tmux 默认不透传 OSC 8 超链接 — kodax 输出中的 file:// / docs URL 在 tmux 内不可点击

- **Priority**: Low
- **Status**: Open（terminal multiplexer 默认配置问题，非 KodaX bug；提供一行 workaround）
- **Introduced**: 一直存在（OSC 8 hyperlink 自 v0.6.x 起被广泛用于 file 路径 / docs 链接）
- **Created**: 2026-04-28
- **Target Version**: 不修复（外部依赖）

#### Background

KodaX 在多处使用 OSC 8 hyperlink escape sequence（`\x1b]8;;<URL>\x1b]8;;\x07`）让支持的终端把 URL 渲染成可点击文本：

- `file://` 链接：edit/read 工具结果中的文件引用
- `docs/...` 路径：诊断消息中指向项目文档的快捷跳转
- 外部 URL：知识/技能链接

主流现代终端（iTerm2、WezTerm、Alacritty、Windows Terminal、Ghostty、VS Code integrated terminal）默认支持 OSC 8。**但 tmux ≤ 3.3 默认开启的"过滤未知 OSC"行为会丢弃所有 OSC 8 序列**，URL 不渲染为可点击，只看到裸文字。

FEATURE_057 Track F（v0.7.30 cell-level diff renderer）评审过程中确认这是 tmux 已知缺省行为，与 KodaX 的渲染层无关——legacy log-update.js 路径同样被影响。

#### Reproduction

1. 在原生终端（iTerm2 / WezTerm / Windows Terminal）运行 kodax，让其输出一条带 `file://` 链接的诊断消息 → 链接显示为带下划线、可 Cmd/Ctrl+点击
2. 进入 tmux session（默认配置），同样运行 → 链接显示为普通文本，鼠标点击无响应
3. `cat` 一段内联 OSC 8 测试串验证：`printf '\e]8;;https://example.com\e\\example link\e]8;;\e\\\n'`

#### Workaround

在用户的 `~/.tmux.conf` 添加一行：

```
set -g allow-passthrough on
```

之后 `tmux kill-server` + 重新 attach 生效。`allow-passthrough` 让 tmux 把它不识别的 OSC/CSI/DCS 序列原样转给底层终端，OSC 8 即被外部终端解析。

注意：`allow-passthrough on` 是 tmux 3.3+ 的设置。tmux 3.2 及以下需要升级或忍受 OSC 8 不可用。

#### Why Not Fix in KodaX

- 关闭 OSC 8 emission 会让所有非 tmux 用户失去可点击链接（占绝大多数）
- 自动 detect tmux 不可靠：`$TMUX` 环境变量在嵌套 SSH / sudo 后可能丢失，且无法判断用户是否已设 passthrough
- terminfo 没有标准化 OSC 8 capability bit，运行时 probe 成本高
- tmux upstream 已在演进 passthrough 默认策略，由 tmux 维护者收敛是更合理的归宿

KodaX 选择记录 known issue + 一行 workaround，让 tmux 用户主动配置。

#### Related

- FEATURE_057 Track F Phase 4 review（v0.7.30）— 在 cell-level renderer 终端兼容性分析中确认该 issue 跨 legacy / cell 路径同形
- `packages/repl/src/tui/substrate/ink/osc.ts` — OSC 8 emit 实现（`link()` / `LINK_END`）
- tmux upstream 讨论：[tmux/tmux#3083](https://github.com/tmux/tmux/issues/3083) passthrough default 历史记录

---
### 125: Thinking-mode cross-provider replay — 三个不可测 OpenAI-compat 与 anthropic 官方 strict mode 待实证

- **Priority**: Low
- **Status**: Open（tracking — 不阻塞发版，记录待实证项以便未来拿到 API key 时回填）
- **Introduced**: v0.7.28（伴随 deepseek V4 thinking-mode 400 修复 + 跨 provider 切换保护工作落地）
- **Created**: 2026-04-26
- **Target Version**: 无固定版本，等可获取的 API key / 实证窗口

#### Background

DeepSeek V4 thinking-mode 修复（v0.7.28）落地了三层保护：

1. **L1**（[openai.ts:807](../packages/llm/src/providers/openai.ts)）：`replayReasoningContent: true` flag 的 provider 把每个 assistant turn 的 `reasoning_content` 字段补齐（默认 `''`），避免 multi-turn 缺字段时 400
2. **L5**（[anthropic.ts:619-645](../packages/llm/src/providers/anthropic.ts)）：strict signature mode 下，缺签名的跨 provider thinking 块转 `<prior_reasoning>` text 注入 ——目的是切到 anthropic 官方时不丢推理痕迹
3. **Kimi guard**（[anthropic.ts:704](../packages/llm/src/providers/anthropic.ts)）：assistant tool_use turn 缺 thinking 块时注入 `{ thinking: '...', signature: '' }` 占位

L1 deepseek V4 路径已实证（直接 API probe 重现 400 + 修复）。但还有三个**未独立实证**的项：

#### Unverified Items

| 项 | 风险 | 现状 |
|---|---|---|
| `kimi` / `qwen` / `zhipu` OpenAI-compat 是否真的拒绝缺 `reasoning_content` 的 replay | 低 — 同字段约定，假设失败模式同形 | v0.7.28 全部 opt-in `replayReasoningContent: true`（按 deepseek 方案 max-tolerance），但**没有 probe 证明该 flag 必要 / 安全**。若任一家对额外字段 strict，会引入新 regression（罕见 — Chinese OpenAI-compat 普遍 lenient on extra fields） |
| Anthropic 官方对历史 thinking 块的签名严格度（L5 strict mode 的真实工作场景） | 极低 — 默认 strict flag 仅对 `anthropic` provider 启用 | 未跑过实测；只在理论上有效。需要 ANTHROPIC_API_KEY 跑一次「带跨 provider thinking history → 切到 anthropic.com」端到端验证 |
| Kimi guard 注入 `{thinking:'...', signature:''}` 是否仍必要 | 低 — 5 个第三方 Anthropic-compat provider（kimi-code / ark-coding / mimo-coding / minimax-coding / zhipu-coding）实测对 (a) 无 thinking 块 / (b) 空 thinking / (c) `'...'` 占位 / (d) 真 thinking 全 LENIENT | guard 当前可能是死代码。删除是独立 cleanup，等再观察 1-2 个版本无人触发后再做 |

#### Reproduction（待补）

各项需要的实证步骤：

1. **kimi/qwen/zhipu OpenAI-compat 严格度**：用对应的 `KIMI_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY`（注意：用户当前持有的 `ZHIPU_API_KEY` 是 `zhipu-coding` 的 Anthropic-compat 端点 key，不是 `zhipu` OpenAI-compat 的；`KIMI_API_KEY` 同理与 `kimi-code` 不同）跑 `c:/tmp/openai-compat-tool-calls-probe.mjs`，看 (II.omit) vs (II.empty) 是否复现 deepseek 的 400/200 模式
2. **Anthropic 官方 L5 strict**：用 `ANTHROPIC_API_KEY` 构造一段含「signature 缺失或不可信的 thinking block」历史，切到 `anthropic` provider 重发，观察是否真按 strict 拒绝 → 验证 `<prior_reasoning>` text 转换路径
3. **Kimi guard**：监控生产 trace，若 1-2 版本内无人在含 tool_use 的 anthropic-compat 历史上触发该 guard 注入路径，可视为死代码删除

#### Workaround / Acceptance

当前 v0.7.28 接受这三项 known limitation：
- kimi/qwen/zhipu OpenAI-compat：opt-in 失败的 risk 低（同协议族 lenient on extra fields），收益大（max-tolerance），用户报障再回退
- Anthropic 官方 L5：默认行为正确（pass-through with 空签名），strict mode 是额外保护层，最坏情况是退回 pre-v0.7.28 行为
- Kimi guard：保留无害；观察期满后再删

#### Related

- 修复 commit 链：L0 错误史保护（runner-driven.ts:2679）/ L1 reasoning_content always-attach（openai.ts:807）/ L3 sanitize_thinking_and_retry recovery action / L5 cross-provider thinking conversion（anthropic.ts:619-645）/ Kimi guard（anthropic.ts:704）
- [v0.7.28.md FEATURE_087/088 Risk 节](features/v0.7.28.md) 同一限制条目
- 经验性证据矩阵：deepseek V4 直接 API probe 已重现 400 + 修复确认；5 个 Anthropic-compat provider 4 种 thinking shape 全 LENIENT；其余维度未测

---
### 124: AMA 子 Agent dispatch 实际触发率偏低 — Controller fanout gate + H1 工具白名单串联收得过紧

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.18 / v0.7.19（FEATURE_067 / 047 / 052 落地时定的保守门槛）
- **Created**: 2026-04-26
- **Target Version**: v0.7.28（unreleased，与本次 prompt+gate 调整同期）

#### Current Behavior

`dispatch_child_task` 工具（FEATURE_067）和 fan-out scheduler（FEATURE_047）已经在 v0.7.18-v0.7.19 落地并通过测试，但**真实运行中子 Agent 派发频率明显低于预期**。表现：

- H1 普通改代码任务：Generator 看不到 `dispatch_child_task` 工具（白名单未包含），无法并行修改多个独立模块
- H1 read-only 调研任务：Scout 升级到 H1 后 controller 的 `fanout.admissible` 立刻变 false，Scout fan-out 提示被关闭
- H2 写多模块任务：`hypothesis-check` fanout class 在 controller 里硬编码 `return false`，Generator 即使在 H2 也得不到 fanout 提示
- Plan / systemic 任务的调研阶段：`profile === 'tactical'` 一刀切，managed profile 完全没有 fan-out 路径

#### Expected Behavior

子 Agent dispatch 是已交付能力，应当在能提升效率的场景被自然激活：

- H1 read-only 调研：Scout 和 Generator 都能在多目标场景派 read-only child
- H2 多模块写入：Generator 能在独立模块改动时派 write child（已有 worktree 隔离机制）
- Plan / systemic 调研：Scout / Planner 能并行调研多个模块作为决策输入

但**不能**强制并行——Rule A/B/C prompt 仍由 LLM 自主判断，gate 只负责"capability available"。

#### Reproduction

观察任意真实多模块任务的 KodaX session：

1. `kodax "审查 packages/llm 和 packages/coding 的安全问题"` —— 触发 H1 review-only 路径，Scout 会 fan-out（这条路径正常）
2. `kodax "在 packages/llm、packages/agent、packages/coding 三个独立模块各加一个空函数"` —— 触发 H2 write，但 Generator 不会派 write child（hypothesis-check 硬编码 false）
3. `kodax "重构 task-engine 的 H1/H2 路由逻辑"` —— 触发 managed profile（`requiresBrainstorm + code` 命中），即使是 read-only 调研阶段也拿不到 fan-out 提示

#### Root Cause（已通过 isolated eval 实测确认）

实测证据：`tests/dispatch-prompt-comparison.eval.ts` 在 zhipu-coding / minimax-coding / deepseek 三家 provider 上，**给 LLM 看到 `dispatch_child_task` 工具 + 现有 RULE A/B/C prompt 的隔离环境下，T1（fan-out）任务全部正确触发 3 child，T2（不该派）全部正确不派，T3（context preservation）多数正确**。说明 LLM 知道何时该派——**问题不在 prompt，在 gate**。

现状的 4 层串联 gate（任一层关上即 0 触发）：

**Layer 1 - Controller fanout class gate**（[reasoning.ts:1098-1133](../packages/coding/src/reasoning.ts)）：
- `evidence-scan`（bugfix/investigation read-only）只在 `harnessProfile === 'H0_DIRECT'` 启用，H1/H2 一律关闭
- `module-triage`（lookup）同上
- `hypothesis-check`（write 类）硬编码 `return false`
- 只有 `finding-validation`（review）永远开

**Layer 2 - Profile filter**（[reasoning.ts:1158](../packages/coding/src/reasoning.ts)）：
- `profile === 'tactical'` 一刀切。plan / systemic / brainstorm 任务的 managed profile 直接屏蔽 fan-out

**Layer 3 - H1 工具白名单**（V1 chain 时期分析；FEATURE_193 (v0.7.43) 已 retire 整层）：
- 初步分析以为"H1 Generator 在非 review-only 路径下拿不到 `dispatch_child_task`"，但**实地核对后是误判**：
  - 当时 `H1_READONLY_GENERATOR_ALLOWED_TOOLS` 数组本身已经包含 `dispatch_child_task`（该常量在 FEATURE_193 v0.7.43 退役 V1 Planner / readonly Generator 时被删）
  - 非 review-only / 非 docs-scoped 的默认 H1 路径返回 `undefined`，没有 `allowedTools` 过滤，全工具可用
  - 当时 Generator agent 的 tools 数组无条件包含 `generatorDispatch`（FEATURE_193 v0.7.43 退役 V1 chain agent declarations 时删除）
- 既有测试 `Shard 6d-Q — dispatch_child_task exposed to Scout + Generator only` 已经覆盖这个不变量（FEATURE_193 retire 后测试也已迁移到 Worker）
- **本层无 fix 工作**（A3 移除）。V2 Worker 直接拿全工具集，不走 allow-list 路径。

**Layer 4 - 缺乏 telemetry**（[dispatch-child-tasks.ts](../packages/coding/src/tools/dispatch-child-tasks.ts)）：
- 现有 `onToolUseStart` 已记录 LLM 端的"我要派 child"，但缺乏 child 完成的状态 + 耗时聚合
- 改完无法度量"触发率上升了多少 / 平均耗时 / 有没有过头"
- 解决路径：复用工具内已有的 `ctx.reportToolProgress`（KodaXEvents 标准事件），在入口和出口加结构化标记行，无需引入新类型

#### Proposed Solution（v0.7.28 切片）

**Prompt 层（最小化）**：
- A5b：在 Scout 和 Generator 的 RULE C 后追加 "When NOT to use" 否定清单 4 条（参考 Claude Code / opencode 的 negative-bumper 风格）。**已实测无回归**。
- 不重写 RULE A/B/C 结构（实测说明对国产 coding 模型 RULE 标签是有效 anchor）

**Gate 层（核心修复）**：
- A1：`evidence-scan` 解锁到 H1 + read-only（去掉 `harnessProfile === 'H0_DIRECT'` 限制）
- A2：`hypothesis-check` 解锁到 H2_PLAN_EXECUTE_EVAL（去掉硬 `return false`）
- ~~A3~~：实地核对后**phantom problem**，Generator 一直能 dispatch_child_task，无 fix 工作
- B1：`profile === 'tactical'` 改为对 read-only fanout class 不限制 profile，对 hypothesis-check 仍要求 tactical（精确放开，避免一刀切）

**Telemetry 层（验证手段）**：
- A4：在 `dispatch-child-tasks.ts` 入口和出口通过现有 `ctx.reportToolProgress` 发送结构化标记行（`[dispatch] start childId=... readOnly=...` / `[dispatch] end childId=... status=... duration_ms=...`）。**复用既有 KodaXEvents 通道，零新类型、零新 logger**。session transcript 自动持久化，未来 `grep '\[dispatch\]'` 可聚合"改完之后触发率上升了多少 / 哪些任务派了几个 / 平均跑多久 / 是否过头"。

**Provider/model 行为差异（实测发现）**：
跨 provider × 跨 deepseek 模型档位的 dispatch 行为不完全一致——这是模型本身的特性，不是 prompt 缺陷：
- `zhipu-coding (glm-5.1)` / `minimax-coding (M2.7)` / `deepseek-v4-flash`：T1 fan-out 全部 100% 直接派 child
- `deepseek-v4-pro`：60% 直接 fan-out，40% 先 glob 侦察再下一轮 dispatch（v4-pro 是深度推理档，"scope-first" 是合理特性，**不是漏 dispatch**——延迟一轮而已）
- `deepseek-chat`（已废弃，2026-07-24 deprecate）：40% 直接 fan-out，因模型问题不是 prompt 问题
T3（context preservation 单 child）所有 provider 都有概率走"先 grep 再 dispatch"的多轮路径——这是合理 strategy（先看搜索结果再决定要不要 child），不是回归。

**Follow-up（不在本次切片）**：
- B2：Scout opportunity scan 字段（实测说明非紧急）
- B3：Rule B 的 `≥10 file reads` 数字调整（实测说明 LLM 用语义不用数字，无害）
- A2 pre-Scout 限制：`buildAmaControllerDecision` 用的是 routing heuristic 预测的 `harnessProfile`（不是 Scout 确认值）。本次依靠 Generator role-prompt 里的 post-Scout 二次 gate（[role-prompt.ts:608-610](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)）兜底，但 controller 信号在"routing 预测 H1 / Scout 升 H2"路径上仍是关闭的——后续若 telemetry 数据显示该路径有真实需求，可考虑改为 post-Scout 重算 `activeFanoutClass`

#### Acceptance Criteria

Issue 124 关闭条件：
1. v0.7.28 发布后跑过的真实 session 中，`grep '\[dispatch\] start' ~/.kodax/sessions/*/transcript*` 出现非零结果——证明 telemetry 路径通
2. 上述结果至少覆盖一种之前关闭的路径（H1 read-only 调研 / managed profile 调研 / H2 write hypothesis-check 至少一种）——证明 gate 解锁实际生效
3. 没有 user-reported "误派 child / token 飙升" 回归——证明 R5 风险（过度并行）未兑现

不需要硬性"触发率提升 X%"指标，因为没有可信的 baseline（改之前 telemetry 不存在）。改完用绝对触发数 + 主观体感判断即可。

#### Context

- [reasoning.ts:1098-1186](../packages/coding/src/reasoning.ts)（fan-out class gate + buildAmaControllerDecision）
- [tool-policy.ts:362-394](../packages/coding/src/task-engine/_internal/managed-task/tool-policy.ts)（H1 Generator allowedTools）
- [role-prompt.ts:476-499](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)（Scout dispatch_child_task prompt）
- [role-prompt.ts:572-595](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)（Generator dispatch_child_task prompt）
- [tests/dispatch-prompt-comparison.eval.ts](../tests/dispatch-prompt-comparison.eval.ts)（prompt 实测基线，3 providers × 3 variants × 3 tasks）
- [tests/dispatch-prompt-deepseek-variance.eval.ts](../tests/dispatch-prompt-deepseek-variance.eval.ts)（deepseek 跨模型方差探针：v4-flash 100% / v4-pro 60% / chat 40% 直接 fan-out）

#### References

- FEATURE_067 Child Agent Execution（v0.7.18 完成）
- FEATURE_047 Invisible Adaptive Parallelism（v0.7.19 完成）
- FEATURE_052 Dual-Profile AMA Harness and Child Fan-Out Boundaries（v0.7.19 完成）
- 用户反馈：现实际使用中子 Agent 触发频率明显偏低
- 跨家 prompt 风格对比：Claude Code（Agent tool, 4 层结构）、opencode（task tool, "Use 1 / Use multiple" 场景对照）、pi-mono（subagent extension, single/parallel/chain mode 参数）

---

### 122: edit / multi_edit 错误消息在 v0.7.26 过度精简 — 丢失关键信息载体导致 LLM 恢复失败

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.26
- **Fixed**: -
- **Created**: 2026-04-23
- **Resolved**: -
- **Target Version**: v0.7.27（修复已 commit `4423e0d` 于 KodaX 分支，等待随 v0.7.27 发布）

#### Current Behavior

v0.7.26 在 commit `ef085fc` 里为降低 token 开销对 `edit` / `multi_edit` 的错误消息和工具描述做了精简，但与此同时也把若干**信息载体**（不是脚手架）砍掉了。对**强模型**（Claude Opus / Sonnet / GPT-4 级）影响小，但对**中档模型做 Scout**（Kimi / MiniMax / Zhipu 的 capped-budget 档，正是 AMA 里 Scout 的常见模型）会观察到错误消息不足以帮它自恢复：

- **ambiguous-match 缺具体示例**：原消息 `"(a heading, function name, or distinctive comment)"` 被砍 → LLM 不知道什么算"nearby unique context"，可能选随意文本作为 widen 的依据
- **`"Do NOT just shorten"` 的 scope limiter `"just"` 被砍**：变成 `"(Shorter anchors match more, not fewer.)"` 这类范畴判断 → 可能被 LLM 误应用为"任何场景都不要缩短"
- **not-found 错误丢了第二个备选诊断**：原文里 `"...whitespace drift vs the actual file, OR it was never in the file to begin with"` 的 `OR` 分支被砍 → 当 LLM 实际**幻觉**了 anchor 时，它会无限尝试"再读更宽窗口找精确文本"而永远找不到
- **anchor-consumed 诊断语气削弱**：原文 `"is present in the original file but was consumed by..."` 告诉 LLM "你的 anchor 本来对了，问题在另一个 edit"；精简版 `"anchor was consumed by ..."` 读起来像普通失败
- **ANCHOR WARNING 丢了触发语**：原文 `"If later edits need to reference text an earlier edit overlaps..."` 的前置条件被砍 → 规则从"if-then 识别"变成"plain fact"，触发概率下降
- **UNIQUENESS RULE 丢了具体尺寸和示例**：`"#1 cause"` 框架、`"a 6-line window"` 具体尺寸、`"multi-line block"` 示例都被砍

#### Expected Behavior

错误消息在保持 token 经济的前提下**不丢信息载体**。具体来说，具体示例 / scope limiter / 幻觉备选诊断 / diagnostic framing / 触发条件应该全部保留——纯脚手架（`Either (a) ... or (b) ...` 外壳 / `"on that edit if all matches should change"` 等冗余从句）是可砍的。

一次恢复失败造成的额外 retry 成本（几百至几千 tokens）远大于保留这些信息载体的 per-error 成本（每条错误 <25 tokens）。

#### Reproduction

观察到的触发场景（2026-04-23 实际会话）：

```
✗ [Scout] multi_edit (failed)
  edits[1] old_string not found. ...Re-read the file and retry with a stable anchor.

Scout → read - offset=226 - limit=6   # 窄 6 行重读

✗ [Scout] multi_edit (failed)
  edits[1] matched 2 places. Retry with a unique anchor or set replace_all=true on that edit.
```

Scout 的 6 行窄重读在整文件里产生歧义 anchor；v0.7.26 的错误消息**既没提示窄读陷阱，也没提示 anchor 可能根本不在文件里**，Scout 只能盲猜继续。

#### Root Cause

Commit `ef085fc` 把 V1 精简到 V2 时没区分"信息载体"和"脚手架"，整体砍。具体对照：

| 被砍内容 | 作用类别 | 是否该保留 |
|---|---|---|
| `Either (a) ... or (b) ...` 枚举外壳 | 脚手架 | 可砍 |
| `"on that edit if all matches should change"` 从句 | 脚手架 | 可砍 |
| `"at lines"` → `"lines"` | 脚手架 | 可砍 |
| `"This aborts the whole batch — no edits have been applied"` | 冗余（tool description 已有） | 可砍 |
| **`"(a heading, function name, or distinctive comment)"`** | **信息载体** | **必保留** |
| **`"Do NOT just shorten"` 里的 `just`** | **scope limiter** | **必保留** |
| **`"OR it was never in the file to begin with"`** | **幻觉备选诊断** | **必保留** |
| **`"is present in the original file but was consumed"`** | **diagnostic framing** | **必保留** |
| **ANCHOR WARNING 的 `"If later edits need to reference..."`** | **触发语** | **必保留** |
| **UNIQUENESS RULE 的 `"#1 cause"` / 具体尺寸 / `"multi-line block"`** | **具体示例** | **必保留** |

#### Proposed Solution

已在 commit `4423e0d`（KodaX 分支本地，未发布）里**选择性回填**所有信息载体，保留所有脚手架的精简。应用对象：`edit.ts` + `multi_edit.ts` + `registry.ts`，并同步更新 `edit.test.ts` / `multi-edit.test.ts` 断言。

- 净开销：4 个错误消息 +~280 chars（平均 +70/条），工具描述 +~130 chars（session 级缓存）
- 等价 token：每次错误 <25 tokens
- 验证：29/29 edit+multi_edit 测试绿，`tsc --noEmit` 干净

**关闭条件**：v0.7.27 tag 推出时由 `4423e0d` 随版本发布 → 将本 issue 标为 Resolved，Fixed 字段填 v0.7.27。

#### References

- v0.7.26 原精简 commit: `ef085fc fix(coding): enrich edit / multi_edit errors with locations + narrow-read hints`
- 回填 commit（本地未发布）: `4423e0d fix(coding): restore information-carrying detail in edit/multi_edit error messages (bundled for v0.7.27)`
- 相关文件: `packages/coding/src/tools/{edit,multi-edit,registry}.ts` + 对应 `*.test.ts`
- 原 review 建议（要求"少 token"）：v0.7.26 发布前对话上下文

---

### 120: Skill / Plan-mode 调用路径下流式注入 prompt 失效 — `canQueueFollowUps` 未开启

- **Priority**: High
- **Status**: Open
- **Introduced**: 一直存在（自 v0.6.0 引入队列功能起，非主对话路径就未接入）
- **Fixed**: -
- **Created**: 2026-04-20

- **Update 2026-05-04 (FEATURE_110, v0.7.34)**: plan-mode 路径 1 已整体删除（`runWithPlanMode` / `/plan` slash 命令 / `[planMode, setPlanMode]` state 全部移除），本 issue 现仅剩 skill / prompt 调用一条路径。skill 路径已在 v0.7.24 (Issue 121) 顺手补了 `setCanQueueFollowUps(true)` 包裹（[InkREPL.tsx:6237-6239](../packages/repl/src/ui/InkREPL.tsx#L6237-L6239)），需独立验证是否完全闭合。

- **Original Problem**:

  用户通过 `/skill:...`（例如 `/skill:smart-changelog`）或 plan-mode（已于 v0.7.34 删除）触发 agent 执行期间，在流式过程中按 Enter 想排队追加下一条 prompt，会出现：

  - 输入栏字符被吞（由 [prompt-input-controller.ts:251-252](../packages/repl/src/ui/utils/prompt-input-controller.ts#L251-L252) 无条件 `clear()` 导致）
  - 底部 `QueuedCommandsSurface` 无排队提示
  - 输入栏占位符显示 `Agent is busy...`（不是 `Queue a follow-up...`）

  按占位符映射 [surface-liveness.ts:66-71](../packages/repl/src/ui/view-models/surface-liveness.ts#L66-L71)：`busy` = `isLoading=true` + `canQueueFollowUps=false`。证实 `handleSubmit` 在 [InkREPL.tsx:5849](../packages/repl/src/ui/InkREPL.tsx#L5849) 的 `if (!canQueueFollowUps) return;` 命中，输入被静默丢弃。

- **Context**:

  **三条"agent 执行"路径，只有一条开启队列**：

  | 入口 | 调用 | `canQueueFollowUps` |
  |---|---|---|
  | 普通对话（[InkREPL.tsx:6518](../packages/repl/src/ui/InkREPL.tsx#L6518)） | `runQueueableAgentSequence` → 内部 `setCanQueueFollowUps(true)` | ✅ true |
  | Skill / prompt 调用（[InkREPL.tsx:6349](../packages/repl/src/ui/InkREPL.tsx#L6349) → `executeInvocation` 内 [:5763](../packages/repl/src/ui/InkREPL.tsx#L5763)） | 直接 `runAgentRound` | ❌ false |
  | Plan mode（[InkREPL.tsx:6466](../packages/repl/src/ui/InkREPL.tsx#L6466)） | 直接 `runWithPlanMode` | ❌ false |

  另有 `executeInvocation` 内的 plan-mode 子分支（[InkREPL.tsx:5749-5753](../packages/repl/src/ui/InkREPL.tsx#L5749-L5753)）同样未接入。

  **为什么 v0.7.22/v0.7.23 才被察觉**：代码路径一直是这样。用户升级后开始频繁使用 `/skill:` 命令（如 `smart-changelog`），才撞上这个一直存在的盲区。queue 代码本身自 v0.7.20 未变。

  **另有一条独立路径**（同 issue 另一病灶，当 `isLoading=false` 但屏幕仍在流式时）尚未完全复现，需后续追查——本 issue 先闭合可确诊的这一条。

- **Planned Resolution**: **B-全（修"不丢 + 自动续"）**

  **方向**：不做 v0.7.30/v0.8.0 预告的"REPL substrate 重写"（那是大工），只在 skill / plan-mode 两条旁路上**对齐普通对话路径的队列语义**：

  1. 流式期间允许入队（`canQueueFollowUps=true`）
  2. 本轮结束后自动 drain 队列，每条作为后续对话轮执行

  **改动点**（约 30 行集中在 [InkREPL.tsx](../packages/repl/src/ui/InkREPL.tsx)）：

  1. **新增 helper `drainPendingInputsAsFollowUps`**（紧邻 `runQueueableAgentSequence` 之后）
     - 从 `streamingState.pendingInputs` 取第一条
     - 通过 `stageQueuedPrompt` 补 UI 前置
     - 调 `runQueueableAgentSequence` 用这条作 initialPrompt，它内部会 drain 后续所有

  2. **包一层 `setCanQueueFollowUps(true)` / `finally` `setCanQueueFollowUps(false)` 到 `executeInvocation`**
     - 现有 try/catch 结构保留
     - 外层 finally 关闸
     - 正常返回路径后调 `drainPendingInputsAsFollowUps`；抛错路径不 drain（队列保留到用户下一次提交时 drain，与主路径失败行为一致）

  3. **同样模式应用到 handleSubmit 的 plan-mode 分支**（[InkREPL.tsx:6459-6500](../packages/repl/src/ui/InkREPL.tsx#L6459-L6500)）
     - 在 `setIsLoading(false)` 之前 drain，保证 drain 期间仍有 loading 状态

  **不做的事**（刻意保持边界窄）：
  - 不碰 `runQueueableAgentSequence` 本身
  - 不改 `handleSubmit` 的主结构
  - 不碰 `runAgentRound` / task-engine / 任何 coding 层代码
  - 不做 plan-mode-aware drain（drained follow-ups 走普通 agent round，与主路径一致）

  **与 v0.7.30/v0.8.0 roadmap 的关系**：FEATURE_055 "REPL Substrate Hardening" 会重写整个 submit / queue / surface 层。本补丁是"**撑到 v0.7.30**"的战术修复——集中在两处 wrapper，届时随 InkREPL 被抽薄自然被 prune。

  **测试**：
  - 人工 e2e：`/skill:smart-changelog` 流式中按 Enter → 底部排队提示出现 → 命令结束后自动跑该 prompt
  - plan-mode 同路径验证
  - 回归：`packages/repl/src/ui/utils/queued-prompt-sequence.test.ts` 仍绿（不动 sequence 核心）

---
### 119: Scout 升级 H0→H1 后残留 pre-Scout mutationSurface — Generator 被错误锁为 docs-only

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.20（结构性遗留，v0.7.20 修复了 harness/ceiling 两条残留通道后暴露）
- **Fixed**: -
- **Created**: 2026-04-19

- **Original Problem**:

  Scout 把任务从 H0 升级到 H1 后，Generator 的系统提示仍带着 `This H1 run is docs-only. Restrict any edits to documentation artifacts.` 这种约束，导致 Generator 看到用户明确要求（例如"补测试"、"把完成状态挪到对应版本"）也不敢修改测试文件或代码，只能改文档。真实会话中出现过：用户要求补测试 + 同步 FEATURE_LIST.md + 调整版本归属，Scout 已升级到 H1，Generator 仍只做了文档侧编辑、跳过测试。

  本质是 `plan.decision.mutationSurface` 这个字段**同时承担了两个语义**：
  1. Scout **前**：正则启发（`deriveMutationSurface` on original prompt）推出的粗糙上界，给 Scout 当参考
  2. Scout **后**：下游 Generator / fan-out scheduler 读来判断"允许改动面"

  Scout 可以覆盖 `confirmedHarness`（commit `3efdb7b` 已修 clamp bug）和 `upgradeCeiling`（commit `fa4708f` 已修 evaluator 读旧 ceiling），但 `mutationSurface` 从没被 Scout 覆盖过的渠道——升级后仍然是 pre-Scout 的正则残留值。这是"升级后残留"这条主线 bug 的第三条通道。

- **Context**:

  **触发路径**：
  - [packages/coding/src/reasoning.ts:2275](../packages/coding/src/reasoning.ts#L2275) — `deriveMutationSurface` 基于原始 prompt 文本做正则匹配，把 `plan.decision.mutationSurface` 初始化为 `docs-only` 等值
  - [packages/coding/src/task-engine.ts:951-1011](../packages/coding/src/task-engine.ts#L951-L1011) — `applyScoutDecisionToPlan` 只同步 `harnessProfile` 和 `upgradeCeiling`，**从不触碰** `mutationSurface`
  - [packages/coding/src/task-engine.ts:3096-3104](../packages/coding/src/task-engine.ts#L3096-L3104) — Generator 的 `h1MutationGuardance` 读 `decision.mutationSurface`，看到旧的 `docs-only` 就把 Generator 锁死

  **相关下游读点**（同样读 pre-Scout 残留值）：
  - [task-engine.ts:1743-1744](../packages/coding/src/task-engine.ts#L1743-L1744) — fan-out scheduler 判 read-only/docs-only
  - [task-engine.ts:2567, 2578](../packages/coding/src/task-engine.ts#L2567-L2578) — `createRolePrompt` 的 H1 分支
  - [task-engine.ts:2915](../packages/coding/src/task-engine.ts#L2915) — 元数据打印
  - [task-engine.ts:3401](../packages/coding/src/task-engine.ts#L3401) — 传给 `createRolePrompt`

  **相关已修复 commits**（同类 bug 的另外两条通道）：
  - `3efdb7b fix(task-engine): trust Scout routing authority, fix ceiling clamp context-loss bug`
  - `fa4708f fix(task-engine): evaluator prompt uses effective ceiling, not stale heuristic`

  这两个 commit 修了 harness/ceiling 的残留，但漏了 `mutationSurface`。本 issue 闭合最后一条通道。

- **Planned Resolution**:

  **方向**：单一真理源 + 轻推断。不加新字段、不加 validator、不加 retry、不改 Scout prompt。让下游停止信任 Scout 前的启发式字段，改读 Scout 自己的结构化输出。

  **为什么不走"让 Scout 多声明一个字段 + 升级时强制要求"路线**：
  - 违背 KodaX 极简 + 智能哲学，把"LLM 该自己判断"的事变成"schema 枷锁 + retry 循环"
  - 反而把 bug 换方向：未声明时如果 auto-relax 到 `code`，纯 review 任务又会被错误放开
  - Scout 的 `scope` / `reviewFilesOrAreas` / `primaryTask` 已经携带了比"一个 enum 值"更精确的意图信息，不需要再加一个冗余字段

  **具体改动**（半天量）：

  1. **新增纯函数 `inferScoutMutationIntent(scout, primaryTask)`**（约 20 行）
     返回三档：`'review-only'` / `'docs-scoped'` / `'open'`
     - `primaryTask === 'review'` 且 `scope` 为空 → `review-only`
     - `scope ∪ reviewFilesOrAreas` 全部匹配 `*.md`/`docs/`/`CHANGELOG` 等文档路径 → `docs-scoped`
     - 其它 → `open`（默认开放，信任 Scout scope + Evaluator 兜底）

  2. **替换 [task-engine.ts:3096-3104](../packages/coding/src/task-engine.ts#L3096-L3104) 的 `h1MutationGuardance`**
     改读 Scout 的 directive 而非 `decision.mutationSurface`；语气从"restrict/do not mutate"改成"unless ... asks for fixes"的软引导；`open` 档不加任何约束

  3. **迁移或删除另外 4 处下游读点**
     [task-engine.ts:1743-1744, 2567, 2578, 3401](../packages/coding/src/task-engine.ts) — 或迁移到同一推断，或直接删除该分支（依赖 Scout scope + Evaluator 作为自然约束）
     [task-engine.ts:2915](../packages/coding/src/task-engine.ts#L2915) 元数据打印保留，但改为打印 Scout 推断结果

  4. **保留不动的东西**
     - `KodaXManagedScoutPayload` 结构、Scout prompt、validator、parser、persistence schema 全部不动
     - `plan.decision.mutationSurface` 字段本身保留（`reasoning.ts` 内部仍用它推 `topologyCeiling`），只是**下游 H1+ 路径不再读它**
     - `applyScoutDecisionToPlan` 不动（或仅加一条 routing note 声明"下游已走推断"）

  5. **测试**
     - `inferScoutMutationIntent` 纯函数单测（3 档各 1-2 例）
     - 3 个核心回归（task-engine.test.ts）：
       * Scout H0→H1 升级 + 原启发式为 `docs-only` → Generator prompt 不再含"docs-only"字样
       * Scout H1 review 任务（scope 空）→ Generator prompt 含 review-only 软引导
       * Scout H1 纯文档任务（scope 全 .md）→ Generator prompt 含 docs-scoped 软引导
     - 手工 e2e：重跑触发此 bug 的那类 docs + tests 组合任务，确认 Generator 能改 test 文件

  **风险与代价**：
  - Scout `scope` 描述粒度粗时（如 `packages/coding/src`），`isDocsLikePath` 会判失败，推断落 `'open'` → 这是正确行为，不算退化。极简原则下信任 Scout scope 本身 + Evaluator 兜底，不要硬收紧
  - 现有依赖 `decision.mutationSurface === 'docs-only'` 的测试会需要更新（因为下游不再读它）——这反映的是语义修复，不是回归

  **为什么不选其他方案**：
  - ❌ Scout payload 新增 `confirmedMutationSurface` + fail-loud retry：违背极简哲学，加枷锁；retry 烧 token 且体验不自然；弱模型缺省会频繁失败
  - ❌ Scout 升级未声明时 auto-relax 到 `code`：方向错了，会把纯 review 任务错误放开，比现状还危险
  - ❌ 拆 `heuristicMutationSurface` / `mutationSurface` 双字段：结构上更干净，但 7+ 处读点要迁移 + 持久化 schema 扩字段 + 旧快照迁移，scope 太大，收益被推断方案覆盖
  - ❌ 只做最小补丁（Scout 覆盖时同步清 `mutationSurface`）：治标不治本，下次再有"Scout 前 vs Scout 后"冲突字段还会复发

---
### 112: ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式 (RESOLVED)

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.18
- **Fixed**: v0.7.62
- **Created**: 2026-04-12
- **Resolved**: 2026-07-06

- **Original Problem**:

  `ask_user_question` 的 Select 对话框存在两个根本性缺陷：

  **缺陷 1 — 数字编号歧义（当前最严重的体验问题）**

  KodaX Select 使用"输入数字编号 + 按 Enter"选择方式（`InkREPL.tsx` L4152-4196）。当 LLM 的文字输出中也包含编号列表时（如 smart-changelog 列出的步骤 1-6），用户会混淆"步骤编号"和"选项编号"：

  ```
  [LLM 的文字输出]
  步骤 1: Update CHANGELOG.md
  步骤 2: Sync version
  步骤 3: Create Git Tag
  ...

  [Select 对话框]
  1. 步骤 1,2,3      ← 用户以为按 1 = 选步骤 1
  2. 步骤 1,2,3,4    ← 用户按 2 以为 = 选步骤 2，实际选了这个组合
  3. 全部执行
  ```

  Claude Code 使用**上下箭头导航 + Enter 确认**模式（`CustomSelect/use-select-navigation.ts`），聚焦项显示 `❯` 指针，完全避免了数字编号歧义。

  **缺陷 2 — 缺少 input 和 multiSelect 模式**

  KodaX `ask_user_question` 只有单选列表一种交互模式。Claude Code 提供三种：
  - **单选**（默认）：上下导航 + Enter
  - **multiSelect**：空格键切换选中/取消，✓ 标记已选项，Enter 提交全部选择
  - **input 类型选项**：Tab 键展开自由文本输入，用户可输入任意内容

  缺少后两种模式导致：组合选择场景（如 "选择步骤 1,3,5"）LLM 被迫将组合打包为预设选项；用户无法自行输入任意组合。

- **Context**:

  **KodaX 现有实现**：
  - 工具定义：`packages/coding/src/tools/registry.ts` L420-462 — `required: ['question', 'options']`
  - 工具实现：`packages/coding/src/tools/ask-user-question.ts` — 始终走 `ctx.askUser()` → Select 路径
  - REPL Select 交互：`packages/repl/src/ui/InkREPL.tsx` L4152-4196 — 数字输入 + Enter
  - UI 已有 Input 对话框：`showInputDialog()` 支持自由文本 + 默认值，但 `ask_user_question` 无法触发

  **Claude Code 参考实现**（`C:\Works\claudecode`）：
  - `CustomSelect/use-select-navigation.ts` — 基于 reducer 的焦点管理，支持 up/down/pageUp/pageDown
  - `CustomSelect/use-select-input.ts` L241-282 — 数字键快捷选择（可通过 `disableSelection: 'numeric'` 禁用）
  - `CustomSelect/select-option.tsx` — `ListItem` 渲染：`❯` 聚焦指针 + `✓` 选中标记
  - `AskUserQuestionTool.tsx` L19-23 — schema 包含 `multiSelect?: boolean`
  - `use-multiple-choice-state.ts` — 完整的多问题 + 多选状态管理
  - `keybindings/defaultBindings.ts` L319-330 — Select 上下文绑定：up/down/j/k/enter/escape/space

  **影响范围**：所有需要自由文本/组合输入的 skill（smart-changelog, monorepo version-strategy 等）

- **Planned Resolution**:

  **分两阶段实施，第一阶段解决最紧迫的数字歧义问题：**

  **Phase 1：Select 从数字输入改为上下导航（高优先级）**

  将 Select 对话框从"输入数字编号"改为 Claude Code 风格的"上下箭头导航 + Enter 确认"：

  1. **DialogSurface 渲染层**：
     - 选项不再显示 `1. xxx`，改为 `❯ xxx`（聚焦项）/ `  xxx`（非聚焦项）
     - 追踪 `focusedIndex` 状态，随箭头键更新
     - 选中项右侧显示 `✓`

  2. **Keypress handler 改造**（`InkREPL.tsx` L4152-4196）：
     - `↑` / `k` → 上移焦点
     - `↓` / `j` → 下移焦点
     - `Enter` → 确认当前聚焦项（替代数字 + Enter）
     - `Escape` → 取消
     - 数字键保留为**快捷键**直接选中（按 `2` 直接确认第 2 项，不需再按 Enter），但不是主交互方式

  3. **Select 状态提升**：将 `focusedIndex` 加入 `uiRequest` state，让 DialogSurface 能渲染焦点指针

  这一步完全消除数字编号歧义——用户通过视觉焦点指针明确知道选的是哪一项。

  **Phase 2：新增 multiSelect + input 模式（中优先级）**

  1. **multiSelect 模式**：
     - `ask_user_question` schema 新增 `multiSelect?: boolean`
     - 空格键切换当前聚焦项的选中/取消，`✓` 标记已选项
     - Enter 提交所有已选项，返回逗号分隔的 value 列表
     - 解决"选择步骤组合"场景，用户按空格自由勾选任意步骤

  2. **input 模式**：
     - `ask_user_question` schema 新增 `kind?: "select" | "input"`
     - `kind: "input"` 时走 `showInputDialog(question, default)`
     - 用户可自由输入任意文本（如 "1,3,5" 或 "all"）
     - `options` 在 input 模式下变为可选

  3. **返回格式**：
     - 单选：`{"success": true, "choice": "selected_value"}`
     - 多选：`{"success": true, "choice": "value1, value2, value3"}`
     - 输入：`{"success": true, "choice": "<用户自由输入>"}`

  具体改动文件：
  - `packages/repl/src/ui/components/DialogSurface.tsx` — 渲染焦点指针 + 选中标记
  - `packages/repl/src/ui/InkREPL.tsx` — keypress handler 改造 + multiSelect/input 路由
  - `packages/coding/src/tools/registry.ts` — schema 增加 `multiSelect`, `kind`
  - `packages/coding/src/tools/ask-user-question.ts` — 按 kind/multiSelect 分流
  - `packages/coding/src/types.ts` — `AskUserQuestionOptions` 增加新字段

  **为什么不选其他方案**：
  - ❌ 只加 input 模式不改 Select：不解决数字歧义根因，单选场景仍有问题
  - ❌ 只改 skill prompt：无法解决工具能力缺失，LLM 仍被迫打包组合
  - ❌ 全量复刻 Claude Code CustomSelect 组件：过度工程化，KodaX 的 Ink 版本和组件体系不同

#### Resolution (v0.7.62)

- `ask_user_question` now supports `kind: "input"` for free-text answers, with
  cancellation surfaced through the standard cancelled-tool result.
- Select questions now support `multi_select`, `min_selections`, and
  `max_selections`; unsatisfiable bounds are rejected before opening a dialog.
- Choice dialogs now allow a host-provided custom input option by default
  (`allow_custom_input: false` opts out), with custom answers normalized into
  `choice` / `choices` plus `custom_inputs` metadata.
- The agent-layer interaction contract models custom input answers with a typed
  sentinel (`ASK_USER_CUSTOM_INPUT_SIGNAL`) instead of overloading normal option
  values.
- The REPL routes custom choice answers through the existing input dialog and
  supports focused single-select / multi-select submission, preserving
  backward-compatible string and string-array host returns.

#### Files Changed

- `packages/agent/src/runtime/user-interaction.ts`
- `packages/coding/src/tools/ask-user-question.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/types.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/ask-user.ts`
- `tests/ui/ask-user.test.ts`
- `packages/coding/src/tools/ask-user-question.test.ts`

#### Tests Added / Run

- `npm test -- packages/coding/src/tools/ask-user-question.test.ts tests/ui/ask-user.test.ts`
- `npm test -- tests/tracker-consistency.test.ts tests/memory-prompt-injection.test.ts`

---


### 118: esbuild 打包替代 tsc 直接运行 — 消除运行时模块开销与 React dev 模式

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.19
- **Created**: 2026-04-17

- **Original Problem**:

  KodaX 使用 `tsc` 编译 + `tsx`/`node` 直接运行，没有 bundling。这导致：

  1. **React development 模式默认加载**：`process.env.NODE_ENV` 在运行时检查，React 加载 `react-reconciler.development.js`。开发模式每次 render 创建 PerformanceMeasure 和 prop diff 追踪对象（heap snapshot 确认每轮 +20万个 string、+54万个 Array、+6万个 PerformanceMeasure），永不释放。当前通过 `--require ./scripts/production-env.cjs` 设 NODE_ENV 绕过，但不如编译期替换干净。
  2. **Source map 字符串占 ~10MB**：tsx 将 source map 以 `data:application/json;base64,...` 内联到内存。
  3. **模块加载 baseline ~85MB**：每个 `.js` 文件是独立模块，V8 维护模块元数据。
  4. **Tiktoken BPE 数据 4 份副本**、**React reconciler 2 份**：模块被多次解析。

  Claude Code 通过 esbuild/Bun bundler 在编译期 `define: { 'process.env.NODE_ENV': '"production"' }` 彻底消除 development 分支，单文件部署，baseline 显著降低。

- **Proposed Fix**:

  使用 esbuild 打包，编译期替换 NODE_ENV，tree-shake 无用代码，合并模块，外置 source map。预期 baseline 从 85MB 降至 40-50MB，同时消除对 `--require` preload 的依赖。

  注意事项：需处理 Node.js 原生模块 external、动态 import（skill 加载、MCP provider）、打包后回归测试。

---


### 110: 缺少 /mcp status 和 /mcp refresh REPL 命令

- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  用户无法在 REPL 中查看 MCP 连接状态（哪些 server 连接成功、哪些失败、catalog 有什么工具），也无法手动刷新 catalog。只能从 prompt context 间接看到 status=idle/ready/error。

- **Context**: 涉及 `packages/repl/src/interactive/commands.ts`。调用 `extensionRuntime.getDiagnostics()` 和 `refreshCapabilityProviders()`。

- **Planned Resolution**: 在 FEATURE_065 范围内添加 `/mcp` 命令（status 子命令 + refresh 子命令）。

---


### 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  FEATURE_061 移除了预 Scout 状态机和 Tactical Flow，但 `harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'` 类型命名残留在 237 处引用、10 个文件中。这些名字编码的是"哪个预设配置"的思维，而 FEATURE_061 后系统实际运作方式是"Scout 决定需要哪些角色"。

- **Context**:
  `harnessProfile` 字段在以下位置被广泛使用：
  - `types.ts`（5 处）：类型定义
  - `reasoning.ts`（29 处）：路由决策
  - `task-engine.ts`（106 处）：核心引擎
  - `provider-policy.ts`（4 处）：provider 策略
  - `agent.ts`（1 处）：agent 层
  - 各测试文件（~90 处）

  当前 `harnessProfile` 实际上只是一个 worker chain 的标签：
  - `H0_DIRECT` → `[scout]`
  - `H1_EXECUTE_EVAL` → `[generator, evaluator]`
  - `H2_PLAN_EXECUTE_EVAL` → `[planner, generator, evaluator]`

  `buildManagedTaskWorkers` 已经在做 worker chain 映射，harnessProfile 只是触发条件。

- **Planned Resolution**:
  1. 在 `KodaXTaskRoutingDecision` 中用 `workerChain: KodaXTaskRole[]` 替代 `harnessProfile`
  2. 保留 `harnessProfile` 作为 derived label（向后兼容导出类型）
  3. 内部路由逻辑改为基于 `workerChain` 而非 `harnessProfile`
  4. 逐步更新 237 处引用

- **Workaround**: 无需 workaround，当前命名不影响功能正确性。

---
### 106: Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.14
- **Fixed**: -
- **Created**: 2026-04-08

- **Original Problem**:
  Managed-task workers still depend on long visible prose that ends with fenced protocol blocks such as
  `kodax-task-scout`, `kodax-task-contract`, `kodax-task-handoff`, and `kodax-task-verdict`.

  In practice, minor protocol drift can still break orchestration:

  1. evaluator verdicts can be rejected when structured output drifts
  2. planner / scout / handoff blocks can still fail closed on formatting variations
  3. missing protocol blocks can produce blocked runs even when visible content is otherwise useful
  4. malformed worker output can push too much raw text into failure paths, artifacts, or session memory

- **Context**:
  This issue is broader than a single evaluator bug. It is a protocol-layer reliability issue across all managed workers.
  The recent `missing kodax-task-verdict` crash / OOM chain exposed the highest-severity symptom, but the same text-coupled
  design exists for planner, scout, and handoff blocks too.

- **Planned Resolution**:
  Resolve in phases under `FEATURE_059 Managed Task Structured Protocol V2`:

  1. harden all managed parsers to accept the last valid block, JSON variants, and common field aliases
  2. keep protocol-failure UI compact while persisting raw artifacts separately
  3. move toward a dual-track model with separate `visibleText` and `protocolPayload`
  4. eventually let evaluator act as a structured verdict producer instead of relying on a prose-tail block

---


### 082: packages/llm 缺少单元测试
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.5.21
- **Created**: 2026-03-08

- **Original Problem**:
  `packages/llm` 已经补上了一批 provider / reasoning 相关单元测试，但覆盖仍不完整。当前 issue 已从“完全没有单元测试”收敛为“关键基础层测试覆盖仍然偏薄”。

  当前仍需继续补齐的模块：
  - `providers/base.ts` - Provider 基类行为与回退链
  - `providers/registry.ts` - Provider 注册、配置状态与默认快照
  - `providers/gemini-cli.ts` - Gemini CLI 凭证提取和桥接边界
  - `providers/codex-cli.ts` - Codex CLI 凭证提取和桥接边界
  - `providers/anthropic.ts` / `providers/openai.ts` - 更贴近真实 stream 执行路径的契约测试

- **Expected Behavior**:
  - 测试覆盖率应达到 80%+
  - 至少覆盖：凭证提取、消息转换、SSE 解析、错误处理

- **Impact**: 中等
  - 无法保证代码质量和回归测试
  - 重构时容易引入 bug
  - 新增 provider 时缺乏参考模式

- **Current Coverage**:
  - 已有测试：`reasoning-overrides.test.ts`
  - 已有测试：`providers/anthropic-message-serialization.test.ts`
  - 已有测试：`providers/anthropic-reasoning-capability.test.ts`
  - 已有测试：`providers/capability-profile.test.ts`
  - 已有测试：`providers/openai-reasoning-capability.test.ts`
  - 已有测试：`providers/streaming-robustness.test.ts`

- **Context**:
  - 项目全局测试覆盖要求见 `~/.claude/rules/common/testing.md`
  - IMPROVEMENT_CLI_PROVIDERS.md 中也提到了此问题 (P0)

- **Phase 1 Progress (2026-03-23)**:
  - 新增 `providers/base.test.ts`
  - 新增 `providers/registry.test.ts`
  - 新增 `providers/cli-bridge-providers.test.ts`
  - 问题仍保持 Open，后续继续补 CLI bridge 与真实 provider stream 契约测试

- **Proposed Solution**:
  1. 创建 `tests/providers/` 目录
  2. 为每个 provider 创建测试文件
  3. 优先覆盖关键路径：认证、消息转换、流式响应解析
  4. 使用 mock 避免真实 API 调用

---


### 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前 runtime 仍主要依赖本地文件工具和 shell。对于 MCP、web search、web fetch、code search 这类现代 coding agent 的核心工具族，尚未提供一等公民的结构化实现，导致很多任务只能退回到 bash 或外部 CLI，削弱了安全性、可解释性和产品竞争力。

- **Expected Behavior**:
  - KodaX 应提供结构化、可授权、可归因的 MCP / search / retrieval 工具
  - 外部证据和代码探索结果应具备统一的数据模型和权限边界
  - 研究型与验证型任务不应过度依赖临时 shell 命令

- **Context**:
  - `packages/coding/src/tools/`
  - `packages/repl/`
  - `README.md` 当前能力声明

- **Root Cause**:
  1. 早期优先完成了本地读写与 project workflow
  2. 尚未建立统一的 connector / retrieval abstraction
  3. 尚未建立 evidence-carrying result model

- **Proposed Solution**:
  - 实施现有 `FEATURE_035 MCP 能力 Provider`
  - 实施现有 `FEATURE_028 First-Class 搜索检索与证据工具`
  - 以 `FEATURE_034 Extension + Capability Runtime` 作为连接器与能力运行时底座

---

### 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 已经在 CLI 层暴露了 `--team` 和 orchestration 能力，但产品层面仍缺少原生 subagent 角色模型、权限边界、任务路由、证据聚合和与 project truth 的深度集成。当前能力更像并行 runner，而不是成熟的多 Agent 产品。

- **Expected Behavior**:
  - 多 Agent 能力应具备明确的角色语义、状态聚合和 review 边界
  - Team 模式应与 Session Tree、Project Harness、feature truth 协同工作
  - CLI 暴露的能力边界应与真实产品成熟度一致

- **Context**:
  - `src/kodax_cli.ts`
  - `packages/coding/src/orchestration.ts`
  - `docs/FEATURE_LIST.md` 中的 `FEATURE_022`

- **Root Cause**:
  1. 已具备 orchestration plumbing，但 subagent product model 尚未完成
  2. 缺少共享 evidence model 和 role-aware execution layer
  3. 当前 Team mode 仍未与后续 session / harness 体系完全打通

- **Proposed Solution**:
  - `FEATURE_067 Parallel Task Dispatch` (v0.7.18) 作为最小可用切片：Scout 识别可并行子任务 → `runOrchestration` 并行派发 → 聚合结果
  - 完整的 Team Agent 架构 (角色语义/状态聚合/review 边界) 留 v0.8.0 与 FEATURE_059 (Protocol V2) 同版本

---

### 093: 缺少 IDE / Desktop / Web 一体化分发表面 (OPEN)
- **Priority**: Low (2026-04-11 降级: Vibe Coding 时代 terminal 是主入口，IDE Bridge 非关键)
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前主要提供 terminal 与 library 形态，缺少 IDE、desktop、web 等分发表面，因此无法很好承载文件上下文注入、可视化 diff review、远程长任务监控和跨设备会话接力等场景。

- **Expected Behavior**:
  - 至少应具备一个 IDE integration、一个 desktop review surface 和一个 remote / web long-running task surface
  - 不同表面之间应共享同一引擎、session 和 project context

- **Context**:
  - `README.md`
  - `packages/repl/`
  - 当前仓库中缺少对应 app / sdk surface 目录

- **Priority Downgrade Rationale (2026-04-11)**:
  基于 KodaX vs Claude Code 全面对比分析，IDE Bridge 的优先级从 Medium 降级为 Low：
  1. Vibe Coding 范式下对话终端是主入口，不是 IDE 编辑器
  2. KodaX 已有 terminal host 检测 (FEATURE_051)，在 VSCode 集成终端中可正常工作
  3. Cursor/Windsurf/Copilot 已占领 IDE 原生 AI 赛道，KodaX 的核心差异化 (AMA/多 Provider/Repo Intelligence) 全部是 CLI-native
  4. 建 IDE bridge 是高成本低差异化投入 (Claude Code 的 bridge 有 25+ 文件)

- **Root Cause**:
  1. 研发重心长期集中在 CLI 与 project workflow
  2. 缺少统一的 surface protocol 与 session handoff layer
  3. 尚未形成跨表面的产品抽象

- **Proposed Solution**:
- 长期目标：实施 `FEATURE_030 Multi-Surface Delivery`
- 短期：依赖 terminal host 检测 + IDE 集成终端作为分发面
- 在 terminal UX 和 multi-agent 基础稳定后再评估是否需要原生 IDE 集成

---

### 094: 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经本轮逐条核对后确认，仓库里仍有多处核心 runtime 文件与主函数承担了过多职责，已经明显超出“单点修补”可持续维护的范围。相关代码同时混合了参数解析、状态推进、权限判断、会话保存、工具调度、provider 适配与 UI / harness 协调，导致回归风险高、修改面大、代码评审成本持续上升。

- **Expected Behavior**:
  - 核心工作流应按职责拆分为可单测、可替换的子模块
  - 入口函数应主要负责编排，不应同时承担解析、执行、持久化和展示细节
  - handler / evaluator 层应具备清晰的输入输出类型边界

- **Context**:
  - `packages/repl/src/interactive/project-commands.ts`
  - `packages/repl/src/interactive/project-harness.ts`
  - `packages/coding/src/repo-intelligence/query.ts`
  - `src/kodax_cli.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/llm/src/providers/anthropic.ts`
  - `packages/llm/src/providers/openai.ts`

- **Source Debt IDs**:
  - `C5`, `C6`, `H1`, `H2`, `H3`, `H4`, `H5`, `H6`, `H7`, `H8`, `H9`, `H10`

- **Root Cause**:
  1. 功能长期沿着现有入口持续堆叠，缺少阶段性模块化回收
  2. 运行时状态与副作用分布在同一层，导致拆分边界不清晰
  3. 项目 workflow、REPL runtime 与 provider stream 演进速度不一致，最终集中在少数超大文件中

- **Proposed Solution**:
  - 先从 `project-commands.ts`、`project-harness.ts`、`kodax_cli.ts` 开始按职责拆分
  - 把 `agent.ts` 的执行编排继续下沉到独立 helper / service 层
  - 为 provider `stream()` 拆出 event parsing、delta normalization、tool result serialization 等子模块

---

### 095: Agent / REPL 主流程仍存在重复编排与手写运行时流程 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  虽然本轮已经消掉了一部分重复逻辑，但 agent 与 REPL 主流程里仍残留多段手写的执行编排代码，包括 reroute、权限前置、会话保存、git / shell 调度和直接修改运行时上下文的路径。它们在行为上高度相关，却没有统一抽象，后续继续演进时很容易再次漂移。

- **Expected Behavior**:
  - 相同语义的运行时流程应复用统一 helper，而不是在多个入口重复实现
  - 会话持久化、权限执行、reroute 策略和错误分类应集中在清晰的边界层
  - REPL context 更新应通过收敛后的状态接口完成，而不是在多处直接改写字段

- **Context**:
  - `packages/coding/src/agent.ts`
  - `packages/repl/src/interactive/repl.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/coding/src/prompts/builder.ts`

- **Source Debt IDs**:
  - `H38`, `H39`, `H40`, `H41`, `H44`, `M39`

- **Root Cause**:
  1. 不同入口在不同时期各自补齐了相似的 runtime 行为
  2. 会话状态与权限模型缺少统一的 façade 层
  3. 历史上更强调尽快打通功能路径，而不是抽象复用

- **Proposed Solution**:
  - 提炼统一的 permission-aware execution helper
  - 收敛 session snapshot / save / title 更新等流程到可复用 API
  - 将 reroute / git evidence / shell evidence 之类的相邻逻辑合并到单一编排层

---

### 096: 类型边界过宽且共享可变状态较多 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  当前代码库仍有一批 “先用 `any` / `unknown` / 断言打通，再在下游兜底” 的边界，以及若干共享可变状态、公共可变容器和原地修改对象的实现。这类问题短期不一定直接出错，但会削弱重构信心，也会让 provider / skills / session 相关代码更难建立稳定的类型约束。

- **Expected Behavior**:
  - 外部输入、provider 事件、skill 上下文和 registry 应尽量使用显式类型与 type guard
  - 共享状态应最小化暴露面，避免 public mutable collection 和原地修改
  - session / routing / registry 相关模型应尽量复用统一类型定义

- **Context**:
  - `packages/llm/src/providers/anthropic.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/acp/pseudo-acp-server.ts`
  - `packages/skills/src/skill-registry.ts`
  - `packages/repl/src/interactive/plan-mode.ts`
  - `packages/repl/src/interactive/new-command.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/permission/executor.ts`

- **Source Debt IDs**:
  - `H7`
  - `H10`, `H11`, `H12`, `H13`, `H14`, `H15`, `H16`
  - `H42`, `H43`, `H44`, `H45`, `H46`, `H47`
  - `M21`, `M22`, `M23`, `M24`
  - `M6`, `M40`, `M42`, `M43`, `M44`, `M46`, `M47`, `M48`, `M49`, `M67`
  - `L22`, `L27`, `L32`, `L37`

- **Root Cause**:
  1. 多数边界最初优先保证联通性，类型建模滞后
  2. registry / session / tool runtime 各自独立演进，导致共享模型碎片化
  3. 一部分对象被默认当作可变工作区使用，没有及时收敛成不可变接口

- **Proposed Solution**:
  - 先清理 provider 与 ACP 边界的 `any` / 断言
  - 为 skill registry、session storage、routing snapshot 建立统一模型
  - 逐步把 public mutable state 改成受控 accessor 或不可变更新

---

### 097: 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  一批较低风险但会持续侵蚀可观测性的技术债仍然存在，包括静默 `catch`、fire-and-forget async 路径、同步文件系统调用、执行链路里的库层 `console.*` 副作用，以及少数仍依赖 shell / editor / discovery 副作用的分支。它们不像前几批安全问题那样紧急，但会让错误更难定位，也会限制后续把运行时行为统一收口。

- **Expected Behavior**:
  - 静默吞错应仅出现在明确可接受的 best-effort 路径，并附带注释或日志策略
  - 热路径中的同步 I/O 应迁移到缓存或异步接口
  - library / loader / discovery 层应避免直接向控制台输出副作用
  - 命令执行的剩余边角路径应继续向统一执行抽象收敛

- **Context**:
  - `packages/repl/src/common/utils.ts`
  - `packages/repl/src/common/compaction-config.ts`
  - `packages/repl/src/common/permission-config.ts`
  - `packages/repl/src/interactive/plan-storage.ts`
  - `packages/repl/src/permission/permission.ts`
  - `packages/repl/src/permission/executor.ts`
  - `packages/coding/src/tools/read.ts`
  - `packages/coding/src/tools/grep.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H19`, `H20`, `H21`, `H22`, `H23`, `H24`, `H25`, `H26`, `H27`, `H28`, `H29`, `H30`
  - `H48`, `H51`, `H52`, `H54`, `H55`, `H58`
  - `M38`
  - `L10`, `L17`, `L23`, `L26`

- **Root Cause**:
  1. 早期实现大量依赖 best-effort fallback，缺少统一的日志/遥测约束
  2. 部分工具和 loader 仍沿用同步 I/O 以降低实现复杂度
  3. 执行层的命令、编辑器和技能发现路径没有完全统一到同一套运行时约束

- **Proposed Solution**:
  - 为允许静默失败的路径建立显式注释和统一 helper
  - 逐步替换热路径同步 I/O，并对保留的同步路径注明原因
  - 把 loader / discovery / permission 侧的 `console.*` 收敛到 logger
  - 继续收口剩余 command execution 分支到权限感知的执行抽象

- **Phase 1 Progress (2026-03-23)**:
  - `packages/coding/src/tools/read.ts` 改为基于 `fs.stat()` 的异步可访问性检查，移除了 `existsSync`
  - `packages/coding/src/tools/grep.ts` 改为异步路径探测，并为不可访问路径补充明确错误信息
  - `packages/repl/src/common/utils.ts` 为版本号与 `feature_list.json` 进度读取增加缓存，降低热路径同步 I/O 频率
  - `packages/repl/src/common/permission-config.ts`、`packages/repl/src/common/plan-storage.ts` 为保留的 best-effort 静默失败补上显式注释
  - `packages/repl/src/permission/executor.ts` 移除了临时脚本检查里的同步 `existsSync`
  - `packages/repl/src/permission/permission.ts` 为路径 canonicalization 和系统 temp 目录解析增加缓存，减少重复同步文件系统探测
  - 问题仍保持 Open，后续继续清理剩余权限路径解析同步逻辑与执行侧副作用

---

### 098: 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经核对后仍有一批低风险但会持续制造噪音的清理项，包括重复 helper、长期保留的兼容层导出、仓库内无人消费的遗留 API、魔法数字、硬编码提示字符串，以及若干轻量级设计瑕疵。单个问题都不大，但累计起来会影响可读性，也会提高理解成本。

- **Expected Behavior**:
  - helper / utility 应优先复用而不是多处复制
  - 兼容层与 deprecated 导出应有明确退场计划
  - 算法阈值、缓存大小和提示文案应以命名常量或共享常量表达
  - 轻量级设计瑕疵应在不破坏兼容的前提下逐步收敛

- **Context**:
  - `packages/repl/src/ui/utils/message-utils.ts`
  - `packages/repl/src/ui/utils/textUtils.ts`
  - `packages/coding/src/providers/index.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/agent/src/compaction/compaction.ts`
  - `packages/skills/src/file-tracker.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H32`, `H33`, `H34`
  - `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, `M9`, `M11`, `M12`, `M13`, `M14`, `M15`, `M17`, `M18`, `M19`, `M20`
  - `M26`, `M27`, `M28`, `M29`, `M30`, `M31`, `M32`, `M33`, `M34`, `M35`, `M36`, `M41`, `M45`, `M52`, `M53`, `M54`, `M55`, `M56`, `M58`
  - `L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `L8`, `L11`, `L12`, `L13`, `L14`, `L18`, `L19`, `L20`, `L21`, `L25`, `L31`, `L33`

- **Root Cause**:
  1. 多数条目来源于兼容层保留、局部复制粘贴和快速迭代残留
  2. 一些常量原本只在局部使用，后续没有及时抽象或命名
  3. 文案、缓存和占位实现长期存在，但缺少集中清理窗口

- **Proposed Solution**:
  - 先清理无人消费的 helper / export / placeholder
  - 收敛重复字符串与阈值常量
  - 对仍需兼容保留的导出明确 deprecation 注释和删除条件

---

### 099: 测试辅助代码重复，局部验证资产需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  除了已单独跟踪的 `082 packages/llm 缺少单元测试` 之外，当前测试资产本身也存在一批结构性债务，包括超大的测试文件、重复实现 helper、散落的 scratch / 临时验证脚本，以及若干直接依赖硬编码常量的断言。这类问题会降低新增测试的速度，也会让回归定位变得更慢。

- **Expected Behavior**:
  - 通用测试 helper 应抽到共享位置，而不是在多个测试文件内重复实现
  - scratch / 临时验证脚本应清理或迁移到明确的实验目录
  - 大测试文件应按模块拆开，覆盖目标更清晰

- **Context**:
  - `packages/repl/src/interactive/interactive.test.ts`
  - `packages/repl/src/ui/session-history.test.ts`
  - `packages/repl/src/ui/banner.test.ts`
  - `src/cli_option_helpers.test.ts`
  - `tests/kodax_core.test.ts`
  - `tests/scratch/test-retry.ts`

- **Source Debt IDs**:
  - `H12`, `H60`
  - `M10`, `M11`, `M12`, `M59`, `M60`, `M61`, `M62`, `M63`, `M65`, `M68`
  - `L28`, `L29`, `L30`

- **Root Cause**:
  1. 测试在不同阶段由不同模块各自补齐，复用层没有同步建设
  2. 临时验证资产在问题解决后没有及时回收
  3. 对测试代码的整洁度要求低于生产代码，导致债务长期累积

- **Proposed Solution**:
  - 提取共享 test helper，并拆分超大测试文件
  - 清理或迁移 `tests/scratch` 中已失效的实验资产
  - 为测试资产建立最小限度的 lint / consistency 约束

---


### 105: kodax -c 可选择空 ACP 占位 session，classic REPL 还会忽略 resume (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.14
- **Fixed**: v0.7.74
- **Created**: 2026-04-03
- **Resolved**: 2026-07-23

- **Original Problem**:
  用户报告使用 `kodax -c`（继续最近会话）后，之前的历史记录没有正常注入 LLM 上下文。
  LLM 似乎"忘记"了之前的对话内容，表现为不认识之前讨论过的内容。

- **Expected Behavior**:
  - `kodax -c` 应该自动加载当前目录最近的会话历史
  - 历史消息应该作为 `initialMessages` 注入 LLM 上下文
  - UI 应显示 `[Continuing session: xxx]` 横幅

- **Confirmed Root Cause**:
  1. `FileSessionStorage.list()` returns sessions newest-first and includes
     zero-message user-scoped records. Ink startup and the single-task
     `resolveCliTaskSessionId()` path selected element zero directly, unlike
     `kodax -s list` / bare `-r`, which already filter `msgCount > 0`.
  2. A cluster of newer empty ACP placeholder sessions could fill the default
     ten-result list, so `kodax -c` loaded an empty ACP session instead of the
     latest real conversation.
  3. The terminal-compatibility classic REPL path did not process
     `session.resume` or `session.autoResume` at startup at all.
  4. The lower-level coding-runtime CAP-043 auto-resume middleware still chose
     element zero, and classic startup did not guarantee that an explicit ID
     won when a resume flag was also present.

- **Resolution**:
  - Added one resumable-session selector shared by Ink, classic, and
    `kodax -c "prompt"`; it requests up to 1000 summaries and chooses the
    first session with `msgCount > 0`.
  - Classic startup now loads the selected session's messages, UI history,
    lineage, artifact ledger, extension state, runtime identity, title, tag,
    and session ID before creating its interactive context.
  - Ink startup now records the resolved session ID in live options as well as
    the context, keeping subsequent saves and runtime handoff explicit.
  - The coding-runtime middleware mirrors the non-empty broad-scan rule without
    depending on REPL, and explicit IDs short-circuit discovery everywhere.
  - Classic shell execution and workflow project-key derivation use the resumed
    Session's normalized execution workspace rather than the launch directory.

- **Files Changed**:
  - `packages/repl/src/session/resumable-session.ts`
  - `packages/repl/src/session/resumable-session.test.ts`
  - `packages/repl/src/interactive/repl.ts`
  - `packages/repl/src/interactive/repl-startup-session.test.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/index.ts`
  - `packages/agent/src/types.ts`
  - `packages/coding/src/agent-runtime/middleware/auto-resume.ts`
  - `packages/coding/src/agent-runtime/__contract-tests__/cap-043-auto-resume.contract.test.ts`
  - `src/kodax_cli.ts`
  - `docs/test-guides/ISSUE_105_v0.7.74_REGRESSION_GUIDE.md`

- **Tests Added**:
  - Resumable selection skips newer zero-message ACP placeholders and requests
    the broad 1000-session scan.
  - Classic `-c` startup loads the first non-empty conversation with its
    messages, tag, and saved workspace runtime; an explicit ID wins even when a
    resume flag is present.
  - CAP-043 direct/SDK auto-resume skips empty placeholders and requests the
    same broad scan.
  - A built-artifact probe against the affected local session store selected
    `20260722_071230` (43 messages) instead of the newest empty ACP record.

---

## Summary
- Total: 93 (25 Open, 68 Resolved, 0 Partially Resolved, 0 Won't Fix)
- Highest Priority Open: 091 - 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High)
- Historical archived issues are maintained in ISSUES_ARCHIVED.md

## Changelog

### 2026-07-25: Issue 207 resolved (v0.7.77 development)
- Runtime run admission now resolves a provider-only selection to that
  provider's static default model before Auto LLM preflight and launch.
- Explicit model precedence and fail-fast behavior for providers with no
  resolvable default remain unchanged.

### 2026-07-23: Issue 204 resolved (v0.7.74)
- Auto renders the configured/observed LLM or rules engine without a transient
  bare state.
- Per-Session Runtime setting writes are serialized so rapid mode cycling is
  last-action-wins while sticky rules fallback remains explicit.

### 2026-07-23: Issue 105 resolved (v0.7.74)
- Made all `-c` entry paths skip empty placeholder sessions and scan beyond the
  legacy ten-session list cap.
- Restored resume loading in the classic REPL startup path.

### 2026-07-23: Issues 202-203 resolved (v0.7.74)
- Kept canonical compaction checkpoints, first-kept pointers, and post-compact
  attachments on one active lineage path while retaining legacy checkpoint
  compatibility.
- Escalated PowerShell bracket wildcards on path parameters without treating
  bracket-bearing `LiteralPath` filenames as dynamic.

### 2026-07-23: Issues 200-201 resolved (v0.7.74)
- Made root completion delivery explicitly recoverable and legacy-safe through
  persisted pending-delivery IDs, post-commit acknowledgements, and scoped
  queue deduplication across hard restart and soft Runtime rebuild.
- Restricted model waits to mailbox/user activity, kept system reminders from
  ending waits, and corrected Workflow progress guidance.

### 2026-07-22: Issue 198 resolved (v0.7.74)
- Unified SA/AMA durable-compaction and history-tool binding, made the tool pair
  visibility atomic, and closed default AMA's advertised-but-unavailable path.
- Made persistent child compaction inherit policy, retain context-scoped
  telemetry, and archive/search only a separately minted hidden child lineage.

### 2026-07-22: Issue 199 resolved (v0.7.74)
- Closed interrupt admission at managed completion and ordinary completion/error
  callbacks as well as external abort, while releasing abort listeners on every
  Runtime-owned terminal path.
- Terminalized synchronous coding and managed-task launch failures without
  changing the caller-visible `runs.start()` rejection.
- Kept Sidecar observer failures on the diagnostic channel so they cannot close
  a still-consumable interrupt window, with deterministic Runtime and bridge
  regression coverage.

### 2026-07-22: Issues 195-197 added and resolved (v0.7.74)
- Bypassed the LLM for exact safe reads while moving sensitive paths and
  environment disclosure ahead of classifier decisions; the post-resolution
  closure covers bare/Git-object operands and analyzer-less SDK callers.
- Added grep source paging and independent attention admission without
  restoring the Issue 158 universal truncation behavior; all production entry
  paths now use the owner, physical and attention ledgers are separate, and
  persistence failure preserves physically admissible evidence.
- Recognized current user-shaped compaction checkpoints at round exit and
  removed duplicate query/final appends.

### 2026-07-22: Issues 192/194 post-implementation review closure
- Moved terminal Actor receipts behind transcript/session commit, filtered
  acknowledged direct-child event replay, and aligned repeated persisted text
  to the latest canonical suffix.
- Required emergency compaction fallback to reduce tokens and restore physical
  validity before emitting successful compatibility events.
- Synchronized canonical config templates, `kodax_manual`, and current-state
  compaction documentation.

### 2026-07-22: Issue 194 added and resolved (v0.7.74)
- Recorded the local-specialist dispatch contract break, progress-wait model
  amplification, duplicate terminal delivery, non-idempotent resumed tool
  history, ambiguous guardrail denial, and missing tool-result timestamp.
- Resolved catalog selection, terminal-only waiting, durable turn-ID
  acknowledgement, canonical tool-ID resume repair, denial diagnostics, and
  result timestamping; verified 2,299 tests plus the reported real session.

### 2026-07-21: Issue 193 added and resolved (v0.7.73 development)
- Added the versioned Runtime/daemon interrupt-input contract, reused the
  canonical Actor queue for same-Run FIFO safe-boundary delivery, exposed
  queued/delivered status and ordered batch events, and prevented terminal or
  restarted Runs from leaking undelivered input.

### 2026-07-21: Issue 192 added and resolved (v0.7.74)
- Recorded and fixed the large-compaction policy/coverage defect, root/child
  event ambiguity, and unbounded observation transport through FEATURE_272.

### 2026-07-20: Issue 190 added and resolved (v0.7.73)
- Made matcherless legacy grants non-authorizing while retaining management
  compatibility, kept the bounded all-action classifier projection, and added
  escaped-JSON credential redaction.

### 2026-07-20: Issue 189 added and resolved (v0.7.73)
- Unified native reasoning controls, synchronized environment-backed Auto
  settings into Runtime, preserved persisted engine choices, made sidecar
  `none` capability-aware, fixed Qwen hybrid thinking disable requests, and
  serialized parallel confirmation dialogs.

### 2026-07-20: Issue 188 added and resolved (v0.7.73)
- Replaced raw assistant tool arguments and results with bounded semantic
  summaries/status metadata, added fail-closed constructed/extension/MCP
  projection contracts and auditable exemptions, anchored both genuine
  user-intent boundaries under byte pressure, and made first-run provider
  readiness observe the hydrated Runtime environment.

### 2026-07-19: Issue 187 added and resolved (Unreleased)
- Closed the shared-daemon Auto permission owner, safe old-daemon upgrade,
  Windows/Tier-0 path, bounded preview, and 0.7.x SDK compatibility gaps.
- Post-review closure restricted path grants to known file tools, preserved
  POSIX backslashes, rejected dynamic PowerShell persistent grants, aligned
  concrete `toolInput` across embedded/daemon SDKs, preserved embedded host
  policy hooks, committed rewritten calls before execution in both Runner
  paths, derived trusted previews from concrete input, narrowed legacy scope
  responses to Runtime-issued matchers, and propagated blocked calls through
  Runner audit.

### 2026-07-19: Issue 186 added and resolved (v0.7.72)
- Added an awaitable daemon subscription readiness boundary so a second client
  cannot outrun installation of a permission/event listener.

### 2026-07-19: Issue 185 added
- Deferred F266 learning-lock crash recovery hardening; rejected a blanket
  30-second acquisition timeout in favor of a future owner-aware atomic claim.

### 2026-07-19: Issue 184 added
- Deferred sed effect-aware permission classification to avoid shipping a
  blanket write classification that would regress legitimate read-only use.

### 2026-07-18: Issue 183 added and resolved (v0.7.72-hotfix.0)
- Unified CLI and SDK daemon startup ownership, reclaimed only the current
  failed/cancelled candidate process tree, and added a test-only worker-death
  shutdown fallback without changing persistent production daemon semantics.

### 2026-07-18: Issue 182 added and resolved (v0.7.72-hotfix.0)
- Retried bounded Windows sharing-denial errors as lifecycle-lock contention;
  unrelated filesystem errors remain fail-fast.

### 2026-07-18: Issue 181 added and resolved (v0.7.72-hotfix.0)
- Aligned the stale default MiniMax media-capability assertion with the current
  image-capable MiniMax M3 provider default.

### 2026-07-18: Issues 179-180 added and resolved (v0.7.72-hotfix.0)
- Increased Auto[LLM]'s default classifier budget to 20 seconds, removed
  pure readonly invocations from the classifier path, retained classification
  for semantic index refresh, and exposed SDK/daemon overrides.
- Unified queued input on the session-root Actor scope and made `wait_agent`
  plus idle-yield wake lossless without canceling the whole run. SA compatibility,
  single-session SDK auto-binding, explicit concurrent-session routing, and
  ambiguity rejection are covered without reintroducing a second control plane.

### 2026-07-18: Issue 178 added and resolved (v0.7.72-hotfix.0)
- Released stdin ownership on bare-resume cancellation so PowerShell regains
  its prompt without a follow-up keypress; the selected-session handoff remains
  unchanged.

### 2026-07-18: Issue 177 added and resolved (v0.7.72)
- Promoted current Actor capacity to a shared authoritative first-section
  prompt contract for both full and fallback Worker paths, with a passing
  fresh five-track follow-up pilot.

### 2026-07-18: Issues 175-176 added and resolved (v0.7.72)
- Closed the Actor start/interrupt cancellation gap, terminal no-op writes,
  closed mailbox semantics, and daemon Actor capability negotiation.
- Closed Learning lost-wakeup, disconnect waiter cleanup, and transient
  principal facade retention without changing durable cursor identity.

### 2026-07-18: Issue 174 added and resolved (v0.7.72-hotfix.0)
- Bound the searchable `-r` picker to the real process terminal streams, kept
  it alive by owning an unreferenced stdin handle, restored Ctrl+C cancellation,
  separated explicit cancel from unexpected exit, and added a clear
  non-interactive error path.
- Kept the selected picker visible while the full CLI preloads, then transferred
  stdin liveness into the REPL without a transition gap; preload failures clean
  up and preserve the original error.

### 2026-07-18: Issue 172 resolved after production-path closure (v0.7.72-hotfix.0)
- Forwarded guardrails through managed Runner, authorized exact concrete bridge
  calls with one-shot receipts, completed execution-cwd/path-role handling,
  preserved legacy daemon preview input compatibility, and verified the full
  Runtime SDK suite plus publish build.

### 2026-07-18: Issue 172 reopened
- Production review found that managed-task did not forward Runtime guardrails,
  `tool_call` classified only its wrapper, and two command-path forms still
  lost deterministic boundary signals. The issue remains open until the final
  concrete-call authorization path and compatibility regressions are verified.

### 2026-07-17: Issue 172 added and resolved (v0.7.72-hotfix.0)
- Installed and Session-scoped the real auto-mode guardrail in daemon Runtime
  runs, limited the shared permission broker to explicit escalations, separated
  project boundaries from execution cwd, and bounded permission transport data.

### 2026-07-16: Issue 168 added and resolved (v0.7.71)
- Closed A2A executor shutdown/durability, daemon ownership/readiness,
  extension/artifact policy, inbound admission/replay/close/auth/media, and SSE
  resource-boundary gaps found by the final cross-chain review.

### 2026-07-16: Issue 167 added and resolved (v0.7.71)
- Closed A2A OAuth validation/redaction gaps and made config-owned hot
  activation persistence-first, ownership-aware, and revision-conditional.

### 2026-07-15: Issue 164 added and resolved (v0.7.70)
- Added cost-admitted, lossless zero-match MCP recovery and compact CJK query
  segmentation without changing successful lexical-search behavior.

### 2026-07-15: Issue 163 added and resolved (v0.7.70)
- Closed A2A endpoint trust, read-boundary, task continuation/retention,
  artifact, cleanup, redaction, version, and stream-interoperability gaps while
  retaining the existing lightweight Runtime and file-store architecture.

### 2026-07-15: Issue 162 added and resolved (v0.7.70)
- Restored hosted Runtime provider/model precedence for `a2a serve`, admitted
  Markdown Agent providers, and made root/subcommand option ownership and
  command termination explicit.

### 2026-07-15: Issue 161 added and resolved (v0.7.70)
- Closed MCP result-capacity, ranking, pagination integrity, cache recovery,
  cache-persistence truth, and provider-data trust-label gaps found in review.

### 2026-07-15: Issue 160 added and resolved (v0.7.70)
- Added reverse-bridge draining and daemon-owned Workflow/External Agent
  blockers to the atomic rollback revision so shutdown cannot abandon live
  background work or mutate transient credential/Host Tool state.

### 2026-07-15: Resolved issues older than 30 days archived
- Moved 40 resolved issues to `ISSUES_ARCHIVED.md`; all open and recent issues remain active.

### 2026-07-15: Issue 158 reopened review findings resolved (v0.7.69)
- Closed trusted-marker, recovery-transcript, observer-ordering, child-capacity,
  bounded-acquisition, Bash memory/ANSI, public-API, and artifact-lifecycle gaps
  found during implementation review.

### 2026-07-14: Issue 158 added and initially resolved (v0.7.69)
- Replaced transparent post-hoc lossy compression with complete collection and
  one aggregate next-request capacity decision.
- Removed default semantic Bash filters and hidden fixed caps, added exact
  recovery coordinates and incomplete-source markers, and corrected cache-token
  cost accounting.
- Replaced default destructive history microcompaction/static percentage
  targeting with physical-capacity, summary-first compaction and typed failure
  that preserves canonical history.
- Added regression coverage and a corrective ADR/feature/test-guide record.

### 2026-07-14: Issues 155 and 156 added and resolved (v0.7.69)
- Unified the resume picker with the owned TUI input lifecycle.
- Replaced repeated full-transcript pagination with one bounded, concurrent
  metadata-head scan while preserving legacy project aliases.

### 2026-07-11: Issue 151 added and resolved (v0.7.67)
- Distinguished Codex-owned MCP Node processes from KodaX test residues by
  command line, parent PID, and start time.
- Added explicit Runtime daemon shutdown to the config suite and parent-death
  watchdogs to long-running process fixtures.
- Verified the corrected suite leaves no new Node PID and removed five verified
  orphaned KodaX test processes without touching Codex MCP servers.

### 2026-07-11: Issue 150 added and resolved (v0.7.67)
- Withdrew the initial GitHub release/tag before npm publication.
- Restored restricted-script `phase` / external `target` forwarding.
- Made executor-plane close terminal and waiter-safe.
- Hardened scoped-review schemas, Feature 259 baseline reconstruction, and
  best-effort local ledger mirroring.
- Added focused regression tests and prepared a rebuilt v0.7.67 release.

### 2026-07-11: Issue 149 added and resolved (v0.7.67)

- Isolated both ACP test harnesses from real user session and Runtime storage.
- Delayed ACP persistence until the first valid prompt and added reversible,
  preview-first cleanup for the narrow legacy placeholder shape.
- Added searchable session resume plus SDK/Daemon surface and cursor pagination.

### 2026-07-10: Issue 147 added and resolved (v0.7.66)

- GitHub Release archive 现在携带 provider metadata 与全部 Worker sidecar。
- 新增 workflow YAML 回归测试，并在 sidecar 缺失时让发布任务 fail closed。

### 2026-07-10: Issue 146 added and resolved (v0.7.66)

- 图片路径处理失败时恢复原始文本，并通过非持久化两秒 Toast 提示用户。
- 保留有效图片附件行为；新增回归测试锁定不提交、不写历史的边界。

### 2026-07-10: Issue 145 added and resolved (v0.7.66)
- Resolved the runtime daemon / SDK lifecycle, event replay, permission,
  serialization, protocol-validation, artifact, and host-cleanup gaps found in
  the post-v0.7.63 architecture review.
- Added multi-client socket, restart/replay, listener isolation, active-run
  conflict, protected-path broker, frame-limit, wire-error, subscription-race,
  JSON-safe REPL, ACP storage, diagnostic restore, and LSP close regressions.

### 2026-07-06: Issue 112 resolved (v0.7.62)
- Resolved 112: `ask_user_question` now supports free-text input,
  multi-select with selection bounds, and default-on custom input answers. The
  REPL routes custom choice answers through the existing input dialog, while the
  tool returns normalized `choice` / `choices` and `custom_inputs` fields for
  the model.

### 2026-06-25: Issue 143 resolved (v0.7.57)
- Resolved 143: Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框 (High).
- Fix (5 workstream, all landed): WS1 late-verdict 采纳（窗口过期改为 `await` 同一 classifyPromise 并采纳裁决 — allow/block 不弹框，仅真 escalate 弹框；比原 peek-race 设计更简洁、无 UI 改动、无闪烁）+ WS2 无 askUser ⇒ 窗口强制 0（修对 SDK/非交互）+ WS3 `autoMode.speculativeWindowMs` config 面 + env 透传（REPL+Space）+ WS4 v0.7.39.md 对账（late-verdict 使 micro-bench 失去正确性意义，按 EVAL_GUIDELINES Layer 1 不补跑付费 bench）+ WS5 防 double-record/settle 验证。
- Verification: coding 3570 passed（1 项 orchestration maxConcurrent 并发计时 flaky，隔离复跑绿，无关）、repl 2135 passed、coding+repl tsc clean；新增 17 个单测（guardrail 7 + permission-config 8 + bootstrap 2）。
- cost-tracker 在 classify.ts:96-98 内部结算恰好一次 → 二次 await 不 double-settle（reviewer code-trace 证实）；迟到 block 现正确喂 denial-tracker（旧路径丢弃曾误记为 breaker error）。

### 2026-06-25: Issue 143 added
- Added 143: Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框，auto 模式形同虚设 (High, Open).
- Diagnosis (代码实证): 三根因叠加 —— (1) 窗口过期后后台 classify 裁决在 v1 被硬丢弃，即便迟到 allow 也变成必须人点的硬弹窗 (`guardrail.ts:443-449` / `speculative.ts:13-17`); (2) 500ms 是占位值，FEATURE_158 承诺的 Anthropic/DeepSeek/Zhipu micro-bench 从未回填 (文档末尾无报告 + release gate 未勾 + benchmark 无数据); (3) 窗口 500ms 与 classifier timeout 8000ms 的 16× 内部矛盾使远程/慢 provider 误弹成数学必然。REPL 与 Space 均未传 `speculativeWindowMs`，且无 config.json 面。
- Proposed (完整修复，非治标): WS1 采纳 late verdict / peek 模式 (窗口降级为"是否显示 pending UI") + WS2 无 askUser ⇒ 不投机 (修对 SDK/非交互) + WS3 补 `autoMode.speculativeWindowMs` config 面 + WS4 回填 micro-bench 固化默认 + WS5 防 double-record 验证。显式 descope provider/latency-aware knob (采纳 WS1 后冗余)。
- cost-tracker 在 `classify.ts:96-98` 内部结算，每次 classify 恰好一次，与窗口无关 → 采纳 late verdict 不会 double-settle。

### 2026-06-25: Issue 142 added and resolved
- Added and resolved 142: kimi-code thinking-only completion can terminate Worker with only `[Worker]` visible (High).
- Diagnosis: upstream reasoning provider can return a completed thinking-only/whitespace-only turn; KodaX v0.7.56 only retried fully-empty turns, so the Runner could incorrectly accept it as a terminal text-only completion.
- Fix: classify "no user-visible text and no tool calls" as degraded empty output, retry via the existing bounded re-stream path, fail locally if retries are exhausted, and guard the UI against committing bare managed role labels.

### 2026-06-18: Issue 140 resolved (v0.7.52)
- Resolved 140: Published bundle leaves computed `./agent.js` child-executor import, breaking workflow child agents (High).
- Fix: child-executor keeps lazy loading but uses a literal `import('./agent.js')`, and build/release guards reject raw child-executor runtime imports in generated bundles before publishing.
- Verification: fixed release line v0.7.52 was checked at the bundle/package level, not only through source-level TypeScript tests.

### 2026-06-15: Issue 138 added & resolved
- Added & Resolved 138: Workflow host RPC 边界对对象载荷零校验 — `synthesize` 传非数组 inputs 崩裸 TypeError + `runAgent`/`spawnAgent` 缺 name/prompt 静默烧 token (High)
- Root cause: host RPC 边界对标量字符串参数两层校验，但对对象载荷（runAgent/spawnAgent/synthesize/log input）只检查"是对象"后 `as unknown as` 裸转，字段形状零校验；`buildSynthesisPrompt` 同步 `.inputs.map` 让非数组直接崩，runAgent/spawnAgent 的缺字段则静默派发空 objective 子 Agent。
- Fix: runtime 容忍 inputs 为 array/string/object（`normalizeSynthesisInputs/Rubric`）+ script-runner 新增 `readSpawnAgentInput`/`readSynthesizeInput`/`readLogEvent` 替换 4 处裸转、强制 name/prompt 非空 + readOnly 布尔 + rubric 非空 + generator prompt 提示。
- Verification: workflow 全套件 135 passed、agent+coding typecheck clean、`npm run build:packages` success。

### 2026-06-05: Issue 137 added & resolved
- Added & Resolved 137: Streamable HTTP MCP transport drops `Mcp-Session-Id` on sessionful servers (High)
- Root cause: `createStreamableHttpTransport` did not persist the session id returned by initialize and did not attach it to later POST / GET / DELETE requests.
- Fix: persist `Mcp-Session-Id`, inject it into later requests, delay notification stream startup until after the first successful POST, and clear session state on 404 expiry.
- Verification: transport regression tests, MCP provider/tool tests, agent package typecheck, and live `toolMcpCall` smoke against `http://82.156.201.14:4747/api/mcp`.

### 2026-05-16: Issue 132 resolved (v0.7.41)
- Resolved 132: `h2-boundary-runner.test.ts` "session.jsonl" ENOENT — eager-read + retry budget enlargement
- Strategy: structurally eliminate the race window (read content immediately after `findEvalSessionJsonl`'s `fs.stat` succeeds, before git diff / worktree cleanup / 3x fs.writeFile add 200-400ms) instead of just absorbing it
- AgentTaskResult adds `sessionJsonlContent: string | null` (alongside existing `sessionJsonlPath`); persistCell now consumes content directly (no readFile)
- retry budget: 6 attempts × `[50, 100, 200, 400, 800]` ms backoff = ~1.55s total (outlasts Windows AV scan windows observed >150ms in initial fix attempt)
- Verification: 5 sequential full-suite runs (heavy parallel load) green; no warning fired

### 2026-05-16: Issue 132 + Issue 133 added (test flake tracking)
- Added 132: `h2-boundary-runner.test.ts` "session.jsonl" ENOENT race — runner silent error swallow + cleanup race causes intermittent flake under heavy parallel load (Low, Open，调研中，per user 暂不动 runner 代码)
- Added 133: `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake under heavy parallel load (Low, Open，独立调研，per user 不推迟到后续版本 milestone)
- 同期 `compaction.test.ts` "keeps partial summary progress when a later summary attempt fails" 加 `{ timeout: 15_000 }` 直接 fix（precedent commit `d4a47bc9` 模式）

### 2026-05-09: Issue 129 added & resolved
- Added 129: Auto 模式下纯只读管道命令被误判为"修改文件"并强制确认 (Medium)
- Resolved 129 in v0.7.38: 三个相互叠加的根因（`2>NUL` 假阳性 + 缺 `findstr` 白名单 + 管道一票否决）以最小切口"strip-then-classify"统一修掉
- 新增 `NULL_DEVICE_REDIRECT_PATTERN` 模块常量被 `isBashReadCommand` / `isBashWriteCommand` 共用；`BASH_SAFE_READ_COMMANDS` 加 `findstr`、`fc`、`where` 三件套
- 新加 8 个 unit test，全包重跑 232/232 PASS

### 2026-04-11: Issue 107 added
- Added 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition (Medium Priority)
- 由 FEATURE_061 Phase 5 识别，237 处引用跨 10 文件，需 v0.7.16 提交后独立处理

### 2026-04-03: Issue 105 added
- Added 105: kodax -c 历史记录未注入 LLM 上下文 - resume 路径可能存在 gitRoot 过滤不一致 (Medium Priority)
- 代码链分析完成，确认代码路径完整但存在多个潜在故障点
- 主要关注: agent.ts 中 storage.list() 未传 gitRoot 参数、旧会话缺少 gitRoot 字段、compact 策略下 initialMessages 不传递

### 2026-03-28: Issues 102-104 resolved
- Resolved 102: Repo-intelligence now reuses the same source-aware file collector across overview and query/index layers
- Resolved 103: managed-task planning now reuses `repoRoutingSignals` across `runKodaX()` and `task-engine`
- Resolved 104: repo-intelligence cache readers now validate runtime JSON shape and treat mismatches as cache invalidation

### 2026-03-28: Issues 102-104 added
- Added 102: Repo-intelligence mixes git-tracked and filesystem-discovered file sets (Medium Priority)
- Added 103: Managed-task planning recomputes repo routing signals in the same workspace (Low Priority)
- Added 104: Repo-intelligence cache JSON is read without runtime shape validation (Low Priority)

### 2026-03-27: Issue 101 resolved
- Resolved 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- dependency handoff 现在保留 `Summary + Result artifact + fuller output`，Evaluator 不再只拿到截断摘要
- managed-task transcript 现在会保留非终态 worker 输出，Generator 文本不会在 Evaluator 收口后直接消失
- AMA 新增显式 refinement loop，review 最终答复也改成 final review，而不是 review-of-review

### 2026-03-27: Issue 101 added
- Added 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- Generator review text vanishes from UI when Evaluator takes over, and lossy handoff (truncateText 400 chars) limits Evaluator evidence

### 2026-03-23: Issues 013-077 batch resolved
- Resolved 8 legacy low-priority issues (013, 014, 015, 017, 018, 055, 061, 077) at v0.6.17

### 2026-03-23: Issue 100 resolved
- Resolved 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 新增 `src/acp_logger.ts`，统一将 ACP 日志安全写入 `stderr`，避免污染 ACP `stdout` JSONL 协议流
- 补充 ACP 启动摘要、会话生命周期、prompt 开始/结束、权限协商、取消和错误日志
- 支持 `KODAX_ACP_LOG=off|error|info|debug` 控制 ACP 日志级别，并同步更新 CLI 帮助和 README 文档

### 2026-03-23: Issue 100 added
- Added 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 问题确认：`kodax acp serve` 当前缺少启动摘要、会话生命周期、权限协商、错误与关闭日志，stdout 又被 ACP JSONL 协议占用，导致实际只能依赖 stderr 做安全日志输出
- 后续修复方向：补充 stderr logger、启动摘要、关键生命周期日志，以及可控日志级别开关

### 2026-03-22: Technical debt audit merged into canonical issue tracker
- Verified and landed the fix batch for `C10`, `H17`, `H18`, `H53`, `H59`, `M37`, `M57`, and `M69` during the cleanup pass
- Rolled the remaining verified technical debt into active issues `094` through `099`, so each unresolved item now has a stable issue home
- Removed the temporary `docs/TECHNICAL_DEBT.md` document after migrating the remaining backlog into `KNOWN_ISSUES.md`

### 2026-03-19: Issue 090 resolved
- Resolved 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- 新增 provider capability profile，显式区分 Native API 与 CLI bridge，并记录上下文语义和 MCP 支持边界
- `/model` 与 `/status` 现在会直接披露 bridge provider 的限制：只转发最新一条用户消息，且 MCP 不可用
- 新增 `packages/llm/src/providers/capability-profile.test.ts` 与 `packages/repl/src/interactive/provider-capabilities.test.ts`，防止桥接 provider 再次被误标为原生语义

### 2026-03-19: Issue 089 resolved
- Resolved 089: Feature / Design / Summary 元数据漂移 (High Priority)
- 新增 `tests/tracker-consistency.test.ts`，自动校验 FEATURE_LIST 版本/summary、KNOWN_ISSUES summary/最高优先级 open issue，以及关键 design 文件存在性
- 同步修正 KNOWN_ISSUES summary 漂移，后续再发生同类问题会直接由测试报错

### 2026-03-18: Strategic comparison backlog intake
- Added 089: Feature / Design / Summary 元数据漂移 (High Priority)
- Added 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- Added 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High Priority)
- Added 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (High Priority)
- Added 093: 缺少 IDE / Desktop / Web 一体化分发表面 (Medium Priority)
- 来源：对标 opencode / Gemini CLI / Codex CLI / Claude Code 的差距分析，并已同步映射到 feature backlog

### 2026-03-16: Issue 088 新增并修复
- Added & Resolved 088: 消息列表视口布局不稳定 - 底部区域跳动/最后一行被裁剪 (High Priority)
- 核心变更：引入 Viewport Budget + Transcript Layout 架构
  1. 新增 `viewport-budget.ts` 统一计算底部区块行数
  2. 新增 `transcript-layout.ts` 将消息渲染改为扁平 TranscriptRow[] 数据模型
  3. StatusBar 导出 `getStatusBarText()` 纯函数供预算计算复用
  4. MessageList 移除 Static/Dynamic 分割，改为统一 TranscriptRow 渲染
  5. AutocompleteSuggestions 状态管理提升到父组件
  6. Select 对话框选项根据 viewport budget 截断
- Code Review 遗留 5 个未修复问题（model fallback、paddingY 未扣除等）
- 新增 7 个测试用例（viewport-budget 3 + transcript-layout 4）
- 版本：v0.5.39

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误触发命令补全
- 根因：多个 Completer 的 `canComplete()` 只检查触发符位置，未检查是否在有效触发位置（开头或空格后）
- 解决方案：统一规则 - `/` 和 `@` 不在开头时，前面必须有空格才能触发补全
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts` - FileCompleter, CommandCompleter
  - `packages/repl/src/interactive/autocomplete-provider.ts` - shouldTrigger
  - `packages/repl/src/interactive/completers/argument-completer.ts` - ArgumentCompleter
  - `packages/repl/src/interactive/completers/skill-completer.ts` - SkillCompleter

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误地触发了命令补全
- 根因：各 Completer 的 `canComplete()` 只检查最后一个 `/` 或 `@`，没有验证是否在有效的触发位置
- 修复：统一触发规则 - `/` 和 `@` 在输入中段时，前面必须有空格才能触发
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts`
  - `packages/repl/src/interactive/autocomplete-provider.ts`
  - `packages/repl/src/interactive/completers/argument-completer.ts`
  - `packages/repl/src/interactive/completers/skill-completer.ts`
- 测试：71 个测试全部通过，- 版本：v0.5.33

### 2026-03-12: Issue 086 新增
- Added 086: 自动补全前缀匹配方向错误导致超长输入仍匹配短选项 (High Priority)
- 根因分析：`combinedMatch()` 中的 `prefixMatch()` 检查方向错误，检查的是"选项是否以用户输入开头"而非"用户输入是否以选项开头"
- 现象：输入 `/model zhipu-coding` 时，补全列表仍显示 `zhipu` 选项，按回车会替换为 `/model zhipu`
- 影响文件：`packages/repl/src/interactive/fuzzy.ts`, `autocomplete-provider.ts`, `autocomplete.ts`, `argument-completer.ts`

### 2026-03-12: Issue 083 修复
- Resolved 083: 缺少快捷键系统 (Medium Priority)
- 实现内容：
  1. 创建集中式快捷键注册表 (ShortcutsRegistry)
  2. 创建 useShortcut React Hook 集成 KeypressContext
  3. 定义默认快捷键（中断、清屏、帮助、思考等）
  4. 添加 GlobalShortcuts 组件注册全局快捷键
  5. 集成 ShortcutsProvider 到 InkREPL
  6. 帮助面板仅在输入为空时显示，发送后自动隐藏
- GPT Review 后修复：
  1. `?` 快捷键优先级从 -10 提升到 150（高于 InputPrompt 的 100）
  2. 添加 Shift+Tab 转义序列 `\x1b[Z` 支持
  3. 移除 toggleWorkMode 快捷键（语义错误）
  4. 移除用户配置相关代码（按用户要求不实现）
- 修改文件：`packages/repl/src/ui/shortcuts/` 目录下 7 个文件 + `InkREPL.tsx` + `InputPrompt.tsx` + `keypress-parser.ts`
- 设计决策：按用户要求不实现用户配置文件，保持简洁

### 2026-03-12: Issue 085 修复
- Added & Resolved 085: 只读 Bash 命令白名单未在非 plan 模式复用 (Medium Priority)
- 修复内容：
  1. 将 `isBashReadCommand()` 检查移到所有模式下都生效
  2. 将只读命令检查移到**受保护路径检查之前**，项目目录外的只读命令也能自动放行
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`, `packages/repl/src/interactive/repl.ts`

### 2026-03-12: Issue 084 新增
- Added 084: 流式响应长时间静默中断无任何提示 (High Priority)
- 现象：长时间（9小时）后会话静默中断，无重试/错误信息，API 无调用日志
- 可能原因：流式响应 `for await` 循环在网络断开时静默结束，或超时机制未生效

### 2026-03-11: Won't Fix Issues 归档
- Archived 3 Won't Fix issues to ISSUES_ARCHIVED.md:
  - 039: 死代码 printStartupBanner (误报)
  - 053: /help 命令输出重复渲染
  - 063: Shift+Enter 换行功能失效
- Remaining: 10 Open issues only

### 2026-03-11: Issue 058 归档
- Issue 058 (终端流式输出闪烁问题) 归档到 ISSUES_ARCHIVED.md
- VS Code Terminal 兼容性问题已确认解决方案（关闭 GPU 加速）
- Remaining: 10 Open, 3 Won't Fix

### 2026-03-11: Issue 归档
- 31 resolved issues archived to ISSUES_ARCHIVED.md
- Remaining: 10 Open, 1 Partially Resolved, 3 Won't Fix
- Issue 083 added: 缺少快捷键系统 (Medium Priority)

### 2026-03-11: Issue 状态审查更新
- **Issue 006**: Open → Resolved (存储层 `getFeatureByIndex()` 添加了范围验证)
- **Issue 039**: Open → Won't Fix (误报 - `printStartupBanner` 函数实际在 `repl.ts` 第 156 行被调用，非死代码)
- **Issue 060**: Deferred → Resolved (定时器已同步：StreamingContext flush 80ms 与 Spinner 动画帧 80ms 同步)
- **Issue 067**: Open → Resolved (v0.5.27 实现了正确的重试循环和回调式 UI 通知)
- **Issue 069**: Open → Resolved (`toolAskUserQuestion` 工具已存在于 `packages/coding/src/tools/ask-user-question.ts`)
- **Issue 070**: Open → Resolved (代码审查确认换行符在流式管道中被正确保留，非 KodaX 代码问题)
- **Issue 081**: Open → Resolved (Provider 已使用 `useMemo` 记忆化，所有回调使用 `useCallback` 包装)
- 更新 Summary 统计: 10 Open, 32 Resolved, 1 Partially Resolved, 3 Won't Fix

### 2026-02-28: Issue 052 修复
- Resolved 052: 受保护路径确认对话框显示错误选项
- 修复 `gitRoot` 变量读取错误：从 `options.context?.gitRoot` 改为 `context.gitRoot`
- 新增 `isCommandOnProtectedPath()` 函数检测 bash 命令中的受保护路径
- 扩展受保护路径检查：同时覆盖 `write`/`edit` 工具和 `bash` 命令
- 修改文件：`InkREPL.tsx`, `permission/permission.ts`, `permission/index.ts`

### 2026-02-28: Issue 051 修复
- Resolved 051: 权限确认取消时无提示
- 在 `beforeToolExecute` 中用户拒绝确认时添加取消提示消息
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`

### 2026-02-27: Issue 002 标记为 Won't Fix
- Issue 002 (/plan 命令未使用 _currentConfig 参数) 标记为 Won't Fix
- 理由：下划线前缀是 TypeScript 标准约定，表示"故意不使用"
- 类型签名要求该参数，无法删除
- 无实际功能问题

### 2026-02-27: Issue 001 已修复
- Issue 001 (未使用常量 PLAN_GENERATION_PROMPT) 已修复
- 删除了 `packages/repl/src/common/plan-mode.ts` 中未使用的 `PLAN_GENERATION_PROMPT` 常量（25 行代码）
- 该常量从未被 `generatePlan` 函数使用，是纯粹的死代码删除

### 2026-02-27: Issue 046 最终修复
- Issue 046 (Session 恢复时消息显示异常) 已完全修复
- 根本原因分析和修复：
  1. **用户消息重复**：`InkREPL.tsx` 和 `agent.ts` 都添加用户消息，删除前者的 push 操作
  2. **消息截断**：`MessageList.tsx` 默认 `maxLines=20` 太小，改为 1000
  3. **[Complex content]**：纯 tool_result 消息返回空字符串并在 UI 层过滤
  4. **thinking 内容显示**：`extractTextContent` 不应提取 thinking 块内容
- 修改文件：`InkREPL.tsx`, `MessageList.tsx`, `message-utils.ts`

### 2026-02-26: Issue 046 重新打开
- Issue 046 (Session 恢复时消息显示异常) 并未完全修复
- 发现更多问题：
  1. 用户消息重复显示（同一消息出现两遍）
  2. Assistant 回复被截断（显示 `... (33 more lines)`）
  3. tool_result 仍显示为 [Complex content]
- 提升优先级为 High

### 2026-02-26: Issue 046 部分修复（后发现问题未解决）
- 扩展 extractTextContent 支持 thinking/tool_use/redacted_thinking 块
- 但后续测试发现仍有用户消息重复、回复截断等问题

### 2026-02-26: Issue 036 修复
- Resolved 036: React 状态同步潜在问题 - 将三个独立 useState 合并为单一状态对象，确保原子更新

### 2026-02-26: Issue 037 状态更新
- Resolved 037: 两套键盘事件系统冲突 - InputPrompt 已迁移使用 KeypressContext
- InkREPL 现使用 KeypressProvider 包裹，使用优先级系统注册处理器
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 047 新增
- Added 047: 流式输出时界面闪烁 (Medium Priority)
- 高速流式输出时界面出现闪烁，可能与 Ink 渲染频率有关

### 2026-02-26: Issue 019 修复
- Resolved 019: 状态栏 Session ID 显示问题 - 移除截断逻辑，显示完整 Session ID
- 修正 KNOWN_ISSUES.md 中过时的描述（原描述针对已废弃的 status-bar.ts）
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 011 & 012 修复
- Resolved 011: 命令预览长度不一致 - 统一使用 PREVIEW_MAX_LENGTH 常量
- Resolved 012: ANSI Strip 性能问题 - 缓存正则表达式避免重复编译
- 更新 Issue 011 状态（之前已修复但未更新状态）
- 当前 Open Issues 降至 15 个

### 2026-02-25: Issue 045 新增
- Added 045: Spinner 出现时问答顺序颠倒 (High Priority)
- 问题表现与 Issue 040 类似，都涉及渲染顺序问题
- 需要进一步排查 Spinner 组件与 MessageList 的渲染顺序关系

### 2026-02-25: Issue 040 修复完成
- Resolved 040: REPL 显示问题 - 命令输出渲染位置错误
- 最终方案：捕获 console.log 输出并添加到 history
- 命令输出现在按正确顺序出现在用户消息之后
- 相关提交：fddc97c, 9c40f40

### 2026-02-24: Issue 040 重新打开
- Issue 040 之前的修复只解决了部分问题
- 新发现的根本问题：命令输出（/help, /model 等）渲染在 Banner 下面、用户消息上面
- 根因：console.log 被 Ink patchConsole 捕获后渲染在 MessageList 之前的位置
- 解决方案：修改命令返回输出字符串，添加到 history 而非使用 console.log

### 2026-02-24: Issue 040 修复 (v0.4.2)
- Resolved 040: REPL 显示问题 - Banner重复/消息双重输出
- 修复内容：
  1. Banner 使用 Ink `<Static>` 组件固定在顶部
  2. 移除冗余的 `console.log` 用户消息输出
  3. MessageList 在流式响应时过滤掉最后一条 assistant 历史
  4. 添加 React 状态更新等待确保渲染顺序正确

### 2026-02-24: v0.4.0 发布 + Issue 040 更新
- 完成架构重构：@kodax/core + @kodax/repl monorepo
- 更新 Issue 040：添加实际测试观察结果
  - Banner 延迟显示（首次交互后才出现）
  - 用户消息双重显示（console.log + MessageList）
  - [Complex content] 与实际内容重复显示
  - 命令输出实际可见（问题 3 部分缓解）
  - 新发现 punycode 弃用警告（低优先级）
- 修复计划调整为短期快速修复 + 长期架构重构

### 2026-02-24: Issue 044 修复
- Resolved 044: 流式输出时 Ctrl+C 延迟生效
- 根因：AbortSignal 未传递给底层 SDK，HTTP 请求无法被取消
- 修复：传递 signal 给 Anthropic/OpenAI SDK 的 create 方法
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 6 个文件实现完整的中断功能

### 2026-02-23: Issue 040 详细分析
- 深度分析 040: REPL 显示严重问题
- 发现问题远超预期：重复消息、占位符、命令不可见、顺序混乱
- 对比 Gemini CLI 的 ConsolePatcher 架构
- 提出短期修复和长期重构方案
- 长期方案融合到 v0.4.0 monorepo 重构计划

### 2026-02-23: Issue 044 新增
- Added 044: 流式输出时 Ctrl+C 延迟生效 (High Priority)
- 根因：流式迭代期间 Ctrl+C 事件被延迟处理
- 043 修复了 AbortSignal 传递，但 Ctrl+C 按键事件处理仍有问题

### 2026-02-23: Issue 043 修复
- Resolved 043: 流式响应中断不完全
- 添加 AbortSignal 传递链：UI → runKodaX → provider → SDK
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 7 个文件实现完整的中断功能

### 2026-02-23: Issue 035 后续修复
- Resolved 041: 历史导航清空输入无法恢复
- Resolved 042: Shift+Enter/Ctrl+J 换行无效
- Added 043: 流式响应中断不完全（需要传递 AbortSignal 到 API 调用）

### 2026-02-23: REPL 显示问题
- Added 040: REPL 历史显示乱序 - Banner 出现在对话中间 (High Priority)
- 根因：console.log 与 MessageList 双重输出 + Ink patchConsole 机制导致渲染顺序混乱
- 解决方案：移除冗余的 console.log 用户输入输出

### 2026-02-22: Issue 状态更新
- Issue 037 (两套键盘事件系统冲突) → 计划在 v0.4.0 解决，已融合到 feature design
- Issue 038 (输入焦点竞态条件) → Won't Fix，理论问题无实际影响
- Issue 039 (死代码 printStartupBanner) → 计划在 v0.4.0 解决，已融合到 feature design
- 更新 v0.4.0 feature design 文档，添加同步解决的已知问题章节

### 2026-02-22: REPL 代码审查
- Added 035: Backspace 检测边缘情况 (High Priority)
- Added 036: React 状态同步潜在问题 (Medium Priority)
- Added 037: 两套键盘事件系统冲突 (Medium Priority)
- Added 038: 输入焦点竞态条件 (Low Priority)
- Added 039: 死代码 printStartupBanner (Low Priority)
- 所有新 issue 都包含详细的根因分析和安全修复方案
- Issue 037, 038, 039 推迟到 v0.4.0 处理

### 2026-02-22: 代码质量修复
- Resolved 008: 交互提示缺少输入验证
- Resolved 009: 不安全的类型断言

### 2026-02-21: 格式更新 (v0.3.3)
- 更新 KNOWN_ISSUES.md 格式以符合新版 known-issues-tracker 技能规范
- 添加 `Introduced` 和 `Fixed` 版本追踪字段
- 根据提交历史推断问题引入版本（v0.3.1: 交互式 UI 首次引入）

### 2026-02-20: v0.3.3 流式显示修复
- Resolved 031: Thinking 内容不显示
- Resolved 032: 非流式输出
- Resolved 033: Banner 消失
- Resolved 034: /help 输出不可见
- Added 28 test cases

### 2026-02-20: Phase 6-8 完成与会话管理修复
- Resolved 029: --continue 会话不恢复
- Resolved 030: gitRoot 未设置

### 2026-02-20: v0.3.2 高优先级问题修复
- Resolved 026: Resize handler 空引用
- Resolved 027: 异步上下文直接退出
- Resolved 028: 超宽终端分隔符

### 2026-02-20: 按键问题修复
- Resolved 023: Delete 键无效
- Resolved 024: Backspace 键无效
- Resolved 025: Shift+Enter 换行无效

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
