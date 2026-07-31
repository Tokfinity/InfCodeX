import { main as initSkill } from './builtin/skill-creator/scripts/init-skill.js';
import { main as validateSkill } from './builtin/skill-creator/scripts/quick-validate.js';
import { main as runEval } from './builtin/skill-creator/scripts/run-eval.js';
import { main as gradeEvals } from './builtin/skill-creator/scripts/grade-evals.js';
import { main as analyzeBenchmark } from './builtin/skill-creator/scripts/analyze-benchmark.js';
import { main as compareRuns } from './builtin/skill-creator/scripts/compare-runs.js';
import { main as packageSkill } from './builtin/skill-creator/scripts/package-skill.js';
import { main as installSkill } from './builtin/skill-creator/scripts/install-skill.js';
import { setKodaXSDKForSkillCreator } from './builtin/skill-creator/scripts/utils.js';

export const SKILL_CREATOR_DISPATCH_ACTIONS = [
  'init',
  'validate',
  'eval',
  'grade',
  'analyze',
  'compare',
  'package',
  'install',
] as const;

export type SkillCreatorDispatchAction =
  (typeof SKILL_CREATOR_DISPATCH_ACTIONS)[number];

type SkillCreatorMain = (argv?: string[]) => Promise<void>;

const DISPATCHERS: Readonly<Record<SkillCreatorDispatchAction, SkillCreatorMain>> = {
  init: initSkill,
  validate: validateSkill,
  eval: runEval,
  grade: gradeEvals,
  analyze: analyzeBenchmark,
  compare: compareRuns,
  package: packageSkill,
  install: installSkill,
};

export function isSkillCreatorDispatchAction(
  value: string | undefined,
): value is SkillCreatorDispatchAction {
  return value !== undefined
    && SKILL_CREATOR_DISPATCH_ACTIONS.some((action) => action === value);
}

export async function dispatchSkillCreatorTool(
  action: SkillCreatorDispatchAction,
  args: readonly string[],
  sdk: Readonly<Record<string, unknown>>,
): Promise<void> {
  setKodaXSDKForSkillCreator(sdk);
  await DISPATCHERS[action]([
    process.execPath,
    `skill-${action}.js`,
    ...args,
  ]);
}
