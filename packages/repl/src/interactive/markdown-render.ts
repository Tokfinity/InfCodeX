import chalk from 'chalk';
import { getSymbols } from './prompts.js';

interface CodeBlock {
  language: string;
  code: string;
  startIndex: number;
  endIndex: number;
}

const LANGUAGE_KEYWORDS: Record<string, string[]> = {
  javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof'],
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof'],
  typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'enum', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof'],
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'enum', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof'],
  jsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this'],
  tsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'enum', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this'],
  python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'async', 'await', 'lambda', 'yield', 'pass', 'None', 'True', 'False'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'async', 'await', 'lambda', 'yield', 'pass', 'None', 'True', 'False'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return'],
  sh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return'],
  shell: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return'],
  zsh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return'],
  json: ['true', 'false', 'null'],
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] ?? '',
      code: match[2] ?? '',
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return blocks;
}

export function getHighlightKeywordPattern(language: string): RegExp | null {
  const normalized = language.trim().toLowerCase();
  const keywords = LANGUAGE_KEYWORDS[normalized];
  if (!keywords || keywords.length === 0) {
    return null;
  }

  return new RegExp(`\\b(${keywords.map(escapeRegex).join('|')})\\b`, 'g');
}

function highlightCode(code: string, language: string): string {
  const keywordPattern = getHighlightKeywordPattern(language);
  const strings = /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g;
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
  const numbers = /\b(\d+\.?\d*)\b/g;

  let result = code;
  result = result.replace(comments, chalk.dim('$1'));
  result = result.replace(strings, chalk.green('$&'));
  if (keywordPattern) {
    result = result.replace(keywordPattern, chalk.cyan('$1'));
  }
  result = result.replace(numbers, chalk.yellow('$1'));

  return result;
}

export function renderMarkdown(text: string): string {
  const symbols = getSymbols();
  let result = text;
  const codeBlocks = parseCodeBlocks(text);

  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const block = codeBlocks[i];
    if (!block) {
      continue;
    }

    const highlighted = highlightCode(block.code, block.language);
    const header = block.language ? chalk.dim(`[${block.language}]`) : '';
    const divider = chalk.dim('\u2500'.repeat(40));
    const replacement = `\n${divider}\n${header}\n${highlighted}${divider}\n`;
    result = result.slice(0, block.startIndex) + replacement + result.slice(block.endIndex);
  }

  result = result.replace(/`([^`]+)`/g, (_, code: string) => chalk.bgGray.black(` ${code} `));
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, content: string) => chalk.bold(content));
  result = result.replace(/\*([^*]+)\*/g, (_, content: string) => chalk.italic(content));
  result = result.replace(/^### (.+)$/gm, (_, title: string) => chalk.bold.cyan(`### ${title}`));
  result = result.replace(/^## (.+)$/gm, (_, title: string) => chalk.bold.blue(`## ${title}`));
  result = result.replace(/^# (.+)$/gm, (_, title: string) => chalk.bold.white(`# ${title}`));
  result = result.replace(/^- (.+)$/gm, (_, item: string) => `  ${symbols.bullet} ${item}`);
  result = result.replace(/^\* (.+)$/gm, (_, item: string) => `  ${symbols.bullet} ${item}`);
  result = result.replace(/^(\d+)\. (.+)$/gm, (_, num: string, item: string) => `  ${chalk.dim(num)}. ${item}`);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, content: string, url: string) =>
    `${chalk.cyan(content)} ${chalk.dim(`(${url})`)}`,
  );

  return result;
}

export class StreamingMarkdownRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private codeBlockLanguage = '';
  private lastRenderedLength = 0;

  append(text: string): void {
    this.buffer += text;
  }

  renderNew(): string {
    const newContent = this.buffer.slice(this.lastRenderedLength);
    this.lastRenderedLength = this.buffer.length;

    const codeBlockStart = newContent.indexOf('```');
    if (codeBlockStart !== -1) {
      this.inCodeBlock = !this.inCodeBlock;
      if (this.inCodeBlock) {
        const afterStart = newContent.slice(codeBlockStart + 3);
        const newlineIndex = afterStart.indexOf('\n');
        if (newlineIndex !== -1) {
          this.codeBlockLanguage = afterStart.slice(0, newlineIndex).trim();
        }
      }
    }

    if (this.inCodeBlock) {
      return newContent;
    }

    return this.renderInline(newContent);
  }

  private renderInline(text: string): string {
    let result = text;
    result = result.replace(/`([^`\n]+)`/g, (_, code: string) => chalk.bgGray.black(` ${code} `));
    result = result.replace(/\*\*([^*\n]+)\*\*/g, (_, content: string) => chalk.bold(content));
    result = result.replace(/\*([^*\n]+)\*/g, (_, content: string) => chalk.italic(content));
    return result;
  }

  reset(): void {
    this.buffer = '';
    this.lastRenderedLength = 0;
    this.inCodeBlock = false;
    this.codeBlockLanguage = '';
  }

  getBuffer(): string {
    return this.buffer;
  }

  isInCodeBlock(): boolean {
    return this.inCodeBlock;
  }
}

export function formatToolOutput(toolName: string, result: string): string {
  const symbols = getSymbols();
  const maxLength = 2000;
  const truncated = result.length > maxLength
    ? `${result.slice(0, maxLength)}\n...[output truncated]`
    : result;

  return `${chalk.dim(`${symbols.arrow} ${toolName}`)}\n${chalk.dim(truncated)}`;
}

export function formatToolStatus(
  toolName: string,
  status: 'running' | 'success' | 'error',
  duration?: number,
): string {
  const symbols = getSymbols();

  switch (status) {
    case 'running':
      return chalk.cyan(`${symbols.arrow} ${toolName}...`);
    case 'success': {
      const durationStr = duration !== undefined ? ` (${duration}ms)` : '';
      return chalk.green(`${symbols.success} ${toolName}${durationStr}`);
    }
    case 'error':
      return chalk.red(`${symbols.error} ${toolName}`);
  }
}

export function createProgressIndicator(
  current: number,
  total: number,
  label: string = '',
): string {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = chalk.green('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
  const percentStr = chalk.dim(`${percent.toString().padStart(3)}%`);

  return label ? `${bar} ${percentStr} ${chalk.dim(label)}` : `${bar} ${percentStr}`;
}
