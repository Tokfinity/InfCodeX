import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setAgentConfigHome } from "../runtime/agent-home.js";
import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from "../diagnostics.js";
import { withLearningFileLock } from "../learning/store-lock.js";
import { hashMemoryIdentityComponent } from "../memory/index.js";
import type { KodaXMemoryOutcomeDigest } from "../types.js";
import {
  claimEpisodeReview,
  captureEpisodeReviewBranchEpoch,
  commitEpisodeReviewAction,
  commitEpisodeReviewDecision,
  completeEpisodeReview,
  completeFencedEpisodeReview,
  deferEpisodeReview,
  drainPendingEpisodeReviews,
  failEpisodeReviewApply,
  failEpisodeReviewAttempt,
  freezeEpisodeReviewInput,
  inspectEpisodeReviewJob,
  listPendingEpisodeReviews,
  persistPendingEpisodeReview,
  withPendingEpisodeReviewSessionFence,
  type EpisodeReviewDrainOptions,
  type PendingEpisodeReviewV2,
  EpisodeReviewBranchChangedError,
} from "./review-inbox.js";

const identity = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  projectId: "project-a",
  sessionId: "session-a",
} as const;

function digest(sequence = 1): KodaXMemoryOutcomeDigest {
  return {
    id: `digest-${sequence}`,
    reviewKey: `review-${sequence}`,
    sessionId: identity.sessionId,
    branchId: identity.sessionId,
    sequence,
    objective: "Ship memory",
    approach: "Run tests",
    outcome: "succeeded",
    summary: "Tests passed",
    evidenceRefs: ["tool:test"],
    visibility: "prompt_safe",
    createdAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("FEATURE_260 episode review inbox", () => {
  let home: string | undefined;

  afterEach(async () => {
    setAgentConfigHome(undefined);
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("upserts one minimized pending review idempotently", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-inbox-"));
    setAgentConfigHome(home);

    const first = await persistPendingEpisodeReview(identity, digest());
    const second = await persistPendingEpisodeReview(identity, digest());
    const pending = await listPendingEpisodeReviews({
      tenantId: identity.tenantId,
    });

    expect(first.path).toBe(second.path);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reviewKey: "review-1",
      ownerSessionRef: "session-a",
    });
    expect(await readFile(first.path, "utf8")).not.toContain("tenant-a");
  });

  it("retains an intent-only cancelled digest as one idempotent pending review", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-cancelled-intent-"),
    );
    setAgentConfigHome(home);
    const evidenceRef = "user-intent:cancelled-preference";
    const cancelledDigest: KodaXMemoryOutcomeDigest = {
      ...digest(),
      outcome: "cancelled",
      objective: "Run focused tests before reporting success.",
      approach: "episode completion",
      summary: "Explicit memory intent captured before episode cancellation.",
      evidenceRefs: [evidenceRef],
      evidence: [
        {
          ref: evidenceRef,
          grade: "authoritative",
          source: "user",
          observedAt: "2026-07-29T07:00:00.000Z",
        },
      ],
      memoryIntent: {
        operation: "remember",
        evidenceRef,
        candidateStatement: "Run focused tests before reporting success.",
        userQuote: "Going forward, run focused tests before reporting success.",
      },
    };

    const first = await persistPendingEpisodeReview(identity, cancelledDigest);
    const second = await persistPendingEpisodeReview(identity, cancelledDigest);
    const pending = await listPendingEpisodeReviews({
      tenantId: identity.tenantId,
    });

    expect(first.entry.jobId).toBe(second.entry.jobId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.digest).toMatchObject({
      outcome: "cancelled",
      evidenceRefs: [evidenceRef],
      memoryIntent: { evidenceRef },
    });
  });

  it("rejects a cancelled digest without authoritative bound intent", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-invalid-cancelled-"),
    );
    setAgentConfigHome(home);
    const persistOwner = vi.fn(async () => undefined);
    const invalidDigest = {
      ...digest(),
      outcome: "cancelled",
    } as KodaXMemoryOutcomeDigest;

    await expect(
      persistPendingEpisodeReview(identity, invalidDigest, { persistOwner }),
    ).rejects.toThrow("invalid outcome digest");
    expect(persistOwner).not.toHaveBeenCalled();
    expect(await readdir(home, { recursive: true })).toEqual([]);
  });

  it("writes a receipt before removing the pending entry", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-complete-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());

    await expect(
      completeEpisodeReview(identity, "review-1", ["proposal-1"]),
    ).rejects.toThrow("v2 episode review requires frozen input");
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toHaveLength(1);
  });

  it("serializes new tenant root registration with a session-wide fence", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-root-registry-"),
    );
    const identityA = { ...identity, configHome: home };
    const identityB = { ...identityA, tenantId: "tenant-b" };
    const pendingA = await persistPendingEpisodeReview(identityA, digest(2));
    const tenantRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identityA.tenantId),
      hashMemoryIdentityComponent("session", identityA.sessionId),
    );
    const branchLockPath = path.join(tenantRoot, ".branch-authority.lock");
    let releaseBranchLock!: () => void;
    const branchLockRelease = new Promise<void>((resolve) => {
      releaseBranchLock = resolve;
    });
    let markBranchLockHeld!: () => void;
    const branchLockHeld = new Promise<void>((resolve) => {
      markBranchLockHeld = resolve;
    });
    const holder = withLearningFileLock(branchLockPath, async () => {
      markBranchLockHeld();
      await branchLockRelease;
    });
    await branchLockHeld;

    const fence = withPendingEpisodeReviewSessionFence(
      {
        configHome: home,
        sessionId: identityA.sessionId,
      },
      (runFence) => runFence([]),
    );
    const queuePath = `${branchLockPath}.queue`;
    const queueDeadline = Date.now() + 2_000;
    let fenceQueued = false;
    while (!fenceQueued && Date.now() < queueDeadline) {
      try {
        fenceQueued = (await readdir(queuePath)).some((name) =>
          name.startsWith("ticket-"),
        );
      } catch {
        // The fair-lock queue may not exist until the fence reaches this root.
      }
      if (!fenceQueued)
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(fenceQueued).toBe(true);

    let tenantBRegistered = false;
    const registerTenantB = (async () => {
      const epoch = await captureEpisodeReviewBranchEpoch(identityB);
      const persisted = await persistPendingEpisodeReview(
        identityB,
        {
          ...digest(2),
          id: "digest-root-registry-tenant-b",
          reviewKey: "review-root-registry-tenant-b",
        },
        { expectedBranchEpoch: epoch },
      );
      tenantBRegistered = true;
      return persisted;
    })();
    const registrationDeadline = Date.now() + 1_000;
    while (!tenantBRegistered && Date.now() < registrationDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const registeredBeforeFence = tenantBRegistered;

    releaseBranchLock();
    const [removed, persistedB] = await Promise.all([fence, registerTenantB]);
    await holder;

    expect(registeredBeforeFence).toBe(false);
    expect(removed).toBe(1);
    expect(persistedB.entry.branchEpoch).toBe(0);
    expect(
      await listPendingEpisodeReviews({
        configHome: home,
        tenantId: identityA.tenantId,
      }),
    ).toEqual([]);
    expect(
      await listPendingEpisodeReviews({
        configHome: home,
        tenantId: identityB.tenantId,
      }),
    ).toMatchObject([{ digest: { id: "digest-root-registry-tenant-b" } }]);
    expect(pendingA.entry.jobId).not.toBe(persistedB.entry.jobId);
  });

  it("fences jobs outside the exact active branch even when their sequence is lower", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-exact-fence-"),
    );
    const active = {
      ...digest(9),
      id: "digest-active",
      reviewKey: "review-active",
    };
    const sibling = {
      ...digest(1),
      id: "digest-sibling",
      reviewKey: "review-sibling",
      branchId: "sibling",
    };
    await persistPendingEpisodeReview(
      { ...identity, configHome: home },
      active,
    );
    const siblingReview = await persistPendingEpisodeReview(
      { ...identity, configHome: home },
      sibling,
    );

    expect(
      await withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: identity.sessionId,
        },
        (fence) => fence([active.id]),
      ),
    ).toBe(1);
    expect(
      await listPendingEpisodeReviews({
        configHome: home,
        tenantId: identity.tenantId,
      }),
    ).toMatchObject([{ digest: { id: active.id } }]);
    const authority = JSON.parse(
      await readFile(
        path.join(
          home,
          "memory-review-inbox",
          hashMemoryIdentityComponent("tenant", identity.tenantId),
          hashMemoryIdentityComponent("session", identity.sessionId),
          "branch-authority.json",
        ),
        "utf8",
      ),
    ) as {
      readonly exactFences?: readonly {
        readonly retiredJobIds: readonly string[];
      }[];
    };
    expect(
      authority.exactFences?.some((fence) =>
        fence.retiredJobIds.includes(siblingReview.entry.jobId),
      ),
    ).toBe(true);
  });

  it("prevalidates every tenant root before applying an exact session fence", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-fence-preflight-"),
    );
    const tenantIds = ["tenant-preflight-a", "tenant-preflight-b"].sort(
      (left, right) =>
        hashMemoryIdentityComponent("tenant", left).localeCompare(
          hashMemoryIdentityComponent("tenant", right),
        ),
    );
    const goodOwner = {
      ...identity,
      configHome: home,
      tenantId: tenantIds[0]!,
    };
    const badOwner = { ...identity, configHome: home, tenantId: tenantIds[1]! };
    const goodDigest = {
      ...digest(2),
      id: "digest-fence-preflight-good",
      reviewKey: "review-fence-preflight-good",
    };
    const good = await persistPendingEpisodeReview(goodOwner, goodDigest);
    const badDigest = {
      ...digest(1),
      id: "digest-fence-preflight-bad-receipt",
      reviewKey: "review-fence-preflight-bad-receipt",
    };
    const badSessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", badOwner.tenantId),
      hashMemoryIdentityComponent("session", badOwner.sessionId),
    );
    const badPendingDir = path.join(badSessionRoot, "pending");
    const badReceiptsDir = path.join(badSessionRoot, "receipts");
    await mkdir(badPendingDir, { recursive: true });
    await mkdir(badReceiptsDir, { recursive: true });
    await writeFile(
      path.join(
        badPendingDir,
        `${hashMemoryIdentityComponent("review", badDigest.reviewKey)}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        reviewKey: badDigest.reviewKey,
        digest: badDigest,
        ownerSessionRef: badOwner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", badOwner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          badOwner.projectId,
        ),
        createdAt: badDigest.createdAt,
      })}\n`,
      "utf8",
    );
    const badReceiptPath = path.join(
      badReceiptsDir,
      `${hashMemoryIdentityComponent("review", badDigest.reviewKey)}.json`,
    );
    await writeFile(badReceiptPath, "{}\n", "utf8");

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: identity.sessionId,
        },
        (fence) => fence([]),
      ),
    ).rejects.toThrow("invalid review protocol record");
    await rm(badReceiptPath, { force: true });
    await expect(
      claimEpisodeReview(goodOwner, good.entry.jobId),
    ).resolves.toMatchObject({ jobId: good.entry.jobId });
  });

  it("does not delete a v2 envelope whose completed state has a mismatched identity", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-state-identity-"),
    );
    const owner = { ...identity, configHome: home };
    const persisted = await persistPendingEpisodeReview(owner, {
      ...digest(2),
      id: "digest-state-identity",
      reviewKey: "review-state-identity",
    });
    const statePath = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
      "jobs",
      hashMemoryIdentityComponent("review", persisted.entry.jobId),
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      statePath,
      `${JSON.stringify({ ...state, jobId: "wrong-job-id", status: "completed" })}\n`,
      "utf8",
    );

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: owner.sessionId,
        },
        (fence) => fence([]),
      ),
    ).rejects.toThrow("review job state identity mismatch");
    await expect(readFile(persisted.path, "utf8")).resolves.toContain(
      persisted.entry.jobId,
    );
  });

  it("drains only owner-validated reviews and keeps deferred work pending", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-inbox-drain-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, digest(2));
    await persistPendingEpisodeReview(identity, digest(3));

    const reviewed: string[] = [];
    const result = await drainPendingEpisodeReviews(identity, {
      revalidate: async (entry) =>
        entry.digest.sequence === 1
          ? "eligible"
          : entry.digest.sequence === 2
            ? "discard"
            : "defer",
      review: async (entry) => {
        reviewed.push(entry.reviewKey);
        return [`proposal-${entry.digest.sequence}`];
      },
    });

    expect(result).toEqual({
      reviewed: 1,
      discarded: 1,
      deferred: 1,
      failed: 0,
      failures: [],
    });
    expect(reviewed).toEqual(["review-1"]);
    expect(
      (await listPendingEpisodeReviews({ tenantId: identity.tenantId })).map(
        (entry) => entry.reviewKey,
      ),
    ).toEqual(["review-3"]);
  });

  it("holds session authority through a legacy v1 review effect and receipt", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-fence-"),
    );
    const owner = { ...identity, configHome: home };
    const legacyDigest = {
      ...digest(1),
      id: "digest-legacy-v1-fence",
      reviewKey: "review-legacy-v1-fence",
    };
    const pendingDir = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
      "pending",
    );
    await mkdir(pendingDir, { recursive: true });
    await writeFile(
      path.join(
        pendingDir,
        `${hashMemoryIdentityComponent("review", legacyDigest.reviewKey)}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        reviewKey: legacyDigest.reviewKey,
        digest: legacyDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: legacyDigest.createdAt,
      })}\n`,
      "utf8",
    );
    let releaseReview!: () => void;
    const reviewRelease = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let markReviewEntered!: () => void;
    const reviewEntered = new Promise<void>((resolve) => {
      markReviewEntered = resolve;
    });
    let appliedEffects = 0;
    const drain = drainPendingEpisodeReviews(owner, {
      revalidate: async () => "eligible",
      review: async () => {
        markReviewEntered();
        await reviewRelease;
        appliedEffects += 1;
        return ["proposal-legacy-v1-fence"];
      },
    });
    await reviewEntered;

    let fenceFinished = false;
    const fence = withPendingEpisodeReviewSessionFence(
      {
        configHome: home,
        sessionId: owner.sessionId,
      },
      (runFence) => runFence([]),
    ).then((removed) => {
      fenceFinished = true;
      return removed;
    });
    const fenceDeadline = Date.now() + 1_000;
    while (!fenceFinished && Date.now() < fenceDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const fenceFinishedBeforeReview = fenceFinished;

    releaseReview();
    const [result, removed] = await Promise.all([drain, fence]);

    expect(fenceFinishedBeforeReview).toBe(false);
    expect(appliedEffects).toBe(1);
    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect(removed).toBe(0);
  });

  it("retires an abandoned legacy v1 processing entry during a session fence", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-processing-"),
    );
    const owner = { ...identity, configHome: home };
    const legacyDigest = {
      ...digest(1),
      id: "digest-legacy-v1-processing",
      reviewKey: "review-legacy-v1-processing",
    };
    const processingDir = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
      "processing",
    );
    const processingPath = path.join(processingDir, "abandoned-v1.json");
    await mkdir(processingDir, { recursive: true });
    await writeFile(
      processingPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: legacyDigest.reviewKey,
        digest: legacyDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: legacyDigest.createdAt,
      })}\n`,
      "utf8",
    );

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: owner.sessionId,
        },
        (fence) => fence([]),
      ),
    ).resolves.toBe(1);
    await expect(readFile(processingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toEqual([]);

    const activeDigest = {
      ...legacyDigest,
      id: "digest-legacy-v1-processing-active",
      reviewKey: "review-legacy-v1-processing-active",
    };
    await writeFile(
      processingPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: activeDigest.reviewKey,
        digest: activeDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: activeDigest.createdAt,
      })}\n`,
      "utf8",
    );

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: owner.sessionId,
        },
        (fence) => fence([activeDigest.id]),
      ),
    ).resolves.toBe(0);
    await expect(readFile(processingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: activeDigest.id } }]);
  });

  it("preserves an active legacy processing entry when fencing a same-key pending entry", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-fence-collision-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewKey = "review-legacy-v1-fence-collision";
    const activeDigest = {
      ...digest(1),
      id: "digest-legacy-v1-active-processing",
      reviewKey,
    };
    const retiredDigest = {
      ...digest(2),
      id: "digest-legacy-v1-retired-pending",
      reviewKey,
      createdAt: "2026-07-12T00:01:00.000Z",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingDir = path.join(sessionRoot, "pending");
    const processingDir = path.join(sessionRoot, "processing");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(processingDir, { recursive: true });
    const legacyEntry = (reviewDigest: KodaXMemoryOutcomeDigest) => ({
      version: 1,
      reviewKey,
      digest: reviewDigest,
      ownerSessionRef: owner.sessionId,
      ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
      ownerProjectHash: hashMemoryIdentityComponent("project", owner.projectId),
      createdAt: reviewDigest.createdAt,
    });
    await writeFile(
      path.join(
        pendingDir,
        `${hashMemoryIdentityComponent("review", reviewKey)}.json`,
      ),
      `${JSON.stringify(legacyEntry(retiredDigest))}\n`,
      "utf8",
    );
    const processingPath = path.join(processingDir, "active-claim.json");
    await writeFile(
      processingPath,
      `${JSON.stringify(legacyEntry(activeDigest))}\n`,
      "utf8",
    );

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: owner.sessionId,
        },
        (fence) => fence([activeDigest.id]),
      ),
    ).resolves.toBe(1);
    await expect(readFile(processingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: activeDigest.id } }]);
  });

  it("does not let a stale legacy claim overwrite a same-key pending entry", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-stale-collision-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewKey = "review-legacy-v1-stale-collision";
    const staleDigest = {
      ...digest(1),
      id: "digest-legacy-v1-stale-processing",
      reviewKey,
    };
    const pendingDigest = {
      ...digest(2),
      id: "digest-legacy-v1-new-pending",
      reviewKey,
      createdAt: "2026-07-12T00:01:00.000Z",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingDir = path.join(sessionRoot, "pending");
    const processingDir = path.join(sessionRoot, "processing");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(processingDir, { recursive: true });
    const legacyEntry = (reviewDigest: KodaXMemoryOutcomeDigest) => ({
      version: 1,
      reviewKey,
      digest: reviewDigest,
      ownerSessionRef: owner.sessionId,
      ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
      ownerProjectHash: hashMemoryIdentityComponent("project", owner.projectId),
      createdAt: reviewDigest.createdAt,
    });
    await writeFile(
      path.join(
        pendingDir,
        `${hashMemoryIdentityComponent("review", reviewKey)}.json`,
      ),
      `${JSON.stringify(legacyEntry(pendingDigest))}\n`,
      "utf8",
    );
    const processingPath = path.join(processingDir, "stale-claim.json");
    await writeFile(
      processingPath,
      `${JSON.stringify(legacyEntry(staleDigest))}\n`,
      "utf8",
    );
    const staleTime = new Date(Date.now() - 6 * 60_000);
    await utimes(processingPath, staleTime, staleTime);

    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: pendingDigest.id } }]);
    await expect(readdir(processingDir)).resolves.toEqual(["stale-claim.json"]);

    await expect(
      withPendingEpisodeReviewSessionFence(
        {
          configHome: home,
          sessionId: owner.sessionId,
        },
        (fence) => fence([staleDigest.id]),
      ),
    ).resolves.toBe(1);
    await expect(readdir(processingDir)).resolves.toEqual([]);
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: staleDigest.id } }]);
  });

  it("does not replay a distinct stale legacy claim after the same key completes", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-receipt-gate-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewKey = "review-legacy-v1-receipt-gate";
    const staleDigest = {
      ...digest(1),
      id: "digest-legacy-v1-receipt-stale",
      reviewKey,
    };
    const pendingDigest = {
      ...digest(2),
      id: "digest-legacy-v1-receipt-pending",
      reviewKey,
      createdAt: "2026-07-12T00:01:00.000Z",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingDir = path.join(sessionRoot, "pending");
    const processingDir = path.join(sessionRoot, "processing");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(processingDir, { recursive: true });
    const legacyEntry = (reviewDigest: KodaXMemoryOutcomeDigest) => ({
      version: 1,
      reviewKey,
      digest: reviewDigest,
      ownerSessionRef: owner.sessionId,
      ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
      ownerProjectHash: hashMemoryIdentityComponent("project", owner.projectId),
      createdAt: reviewDigest.createdAt,
    });
    await writeFile(
      path.join(
        pendingDir,
        `${hashMemoryIdentityComponent("review", reviewKey)}.json`,
      ),
      `${JSON.stringify(legacyEntry(pendingDigest))}\n`,
      "utf8",
    );
    const processingPath = path.join(processingDir, "stale-claim.json");
    await writeFile(
      processingPath,
      `${JSON.stringify(legacyEntry(staleDigest))}\n`,
      "utf8",
    );
    const staleTime = new Date(Date.now() - 6 * 60_000);
    await utimes(processingPath, staleTime, staleTime);
    let appliedEffects = 0;
    const options = {
      revalidate: async () => "eligible" as const,
      review: async () => {
        appliedEffects += 1;
        return ["proposal-legacy-v1-receipt-gate"];
      },
    };

    await expect(
      drainPendingEpisodeReviews(owner, options),
    ).resolves.toMatchObject({ reviewed: 1, failed: 0 });
    expect(appliedEffects).toBe(1);
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toEqual([]);
    await expect(readdir(processingDir)).resolves.toEqual([]);
    await expect(
      drainPendingEpisodeReviews(owner, options),
    ).resolves.toMatchObject({ reviewed: 0, failed: 0 });
    expect(appliedEffects).toBe(1);
  });

  it("removes a legacy pending residue protected by a committed receipt", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-pending-receipt-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewDigest = {
      ...digest(1),
      id: "digest-legacy-v1-pending-receipt",
      reviewKey: "review-legacy-v1-pending-receipt",
    };
    const pendingDir = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
      "pending",
    );
    await mkdir(pendingDir, { recursive: true });
    const pendingPath = path.join(
      pendingDir,
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    const entry = {
      version: 1,
      reviewKey: reviewDigest.reviewKey,
      digest: reviewDigest,
      ownerSessionRef: owner.sessionId,
      ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
      ownerProjectHash: hashMemoryIdentityComponent("project", owner.projectId),
      createdAt: reviewDigest.createdAt,
    };
    await writeFile(pendingPath, `${JSON.stringify(entry)}\n`, "utf8");
    await completeEpisodeReview(owner, reviewDigest.reviewKey, [
      "proposal-completed",
    ]);
    await writeFile(pendingPath, `${JSON.stringify(entry)}\n`, "utf8");
    let appliedEffects = 0;

    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toEqual([]);
    await expect(readFile(pendingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      drainPendingEpisodeReviews(owner, {
        revalidate: async () => "eligible",
        review: async () => {
          appliedEffects += 1;
          return ["proposal-replayed"];
        },
      }),
    ).resolves.toMatchObject({ reviewed: 0, failed: 0 });
    expect(appliedEffects).toBe(0);
  });

  it("rejects malformed or mismatched receipts without deleting legacy work", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-invalid-receipt-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewDigest = {
      ...digest(1),
      id: "digest-legacy-v1-invalid-receipt",
      reviewKey: "review-legacy-v1-invalid-receipt",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingDir = path.join(sessionRoot, "pending");
    const receiptsDir = path.join(sessionRoot, "receipts");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(receiptsDir, { recursive: true });
    const pendingPath = path.join(
      pendingDir,
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    await writeFile(
      pendingPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        digest: reviewDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: reviewDigest.createdAt,
      })}\n`,
      "utf8",
    );
    const receiptPath = path.join(
      receiptsDir,
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    const invalidReceipts: readonly unknown[] = [
      {},
      {
        version: 1,
        reviewKey: "wrong-review-key",
        proposalIds: ["proposal-1"],
        completedAt: "2026-07-12T00:02:00.000Z",
      },
      {
        version: 1,
        jobId: "wrong-job-id",
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-1"],
        completedAt: "2026-07-12T00:02:00.000Z",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        ownerAgentHash: hashMemoryIdentityComponent("agent", "agent-b"),
        ownerProjectHash: hashMemoryIdentityComponent("project", "project-b"),
        proposalIds: ["proposal-1"],
        completedAt: "2026-07-12T00:02:00.000Z",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: [1],
        completedAt: "2026-07-12T00:02:00.000Z",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-1"],
        completedAt: "not-a-timestamp",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-1"],
        completedAt: "0",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-1"],
        completedAt: "2026-02-30T00:00:00.000Z",
      },
      {
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-1"],
        completedAt: "2026-07-12T00:02:00.000Z",
        forgedAuthority: "attacker",
      },
    ];

    for (const invalidReceipt of invalidReceipts) {
      await writeFile(
        receiptPath,
        `${JSON.stringify(invalidReceipt)}\n`,
        "utf8",
      );
      await expect(
        listPendingEpisodeReviews({
          configHome: home,
          tenantId: owner.tenantId,
        }),
      ).rejects.toThrow();
      await expect(readFile(pendingPath, "utf8")).resolves.toContain(
        reviewDigest.id,
      );
    }
    await writeFile(receiptPath, "{", "utf8");
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).rejects.toThrow("invalid review protocol record");
    await expect(readFile(pendingPath, "utf8")).resolves.toContain(
      reviewDigest.id,
    );
    await rm(receiptPath, { force: true });
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: reviewDigest.id } }]);
  });

  it("rejects empty legacy proposal ids without terminalizing the review", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-empty-id-"),
    );
    const owner = { ...identity, configHome: home };
    const reviewDigest = {
      ...digest(1),
      id: "digest-legacy-v1-empty-id",
      reviewKey: "review-legacy-v1-empty-id",
    };
    const pendingDir = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
      "pending",
    );
    await mkdir(pendingDir, { recursive: true });
    await writeFile(
      path.join(
        pendingDir,
        `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        digest: reviewDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: reviewDigest.createdAt,
      })}\n`,
      "utf8",
    );

    await expect(
      completeEpisodeReview(owner, reviewDigest.reviewKey, [""]),
    ).rejects.toThrow("proposalIds");
    await expect(
      drainPendingEpisodeReviews(owner, {
        revalidate: async () => "eligible",
        review: async () => [""],
      }),
    ).resolves.toMatchObject({ reviewed: 0, failed: 1 });
    await expect(
      listPendingEpisodeReviews({
        configHome: home,
        tenantId: owner.tenantId,
      }),
    ).resolves.toMatchObject([{ digest: { id: reviewDigest.id } }]);
  });

  it("binds legacy completion to its owner and keeps the first receipt immutable", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-owner-"),
    );
    const owner = { ...identity, configHome: home };
    const intruder = {
      ...owner,
      agentId: "agent-b",
      projectId: "project-b",
    };
    const reviewDigest = {
      ...digest(1),
      id: "digest-legacy-v1-owner",
      reviewKey: "review-legacy-v1-owner",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingPath = path.join(
      sessionRoot,
      "pending",
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    await mkdir(path.dirname(pendingPath), { recursive: true });
    await writeFile(
      pendingPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        digest: reviewDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: reviewDigest.createdAt,
      })}\n`,
      "utf8",
    );
    const foreignReceiptPath = path.join(
      sessionRoot,
      "receipts",
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    await mkdir(path.dirname(foreignReceiptPath), { recursive: true });
    await writeFile(
      foreignReceiptPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        ownerAgentHash: hashMemoryIdentityComponent("agent", intruder.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          intruder.projectId,
        ),
        proposalIds: ["proposal-first"],
        completedAt: "2026-07-12T00:01:00.000Z",
      })}\n`,
      "utf8",
    );
    await expect(
      completeEpisodeReview(owner, reviewDigest.reviewKey, ["proposal-first"]),
    ).rejects.toThrow("review owner identity mismatch");
    await rm(foreignReceiptPath, { force: true });

    await expect(
      completeEpisodeReview(intruder, reviewDigest.reviewKey, [
        "proposal-intruder",
      ]),
    ).rejects.toThrow("review owner identity mismatch");
    await expect(readFile(pendingPath, "utf8")).resolves.toContain(
      reviewDigest.id,
    );

    const first = await completeEpisodeReview(owner, reviewDigest.reviewKey, [
      "proposal-first",
    ]);
    const firstReceipt = await readFile(first.receiptPath, "utf8");
    await expect(
      completeEpisodeReview(owner, reviewDigest.reviewKey, ["proposal-first"]),
    ).resolves.toEqual(first);
    await expect(
      completeEpisodeReview(owner, reviewDigest.reviewKey, ["proposal-replay"]),
    ).rejects.toThrow("review receipt payload mismatch");
    await expect(
      completeEpisodeReview(intruder, reviewDigest.reviewKey, [
        "proposal-first",
      ]),
    ).rejects.toThrow("review owner identity mismatch");
    expect(await readFile(first.receiptPath, "utf8")).toBe(firstReceipt);
    expect(JSON.parse(firstReceipt)).toMatchObject({
      proposalIds: ["proposal-first"],
    });
  });

  it("checks legacy ownership before cleaning an ownerless receipt residue", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-v1-old-receipt-"),
    );
    const owner = { ...identity, configHome: home };
    const intruder = { ...owner, agentId: "agent-b", projectId: "project-b" };
    const reviewDigest = {
      ...digest(1),
      id: "digest-legacy-v1-old-receipt",
      reviewKey: "review-legacy-v1-old-receipt",
    };
    const sessionRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", owner.tenantId),
      hashMemoryIdentityComponent("session", owner.sessionId),
    );
    const pendingPath = path.join(
      sessionRoot,
      "pending",
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    const receiptPath = path.join(
      sessionRoot,
      "receipts",
      `${hashMemoryIdentityComponent("review", reviewDigest.reviewKey)}.json`,
    );
    await mkdir(path.dirname(pendingPath), { recursive: true });
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(
      pendingPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        digest: reviewDigest,
        ownerSessionRef: owner.sessionId,
        ownerAgentHash: hashMemoryIdentityComponent("agent", owner.agentId),
        ownerProjectHash: hashMemoryIdentityComponent(
          "project",
          owner.projectId,
        ),
        createdAt: reviewDigest.createdAt,
      })}\n`,
      "utf8",
    );
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        version: 1,
        reviewKey: reviewDigest.reviewKey,
        proposalIds: ["proposal-old"],
        completedAt: "2026-07-12T00:01:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      completeEpisodeReview(intruder, reviewDigest.reviewKey, ["proposal-old"]),
    ).rejects.toThrow("review owner identity mismatch");
    await expect(readFile(pendingPath, "utf8")).resolves.toContain(
      reviewDigest.id,
    );
    await expect(
      completeEpisodeReview(owner, reviewDigest.reviewKey, ["proposal-old"]),
    ).resolves.toMatchObject({ acknowledged: true, receiptPath });
    await expect(readFile(pendingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("bounds a maintenance drain and retains failed reviews for retry", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-inbox-bounded-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, digest(2));

    const result = await drainPendingEpisodeReviews(identity, {
      maxEntries: 1,
      revalidate: async () => "eligible",
      review: async () => {
        throw new Error("transient reviewer failure");
      },
    });

    expect(result).toEqual({
      reviewed: 0,
      discarded: 0,
      deferred: 1,
      failed: 1,
      failures: [
        { reviewKey: "review-1", error: "transient reviewer failure" },
      ],
    });
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toHaveLength(2);
  });

  it("does not drain project-owned reviews without a project identity", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-projectless-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    let reviewCalls = 0;

    const result = await drainPendingEpisodeReviews(
      {
        tenantId: identity.tenantId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
      },
      {
        revalidate: async () => "eligible",
        review: async () => {
          reviewCalls += 1;
          return ["proposal-1"];
        },
      },
    );

    expect(result).toEqual({
      reviewed: 0,
      discarded: 0,
      deferred: 1,
      failed: 0,
      failures: [],
    });
    expect(reviewCalls).toBe(0);
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toHaveLength(1);
  });

  it("still drains reviews that are owned by a project-less identity", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-unscoped-"),
    );
    setAgentConfigHome(home);
    const projectless = {
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    } as const;
    await persistPendingEpisodeReview(projectless, digest());

    const result = await drainPendingEpisodeReviews(projectless, {
      revalidate: async () => "eligible",
      review: async () => ["proposal-1"],
    });

    expect(result.reviewed).toBe(1);
    expect(result.deferred).toBe(0);
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toEqual([]);
  });

  it("ignores persisted digests with an invalid evidence shape", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-inbox-invalid-evidence-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const raw = await readFile(persisted.path, "utf8");
    await writeFile(
      persisted.path,
      raw.replace('"evidenceRefs":', '"evidence": {},\n    "evidenceRefs":'),
      "utf8",
    );

    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) =>
      diagnostics.push(diagnostic),
    );
    try {
      expect(
        await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
      ).toEqual([]);
    } finally {
      restoreDiagnostics();
    }
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "memory.review-inbox",
        level: "warn",
        message: "Invalid pending episode review was skipped.",
      }),
    ]);
  });

  it("atomically claims a pending review across concurrent drains", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-inbox-claim-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    let reviewCalls = 0;
    const options = {
      revalidate: async () => "eligible" as const,
      review: async () => {
        reviewCalls += 1;
        reviewStarted();
        await reviewGate;
        return ["proposal-1"];
      },
    };

    const first = drainPendingEpisodeReviews(identity, options);
    await started;
    const second = drainPendingEpisodeReviews(identity, options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReview();
    await Promise.all([first, second]);

    expect(reviewCalls).toBe(1);
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toEqual([]);
  });
});

describe("FEATURE_263 fenced episode review protocol", () => {
  let home: string | undefined;

  afterEach(async () => {
    setAgentConfigHome(undefined);
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("rejects an outcome captured before the active branch epoch changed", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-v2-root-epoch-"));
    setAgentConfigHome(home);
    const epoch = await captureEpisodeReviewBranchEpoch(identity);

    await withPendingEpisodeReviewSessionFence(identity, (fence) => fence([]));

    await expect(
      persistPendingEpisodeReview(identity, digest(), {
        expectedBranchEpoch: epoch,
      }),
    ).rejects.toBeInstanceOf(EpisodeReviewBranchChangedError);
    await expect(
      listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).resolves.toEqual([]);
  });

  it("holds the branch fence through owner-session digest persistence", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-owner-atomic-"),
    );
    setAgentConfigHome(home);
    const epoch = await captureEpisodeReviewBranchEpoch(identity);
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      ownerEntered = resolve;
    });
    let branchMutationFinished = false;

    const persistence = persistPendingEpisodeReview(identity, digest(), {
      expectedBranchEpoch: epoch,
      persistOwner: async () => {
        ownerEntered();
        await ownerGate;
      },
    });
    await entered;
    const mutation = withPendingEpisodeReviewSessionFence(identity, (fence) =>
      fence([]),
    ).then(() => {
      branchMutationFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(branchMutationFinished).toBe(false);

    releaseOwner();
    await persistence;
    await mutation;
    expect(branchMutationFinished).toBe(true);
    await expect(
      listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).resolves.toEqual([]);
  });

  it("persists v2 work and freezes one immutable input on first claim", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-v2-input-"));
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    expect(persisted.entry.version).toBe(2);

    const claim = await claimEpisodeReview(identity, "review-1", {
      now: new Date("2026-07-12T00:01:00.000Z"),
      leaseMs: 60_000,
    });
    expect(claim).toMatchObject({ epoch: 1, jobId: persisted.entry.jobId });
    if (claim === undefined) throw new Error("expected review claim");

    const first = await freezeEpisodeReviewInput(
      identity,
      claim,
      {
        evidence: {
          digest: digest(),
          exactSkillSnapshot: null,
          priorDigests: [],
        },
        promptRevision: "skill-learning-review-v1",
        schemaRevision: "unified-review-v1",
        policyRevision: "project-canary-v1",
        providerRevision: "provider-a",
      },
      new Date("2026-07-12T00:01:01.000Z"),
    );
    const second = await freezeEpisodeReviewInput(
      identity,
      claim,
      {
        evidence: { digest: digest(2) },
        promptRevision: "changed",
        schemaRevision: "changed",
        policyRevision: "changed",
        providerRevision: "changed",
      },
      new Date("2026-07-12T00:01:01.000Z"),
    );

    expect(second).toEqual(first);
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidenceBytes).toContain('"exactSkillSnapshot":null');
  });

  it("preserves __proto__ keys in the exact frozen evidence bytes", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-proto-evidence-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const evidence = JSON.parse(
      '{"__proto__":{"critical":"included"},"alpha":1}',
    ) as unknown;

    const checkpoint = await freezeEpisodeReviewInput(identity, claim, {
      evidence,
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });

    expect(checkpoint.evidenceBytes).toBe(
      '{"__proto__":{"critical":"included"},"alpha":1}',
    );
  });

  it("rejects a stale claim after a newer lease epoch is issued", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-v2-fence-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const first = await claimEpisodeReview(identity, "review-1", {
      now: new Date("2026-07-12T00:01:00.000Z"),
      leaseMs: 1_000,
    });
    const second = await claimEpisodeReview(identity, "review-1", {
      now: new Date("2026-07-12T00:01:02.000Z"),
      leaseMs: 60_000,
    });
    if (first === undefined || second === undefined)
      throw new Error("expected both review claims");

    await expect(
      commitEpisodeReviewDecision(
        identity,
        first,
        {
          inputHash: "a".repeat(64),
          memoryProposalIds: [],
        },
        new Date("2026-07-12T00:01:02.000Z"),
      ),
    ).rejects.toThrow("review claim is no longer authoritative");
    expect(second.epoch).toBe(2);
  });

  it("commits one decision and idempotent action receipts under the live lease", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-v2-decision-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1", {
      now: new Date("2026-07-12T00:01:00.000Z"),
      leaseMs: 60_000,
    });
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(
      identity,
      claim,
      {
        evidence: { digest: digest() },
        promptRevision: "p1",
        schemaRevision: "s1",
        policyRevision: "g1",
        providerRevision: "provider-a",
      },
      new Date("2026-07-12T00:01:00.500Z"),
    );
    const decision = await commitEpisodeReviewDecision(
      identity,
      claim,
      {
        inputHash: input.evidenceHash,
        memoryProposalIds: ["proposal-1"],
      },
      new Date("2026-07-12T00:01:01.000Z"),
    );

    await expect(
      commitEpisodeReviewDecision(
        identity,
        claim,
        {
          inputHash: input.evidenceHash,
          memoryProposalIds: ["different"],
        },
        new Date("2026-07-12T00:01:01.000Z"),
      ),
    ).resolves.toEqual(decision);
    const first = await commitEpisodeReviewAction(
      identity,
      claim,
      {
        actionId: `${decision.decisionId}:memory`,
        decisionId: decision.decisionId,
        carrier: "memory",
        resultRefs: ["proposal-1"],
      },
      new Date("2026-07-12T00:01:02.000Z"),
    );
    const second = await commitEpisodeReviewAction(
      identity,
      claim,
      {
        actionId: `${decision.decisionId}:memory`,
        decisionId: decision.decisionId,
        carrier: "memory",
        resultRefs: ["ignored"],
      },
      new Date("2026-07-12T00:01:02.000Z"),
    );
    expect(second).toEqual(first);
    await expect(
      commitEpisodeReviewAction(
        identity,
        claim,
        {
          actionId: `${decision.decisionId}:skill`,
          decisionId: decision.decisionId,
          carrier: "skill",
          resultRefs: [""],
        },
        new Date("2026-07-12T00:01:02.000Z"),
      ),
    ).rejects.toThrow("resultRefs");
    await expect(
      commitEpisodeReviewAction(
        identity,
        claim,
        {
          actionId: `${decision.decisionId}:skill`,
          decisionId: decision.decisionId,
          carrier: "skill",
          resultRefs: ["skill-record"],
        },
        new Date("2026-07-12T00:01:02.000Z"),
      ),
    ).rejects.toThrow("not required");
    await expect(
      commitEpisodeReviewAction(
        identity,
        claim,
        {
          actionId: `${decision.decisionId}:bogus`,
          decisionId: decision.decisionId,
          carrier: "bogus" as "memory",
          resultRefs: ["proposal-1"],
        },
        new Date("2026-07-12T00:01:02.000Z"),
      ),
    ).rejects.toThrow("carrier");
  });

  it("rejects empty v2 proposal ids before decision or completion state changes", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-empty-proposal-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });

    await expect(
      commitEpisodeReviewDecision(identity, claim, {
        inputHash: input.evidenceHash,
        memoryProposalIds: [""],
      }),
    ).rejects.toThrow("memoryProposalIds");
    let snapshot = await inspectEpisodeReviewJob(identity, claim.jobId);
    expect(snapshot?.decision).toBeUndefined();
    expect(snapshot?.state.status).toBe("processing");

    await expect(
      completeFencedEpisodeReview(identity, claim, [""]),
    ).rejects.toThrow("proposalIds");
    snapshot = await inspectEpisodeReviewJob(identity, claim.jobId);
    expect(snapshot?.state.status).toBe("processing");
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toHaveLength(1);
  });

  it("rejects a conflicting terminal receipt without completing the v2 job", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-receipt-conflict-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    const decision = await commitEpisodeReviewDecision(identity, claim, {
      inputHash: input.evidenceHash,
      memoryProposalIds: ["proposal-first"],
    });
    await commitEpisodeReviewAction(identity, claim, {
      actionId: `${decision.decisionId}:memory`,
      decisionId: decision.decisionId,
      carrier: "memory",
      resultRefs: ["proposal-first"],
    });
    const receiptPath = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identity.tenantId),
      hashMemoryIdentityComponent("session", identity.sessionId),
      "receipts",
      `${hashMemoryIdentityComponent("review", claim.jobId)}.json`,
    );
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        version: 1,
        jobId: claim.jobId,
        reviewKey: claim.reviewKey,
        proposalIds: ["proposal-stale"],
        completedAt: "2026-07-12T00:01:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      completeFencedEpisodeReview(identity, claim, ["proposal-first"]),
    ).rejects.toThrow("review receipt payload mismatch");
    expect(
      (await inspectEpisodeReviewJob(identity, claim.jobId))?.state.status,
    ).toBe("decided");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      proposalIds: ["proposal-stale"],
    });
  });

  it("does not complete a v2 job before its decision and action receipts exist", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-premature-completion-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");

    await expect(
      completeFencedEpisodeReview(identity, claim, []),
    ).rejects.toThrow("review completion requires a frozen input");
    expect(
      (await inspectEpisodeReviewJob(identity, claim.jobId))?.state.status,
    ).toBe("processing");
    await expect(readFile(persisted.path, "utf8")).resolves.toContain(
      claim.jobId,
    );
  });

  it("completes only after every carrier pinned by the decision has a receipt", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-required-carriers-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    await expect(
      commitEpisodeReviewDecision(identity, claim, {
        inputHash: input.evidenceHash,
        memoryProposalIds: [],
        requiredCarriers: ["skill"],
      }),
    ).rejects.toThrow("include memory");
    const decision = await commitEpisodeReviewDecision(identity, claim, {
      inputHash: input.evidenceHash,
      memoryProposalIds: ["proposal-memory"],
      requiredCarriers: ["memory", "skill"],
    });
    await commitEpisodeReviewAction(identity, claim, {
      actionId: `${decision.decisionId}:memory`,
      decisionId: decision.decisionId,
      carrier: "memory",
      resultRefs: ["proposal-memory"],
    });

    await expect(
      completeFencedEpisodeReview(identity, claim, ["proposal-memory"]),
    ).rejects.toThrow("missing required skill action receipt");
    expect(
      (await inspectEpisodeReviewJob(identity, claim.jobId))?.state.status,
    ).toBe("decided");

    await commitEpisodeReviewAction(identity, claim, {
      actionId: `${decision.decisionId}:skill`,
      decisionId: decision.decisionId,
      carrier: "skill",
      resultRefs: ["skill-record"],
    });
    await expect(
      completeFencedEpisodeReview(identity, claim, ["proposal-memory"]),
    ).resolves.toMatchObject({ acknowledged: true });
  });

  it("rejects a frozen input whose durable identity or evidence is forged", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-input-identity-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const jobRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identity.tenantId),
      hashMemoryIdentityComponent("session", identity.sessionId),
      "jobs",
      hashMemoryIdentityComponent("review", claim.jobId),
    );
    const evidence = { alpha: 1 };
    const evidenceBytes = JSON.stringify(evidence);
    const evidenceHash = createHash("sha256")
      .update(evidenceBytes)
      .digest("hex");
    const checkpoint = {
      version: 1,
      jobId: claim.jobId,
      evidence,
      evidenceBytes,
      evidenceHash,
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
      createdAt: "2026-07-12T00:01:00.000Z",
    };
    const invalidCheckpoints = [
      { ...checkpoint, jobId: "wrong-job" },
      { ...checkpoint, createdAt: "0" },
      { ...checkpoint, evidenceHash: "f".repeat(64) },
    ];
    await expect(
      freezeEpisodeReviewInput(identity, claim, {
        evidence,
        promptRevision: "",
        schemaRevision: "s1",
        policyRevision: "g1",
        providerRevision: "provider-a",
      }),
    ).rejects.toThrow("promptRevision");
    await expect(
      readFile(path.join(jobRoot, "review-input.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const invalidCheckpoint of invalidCheckpoints) {
      await writeFile(
        path.join(jobRoot, "review-input.json"),
        `${JSON.stringify(invalidCheckpoint)}\n`,
        "utf8",
      );
      await expect(
        freezeEpisodeReviewInput(identity, claim, {
          evidence,
          promptRevision: "p1",
          schemaRevision: "s1",
          policyRevision: "g1",
          providerRevision: "provider-a",
        }),
      ).rejects.toThrow();
    }
    const state = JSON.parse(
      await readFile(path.join(jobRoot, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state.status).toBe("processing");
  });

  it("rejects a decision whose durable identity does not match its job and input", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-decision-identity-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    const jobRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identity.tenantId),
      hashMemoryIdentityComponent("session", identity.sessionId),
      "jobs",
      hashMemoryIdentityComponent("review", claim.jobId),
    );
    await writeFile(
      path.join(jobRoot, "decision.json"),
      `${JSON.stringify({
        version: 1,
        jobId: "wrong-job",
        decisionId: "wrong-decision",
        inputHash: input.evidenceHash,
        memoryProposalIds: ["forged-proposal"],
        committedAt: "2026-07-12T00:01:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      commitEpisodeReviewDecision(identity, claim, {
        inputHash: input.evidenceHash,
        memoryProposalIds: ["proposal-1"],
      }),
    ).rejects.toThrow("review decision identity mismatch");
    await expect(
      inspectEpisodeReviewJob(identity, claim.jobId),
    ).rejects.toThrow("review decision identity mismatch");
    const state = JSON.parse(
      await readFile(path.join(jobRoot, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state.status).toBe("processing");
  });

  it("rejects an action receipt whose durable identity does not match its path", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-action-identity-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    const decision = await commitEpisodeReviewDecision(identity, claim, {
      inputHash: input.evidenceHash,
      memoryProposalIds: ["proposal-1"],
    });
    const actionId = `${decision.decisionId}:memory`;
    const jobRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identity.tenantId),
      hashMemoryIdentityComponent("session", identity.sessionId),
      "jobs",
      hashMemoryIdentityComponent("review", claim.jobId),
    );
    const actionsRoot = path.join(jobRoot, "actions");
    await mkdir(actionsRoot, { recursive: true });
    await writeFile(
      path.join(
        actionsRoot,
        `${hashMemoryIdentityComponent("review", actionId)}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        jobId: "wrong-job",
        actionId: "wrong-action",
        decisionId: "wrong-decision",
        carrier: "skill",
        resultRefs: ["forged-result"],
        committedAt: "2026-07-12T00:01:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      commitEpisodeReviewAction(identity, claim, {
        actionId,
        decisionId: decision.decisionId,
        carrier: "memory",
        resultRefs: ["proposal-1"],
      }),
    ).rejects.toThrow("review action receipt identity mismatch");
    await expect(
      inspectEpisodeReviewJob(identity, claim.jobId),
    ).rejects.toThrow("review action receipt identity mismatch");
    const state = JSON.parse(
      await readFile(path.join(jobRoot, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state.status).toBe("decided");
  });

  it("counts only provider failures and stops after the fourth failed attempt", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-v2-retry-"));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const attemptTimes = [
      "2026-07-12T00:01:00.000Z",
      "2026-07-12T00:02:00.000Z",
      "2026-07-12T00:07:00.000Z",
      "2026-07-12T00:37:00.000Z",
    ];
    for (const [index, time] of attemptTimes.entries()) {
      const claim = await claimEpisodeReview(identity, "review-1", {
        now: new Date(time),
        leaseMs: 60_000,
      });
      if (claim === undefined) throw new Error(`expected claim ${index + 1}`);
      await failEpisodeReviewAttempt(
        identity,
        claim,
        { kind: "provider_error", message: `failure-${index + 1}` },
        new Date(time),
      );
    }

    const job = await inspectEpisodeReviewJob(identity, "review-1");
    expect(job?.state).toMatchObject({
      status: "attention",
      providerAttempts: 4,
      lastError: "failure-4",
    });
    expect(
      await claimEpisodeReview(identity, "review-1", {
        now: new Date("2026-07-12T01:37:00.000Z"),
      }),
    ).toBeUndefined();
  });

  it("resumes a committed decision without re-applying an action that has a receipt", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-resume-action-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    const decision = await commitEpisodeReviewDecision(identity, claim, {
      inputHash: input.evidenceHash,
      memoryProposalIds: [],
    });
    await commitEpisodeReviewAction(identity, claim, {
      actionId: `${decision.decisionId}:memory`,
      decisionId: decision.decisionId,
      carrier: "memory",
      resultRefs: ["proposal-1"],
    });
    await deferEpisodeReview(identity, claim, "simulated owner restart");
    let applyCalls = 0;

    const result = await drainPendingEpisodeReviews(identity, {
      revalidate: async () => "eligible",
      review: async () => [],
      listV2Actions: () => ["memory"],
      applyV2Action: async () => {
        applyCalls += 1;
        return ["unexpected"];
      },
    });

    expect(result.reviewed).toBe(1);
    expect(applyCalls).toBe(0);
  });

  it("resumes legacy v2 decisions with valid optional Skill receipts", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-legacy-carriers-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");
    const input = await freezeEpisodeReviewInput(identity, claim, {
      evidence: { digest: digest() },
      promptRevision: "p1",
      schemaRevision: "s1",
      policyRevision: "g1",
      providerRevision: "provider-a",
    });
    const decision = await commitEpisodeReviewDecision(identity, claim, {
      inputHash: input.evidenceHash,
      memoryProposalIds: ["proposal-1"],
      requiredCarriers: ["memory", "skill"],
    });
    for (const carrier of ["memory", "skill"] as const) {
      await commitEpisodeReviewAction(identity, claim, {
        actionId: `${decision.decisionId}:${carrier}`,
        decisionId: decision.decisionId,
        carrier,
        resultRefs: [carrier === "memory" ? "proposal-1" : "skill-record"],
      });
    }
    const jobRoot = path.join(
      home,
      "memory-review-inbox",
      hashMemoryIdentityComponent("tenant", identity.tenantId),
      hashMemoryIdentityComponent("session", identity.sessionId),
      "jobs",
      hashMemoryIdentityComponent("review", claim.jobId),
    );
    const legacyDecision: Record<string, unknown> = { ...decision };
    delete legacyDecision.requiredCarriers;
    await writeFile(
      path.join(jobRoot, "decision.json"),
      `${JSON.stringify(legacyDecision)}\n`,
      "utf8",
    );
    await deferEpisodeReview(identity, claim, "simulated legacy owner restart");
    let applyCalls = 0;

    await expect(
      inspectEpisodeReviewJob(identity, claim.jobId),
    ).resolves.toMatchObject({
      actions: [{ carrier: "memory" }, { carrier: "skill" }],
    });
    await expect(
      drainPendingEpisodeReviews(identity, {
        revalidate: async () => "eligible",
        review: async () => [],
        listV2Actions: () => ["memory", "skill"],
        applyV2Action: async () => {
          applyCalls += 1;
          return ["unexpected"];
        },
      }),
    ).resolves.toMatchObject({ reviewed: 1, failed: 0 });
    expect(applyCalls).toBe(0);
  });

  it("rejects an invalid carrier before invoking its external effect", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-invalid-carrier-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    let effects = 0;

    const result = await drainPendingEpisodeReviews(identity, {
      revalidate: async () => "eligible",
      review: async () => [],
      listV2Actions: () => ["bogus" as "memory"],
      applyV2Action: async (_entry, _decision, _carrier, _claim, commit) =>
        commit(async () => {
          effects += 1;
          return ["unexpected"];
        }),
    });

    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(effects).toBe(0);
    expect(
      (await inspectEpisodeReviewJob(identity, persisted.entry.jobId))?.actions,
    ).toEqual([]);
  });

  it("rejects duplicate carriers before invoking either external effect", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-duplicate-carrier-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    let effects = 0;

    const result = await drainPendingEpisodeReviews(identity, {
      revalidate: async () => "eligible",
      review: async () => [],
      listV2Actions: () => ["memory", "memory"],
      applyV2Action: async (_entry, _decision, _carrier, _claim, commit) =>
        commit(async () => {
          effects += 1;
          return ["unexpected"];
        }),
    });

    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(effects).toBe(0);
    expect(
      (await inspectEpisodeReviewJob(identity, persisted.entry.jobId))?.actions,
    ).toEqual([]);
  });

  it("defers owner/provider unavailability without consuming provider attempts", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-unavailable-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, "review-1");
    if (claim === undefined) throw new Error("expected review claim");

    const state = await failEpisodeReviewAttempt(identity, claim, {
      kind: "provider_unavailable",
      message: "provider is not installed in this owner",
    });

    expect(state).toMatchObject({ status: "pending", providerAttempts: 0 });
  });

  it("tracks carrier apply failures separately and never spends provider attempts", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-apply-retry-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const claim = await claimEpisodeReview(identity, persisted.entry.jobId, {
      now: new Date("2026-07-12T00:01:00.000Z"),
      leaseMs: 60_000,
    });
    if (claim === undefined) throw new Error("expected review claim");

    const state = await failEpisodeReviewApply(
      identity,
      claim,
      { carrier: "skill", message: "record CAS failed" },
      new Date("2026-07-12T00:01:00.000Z"),
    );

    expect(state).toMatchObject({
      status: "pending",
      providerAttempts: 0,
      applyAttempts: 1,
      applyAttemptsByCarrier: { memory: 0, skill: 1 },
      lastError: "skill apply failed: record CAS failed",
      nextApplyAttemptAt: "2026-07-12T00:02:00.000Z",
    });
  });

  it("keeps independent Memory and Skill retry budgets", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-carrier-budget-"),
    );
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const attempts = [
      ["memory", "2026-07-12T00:01:00.000Z"],
      ["memory", "2026-07-12T00:02:00.000Z"],
      ["memory", "2026-07-12T00:07:00.000Z"],
      ["skill", "2026-07-12T00:37:00.000Z"],
    ] as const;
    let state;
    for (const [carrier, time] of attempts) {
      const claim = await claimEpisodeReview(identity, persisted.entry.jobId, {
        now: new Date(time),
        leaseMs: 60_000,
      });
      if (claim === undefined) throw new Error(`expected ${carrier} claim`);
      state = await failEpisodeReviewApply(
        identity,
        claim,
        { carrier, message: `${carrier} failed` },
        new Date(time),
      );
    }

    expect(state).toMatchObject({
      status: "pending",
      applyAttemptsByCarrier: { memory: 3, skill: 1 },
      nextApplyAttemptAt: "2026-07-12T00:38:00.000Z",
    });
  });

  it("skips attention and backoff jobs without spending the drain entry budget", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-drain-starvation-"),
    );
    setAgentConfigHome(home);
    const blocked = await persistPendingEpisodeReview(identity, digest(1));
    for (const time of [
      "2026-07-12T00:01:00.000Z",
      "2026-07-12T00:02:00.000Z",
      "2026-07-12T00:07:00.000Z",
      "2026-07-12T00:37:00.000Z",
    ]) {
      const claim = await claimEpisodeReview(identity, blocked.entry.jobId, {
        now: new Date(time),
        leaseMs: 60_000,
      });
      if (claim === undefined) throw new Error("expected blocked claim");
      await failEpisodeReviewAttempt(
        identity,
        claim,
        { kind: "provider_error", message: "poison job" },
        new Date(time),
      );
    }
    await persistPendingEpisodeReview(identity, {
      ...digest(2),
      createdAt: "2026-07-12T00:01:00.000Z",
    });

    const result = await drainPendingEpisodeReviews(identity, {
      maxEntries: 1,
      revalidate: async () => "eligible",
      review: async () => ["proposal-2"],
    });

    expect(result.reviewed).toBe(1);
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toMatchObject([{ reviewKey: "review-1" }]);
  });

  it("enforces the provider deadline when the reviewer ignores its AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      home = await mkdtemp(
        path.join(os.tmpdir(), "kodax-review-v2-hard-timeout-"),
      );
      setAgentConfigHome(home);
      await persistPendingEpisodeReview(identity, digest());
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const draining = drainPendingEpisodeReviews(identity, {
        revalidate: async () => "eligible",
        review: async () => [],
        prepareV2Input: async () => ({
          evidence: { digest: digest() },
          promptRevision: "p1",
          schemaRevision: "s1",
          policyRevision: "g1",
          providerRevision: "provider-a",
        }),
        decideV2: async () => {
          markStarted();
          return new Promise(() => undefined);
        },
      });

      await started;
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(draining).resolves.toMatchObject({
        failed: 1,
        failures: [
          {
            reviewKey: "review-1",
            error: "episode reviewer timed out after 90000ms",
          },
        ],
      });
      expect(
        (await inspectEpisodeReviewJob(identity, "review-1"))?.state,
      ).toMatchObject({ providerAttempts: 1, status: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers completion only after all action receipts and retries a failed delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:01:00.000Z"));
    try {
      home = await mkdtemp(
        path.join(os.tmpdir(), "kodax-review-v2-completion-hook-"),
      );
      setAgentConfigHome(home);
      await persistPendingEpisodeReview(identity, digest());
      const observedActionCounts: number[] = [];
      let applyCalls = 0;
      let completionCalls = 0;
      const options = {
        revalidate: async () => "eligible" as const,
        review: async () => [],
        decideV2: async (
          _entry: PendingEpisodeReviewV2,
          input: Parameters<
            NonNullable<EpisodeReviewDrainOptions["decideV2"]>
          >[1],
        ) => ({
          inputHash: input.evidenceHash,
          memoryProposalIds: [],
          requiredCarriers: ["memory", "skill"] as const,
        }),
        listV2Actions: () => ["memory", "skill"] as const,
        applyV2Action: async (
          _entry: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[0],
          _decision: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[1],
          carrier: "memory" | "skill",
          _claim: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[3],
          commit: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[4],
        ) => {
          applyCalls += 1;
          return commit(async () => [`${carrier}-result`]);
        },
        onV2Completed: async (_entry: PendingEpisodeReviewV2) => {
          completionCalls += 1;
          observedActionCounts.push(applyCalls);
          if (completionCalls === 1)
            throw new Error("session write interrupted");
        },
      };

      expect((await drainPendingEpisodeReviews(identity, options)).failed).toBe(
        1,
      );
      expect(await inspectEpisodeReviewJob(identity, "review-1")).toMatchObject(
        {
          state: { status: "pending", completionAttempts: 1 },
          actions: [{ carrier: "memory" }, { carrier: "skill" }],
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        (await drainPendingEpisodeReviews(identity, options)).reviewed,
      ).toBe(1);
      expect(observedActionCounts).toEqual([2, 2]);
      expect(applyCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges terminal receipt failures to completion without an optional hook", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:01:00.000Z"));
    try {
      home = await mkdtemp(
        path.join(os.tmpdir(), "kodax-review-v2-terminal-receipt-"),
      );
      setAgentConfigHome(home);
      const pending = await persistPendingEpisodeReview(identity, digest());
      const receiptsPath = path.join(
        path.dirname(path.dirname(pending.path)),
        "receipts",
      );
      await writeFile(receiptsPath, "block receipt directory creation", "utf8");
      let applyCalls = 0;
      const options = {
        revalidate: async () => "eligible" as const,
        review: async () => [],
        applyV2Action: async (
          _entry: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[0],
          _decision: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[1],
          _carrier: "memory" | "skill",
          _claim: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[3],
          commit: Parameters<
            NonNullable<EpisodeReviewDrainOptions["applyV2Action"]>
          >[4],
        ) => {
          applyCalls += 1;
          return commit(async () => ["memory-result"]);
        },
      };

      expect((await drainPendingEpisodeReviews(identity, options)).failed).toBe(
        1,
      );
      expect(
        await inspectEpisodeReviewJob(identity, pending.entry.jobId),
      ).toMatchObject({
        state: {
          status: "pending",
          completionAttempts: 1,
          applyAttemptsByCarrier: { memory: 0, skill: 0 },
        },
        actions: [{ carrier: "memory", resultRefs: ["memory-result"] }],
      });

      await rm(receiptsPath);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        (await drainPendingEpisodeReviews(identity, options)).reviewed,
      ).toBe(1);
      expect(applyCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores and removes a pending residue whose canonical job is already completed", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-completed-residue-"),
    );
    setAgentConfigHome(home);
    const pending = await persistPendingEpisodeReview(identity, digest());
    const envelopeBytes = await readFile(pending.path, "utf8");

    await expect(
      drainPendingEpisodeReviews(identity, {
        revalidate: async () => "eligible",
        review: async () => [],
      }),
    ).resolves.toMatchObject({ reviewed: 1, failed: 0 });

    await writeFile(pending.path, envelopeBytes, "utf8");
    await expect(
      listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).resolves.toEqual([]);
    await expect(readFile(pending.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes distinct inbox receipts for distinct branch jobs with the same review key", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-v2-distinct-receipts-"),
    );
    setAgentConfigHome(home);
    const first = await persistPendingEpisodeReview(identity, digest());
    const drain = () =>
      drainPendingEpisodeReviews(identity, {
        revalidate: async () => "eligible" as const,
        review: async () => [],
      });
    expect((await drain()).reviewed).toBe(1);
    await withPendingEpisodeReviewSessionFence(identity, (fence) => fence([]));
    const second = await persistPendingEpisodeReview(identity, {
      ...digest(),
      branchId: "new-branch",
    });
    expect(second.entry.jobId).not.toBe(first.entry.jobId);
    expect((await drain()).reviewed).toBe(1);

    const receiptsRoot = path.join(home, "memory-review-inbox");
    const receiptFiles = (await readdir(receiptsRoot, { recursive: true }))
      .filter(
        (file) =>
          file.includes(`receipts${path.sep}`) && file.endsWith(".json"),
      )
      .map((file) => path.join(receiptsRoot, file));
    expect(receiptFiles).toHaveLength(2);
    const receipts = await Promise.all(
      receiptFiles.map(
        async (file) =>
          JSON.parse(await readFile(file, "utf8")) as {
            jobId?: string;
          },
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.jobId))).toEqual(
      new Set([first.entry.jobId, second.entry.jobId]),
    );
  });
});

describe("FEATURE_289 episode review drain fixes", () => {
  let home: string | undefined;

  afterEach(async () => {
    setAgentConfigHome(undefined);
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("does not spend the drain entry budget on deferred jobs", async () => {
    home = await mkdtemp(
      path.join(os.tmpdir(), "kodax-review-f289-defer-budget-"),
    );
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, {
      ...digest(2),
      createdAt: "2026-07-12T00:01:00.000Z",
    });
    await persistPendingEpisodeReview(identity, {
      ...digest(3),
      createdAt: "2026-07-12T00:02:00.000Z",
    });
    const reviewed: string[] = [];

    const result = await drainPendingEpisodeReviews(identity, {
      maxEntries: 2,
      revalidate: async (entry) =>
        entry.reviewKey === "review-1" ? "defer" : "eligible",
      review: async (entry) => {
        reviewed.push(entry.reviewKey);
        return [`proposal-${entry.digest.sequence}`];
      },
    });

    expect(result).toMatchObject({ reviewed: 2, deferred: 1, failed: 0 });
    expect(reviewed).toEqual(["review-2", "review-3"]);
    expect(
      await listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).toMatchObject([{ reviewKey: "review-1" }]);
  });

  it("counts pre-decide failures as provider attempts and escalates to attention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
    try {
      home = await mkdtemp(
        path.join(os.tmpdir(), "kodax-review-f289-predecide-attempt-"),
      );
      setAgentConfigHome(home);
      const persisted = await persistPendingEpisodeReview(identity, digest());
      const options = {
        revalidate: async () => "eligible" as const,
        review: async () => ["proposal-1"],
        prepareV2Input: async () => {
          throw new Error("reviewer crashed while building input");
        },
      };

      for (const backoffMs of [0, 60_000, 5 * 60_000, 30 * 60_000]) {
        await vi.advanceTimersByTimeAsync(backoffMs);
        await expect(
          drainPendingEpisodeReviews(identity, options),
        ).resolves.toMatchObject({ failed: 1, reviewed: 0 });
      }

      expect(
        (await inspectEpisodeReviewJob(identity, persisted.entry.jobId))?.state,
      ).toMatchObject({ providerAttempts: 4, status: "attention" });
      await expect(
        drainPendingEpisodeReviews(identity, options),
      ).resolves.toMatchObject({ failed: 0, reviewed: 0, deferred: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the claim without committing a decision once the drain deadline passes", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "kodax-review-f289-deadline-"));
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const deadlineAtMs = Date.now() + 100;

    const result = await drainPendingEpisodeReviews(identity, {
      deadlineAtMs,
      revalidate: async () => "eligible",
      review: async () => ["proposal-1"],
      decideV2: async (
        _entry: PendingEpisodeReviewV2,
        input: Parameters<
          NonNullable<EpisodeReviewDrainOptions["decideV2"]>
        >[1],
      ) => {
        // Simulate a slow provider that only resolves after the deadline.
        while (Date.now() <= deadlineAtMs) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { inputHash: input.evidenceHash, memoryProposalIds: [] };
      },
    });

    expect(result).toMatchObject({ reviewed: 0, failed: 0, deferred: 1 });
    const snapshot = await inspectEpisodeReviewJob(
      identity,
      persisted.entry.jobId,
    );
    expect(snapshot?.state).toMatchObject({
      status: "pending",
      providerAttempts: 0,
    });
    expect(snapshot?.decision).toBeUndefined();
    await expect(
      listPendingEpisodeReviews({ tenantId: identity.tenantId }),
    ).resolves.toHaveLength(1);
  });
});
