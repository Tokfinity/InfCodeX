/**
 * KodaX 项目命令处理器
 *
 * 处理 /project 命令组的所有子命令
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { runKodaX, KodaXOptions, KodaXMessage } from '@kodax/coding';
import { ProjectStorage } from './project-storage.js';
import {
  ProjectFeature,
} from './project-state.js';
import {
  InteractiveContext,
} from './context.js';
import {
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import { buildInitPrompt } from '../common/utils.js';

// ============== 运行时状态管理 ==============

/**
 * 项目运行时状态
 *
 * 用于管理 auto-continue 模式的状态。
 * 设计为模块级单例，因为 REPL 会话中只会有一个自动继续循环。
 */
class ProjectRuntimeState {
  private _autoContinueRunning = false;

  get autoContinueRunning(): boolean {
    return this._autoContinueRunning;
  }

  setAutoContinueRunning(value: boolean): void {
    this._autoContinueRunning = value;
  }

  /** 重置所有状态（用于测试或会话重置） */
  reset(): void {
    this._autoContinueRunning = false;
  }
}

// 模块级单例
export const projectRuntimeState = new ProjectRuntimeState();

// ============== 辅助函数 ==============

/**
 * 创建确认提示函数
 */
function createConfirmFn(rl: readline.Interface): (message: string) => Promise<boolean> {
  return (message: string): Promise<boolean> => {
    return new Promise(resolve => {
      rl.question(`${message} (y/n) `, answer => {
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  };
}

/**
 * 创建问题提示函数
 */
function createQuestionFn(rl: readline.Interface): (prompt: string) => Promise<string> {
  return (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };
}

/**
 * 获取项目存储实例
 */
function getProjectStorage(): ProjectStorage {
  return new ProjectStorage(process.cwd());
}

/**
 * 显示功能信息
 */
function displayFeatureInfo(feature: ProjectFeature, index: number): void {
  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.cyan(`\nNext Feature (Index ${index}):`));
  console.log(chalk.white(`  ${desc}`));

  if (feature.steps?.length) {
    console.log(chalk.dim('\n  Planned steps:'));
    feature.steps.forEach((step, i) => {
      console.log(chalk.dim(`    ${i + 1}. ${step}`));
    });
  }
  console.log();
}

/**
 * 构建 feature 执行的提示词
 */
function buildFeaturePrompt(desc: string, steps?: string[]): string {
  const stepsSection = steps?.length
    ? `\n\nPlanned steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  return `Continue implementing the project. Focus on this feature:

${desc}${stepsSection}

After completing this feature, update feature_list.json to mark it as passes: true.`;
}

/**
 * 执行单个功能
 */
async function executeSingleFeature(
  feature: ProjectFeature,
  index: number,
  context: InteractiveContext,
  options: KodaXOptions
): Promise<{ success: boolean; messages: KodaXMessage[] }> {
  const desc = feature.description || feature.name || 'Unnamed';
  const prompt = buildFeaturePrompt(desc, feature.steps);

  const result = await runKodaX(
    {
      ...options,
      session: {
        ...options.session,
        initialMessages: context.messages,
      },
    },
    prompt
  );

  return {
    success: true,
    messages: result.messages,
  };
}

// ============== 命令处理函数 ==============

/**
 * 打印项目帮助
 */
export function printProjectHelp(): void {
  console.log(chalk.cyan('\n/project - Project Long-Running Task Management\n'));
  console.log(chalk.bold('Usage:'));
  console.log(chalk.dim('  /project <command> [options]\n'));

  console.log(chalk.bold('Commands:'));
  console.log(chalk.dim('  init <task>         ') + 'Initialize a new project with feature list');
  console.log(chalk.dim('  status              ') + 'Show current project status and progress');
  console.log(chalk.dim('  next [--no-confirm] ') + 'Execute the next pending feature');
  console.log(chalk.dim('  auto [--max=N]      ') + 'Auto-execute all pending features (no confirm)');
  console.log(chalk.dim('  pause               ') + 'Pause auto-continue mode');
  console.log(chalk.dim('  list                ') + 'List all features with status');
  console.log(chalk.dim('  mark <n> [done|skip]') + 'Manually mark a feature');
  console.log(chalk.dim('  progress            ') + 'View PROGRESS.md content');

  console.log();
  console.log(chalk.bold('Aliases:'), chalk.dim('/proj, /p'));

  console.log();
  console.log(chalk.bold('Workflow:'));
  console.log(chalk.dim('  1. /project init "Your project description"'));
  console.log(chalk.dim('  2. /project list                    # Review generated features'));
  console.log(chalk.dim('  3. /project next                    # Work on next feature'));
  console.log(chalk.dim('  4. /project auto                    # Or auto-execute all'));
  console.log(chalk.dim('  5. /project status                  # Check progress'));

  console.log();
  console.log(chalk.bold('Options:'));
  console.log(chalk.dim('  --no-confirm        Skip confirmation prompts (next)'));
  console.log(chalk.dim('  --confirm           Require confirmation for each feature (auto)'));
  console.log(chalk.dim('  --max=N             Limit auto-execution to N features'));
  console.log(chalk.dim('  --overwrite         Overwrite existing project (init)'));
  console.log(chalk.dim('  --append            Add features to existing project (init)'));

  console.log();
  console.log(chalk.dim('Type /help for all available commands.'));
  console.log();
}

/**
 * 显示项目状态
 */
async function projectStatus(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const stats = await storage.getStatistics();
  const next = await storage.getNextPendingFeature();

  // 状态条
  const barLength = 20;
  const completedBars = Math.round((stats.percentage / 100) * barLength);
  const bar = '█'.repeat(completedBars) + '░'.repeat(barLength - completedBars);

  console.log(chalk.cyan('\nProject Status:'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(`  Total Features:   ${stats.total}`);
  console.log(`  Completed:        ${chalk.green(stats.completed.toString())}  [${bar} ${stats.percentage}%]`);
  console.log(`  Pending:          ${chalk.yellow(stats.pending.toString())}`);
  console.log(`  Skipped:          ${chalk.dim(stats.skipped.toString())}`);
  console.log(chalk.dim('  ─────────────────────────────────────'));

  if (next) {
    console.log(chalk.cyan(`\nNext Feature (Index ${next.index}):`));
    const desc = next.feature.description || next.feature.name || 'Unnamed';
    console.log(chalk.white(`  ${desc}`));
    if (next.feature.steps?.length) {
      console.log(chalk.dim(`  Steps: ${next.feature.steps.length}`));
    }
  } else if (stats.pending === 0) {
    console.log(chalk.green('\n  ✓ All features completed or skipped'));
  }

  console.log();
}

/**
 * 初始化项目
 */
async function projectInit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
): Promise<{ projectInitPrompt: string } | void> {
  const storage = getProjectStorage();

  // 检查是否已存在
  if (await storage.exists()) {
    const hasAppend = args.includes('--append');
    const hasOverwrite = args.includes('--overwrite');

    if (!hasAppend && !hasOverwrite) {
      console.log(chalk.yellow('\n[Project already exists]'));
      console.log(chalk.dim('Use --append to add features or --overwrite to replace\n'));
      return;
    }

    if (hasOverwrite) {
      const confirmed = await confirm('Overwrite existing project?');
      if (!confirmed) {
        console.log(chalk.dim('\nCancelled\n'));
        return;
      }
    }
  }

  // 获取任务描述
  const taskArgs = args.filter(a => !a.startsWith('--'));
  const task = taskArgs.join(' ').trim();

  if (!task) {
    console.log(chalk.yellow('\nUsage: /project init <task description>'));
    console.log(chalk.dim('Example: /project init "TypeScript + Express REST API"\n'));
    return;
  }

  console.log(chalk.dim('\n📝 Initializing project...\n'));

  // 构建 init prompt，返回给 InkREPL 处理
  // 这样可以使用正确的流式事件处理器
  const initPrompt = buildInitPrompt(task);
  return { projectInitPrompt: initPrompt };
}

/**
 * 执行下一个功能
 */
async function projectNext(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const next = await storage.getNextPendingFeature();
  if (!next) {
    console.log(chalk.green('\n✓ All features completed or skipped\n'));
    return;
  }

  // 解析选项
  const hasNoConfirm = args.includes('--no-confirm');
  const indexArg = args.find(a => a.startsWith('--index='));
  const explicitIndex = indexArg ? parseInt(indexArg.split('=')[1] ?? '0', 10) : null;

  // 如果指定了索引，使用指定的
  const targetIndex = explicitIndex !== null ? explicitIndex : next.index;
  const feature = await storage.getFeatureByIndex(targetIndex);

  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${targetIndex} not found\n`));
    return;
  }

  // 显示功能信息
  displayFeatureInfo(feature, targetIndex);

  // 确认执行
  if (!hasNoConfirm) {
    const confirmed = await confirm('Execute this feature?');
    if (!confirmed) {
      console.log(chalk.dim('\nCancelled\n'));
      return;
    }
  }

  console.log(chalk.dim('\n[Executing...]\n'));

  try {
    // 更新开始时间
    await storage.updateFeatureStatus(targetIndex, {
      startedAt: new Date().toISOString(),
    });

    // 获取 KodaX 选项
    const options = callbacks.createKodaXOptions?.();
    if (!options) {
      console.log(chalk.red('\n[Error] KodaX options not available\n'));
      return;
    }

    // 执行功能
    const result = await executeSingleFeature(feature, targetIndex, context, options);
    context.messages = result.messages;

    // 检查是否完成（通过读取更新后的 feature_list.json）
    const updatedFeature = await storage.getFeatureByIndex(targetIndex);
    if (updatedFeature?.passes) {
      await storage.updateFeatureStatus(targetIndex, {
        completedAt: new Date().toISOString(),
      });
      console.log(chalk.green('\n✓ Feature completed\n'));
    } else {
      console.log(chalk.yellow('\n⚠ Feature may not be fully completed'));
      console.log(chalk.dim('Check the result and manually mark with /project mark <index> done\n'));
    }

    // 显示进度
    const stats = await storage.getStatistics();
    console.log(chalk.dim(`Progress: ${stats.completed}/${stats.total} [${stats.percentage}%]\n`));

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Error] ${err.message}\n`));
  }
}

/**
 * 解析 auto 命令选项
 */
function parseAutoOptions(args: string[]): { hasConfirm: boolean; maxRuns: number } {
  const hasConfirm = args.includes('--confirm');
  const maxArg = args.find(a => a.startsWith('--max='));
  const maxRuns = maxArg ? parseInt(maxArg.split('=')[1] ?? '10', 10) : 0; // 0 = unlimited
  return { hasConfirm, maxRuns };
}

/**
 * 处理自动继续模式的用户输入
 */
type AutoAction = 'yes' | 'no' | 'skip' | 'quit';

function parseAutoAction(answer: string): AutoAction {
  const action = answer.toLowerCase().trim();
  if (action === 'q' || action === 'quit') return 'quit';
  if (action === 's' || action === 'skip') return 'skip';
  if (action.startsWith('y')) return 'yes';
  return 'no';
}

/**
 * 自动继续模式
 */
async function projectAuto(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>,
  question: (prompt: string) => Promise<string>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  if (projectRuntimeState.autoContinueRunning) {
    console.log(chalk.yellow('\n[Auto-continue already running]'));
    console.log(chalk.dim('Use /project pause to stop\n'));
    return;
  }

  // 解析选项
  const { hasConfirm, maxRuns } = parseAutoOptions(args);

  const stats = await storage.getStatistics();
  let runCount = 0;

  console.log(chalk.cyan('\nAuto-Continue Mode'));
  console.log(chalk.dim(`  Max runs: ${maxRuns || 'unlimited'}`));
  console.log(chalk.dim(`  Confirm each: ${hasConfirm ? 'yes' : 'no'}`));
  console.log(chalk.dim(`  Remaining: ${stats.pending} features`));
  console.log();

  projectRuntimeState.setAutoContinueRunning(true);

  try {
    while (projectRuntimeState.autoContinueRunning) {
      const next = await storage.getNextPendingFeature();
      if (!next) {
        console.log(chalk.green('\n✓ All features completed\n'));
        break;
      }

      runCount++;
      if (maxRuns > 0 && runCount > maxRuns) {
        console.log(chalk.yellow('\nMax runs reached\n'));
        break;
      }

      const desc = next.feature.description || next.feature.name || 'Unnamed';
      console.log(chalk.cyan(`[${runCount}] ${desc}`));

      // 确认（仅在 --confirm 模式下）
      if (hasConfirm) {
        const answer = await question('Execute? (y/n/s=skip/q=quit) ');
        const action = parseAutoAction(answer);

        if (action === 'quit') {
          console.log(chalk.dim('\nPaused\n'));
          break;
        }
        if (action === 'skip') {
          await storage.updateFeatureStatus(next.index, { skipped: true });
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
        if (action === 'no') {
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
      }

      // 执行
      try {
        const options = callbacks.createKodaXOptions?.();
        if (!options) {
          console.log(chalk.red('\n[Error] KodaX options not available\n'));
          break;
        }
        const result = await executeSingleFeature(next.feature, next.index, context, options);
        context.messages = result.messages;

        const updatedFeature = await storage.getFeatureByIndex(next.index);
        if (updatedFeature?.passes) {
          console.log(chalk.green('  ✓ Completed\n'));
        } else {
          console.log(chalk.yellow('  ⚠ May need review\n'));
        }

      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.log(chalk.red(`  ✗ Error: ${err.message}\n`));

        const continueAfter = await confirm('Continue with next feature?');
        if (!continueAfter) {
          break;
        }
      }
    }
  } finally {
    projectRuntimeState.setAutoContinueRunning(false);
  }
}

/**
 * 暂停自动继续
 */
async function projectPause(): Promise<void> {
  if (projectRuntimeState.autoContinueRunning) {
    projectRuntimeState.setAutoContinueRunning(false);
    console.log(chalk.cyan('\n[Auto-continue paused]\n'));
  } else {
    console.log(chalk.yellow('\n[Auto-continue not running]\n'));
  }
}

/**
 * 列出所有功能
 */
async function projectList(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const features = await storage.listFeatures();
  const stats = await storage.getStatistics();

  console.log(chalk.cyan(`\nFeatures (${stats.total} total):\n`));

  features.forEach((f, i) => {
    const status = f.passes
      ? chalk.green('✓')
      : f.skipped
        ? chalk.dim('⊘')
        : chalk.yellow('○');

    const desc = f.description || f.name || 'Unnamed';
    const preview = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;

    console.log(`  ${status} ${chalk.dim(`${i}.`)} ${preview}`);
  });

  console.log();
  console.log(chalk.dim(`  Legend: ✓ completed  ○ pending  ⊘ skipped\n`));
}

/**
 * 标记功能状态
 */
async function projectMark(args: string[]): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const index = parseInt(args[0] ?? '', 10);
  const status = (args[1] ?? '').toLowerCase();

  if (isNaN(index)) {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  const feature = await storage.getFeatureByIndex(index);
  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${index} not found\n`));
    return;
  }

  const updates: Partial<ProjectFeature> = {};

  if (status === 'done') {
    updates.passes = true;
    updates.completedAt = new Date().toISOString();
  } else if (status === 'skip') {
    updates.skipped = true;
  } else {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  await storage.updateFeatureStatus(index, updates);

  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.green(`\n✓ Marked feature ${index} as ${status}`));
  console.log(chalk.dim(`  ${desc}\n`));
}

/**
 * 查看进度文件
 */
async function projectProgress(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const progress = await storage.readProgress();

  if (!progress) {
    console.log(chalk.dim('\n[PROGRESS.md is empty]\n'));
    return;
  }

  console.log(chalk.cyan('\nPROGRESS.md:\n'));
  console.log(chalk.dim('─'.repeat(50)));
  // 只显示最后 50 行
  const lines = progress.split('\n');
  const displayLines = lines.slice(-50);
  console.log(displayLines.join('\n'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();
}

/**
 * 主入口：处理 /project 命令
 */
export async function handleProjectCommand(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<{ projectInitPrompt: string } | void> {
  const subCommand = args[0]?.toLowerCase();

  // 确定确认函数的来源
  // 优先使用 callbacks.confirm (Ink UI)，其次使用 readline (传统 REPL)
  const rl = callbacks.readline;
  const hasConfirm = !!callbacks.confirm;

  // 对于需要交互的命令，检查是否有确认能力
  if (['init', 'next', 'auto'].includes(subCommand ?? '')) {
    if (!hasConfirm && !rl) {
      console.log(chalk.red(`\n[Error] /project ${subCommand} is not available in the current UI mode`));
      console.log(chalk.dim('This command requires interactive input which is not supported.\n'));
      return;
    }
  }

  // 创建辅助函数 - 优先使用 callbacks.confirm
  const confirm: (message: string) => Promise<boolean> = hasConfirm
    ? callbacks.confirm!
    : rl
      ? createConfirmFn(rl)
      : async () => false;
  const question = rl ? createQuestionFn(rl) : async () => '';

  switch (subCommand) {
    case 'init':
    case 'i':
      return await projectInit(args.slice(1), context, callbacks, currentConfig, confirm);

    case 'status':
    case 'st':
    case 'info':
      await projectStatus();
      break;

    case 'next':
    case 'n':
      await projectNext(args.slice(1), context, callbacks, currentConfig, confirm);
      break;

    case 'auto':
    case 'a':
      await projectAuto(args.slice(1), context, callbacks, currentConfig, confirm, question);
      break;

    case 'pause':
      await projectPause();
      break;

    case 'list':
    case 'l':
      await projectList();
      break;

    case 'mark':
    case 'm':
      await projectMark(args.slice(1));
      break;

    case 'progress':
    case 'p':
      await projectProgress();
      break;

    default:
      printProjectHelp();
  }
}

/**
 * 检测并显示项目提示
 */
export async function detectAndShowProjectHint(): Promise<boolean> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    return false;
  }

  const stats = await storage.getStatistics();

  console.log(chalk.cyan('  📁 Long-running project detected'));
  console.log(chalk.dim(`    ${stats.completed}/${stats.total} features completed [${stats.percentage}%]`));
  console.log(chalk.dim('    Use /project status to view progress'));
  console.log(chalk.dim('    Use /project next to work on next feature'));
  console.log();

  return true;
}
