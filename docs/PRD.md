# KodaX 产品需求文档（PRD）

> Last updated: 2026-03-26
>
> 本 PRD 描述 `FEATURE_022` 所承载的产品转向：
> KodaX 正从“CLI + Project Mode”转向“以 `task` 为中心、默认支持多智能体协作的执行引擎”。

## 中文导读

这份 PRD 关注的是“产品为什么这样设计”，不是代码细节。

建议先抓住这几个核心判断：

- 用户不应该先选 mode，再决定怎么提问；应该直接提出工作请求，由系统决定 execution shape。
- 对简单任务，`H0_DIRECT` 仍然可以成立；对复杂任务，multi-agent 和 verification 是默认路径。
- 产品层最重要的是 `task`，不是旧的 `Project Mode`。
- `kodax -c` 这种恢复语义属于 `user session`；内部 planner / evaluator 的 worker session 不应混进产品层恢复入口。

如果你想快速理解产品语义，优先看：

1. `User Promise`
2. `Product Principles`
3. `Primary User Journeys`

---

## 1. 产品定位

KodaX 面向这样一类用户：

- 希望代码库保持轻量、可检查
- 希望 provider 选择足够灵活
- 希望 long-running task 可靠执行
- 希望用户侧尽量少做 mode 切换
- 希望产品能从 terminal 逐步走向 embedded 和 multi-surface

产品外在应该尽量简单，但内部 execution model 必须足够强。

关键变化是：

- 旧模型：single agent + optional project workflow
- 新模型：由 task engine 自动判断何时需要 planning、multiple agents、verification

阅读辅助：

- `task engine` = 系统自动决定执行形态
- `user session` = 用户通过 `kodax -c` 恢复的会话
- `managed-task worker session` = planner / generator / evaluator 的内部执行上下文
- `evidence` = tests、deterministic checks、browser verification、reviewer judgment 等可验证证据

---

## 2. 用户承诺

当用户要求 KodaX 完成一项工作时，KodaX 应该：

1. 判断任务是简单还是复杂
2. 自动选择合适的 execution shape
3. 在 long-running work 中保留 task truth
4. 不盲信 executor 的自我汇报
5. 提供 inspection / override 能力，但不强迫用户先选 mode

一句话总结：

- 外面尽量简单
- 中间足够智能
- 最终结果足够可靠

---

## 3. 产品原则

### 3.1 隐形的 mode 选择

用户在提出请求之前，不应该先决定自己是不是处于 `project mode`、`brainstorm mode` 或 `multi-agent mode`。

### 3.2 非平凡任务默认走 native multi-agent

对于 non-trivial task，系统默认应该采用 role separation：

- planning
- execution
- evaluation

`single-agent execution` 只是 fallback，不是主架构。

### 3.3 证据优先于乐观自报

任务是否完成，应由 `evidence` 与 `evaluator` 判断，而不是由 executor 说“done”。

### 3.4 Durable task state

对于 long-running work，必须保存可持续的事实状态：

- task envelope
- contract
- plan
- evidence
- checkpoints
- lineage

### 3.5 Provider-aware behavior

KodaX should adapt to the actual semantics of the selected provider instead of assuming every provider behaves like the best native implementation.

### 3.6 Progressive simplification

As models and runtime guarantees improve, KodaX should remove scaffolding that is no longer load-bearing.

---

## 4. Primary User Journeys

### 4.1 Quick answer

User intent:

- explain code
- summarize a file
- answer a conceptual question

Expected behavior:

- lightweight routing
- no unnecessary task ceremony
- fast answer

### 4.2 Directed code change

User intent:

- make a small edit
- fix a bug
- add a focused behavior

Expected behavior:

- automatic detection that evaluation is needed
- generator plus evaluator flow
- clear summary of what changed and what was verified

### 4.3 Ambiguous or architectural request

User intent:

- "build X"
- "improve this system"
- "make this production-ready"

Expected behavior:

- auto-triggered discovery or brainstorm
- contract creation before major execution
- explicit scope and assumptions

### 4.4 Long-running delivery

User intent:

- multi-file refactor
- feature delivery across many turns
- sustained work over time

Expected behavior:

- durable task state
- checkpoints
- evidence accumulation
- native multi-agent orchestration
- resumable execution

---

## 5. Core Product Capabilities

### 5.1 Task intake and routing

The system must determine:

- task kind
- complexity
- risk
- append vs overwrite
- whether brainstorm is needed
- whether durable state is required
- which harness profile to use

### 5.2 Native multi-agent execution

The system must support:

- `Lead`
- `Planner`
- `Generator`
- `Evaluator`
- optional specialist workers

### 5.3 Evidence-driven verification

The system must support:

- deterministic checks
- evaluator review
- evidence capture
- completion verdicts
- retry loops when evidence is insufficient

### 5.4 Durable task memory

The system must persist:

- task envelope
- contract
- decisions
- evidence
- checkpoints
- session tree / lineage

### 5.5 Capability substrate

The system must support:

- extensible tools and capabilities
- sandbox and MCP as optional runtime capabilities
- structured result transport
- host-neutral loading

### 5.6 Multi-surface readiness

The runtime must be reusable across:

- terminal
- ACP host integrations
- future IDE and desktop surfaces

---

## 6. Target User Experience

### 6.1 What the user should feel

- "I can just ask."
- "The system knows when to think harder."
- "The system does not overcomplicate simple tasks."
- "Long-running work feels managed instead of fragile."
- "When KodaX says a task is done, it can explain why."

### 6.2 What the user should not need to think about

- whether to manually enter project mode
- whether to manually request brainstorm mode
- whether to manually choose multi-agent architecture
- whether the executor is self-grading its own work

---

## 7. Transitional UX Policy

### 7.1 `/project`

`/project` remains available, but its role changes:

- status and inspection
- manual override
- resume, pause, or verify
- artifact browsing

It is no longer the conceptual center of the product.

### 7.2 `--init` and `--auto-continue`

These stay as compatibility and convenience entry points, but should route into the same task engine used by natural requests.

### 7.3 `--team`

`--team` should stop being treated as the main multi-agent product story.

If retained temporarily, it should be documented as legacy or compatibility-oriented behavior.

---

## 8. Out-of-Scope Ideas

The architecture reset intentionally avoids:

- mandatory heavyweight multi-agent execution for every prompt
- hidden or opaque score systems without inspectable evidence
- unlimited branch-search or auto-generated harness code
- using the extension runtime as a catch-all orchestration layer

---

## 9. Success Criteria

### 9.1 Product outcomes

1. Users can issue long-running requests without first choosing "project mode".
2. Non-trivial write tasks use independent evaluation by default.
3. Managed tasks survive interruption with durable state.
4. Provider differences are explicit instead of silently flattened.
5. KodaX can evolve into IDE, desktop, and remote surfaces without rewriting the core engine.

### 9.2 Quality outcomes

1. Fewer false-positive "done" states.
2. Clearer reasoning about append vs overwrite.
3. Better behavior on ambiguous tasks.
4. Better trust in long-running automation.

---

## 10. Roadmap Strategy

### 10.1 Foundation release: v0.7.0

Goals:

- install the new core engine shape
- make multi-agent native
- make task routing explicit
- keep `034` as the runtime substrate

Features:

- `019` Session Tree, Checkpoints, and Rewindable Task Runs
- `022` Native Multi-Agent Control Plane
- `025` Adaptive Task Intelligence and Harness Router
- `026` Roadmap Integrity and Planning Hygiene
- `029` Provider Capability Transparency and Harness Policy
- `034` Extension and Capability Runtime

### 10.2 Enrichment release: v0.8.0

Goals:

- deepen retrieval, knowledge, and runtime safety

Features:

- `007` Theme System Consolidation
- `018` Task-Aware Repository Intelligence Substrate
- `028` First-Class Retrieval, Context, and Evidence Tooling
- `035` MCP Capability Provider
- `038` Official Sandbox Extension

### 10.3 Delivery releases

Later priorities:

- `031` Multimodal Artifact Inputs
- `023` Dual-Mode Terminal UX
- `030` Multi-Surface Delivery

---

## 11. Dependencies and Boundaries

### 11.1 Runtime substrate

`FEATURE_034` is necessary and should remain strong, but it is not the multi-agent control plane.

### 11.2 Verification substrate

The existing project harness ideas remain valuable, but they should be generalized into task-level evidence and evaluator semantics.

### 11.3 Legacy project artifacts

Current project truth files and `.agent/project/` remain useful as migration inputs, not as the permanent core abstraction.

---

## 12. References

- [ADR](ADR.md)
- [HLD](HLD.md)
- [Detailed Design](DD.md)
- [Feature Roadmap](features/README.md)

---

## Appendix A: Retained Product Baseline and Constraints

The sections above define the target product direction after the `FEATURE_022` shift. The appendix below restores important baseline product information from the earlier PRD so implementation work still has access to the current-product frame, constraints, and release history.

### A.1 Original product positioning

KodaX remains a lightweight TypeScript coding agent with:

- a layered architecture whose lower layers can be reused independently
- broad multi-provider support
- explicit permission modes and tool confirmations
- extension points across providers, tools, and skills

That baseline still matters even as the product shifts from "CLI plus Project Mode" to a task engine.

### A.2 Target users retained

| User type | Typical use | Core need |
|---|---|---|
| Independent developers | daily coding assistance | speed, low cost, provider choice |
| Team developers | review, refactor, guided edits | consistency, configurability, permissions |
| DevOps and automation users | CI/CD, unattended flows | automation, reliability, long-running behavior |
| AI builders and researchers | agent experiments | modularity, reusability, inspectability |

### A.3 Current core feature baseline

| Capability | Baseline value | Priority in the old PRD |
|---|---|---|
| Multi-provider support | Anthropic, OpenAI, Google-adjacent, Zhipu, Kimi, MiniMax, DeepSeek, bridge-backed providers | `P0` |
| Interactive REPL | Ink / React terminal UI with streaming output | `P0` |
| Tool set | read, write, edit, bash, glob, grep, undo, diff, ask-user | `P0` |
| Permission modes | `plan`, `default`, `accept-edits`, `auto-in-project` | `P0` |
| Session management | save, resume, list, delete | `P1` |
| Thinking / reasoning mode | supported on capable providers | `P1` |
| Parallel tool execution | multi-tool parallelism where safe | `P1` |
| Skills system | markdown-defined reusable instruction bundles | `P1` |
| Long-running flows | project workflows, harness, resumable automation | `P2` |
| Multi-agent work | now re-scoped under `FEATURE_022` | `P2` historically, now foundational |

### A.4 Technical constraints retained

| Area | Constraint |
|---|---|
| Runtime | Node.js `>= 20.0.0` |
| Language | TypeScript `>= 5.3.0` |
| CLI stack | Ink (`React for CLI`) remains the current renderer baseline |
| Tests | Vitest remains the primary test framework |
| Packaging | npm workspaces monorepo |
| Licensing | allow Apache / BSD / MIT style dependencies; avoid GPL / SSPL |
| Architecture | packages should remain independently useful where practical |
| Dependency direction | no circular dependencies |
| Quality bar | target high type safety and strong test coverage |

### A.5 Functional requirements by layer retained

#### `@kodax/ai`

Still requires:

- shared provider abstraction
- unified streaming interface
- provider registry
- normalized errors
- provider-aware reasoning controls where supported

#### `@kodax/agent`

Still requires:

- session management
- message persistence and reconstruction
- compaction-friendly message handling
- token estimation support

#### `@kodax/skills`

Still requires:

- skill discovery from user and project locations
- markdown-first skill execution
- natural-language triggering
- support for built-in and custom skills

#### `@kodax/coding`

Still requires:

- tool definitions and execution
- prompt construction
- coding loop orchestration
- permission integration
- long-running and harness-friendly runtime behavior

#### `@kodax/repl`

Still requires:

- interactive terminal UX
- permission controls
- built-in commands
- autocomplete
- theme support
- managed task and project control surfaces

### A.6 Non-functional requirements retained

| Area | Retained expectation |
|---|---|
| First response latency | aim for a fast first token / first visible response |
| Memory | avoid unnecessary runtime bloat |
| Type safety | keep public APIs strongly typed |
| Testability | components should remain independently testable |
| Cross-platform support | Windows, macOS, and Linux remain supported targets |
| Documentation | public interfaces and major workflows should remain documented |

### A.7 Release history retained

Important shipped milestones from the previous PRD remain useful as product history:

- `v0.5.x`: 5-layer architecture stabilized
- `v0.5.33`: autocomplete system and broader provider set
- `v0.6.0`: Command System 2.0 and Project Mode 2.0
- `v0.6.4`: history review mode and mouse-wheel interaction improvements
- `v0.6.10`: Project Harness and artifact migration
- `v0.6.15`: ACP server, provider growth, pending inputs, and runtime controls

The target state has changed, but these milestones remain part of the path that led to the current architecture.

### A.8 Risk baseline retained

| Risk | Why it still matters | Typical mitigation |
|---|---|---|
| Provider API changes | can break integrations quickly | isolate through provider abstraction |
| Dependency vulnerabilities | affect local execution trust | dependency review and updates |
| Context and token limits | still shape runtime behavior | compaction and provider-aware policy |
| Concurrency hazards | affect tool safety and determinism | guarded parallelism and explicit ownership |
| False-positive completion | more serious under automation | evaluator separation and evidence model |

### A.9 Glossary retained

| Term | Meaning |
|---|---|
| Provider | implementation of a model backend |
| Tool | callable runtime capability exposed to the agent |
| Skill | reusable instruction bundle |
| Session | persisted conversation/runtime history |
| Task | first-class managed work unit in the new architecture |
| Contract | task-local scope and completion criteria |
| Evidence | persisted proof used for completion judgment |
