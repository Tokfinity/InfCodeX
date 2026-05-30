/**
 * FEATURE_200 Phase E (v0.7.45) — readline/input helpers extracted from repl.ts.
 * Self-contained (verified: no calls to repl.ts-local fns, zero closure state).
 * getPrompt / askInput / openExternalEditor / needsContinuation.
 */
import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';
import { getProviderModel } from '../common/utils.js';
import { getTerminalWidth } from './prompts.js';
import { getCurrentTheme } from './themes.js';
import { executeShellCommand } from '../ui/utils/shell-executor.js';
import type { CurrentConfig } from './commands.js';

export function getPrompt(mode: string, config: CurrentConfig): string {
  const theme = getCurrentTheme();
  const modeColor = mode === 'plan' ? chalk.hex(theme.colors.warning) : chalk.hex(theme.colors.success);
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const width = getTerminalWidth();

  // Decide prompt detail level based on terminal width - 根据终端宽度决定提示符详细程度
  if (width < 60) {
    // Narrow terminal: minimal prompt - 窄终端：最简提示符
    const modeIndicator = mode === 'plan' ? '?' : theme.symbols.prompt;
    return modeColor(`${modeIndicator} `);
  } else if (width < 100) {
    // Medium width: short prompt - 中等宽度：简短提示符
    const flagChar = config.reasoningMode !== 'off'
      ? config.reasoningMode[0]?.toUpperCase() ?? 'R'
      : '';
    const flagPart = flagChar ? chalk.hex(theme.colors.dim)(`[${flagChar}]`) : '';
    return modeColor(`kodax:${mode}${flagPart}> `);
  }

  // Wide terminal: full prompt - 宽终端：完整提示符
  const reasoningFlag = config.reasoningMode !== 'off'
    ? chalk.hex(theme.colors.info)(`[reason:${config.reasoningMode}]`)
    : '';
  return modeColor(`kodax:${mode} (${config.provider}:${model})${reasoningFlag}> `);
}

// Read input (supports multiline and external editor) - 读取输入 (支持多行和外部编辑器)
export async function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  const theme = getCurrentTheme();
  const lines: string[] = [];

  // Read first line - 读取第一行
  const firstLine = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });

  // Check if user wants to open external editor (Ctrl+E is input as special char) - 检查是否要打开外部编辑器 (Ctrl+E 会被输入为特殊字符)
  if (firstLine === '\x05' || firstLine.toLowerCase() === '/e') {
    const edited = await openExternalEditor(lines.join('\n'));
    return edited;
  }

  lines.push(firstLine);

  // Detect if multiline input is needed - 检测是否需要多行输入
  // 1. Ends with \ (continuation char) - 以 \ 结尾 (续行符)
  // 2. Unclosed brackets/quotes - 括号/引号未闭合
  while (needsContinuation(lines.join('\n'))) {
    const continuationPrompt = chalk.hex(theme.colors.dim)('... ');
    const nextLine = await new Promise<string>((resolve) => {
      rl.question(continuationPrompt, resolve);
    });
    lines.push(nextLine);
  }

  // Process continuation: remove trailing \ - 处理续行符：移除行尾的 \
  const result = lines.join('\n').replace(/\\\n/g, '\n');
  return result;
}

// Open external editor - 打开外部编辑器
// Security note: Use spawnSync instead of execSync to avoid command injection - 安全说明: 使用 spawnSync 代替 execSync 避免命令注入
export async function openExternalEditor(initialContent: string): Promise<string> {
  // Use os.tmpdir() to get system-safe temp directory - 使用 os.tmpdir() 获取系统安全的临时目录
  const tmpDir = path.join(os.tmpdir(), 'kodax');
  // Use random suffix to avoid filename conflicts - 使用随机后缀避免文件名冲突
  const tmpFile = path.join(tmpDir, `input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    // Ensure temp directory exists - 确保临时目录存在
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(tmpFile, initialContent, 'utf-8');

    let editor = process.env.EDITOR ?? process.env.VISUAL ??
      (process.platform === 'win32' ? 'notepad.exe' : 'nano');

    // Basic security check: verify editor name doesn't contain path separators or suspicious chars - 基本的安全检查: 验证编辑器名称不包含路径分隔符或可疑字符
    // This prevents some obvious injection attempts but won't stop all attacks - 这可以防止一些明显的注入尝试，但不会阻止所有攻击
    // spawnSync itself doesn't execute through shell, so most command injection is prevented - spawnSync 本身不通过 shell 执行，所以大部分命令注入已被阻止
    if (editor.includes('/') || editor.includes('\\') || editor.includes('&&') || editor.includes('|')) {
      // If editor path contains special chars, try to extract base name - 如果编辑器路径包含特殊字符，尝试提取基本名称
      const baseName = path.basename(editor);
      console.log(chalk.yellow(`\n[Security] Editor path sanitized: ${baseName}`));
      editor = baseName;
    }

    console.log(chalk.dim(`\n[Opening editor: ${editor}]`));

    // Windows notepad special hint - Windows notepad 特殊提示
    const isWindowsNotepad = process.platform === 'win32' &&
      (editor.toLowerCase() === 'notepad' || editor.toLowerCase() === 'notepad.exe');

    if (isWindowsNotepad) {
      console.log(chalk.dim('Note: Please close Notepad manually after editing to continue.\n'));
    } else {
      console.log(chalk.dim('Save and close the editor to continue...\n'));
    }

    // Use spawnSync instead of execSync - avoid shell command injection - 使用 spawnSync 代替 execSync - 避免 shell 命令注入
    // spawnSync executes program directly, args passed as array, not parsed through shell - spawnSync 直接执行程序，参数作为数组传递，不经过 shell 解析
    childProcess.spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      timeout: 300000, // 5 minutes timeout
      shell: false,    // Explicitly disable shell - 明确禁用 shell
    });

    // Read edited content - 读取编辑后的内容
    const content = await fs.promises.readFile(tmpFile, 'utf-8');
    return content.trim();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Editor Error] ${err.message}`));
    return initialContent;
  } finally {
    // Clean up temp file - 清理临时文件
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors - 忽略清理错误
    }
  }
}

// Detect if continuation is needed - 检测是否需要续行
export function needsContinuation(input: string): boolean {
  // Ends with \ (continuation char) - 以 \ 结尾（续行符）
  if (input.endsWith('\\') && !input.endsWith('\\\\')) {
    return true;
  }

  // Detect unclosed brackets - 检测未闭合的括号
  const openBrackets = { '(': 0, '[': 0, '{': 0 };
  const closeBrackets = { ')': '(', ']': '[', '}': '{' };
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // Handle strings - 处理字符串
    if ((char === '"' || char === "'" || char === '`') && input[i - 1] !== '\\') {
      if (inString === char) {
        inString = null;
      } else if (inString === null) {
        inString = char;
      }
      continue;
    }

    // Don't detect brackets inside strings - 在字符串内不检测括号
    if (inString) continue;

    // Detect brackets - 检测括号
    if (char in openBrackets) {
      openBrackets[char as keyof typeof openBrackets]++;
    } else if (char in closeBrackets) {
      const openChar = closeBrackets[char as keyof typeof closeBrackets];
      if (openChar) {
        openBrackets[openChar as keyof typeof openBrackets]--;
      }
    }
  }

  // Has unclosed brackets - 有未闭合的括号
  if (Object.values(openBrackets).some(count => count > 0)) {
    return true;
  }

  // Has unclosed string - 有未闭合的字符串
  if (inString) {
    return true;
  }

  return false;
}

// Process special syntax - 处理特殊语法
