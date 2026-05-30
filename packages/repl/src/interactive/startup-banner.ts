/**
 * FEATURE_200 Phase E (v0.7.45) — startup banner + workspace-entry notice
 * extracted from repl.ts. Self-contained (params + module imports only).
 */
import chalk from 'chalk';
import type { AgentsFile } from '@kodax-ai/coding';
import { getProviderModel, KODAX_VERSION } from '../common/utils.js';
import { getCurrentTheme } from './themes.js';
import { formatWorkspaceTruth } from './workspace-runtime.js';
import type { InteractiveContext } from './context.js';
import type { CurrentConfig } from './commands.js';

export function printWorkspaceEntryNotice(runtimeInfo: InteractiveContext['runtimeInfo']): void {
  if (!runtimeInfo?.workspaceRoot) {
    return;
  }

  console.log(chalk.dim(`  Workspace: ${formatWorkspaceTruth(runtimeInfo)}`));
  console.log(chalk.dim('  Use /status workspace for runtime details.\n'));
}


export function printStartupBanner(config: CurrentConfig, mode: string, compactionInfo?: { contextWindow: number; triggerPercent: number; enabled: boolean }, agentsFiles?: AgentsFile[]): void {
  const theme = getCurrentTheme();
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;

  // KODAX block character logo - KODAX 方块字符 logo
  const logo = `
  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗
  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝
  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝
  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗
  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗
  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝`;

  console.log(chalk.hex(theme.colors.primary)('\n' + logo));
  console.log(chalk.hex(theme.colors.text)(`\n  v${KODAX_VERSION}  |  AI Coding Agent  |  ${config.provider}:${model}`));
  console.log(chalk.hex(theme.colors.dim)('\n  ────────────────────────────────────────────────────────'));
  console.log(
    chalk.hex(theme.colors.dim)('  Mode: ') +
    chalk.hex(theme.colors.primary)(mode) +
    chalk.hex(theme.colors.dim)('  |  Reasoning: ') +
    (config.reasoningMode === 'off'
      ? chalk.hex(theme.colors.dim)('off')
      : chalk.hex(theme.colors.success)(config.reasoningMode))
  );

  // Compaction info
  if (compactionInfo) {
    const ctxK = Math.round(compactionInfo.contextWindow / 1000);
    const triggerK = Math.round(compactionInfo.contextWindow * compactionInfo.triggerPercent / 100 / 1000);
    const statusText = compactionInfo.enabled ? chalk.hex(theme.colors.success)('on') : chalk.hex(theme.colors.dim)('off');
    console.log(chalk.hex(theme.colors.dim)(`  Context: ${ctxK}k  |  Compaction: `) + statusText + chalk.hex(theme.colors.dim)(` @ ${compactionInfo.triggerPercent}% (${triggerK}k)`));
  }

  console.log(chalk.hex(theme.colors.dim)('  ────────────────────────────────────────────────────────\n'));

  // Show AGENTS.md loading status
  if (agentsFiles) {
    const totalFiles = agentsFiles.length;
    console.log(chalk.hex(theme.colors.dim)('  Project Rules: ') + chalk.hex(theme.colors.success)(`${totalFiles} rule file(s) loaded`));
    console.log(chalk.hex(theme.colors.dim)('  Use /reload to refresh rules\n'));
  }

  console.log(chalk.hex(theme.colors.dim)('  Quick tips:'));
  console.log(chalk.hex(theme.colors.primary)('    /help      ') + chalk.hex(theme.colors.dim)('Show all commands'));
  console.log(chalk.hex(theme.colors.primary)('    /mode      ') + chalk.hex(theme.colors.dim)('Switch permission mode'));
  console.log(chalk.hex(theme.colors.primary)('    /clear     ') + chalk.hex(theme.colors.dim)('Clear conversation'));
  console.log(chalk.hex(theme.colors.primary)('    @path      ') + chalk.hex(theme.colors.dim)('Attach image to context'));
  console.log(chalk.hex(theme.colors.primary)('    !cmd       ') + chalk.hex(theme.colors.dim)('Run read-only shell command'));
  console.log(chalk.hex(theme.colors.dim)('\n  Keyboard: Tab (complete) | Esc+Esc (edit last) | Ctrl+T (reasoning) | Ctrl+E (editor) | Ctrl+R (history)\n'));
}

