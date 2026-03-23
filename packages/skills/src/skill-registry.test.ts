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
});
