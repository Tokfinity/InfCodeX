/**
 * SDK subpath entry — `@kodax-ai/kodax/skills`
 *
 * Narrow subset alias: exposes ONLY the skills capability surface
 * (SkillRegistry / SkillExecutor / VariableResolver / loadFullSkill /
 * parseSkillMarkdown / expandSkillForLLM / discoverSkills / ...).
 *
 * Symbol set = the pre-FEATURE_194 `@kodax-ai/skills` standalone package's
 * complete public API. Migrating from v0.7.42 `@kodax-ai/skills` requires
 * only changing the import specifier; symbol coverage is unchanged.
 *
 * If you need agent framework symbols (Runner / fan-out / session) — those
 * live under `@kodax-ai/kodax/agent`, not here.
 *
 * Usage:
 * ```ts
 * import { loadSkill, SkillRegistry } from '@kodax-ai/kodax/skills';
 * ```
 *
 * Note: explicit named re-exports (not `export * from
 * '@kodax-ai/agent/capabilities/skills'`) because rollup-plugin-dts does
 * not resolve package.json subpath exports for monorepo workspace packages
 * — see sdk-session.ts comment. Runtime path is unchanged (esbuild
 * resolves subpaths fine); only the .d.ts bundling needs the workaround.
 *
 * See docs/ADR.md ADR-024 (SDK subpath formalization) and ADR-036
 * (FEATURE_194 package consolidation + narrow-subset subpath convention).
 */

export type {
  Skill,
  SkillMetadata,
  SkillFile,
  SkillFrontmatter,
  SkillHook,
  SkillHooks,
  SkillSource,
  SkillContext,
  SkillDynamicContextExecutor,
  SkillResult,
  SkillArtifact,
  SkillPathsConfig,
  ISkillRegistry,
  IVariableResolver,
  DiscoveryResult,
  ExecutionMode,
  ExecutionOptions,
  SkillExpansionResult,
} from '@kodax-ai/agent';

export {
  // types.js — path helpers
  getDefaultSkillPaths,
  getSkillPathsFlat,
  // plugin-paths.js — runtime registration
  registerPluginSkillPath,
  unregisterPluginSkillPath,
  listPluginSkillPaths,
  clearPluginSkillPaths,
  // skill-loader.js
  parseSkillMarkdown,
  loadSkillMetadata,
  loadFullSkill,
  loadSkillFileContent,
  // discovery.js
  discoverSkills,
  discoverSkillsWithMonorepo,
  getNestedSkillPaths,
  // skill-resolver.js
  VariableResolver,
  createResolver,
  resolveSkillContent,
  parseArguments,
  // skill-registry.js
  SkillRegistry,
  getSkillRegistry,
  initializeSkillRegistry,
  resetSkillRegistry,
  // executor.js
  SkillExecutor,
  createExecutor,
  executeSkill,
  // skill-expander.js
  expandSkillForLLM,
  formatSkillActivationMessage,
} from '@kodax-ai/agent';
