# FEATURE_263 v0.7.78 Human Test Guide

## Scope

Verify the complete evidence-gated background Skill learning loop: durable and
rewind-safe review, one immutable reviewer decision, project-scoped learned
Skill canaries, exact use/outcome attribution, conservative trust, and
reversible Learning Center controls.

## Preconditions

1. Use Node.js 20 or newer and build with `npm run build`.
2. Use a disposable KodaX home and project. Do not point this test at a normal
   user Skill directory.
3. Configure a working provider for background semantic review.
4. Keep the project identity stable during positive tests. Use a second
   disposable project for isolation tests.
5. Do not authorize paid eval work solely from this guide; normal provider
   calls made by the product flow are sufficient.

Focused automation:

```powershell
npx vitest run packages/agent/src/memory-control/review-inbox.test.ts packages/agent/src/memory-control/unified-review.test.ts packages/agent/src/learning/learned-skill.test.ts packages/agent/src/learning/learned-skill-driver.test.ts packages/agent/src/learning/learned-skill-usage.test.ts packages/agent/src/learning/legacy-learned-skill-migration.test.ts packages/agent/src/learning/learning-center.test.ts packages/agent/src/learning/store-lock.test.ts packages/agent/src/capabilities/skills/learned-precedence.test.ts packages/agent/src/session-lineage/memory-outcomes.test.ts packages/agent/src/session-lineage/compaction/file-tracker.test.ts packages/coding/src/learning-reviewer.test.ts packages/coding/src/learned-skill-runtime.test.ts packages/coding/src/memory/verified-checks.test.ts packages/coding/src/memory/coding-observations.test.ts packages/coding/src/memory-runtime.test.ts packages/coding/src/agent-runtime/run-substrate.memory-intervention.test.ts packages/repl/src/interactive/storage.test.ts src/runtime-agent-binding.test.ts src/runtime-daemon/server.test.ts src/sdk-runtime.test.ts src/sdk-runtime.learning.test.ts src/kodax_cli.runtime-runner.test.ts
```

## Checks

### 1. Foreground latency and durable intake

Complete a task that contains a reusable, prompt-safe method. Confirm the user
result is returned after the Outcome Digest and pending review job are durable,
without waiting for semantic review. Restart the owner immediately and confirm
the same job is resumed rather than duplicated.

Expected:

- one v2 job, immutable input checkpoint and at most one committed decision;
- frozen evidence has stable exact bytes/hash (including own `__proto__` keys),
  non-empty pinned prompt/schema/policy/provider revisions and canonical
  timestamps;
- pending-job creation and owner-session digest attachment are atomic under the
  captured root branch epoch; a concurrent branch change either waits or makes
  the old episode fail closed;
- provider retry state is separate from apply retry state;
- an uncooperative provider is cut off by the 90-second owner deadline;
- leased, backoff and attention jobs do not starve later eligible work;
- the committed decision pins one unique Memory-containing carrier set; invalid,
  duplicate or unplanned carriers are rejected before any external effect, and
  completion waits for every pinned receipt plus exact Memory result references;
- an older v2 decision without `requiredCarriers` remains restart-compatible:
  Memory is still mandatory, while a valid existing Skill receipt is optional
  and is neither rejected nor replayed;
- no foreground transcript or Action prompt is reused as reviewer state.

### 2. Qualification and automatic project canary

Ask explicitly to preserve a verified reusable method as a Skill, or complete
the same method successfully in two independent root episodes. Let background
review finish, then start a new root run in the same project.

Expected:

- corrections and raw failures still default to Memory;
- a qualifying low-risk Skill is stored as an immutable project record in
  `testing`, with a durable Learning Center notice;
- the Skill appears only on the next binding/run, not midway through the run
  that created it;
- no stable project identity produces a Ready/attention record and never an
  automatically active Skill.

### 3. Discovery and scope gates

Copy or alter a learned Skill artifact without updating its canonical record.
Also open the same KodaX home from a second project.

Expected:

- a mismatched fingerprint, missing/inactive record, symlink/reparse target or
  loose unrecorded artifact fails closed;
- the second project cannot discover the first project's learned Skill;
- a formal project/user Skill with the same name wins over learned content.

### 4. Exact invocation and verified success

Run a task that actually invokes the testing revision, then execute a supported
single verification command such as `npm test` and let it exit successfully.

Expected:

- inventory discovery creates only an `offered` receipt;
- actual expansion/invocation creates an exact revision/fingerprint receipt;
- a successful run with at least one trusted passing check and no failing check
  promotes that exact revision to `active_learned`;
- a bare `check_result`, model self-report, cancelled/timed-out command,
  chained shell command, user silence, or mere offer never promotes it.
- if ordinary usage-ledger enumeration fails, binding-scoped reconciliation
  still records an inconclusive terminal receipt before releasing the canary.
- a late delivery retry copies the already-settled canonical outcome, evidence
  and completion time rather than replacing them with the retry payload.
- outcome receipts with a different invocation/capability identity, reused
  invocation IDs from a replacement binding, or terminal canonical facts
  without an exact completion time fail closed.

### 5. Negative evidence and quarantine

Invoke an exact learned revision and produce a verified rule-level
contradiction. Separately reproduce a generic environment failure such as a
missing external service.

Expected:

- the exact still-current contradictory revision is quarantined and may create
  an immutable testing patch;
- stale revision/fingerprint evidence cannot quarantine a newer revision;
- the generic environment failure remains Memory/inconclusive evidence and
  does not rewrite or quarantine the Skill.

### 6. Canary budget and abandoned outcomes

Use a testing revision up to its three-invocation budget without independent
success evidence. Restart once while a binding lease is outstanding.

Expected:

- at most one concurrent testing binding is admitted;
- expired binding leases recover;
- an invocation from the expired binding receives its terminal outcome receipt
  even after a new root has acquired another binding;
- no fourth invocation is admitted;
- after issued outcomes settle inconclusively, the revision returns to
  Ready/attention instead of remaining exposed indefinitely.

### 7. Rewind and concurrent reviewer fencing

Pause a reviewer after it claims a job, rewind the Runtime session before the
job's digest, then release the reviewer. Repeat with `setActiveEntry`.

Expected:

- the session branch epoch advances before the session mutation;
- tenant-root registration and enumeration share a session authority fence;
  every registered root is locked in sorted order and all mutation plans pass a
  side-effect-free preflight before the first root is changed;
- the claimed job cannot commit a decision, Memory effect, Skill revision or
  action receipt after the branch change;
- a v2 envelope without its exact active-lineage `jobId` digest fails closed;
- a new branch may create a distinct job even when a legacy review key repeats.
- a host-persisted REPL session still durably appends the exact outcome inside
  the branch fence before the pending job may disappear. Such a host must
  provide atomic `storage.mutateLineage`; missing capability fails closed
  before any receipt/notice event is emitted. A `false` mutation result means
  the owner Session is missing and likewise emits no success event; a found
  idempotent no-op returns `true` and may retry host event delivery;
- two storage instances or processes writing the same session serialize on one
  per-session lock. A stale pre-rewind/pre-compaction snapshot, including one
  that proposes a conflicting new compaction, cannot restore retired context.
  A live Session writer held beyond five seconds remains a valid queued writer,
  and a concurrent branch mutation plus review completion waits without a
  nested branch-lock timeout;
- mixed Memory plans notify only the host-applied proposal subset. Receipt and
  notice lineage records remain idempotent, while host events use at-least-once
  delivery with the same job/episode identity after a callback crash.
- action/terminal receipts with mismatched path, job, decision, carrier, owner,
  proposal payload or timestamp fail closed without deleting pending work.
- new legacy v1 receipts bind owner scope; an older ownerless receipt is accepted
  only when its pending entry proves that same owner, and a foreign owner cannot
  clean the residue.

### 8. Learning Center controls

From the global Learning Center, review/trust a Ready revision, disable it,
re-enable it for testing, patch it, roll it back, then explicitly promote it
to the user Skill directory.

Expected:

- all actions use revision/fingerprint CAS and update the canonical project
  record;
- disable/quarantine/archive affects next-run discovery;
- rollback restores the exact previous immutable good artifact;
- cross-project duplicate display names require an exact capability ID;
- promotion never overwrites different formal content;
- another process observing the global event journal receives project Learned
  Area events without an in-process service facade.

### 9. Runtime mode and capability truthfulness

Run the same checks through inline, disposable Worker, and shared daemon modes.
Connect a deliberately old/unsupported daemon and require
`skillLearningLoop: 1`.

Expected:

- supported owners advertise the exact
  `project_scoped_canary`/immutable-decision/record-gated-discovery contract;
- Worker and daemon behavior matches inline behavior and uses one config home;
- raw daemon payloads cannot override `configHome` or `memoryIdentity`;
- delayed owner-session receipts/notices never enter the active REPL session;
- exhausted transient Windows cleanup leaves a per-owner-token released marker, so
  owner, choosing and ticket residue cannot poison the next acquisition;
- a completed job with a residual pending file is ignored and cleaned instead
  of being reclaimed as new work;
- the old daemon fails capability negotiation instead of silently falling back
  to a Ready-only or partial implementation.

## Expected Result

The feature learns only from bounded, prompt-safe and attributable evidence;
automatically exposes only project-scoped testing revisions; requires real
independent verification for trust; and keeps every learned behavior visible,
scope-bound, tamper-evident, disableable, quarantinable and exactly reversible.
