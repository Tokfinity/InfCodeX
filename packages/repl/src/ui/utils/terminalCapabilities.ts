import * as childProcess from 'child_process';

export interface TerminalCapabilities {
  trueColor: boolean;
  colors256: boolean;
  unicode: boolean;
  emoji: boolean;
  tty: boolean;
  columns: number;
  screenReader: boolean;
}

let cachedWindowsCodePage: string | null | undefined;

function detectWindowsCodePage(): string | null {
  if (process.platform !== 'win32') {
    return null;
  }
  if (cachedWindowsCodePage !== undefined) {
    return cachedWindowsCodePage;
  }

  try {
    const output = childProcess.execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'chcp'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const match = output.match(/(\d{3,5})/);
    cachedWindowsCodePage = match?.[1] ?? null;
  } catch {
    cachedWindowsCodePage = null;
  }

  return cachedWindowsCodePage;
}

export function resetTerminalCapabilityCachesForTest(): void {
  cachedWindowsCodePage = undefined;
}

export function setWindowsCodePageForTest(codePage: string | null | undefined): void {
  cachedWindowsCodePage = codePage;
}

export function supportsTrueColor(): boolean {
  const env = process.env;

  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') {
    return true;
  }
  if (env.TERM_PROGRAM === 'iTerm.app') {
    return true;
  }
  if (env.WT_SESSION) {
    return true;
  }
  if (env.TERM === 'xterm-kitty') {
    return true;
  }
  if (env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'gnome-terminal') {
    return true;
  }

  return false;
}

export function supports256Colors(): boolean {
  if (supportsTrueColor()) {
    return true;
  }

  const term = process.env.TERM || '';
  return term.includes('256color')
    || term === 'xterm-256color'
    || term === 'screen-256color'
    || term === 'tmux-256color';
}

export function supportsUnicode(): boolean {
  const env = process.env;
  const lcAll = env.LC_ALL || '';
  const lcCtype = env.LC_CTYPE || '';
  const lang = env.LANG || '';

  if (lcAll === 'C' || lcAll === 'POSIX' || lcCtype === 'C' || lcCtype === 'POSIX' || lang === 'C' || lang === 'POSIX') {
    return false;
  }

  const locale = `${lcAll}|${lcCtype}|${lang}`.toLowerCase();
  if (locale.includes('utf-8') || locale.includes('utf8')) {
    return true;
  }

  if (process.platform === 'win32') {
    if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode') {
      return true;
    }

    return detectWindowsCodePage() === '65001';
  }

  return true;
}

export function supportsEmoji(): boolean {
  const env = process.env;

  if (env.TERM_PROGRAM === 'iTerm.app') {
    return true;
  }
  if (env.WT_SESSION) {
    return true;
  }
  if (env.TERM === 'xterm-kitty') {
    return true;
  }
  if (env.TERM_PROGRAM === 'vscode') {
    return true;
  }
  if (env.TERM_PROGRAM === 'Apple_Terminal') {
    return true;
  }
  if (env.TERM_PROGRAM === 'gnome-terminal') {
    return true;
  }
  if (env.COLORTERM) {
    return true;
  }

  return false;
}

export function getTerminalWidth(): number {
  const defaultWidth = 80;

  if (process.stdout?.columns) {
    return process.stdout.columns;
  }

  const columns = process.env.COLUMNS;
  if (columns) {
    const parsed = Number.parseInt(columns, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return defaultWidth;
}

export function isScreenReader(): boolean {
  const env = process.env;
  return Boolean(env.NO_COLOR || env.TERM === 'dumb' || env.CI);
}

function isTTY(): boolean {
  return process.stdout?.isTTY ?? false;
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  return {
    trueColor: supportsTrueColor(),
    colors256: supports256Colors(),
    unicode: supportsUnicode(),
    emoji: supportsEmoji(),
    tty: isTTY(),
    columns: getTerminalWidth(),
    screenReader: isScreenReader(),
  };
}
