import chalk from 'chalk';
import {
  supportsTrueColor as terminalSupportsTrueColor,
  supportsUnicode as terminalSupportsUnicode,
} from '../ui/utils/terminalCapabilities.js';

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  dim: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface ThemeSymbols {
  prompt: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  arrow: string;
  bullet: string;
  check: string;
  cross: string;
  spinner: string[];
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
  symbols: ThemeSymbols;
  spinner: {
    frames: string[];
    interval: number;
  };
}

function getUnicodeSymbols(): ThemeSymbols {
  return {
    prompt: '\u276F',
    success: '\u2713',
    error: '\u2717',
    warning: '\u26A0',
    info: '\u2139',
    arrow: '\u2192',
    bullet: '\u2022',
    check: '\u2713',
    cross: '\u2717',
    spinner: ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'],
  };
}

function getAsciiSymbols(): ThemeSymbols {
  return {
    prompt: '>',
    success: '[OK]',
    error: '[X]',
    warning: '[!]',
    info: '[i]',
    arrow: '->',
    bullet: '*',
    check: '[v]',
    cross: '[x]',
    spinner: ['|', '/', '-', '\\', '|', '/', '-', '\\'],
  };
}

const darkTheme: Theme = {
  name: 'dark',
  description: 'Dark theme with vibrant colors',
  colors: {
    primary: '#00D7FF',
    secondary: '#9D9D9D',
    accent: '#FF6B6B',
    text: '#FFFFFF',
    dim: '#6B6B6B',
    success: '#4CAF50',
    warning: '#FF9800',
    error: '#F44336',
    info: '#2196F3',
  },
  symbols: terminalSupportsUnicode() ? getUnicodeSymbols() : getAsciiSymbols(),
  spinner: {
    frames: terminalSupportsUnicode()
      ? ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F']
      : ['|', '/', '-', '\\', '|', '/', '-', '\\'],
    interval: 80,
  },
};

const lightTheme: Theme = {
  name: 'light',
  description: 'Light theme for bright terminals',
  colors: {
    primary: '#0066CC',
    secondary: '#666666',
    accent: '#CC0000',
    text: '#000000',
    dim: '#999999',
    success: '#228B22',
    warning: '#CC7A00',
    error: '#CC0000',
    info: '#0066CC',
  },
  symbols: terminalSupportsUnicode() ? getUnicodeSymbols() : getAsciiSymbols(),
  spinner: {
    frames: terminalSupportsUnicode()
      ? ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F']
      : ['|', '/', '-', '\\', '|', '/', '-', '\\'],
    interval: 80,
  },
};

const minimalTheme: Theme = {
  name: 'minimal',
  description: 'Minimal theme without colors (for CI or limited terminals)',
  colors: {
    primary: '',
    secondary: '',
    accent: '',
    text: '',
    dim: '',
    success: '',
    warning: '',
    error: '',
    info: '',
  },
  symbols: getAsciiSymbols(),
  spinner: {
    frames: ['.', 'o', 'O', '0', 'O', 'o'],
    interval: 120,
  },
};

export const themes: Record<string, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  minimal: minimalTheme,
};

let currentTheme: Theme = darkTheme;

export function getCurrentTheme(): Theme {
  return currentTheme;
}

export function setTheme(name: string): boolean {
  const theme = themes[name];
  if (!theme) {
    return false;
  }

  currentTheme = theme;
  return true;
}

export function getThemeNames(): string[] {
  return Object.keys(themes);
}

export function getThemeSymbols(): ThemeSymbols {
  return currentTheme.symbols;
}

export function getSpinnerConfig(): { frames: string[]; interval: number } {
  return currentTheme.spinner;
}

export function colorize(text: string, colorType: keyof ThemeColors): string {
  const color = currentTheme.colors[colorType];
  if (!color) {
    return text;
  }

  if (terminalSupportsTrueColor() && color.startsWith('#')) {
    return chalk.hex(color)(text);
  }

  switch (colorType) {
    case 'primary':
      return chalk.cyan(text);
    case 'secondary':
      return chalk.gray(text);
    case 'accent':
      return chalk.magenta(text);
    case 'text':
      return chalk.white(text);
    case 'dim':
      return chalk.dim(text);
    case 'success':
      return chalk.green(text);
    case 'warning':
      return chalk.yellow(text);
    case 'error':
      return chalk.red(text);
    case 'info':
      return chalk.blue(text);
    default:
      return text;
  }
}

export function formatSuccess(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.success} ${message}`, 'success');
}

export function formatError(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.error} ${message}`, 'error');
}

export function formatWarning(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.warning} ${message}`, 'warning');
}

export function formatInfo(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.info} ${message}`, 'info');
}

export function formatPrompt(mode: string, provider: string, flags: string[]): string {
  const symbols = getThemeSymbols();
  const modeColor = mode === 'ask' ? 'warning' : 'success';
  const flagStr = flags.length > 0 ? ` ${flags.join('')}` : '';
  return colorize(`kodax:${mode} (${provider})${flagStr}${symbols.prompt} `, modeColor);
}

export function autoSelectTheme(): void {
  if (!process.stdout.isTTY) {
    setTheme('minimal');
    return;
  }

  const env = process.env;
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM === 'vscode') {
    setTheme('dark');
    return;
  }

  setTheme('dark');
}

autoSelectTheme();
