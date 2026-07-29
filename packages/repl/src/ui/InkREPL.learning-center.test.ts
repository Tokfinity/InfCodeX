import { describe, expect, it } from "vitest";

import type { LearnedCapabilityRecord } from "@kodax-ai/agent";

import { buildLearningCenterOptions } from "./InkREPL.js";

function learnedRecord(
  capabilityId: string,
  slug: string,
  displayName: string,
): LearnedCapabilityRecord {
  return {
    schemaVersion: 1,
    capabilityId,
    displayName,
    slug,
    carrier: "skill",
    lifecycle: "ready",
    revision: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    source: { kind: "learning_controller" },
  };
}

describe("Learning Center capability choices", () => {
  it("keeps opaque IDs hidden for unique slugs while using them as values", () => {
    const [option] = buildLearningCenterOptions([
      learnedRecord("lc-unique", "release-check", "Release check"),
    ]);

    expect(option).toMatchObject({ value: "lc-unique" });
    expect(option?.label).not.toContain("lc-unique");
  });

  it("shows exact IDs only when duplicate slugs require disambiguation", () => {
    const options = buildLearningCenterOptions([
      learnedRecord("lc-project-a", "release-check", "Project A"),
      learnedRecord("lc-project-b", "release-check", "Project B"),
    ]);

    expect(options).toEqual([
      expect.objectContaining({ value: "lc-project-a" }),
      expect.objectContaining({ value: "lc-project-b" }),
    ]);
    expect(options[0]?.label).toContain("lc-project-a");
    expect(options[1]?.label).toContain("lc-project-b");
  });
});
