import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { SkillRegistry } from "./skill-registry.js";
import { createTempDir, removeTempDir } from "./test-utils/temp-dir.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function writeSkill(
  rootDir: string,
  sourceDir: string,
  name: string,
  description: string
): Promise<void> {
  const skillDir = join(rootDir, sourceDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}

${description}
`,
    "utf8"
  );
}

describe("SkillRegistry", () => {
  it("discovers skills, exposes read-only list accessors, and caches full skill loads", async () => {
    const rootDir = await createTempDir("kodax-skill-registry-");
    tempDirs.push(rootDir);

    await writeSkill(rootDir, "project", "project-skill", "Project skill");
    await writeSkill(rootDir, "user", "user-skill", "User skill");

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [join(rootDir, "user")],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });

    await registry.discover();

    expect(registry.size).toBe(2);
    expect(registry.skills.size).toBe(2);
    expect(registry.has("project-skill")).toBe(true);
    expect(registry.list().map((skill) => skill.name)).toEqual([
      "project-skill",
      "user-skill",
    ]);
    expect(registry.listUserInvocable().map((skill) => skill.name)).toEqual([
      "project-skill",
      "user-skill",
    ]);

    const firstLoad = await registry.loadFull("project-skill");
    await writeFile(
      join(rootDir, "project", "project-skill", "SKILL.md"),
      `---
name: project-skill
description: Updated project skill
---

# project-skill

Updated project skill
`,
      "utf8"
    );
    const secondLoad = await registry.loadFull("project-skill");

    expect(secondLoad).toBe(firstLoad);
    expect(secondLoad.description).toBe("Project skill");
  });

  // 2026-05-20 — claudecode-parity snippet. The system-prompt snippet
  // injected into every worker must point the model at the dedicated
  // `skill` tool (not at `read SKILL.md`) and must NOT leak the
  // SKILL.md filesystem path (that was a hint the model would
  // legitimately follow back to `read`, defeating the rename).
  it("getSystemPromptSnippet routes skill invocation through the `skill` tool", async () => {
    const rootDir = await createTempDir("kodax-skill-snippet-");
    tempDirs.push(rootDir);
    await writeSkill(rootDir, "project", "agent-browser", "Browser automation");

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });
    await registry.discover();

    const snippet = registry.getSystemPromptSnippet();

    // Tool-of-record is the `skill` tool, not `read SKILL.md`.
    expect(snippet).toContain("`skill` tool");
    expect(snippet).toContain("invoke it via the `skill` tool");
    expect(snippet).toContain("BLOCKING REQUIREMENT");
    expect(snippet).toContain("MUST invoke it via the `skill` tool");

    // The legacy "Use the read tool" wording is gone — checking
    // negative direction so a future refactor that re-introduces it
    // trips this test.
    expect(snippet).not.toContain("Use the read tool to load");
    expect(snippet).not.toContain("MUST read the relevant skill's `SKILL.md`");
    // Discovery still surfaces the skill, but without the SKILL.md path
    // hint that would have invited a fallback `read` call.
    expect(snippet).toContain("- agent-browser:");
    expect(snippet).toContain("Browser automation");
    expect(snippet).not.toContain("/SKILL.md");
    expect(snippet).not.toContain("(Location:");
  });
});
