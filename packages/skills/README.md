# @kodax/skills

Skills 标准实现，面向 KodaX 和 Agent Skills 风格目录。

## 概述

`@kodax/skills` 是 KodaX 的 Skills 系统实现，提供：
- Skills 发现和加载
- Skills 执行
- 自然语言触发
- 内置 Skills

这个包可以独立复用，也可以作为 KodaX 的 skills 基础设施使用。

## 安装

```bash
npm install @kodax/skills
```

## 内置 Skills

| Skill | Description | Trigger Keywords |
|-------|-------------|------------------|
| code-review | 自动触发的代码审查，重点发现 bug、回归和风险 | code review, 审查改动, review PR |
| skill-creator | 创建、迁移、评测、打包和安装 KodaX skills，附带 Node 版验证/eval/review/packaging 工具 | 创建 skill, 迁移 skill, 优化 skill |
| tdd | 手动触发的 TDD 工作流，先写失败测试再实现 | /skill:tdd, TDD, 回归测试 |
| git-workflow | 手动触发的 Git 执行型工作流 | /skill:git-workflow, commit, push, PR |

## 使用示例

### Skills 发现

```typescript
import { discoverSkills } from '@kodax/skills';

const { skills, errors } = await discoverSkills(process.cwd());

console.log(`Found ${skills.size} skills:`);
for (const skill of skills.values()) {
  console.log(`- ${skill.name}: ${skill.description}`);
}

if (errors.length > 0) {
  console.warn(errors);
}
```

### Skills 执行

```typescript
import { executeSkill, SkillContext } from '@kodax/skills';

const context: SkillContext = {
  workingDirectory: process.cwd(),
  projectRoot: process.cwd(),
  sessionId: 'example-session',
  environment: {},
};

const result = await executeSkill('code-review', 'src/auth.ts', context);
console.log(result.content);
```

### 注入给 LLM

```typescript
import {
  expandSkillForLLM,
  initializeSkillRegistry,
  type SkillContext,
} from '@kodax/skills';

const context: SkillContext = {
  workingDirectory: process.cwd(),
  projectRoot: process.cwd(),
  sessionId: 'example-session',
  environment: {},
};

const registry = await initializeSkillRegistry(process.cwd());
const skill = await registry.loadFull('code-review');
const expanded = await expandSkillForLLM(skill, 'src/auth.ts', context);

console.log(expanded.content);
```

### 动态上下文 `` !`cmd` `` 与 Host Hook (v0.7.42)

Skill 的 markdown 支持 `` !`shell-cmd` `` 占位符，解析时被替换为命令的 stdout：

```markdown
Current git status:
!`git status --short`
```

默认 `VariableResolver` 用 `execSync` + 内置 allowlist 直接执行 — 这对独立 `kodax` CLI 用户合适，但**嵌入到 host app 时往往不是想要的**（host 通常要走自己的 permission broker / audit trail）。

`SkillContext` 暴露两个 hook：

| 字段 | 行为 |
|---|---|
| `executeDynamicContext?: (cmd, cwd) => Promise<string>` | 注入后，**每次** `` !`cmd` `` 执行都路由到这里。返回 stdout 字符串，或 throw 来拒绝。 |
| `disableDynamicContext?: boolean` | `true` 时所有 `` !`cmd` `` token 直接被替换为拒绝 banner，覆盖 hook。 |

三层 dispatch 顺序：`disable` → `executeDynamicContext` → 兜底 `execSync`。

```ts
import { createResolver } from '@kodax/skills';

const context: SkillContext = {
  workingDirectory: '/repo',
  projectRoot: '/repo',
  sessionId: 'session-1',
  environment: {},
  executeDynamicContext: async (cmd, cwd) => {
    if (!(await brokerAskUser({ kind: 'skill-cmd', command: cmd, cwd }))) {
      throw new Error('user denied');
    }
    return (await brokerExecute(cmd, { cwd })).stdout;
  },
};
const resolver = createResolver(context);  // returns IVariableResolver
```

入口三件套（都从 `@kodax-ai/kodax/skills` 导出）：

- `IVariableResolver` — 接口契约（`resolve(content): Promise<string>`）
- `VariableResolver` — 默认实现类
- `createResolver(context)` — factory，返回 `IVariableResolver`

Host 完全替换 resolver 时可以自己实现 `IVariableResolver` interface — KodaX 自己的 skill 执行路径走的就是这个接口。

详细 embedder 集成指南：[docs/SDK_EMBEDDER_GUIDE.md §2](../../docs/SDK_EMBEDDER_GUIDE.md#2-skill-cmd-dynamic-context-resolution--ivariableresolver)。

### 自定义 Skill

创建自定义 Skill 文件 `~/.kodax/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: 分析内部错误日志并生成简短摘要。当用户要求排查日志、汇总报错或整理 incident 线索时使用。
---

# My Skill

## Workflow
1. First, analyze the code structure
2. Then, identify potential improvements
3. Finally, provide recommendations

See [the checklist](references/checklist.md) when you need the full incident workflow.
```

## Skill 文件结构

```
~/.kodax/skills/
├── my-skill/
│   ├── SKILL.md            # Skill 定义（必需）
│   ├── scripts/            # 可执行辅助脚本
│   ├── references/         # 按需读取的详细参考资料
│   └── assets/             # 模板、静态资源等
```

## `skill-creator` helpers

Builtin `skill-creator` 现在附带一套可直接运行的 Node helpers：

- `scripts/init-skill.js`: 初始化 skill 骨架与可选 eval 文件。
- `scripts/quick-validate.js`: 校验 skill 结构和 frontmatter。
- `scripts/run-eval.js`: 生成 `with_skill` / `without_skill` 的端到端 eval workspace。
- `scripts/run-trigger-eval.js`: 用 KodaX 原生方式评估 description 的触发效果。
- `scripts/improve-description.js`: 基于 eval 结果生成新的 description 候选。
- `scripts/run-loop.js`: 多轮跑 trigger eval 与 description 优化。
- `scripts/aggregate-benchmark.js`: 聚合 benchmark 输出。
- `scripts/generate-review.js`: 生成静态或本地 HTML review 页面。
- `scripts/package-skill.js`: 把 skill 打成 `.skill` 分享包。
- `scripts/install-skill.js`: 从目录或 `.skill` 归档安装到 skills 目录。

## API 导出

```typescript
export { discoverSkills, discoverSkillsWithMonorepo };
export { loadSkillMetadata, loadFullSkill, loadSkillFileContent };
export { initializeSkillRegistry, getSkillRegistry, SkillRegistry };
export { executeSkill, createExecutor, SkillExecutor };
export { expandSkillForLLM, formatSkillActivationMessage };
export { VariableResolver, createResolver, resolveSkillContent, parseArguments };
export type {
  Skill, SkillMetadata, SkillContext, SkillResult,
  IVariableResolver, ISkillRegistry, SkillDynamicContextExecutor,
};
```

## 依赖

运行时依赖保持轻量，核心依赖为 `yaml`，打包 helper 额外使用 `fflate`。

## License

MIT
