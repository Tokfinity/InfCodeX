# FEATURE_292 — Natural-Language-First Memory — Human Test Guide

> Version: `v0.7.85`
> Prerequisite: `npm run build` green and one configured LLM provider.

## 1. Conversation-first happy path

In a fresh project, say:

1. “请记住：这个项目提交前必须运行 npm run build:packages。”
2. “你记住了哪些与这个项目有关的内容？”
3. “请把刚才那条改成：提交前必须运行 npm run build。”
4. “请忘掉提交前运行 build 这条记忆。”

Expected: each explicit safe mutation is applied immediately and receives a
durable receipt. Recall shows accepted Memory rather than `MEMORY.md` existence.
Correction replaces the exact target; forgetting removes it. No approval command
or duplicate episode-review job is required.

## 2. Exceptional decision

Exercise the three exceptional cases separately:

- Broad or ambiguous wording asks a natural follow-up question and does not
  create a fake decision.
- A claim that conflicts with an existing stable claim key creates one readable
  decision with proposed content, reason, and risk. Approving or rejecting it
  in ordinary language uses the exact revision-bearing decision handle and
  current-turn authorization. Show it in one turn and approve it in the next;
  the approval succeeds unless the proposal changed in between.
- Restricted or secret content is rejected and never persisted or made
  approvable.

Run `/memory decisions` only as an advanced cross-check. Its content must match
the conversational explanation and be understandable without inspecting raw
review-job hashes.

## 3. Slash-command escape hatch

- `/memory` lists accepted entries or an explicit empty state.
- `/memory remember --key <semantic-key> [--kind fact|preference|policy|procedure] <text>`
  and `/memory forget <exact-ref>` perform the same governed operations
  as conversation. Omitting `--key` asks for clarification instead of creating
  an unaddressable duplicate fact.
- `/memory doctor` reports pipeline health without presenting internal jobs as
  ordinary user work.
- `/memory open` opens the sole accepted Memory scope in the system default
  external editor/file manager. With multiple scopes it prints exact
  `memory:<number>` choices; `/memory open memory:<number>` opens that item.
- Normal `/memory help` does not advertise raw reviews, status aliases, or
  `rebuild`. The hidden `/memory rebuild` repairs only the derived projection.

## 4. Skill separation

Run `/learn ready` and `/memory`. Expected: `/learn` manages learned reusable
capabilities (Skills); `/memory` manages durable user/project facts and
preferences. `/learn pending` identifies itself as a legacy alias and points to
`/memory doctor` for Memory pipeline health.

## 5. SDK parity

Using `@kodax-ai/kodax/experimental-memory`, create a Memory Agent for the same
identity and call `remember`, `list`, and `forget` through the inferred
`MemoryManagementAgent`. Also compile an old custom `MemoryController` and
confirm the factory returns only the base `MemoryAgent`. Expected: results match the
REPL/conversation state and preserve duplicate, scope, fingerprint, and safety
semantics. Existing review-summary and control-plane exports remain usable.
