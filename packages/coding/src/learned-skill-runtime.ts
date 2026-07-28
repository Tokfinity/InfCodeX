import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  LearnedAreaStore,
  SkillRegistry,
  admitAndRecordLearnedSkillInvocation,
  admitLearnedSkillBinding,
  completeLearnedSkillSessionOutcomes,
  createLearnedCapabilityScope,
  emitKodaXDiagnostic,
  getDefaultSkillPaths,
  migrateLegacyLearnedSkillsForProject,
  recordLearnedSkillOffered,
  reconcileLearnedSkillBindingOutcomes,
  releaseLearnedSkillBinding,
  resolveProjectLearnedAreaRoot,
  type ISkillRegistry,
  type MemoryContextIdentity,
  type Skill,
  type SkillContext,
  type SkillMetadata,
  type SkillResult,
} from '@kodax-ai/agent';

import { resolveExecutionCwd } from './runtime-paths.js';
import type { KodaXContextOptions, KodaXOptions } from './types.js';

export interface CodingLearnedSkillBinding {
  readonly context: Pick<
    KodaXContextOptions,
    | 'skillRegistry'
    | 'skillsPrompt'
    | 'protectedFormalSkillNames'
    | 'learnedSkillBindingId'
    | 'admitLearnedSkillInvocation'
    | 'completeLearnedSkillOutcomes'
  >;
  release(): Promise<void>;
}

export async function prepareCodingLearnedSkillBinding(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  rootSessionId: string,
): Promise<CodingLearnedSkillBinding | undefined> {
  const pinnedRegistry = options.context?.skillRegistry;
  if (options.context?.currentAgentId !== undefined
    || identity.configHome === undefined
    || identity.projectId === undefined) return undefined;
  if (pinnedRegistry?.list().some((skill) => skill.source === 'learned')) return undefined;
  try {
    return await prepareCodingLearnedSkillBindingUnsafe(
      options,
      {
        ...identity,
        configHome: identity.configHome,
        projectId: identity.projectId,
      },
      rootSessionId,
      pinnedRegistry,
    );
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'coding:learned-skills',
      level: 'warn',
      message: `Learned Area disabled for this root run: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

async function prepareCodingLearnedSkillBindingUnsafe(
  options: KodaXOptions,
  identity: MemoryContextIdentity & { readonly configHome: string; readonly projectId: string },
  rootSessionId: string,
  pinnedRegistry: ISkillRegistry | undefined,
): Promise<CodingLearnedSkillBinding> {
  const projectRoot = resolveExecutionCwd(options.context);
  const rootDir = resolveProjectLearnedAreaRoot(identity.configHome, {
    tenantId: identity.tenantId,
    projectId: identity.projectId,
  });
  const store = new LearnedAreaStore(rootDir);
  await store.initialize();
  const scope = createLearnedCapabilityScope(identity.configHome, {
    tenantId: identity.tenantId,
    projectId: identity.projectId,
  });
  await migrateLegacyLearnedSkillsForProject(identity.configHome, store, scope);
  const bindingId = `root_${randomUUID()}`;
  const testingBindings: Record<string, string> = {};
  const testingCapabilityIds: string[] = [];
  for (const record of await store.listCapabilities()) {
    if (record.schemaVersion !== 2 || record.lifecycle !== 'testing') continue;
    const admitted = await admitLearnedSkillBinding(store, record.capabilityId, {
      bindingId,
      ownerSessionRef: rootSessionId,
    });
    if (admitted === undefined) continue;
    testingBindings[record.capabilityId] = bindingId;
    testingCapabilityIds.push(record.capabilityId);
  }
  const learnedArea = {
    rootDir,
    expectedScope: scope,
    testingBindings,
  };
  const learnedRegistry = pinnedRegistry === undefined
    ? undefined
    : new SkillRegistry(undefined, {
        projectPaths: [],
        userPaths: [],
        pluginPaths: [],
        builtinPath: path.join(rootDir, '.no-formal-skills'),
        learnedArea,
      });
  const registry = pinnedRegistry === undefined
    ? createProjectRegistry(projectRoot, identity.configHome, learnedArea)
    : new CompositeSkillRegistry(pinnedRegistry, learnedRegistry!);
  const formalInventory = pinnedRegistry === undefined
    ? undefined
    : createFormalProjectRegistry(projectRoot, identity.configHome);
  try {
    await reconcileLearnedSkillBindingOutcomes(store, {
      sessionId: rootSessionId,
      bindingId,
    });
    await formalInventory?.discover();
    if (learnedRegistry !== undefined) await learnedRegistry.discover();
    else await registry.discover();
    for (const metadata of registry.list()) {
      if (metadata.source !== 'learned' || metadata.learned === undefined) continue;
      await recordLearnedSkillOffered(store, {
        sessionId: rootSessionId,
        bindingId,
        capabilityId: metadata.learned.capabilityId,
        revision: metadata.learned.revision,
        fingerprint: metadata.learned.fingerprint,
      });
    }
  } catch (error) {
    await releaseAll(store, testingCapabilityIds, bindingId);
    throw error;
  }
  return {
    context: {
      learnedSkillBindingId: bindingId,
      skillRegistry: registry,
      protectedFormalSkillNames: [
        ...new Set(
          [...(formalInventory?.list() ?? []), ...registry.list()]
            .filter((skill) => skill.source !== 'learned')
            .map((skill) => skill.name),
        ),
      ],
      skillsPrompt: learnedRegistry === undefined
        ? (registry as SkillRegistry).getSystemPromptSnippet()
        : [
            options.context?.skillsPrompt?.trim(),
            learnedRegistry.getSystemPromptSnippet().trim(),
          ].filter((section): section is string => Boolean(section)).join('\n\n'),
      admitLearnedSkillInvocation: async (input) => {
        const receipt = await admitAndRecordLearnedSkillInvocation(store, {
          sessionId: rootSessionId,
          ownerSessionRef: rootSessionId,
          bindingId,
          capabilityId: input.capabilityId,
          expectedRevision: input.revision,
          expectedFingerprint: input.fingerprint,
        });
        return { invocationId: receipt.invocationId };
      },
      completeLearnedSkillOutcomes: async (input) => {
        await completeLearnedSkillSessionOutcomes(store, {
          ...input,
          sessionId: rootSessionId,
          bindingId,
        });
      },
    },
    release: async () => {
      try {
        await reconcileLearnedSkillBindingOutcomes(store, {
          sessionId: rootSessionId,
          bindingId,
        });
      } finally {
        await releaseAll(store, testingCapabilityIds, bindingId);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createProjectRegistry(
  projectRoot: string,
  configHome: string,
  learnedArea: NonNullable<import('@kodax-ai/agent').SkillPathsConfig['learnedArea']>,
): SkillRegistry {
  const defaults = getDefaultSkillPaths(projectRoot);
  const standardUserPaths = defaults.userPaths.filter((skillPath) => (
    path.basename(path.dirname(skillPath)) === '.agents'
  ));
  return new SkillRegistry(projectRoot, {
    ...defaults,
    userPaths: [path.join(configHome, 'skills'), ...standardUserPaths],
    learnedArea,
  });
}

function createFormalProjectRegistry(
  projectRoot: string,
  configHome: string,
): SkillRegistry {
  const defaults = getDefaultSkillPaths(projectRoot);
  const standardUserPaths = defaults.userPaths.filter((skillPath) => (
    path.basename(path.dirname(skillPath)) === '.agents'
  ));
  return new SkillRegistry(projectRoot, {
    ...defaults,
    userPaths: [path.join(configHome, 'skills'), ...standardUserPaths],
  });
}

class CompositeSkillRegistry implements ISkillRegistry {
  constructor(
    private readonly formal: ISkillRegistry,
    private readonly learned: ISkillRegistry,
  ) {}

  get skills(): ReadonlyMap<string, SkillMetadata> {
    return new Map(this.list().map((skill) => [skill.name, skill]));
  }

  get size(): number {
    return this.list().length;
  }

  async discover(): Promise<void> {}

  get(name: string): SkillMetadata | undefined {
    return this.formal.get(name) ?? this.learned.get(name);
  }

  has(name: string): boolean {
    return this.formal.has(name) || this.learned.has(name);
  }

  list(): SkillMetadata[] {
    const combined = new Map(this.learned.list().map((skill) => [skill.name, skill]));
    for (const skill of this.formal.list()) combined.set(skill.name, skill);
    return [...combined.values()];
  }

  listUserInvocable(): SkillMetadata[] {
    return this.list().filter((skill) => skill.userInvocable);
  }

  loadFull(name: string): Promise<Skill> {
    return this.formal.has(name)
      ? this.formal.loadFull(name)
      : this.learned.loadFull(name);
  }

  invoke(name: string, args: string, context: SkillContext): Promise<SkillResult> {
    return this.formal.has(name)
      ? this.formal.invoke(name, args, context)
      : this.learned.invoke(name, args, context);
  }

  async reload(): Promise<void> {
    throw new Error('a run-scoped learned Skill registry is immutable');
  }
}

async function releaseAll(
  store: LearnedAreaStore,
  capabilityIds: readonly string[],
  bindingId: string,
): Promise<void> {
  await Promise.all(capabilityIds.map((capabilityId) => (
    releaseLearnedSkillBinding(store, capabilityId, bindingId)
  )));
}
