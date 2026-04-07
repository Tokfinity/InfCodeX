import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AAMP_LOG_LEVELS = ['off', 'error', 'info', 'debug'] as const;
export type AampLogLevel = (typeof AAMP_LOG_LEVELS)[number];

const AAMP_LOG_LEVEL_PRIORITY: Record<AampLogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_AAMP_LOG_DIR = path.join(
  process.env.KODAX_HOME ?? path.join(os.homedir(), '.kodax'),
  'aamp',
  'logs',
);

const MAX_AAMP_LOG_FILES = 20;
const MAX_AAMP_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type AampLogRecord = {
  ts: string;
  level: Exclude<AampLogLevel, 'off'>;
  surface: 'aamp';
  event: string;
  message: string;
  fields?: Record<string, unknown>;
};

export interface AampLogger {
  debug(event: string, message: string, fields?: Record<string, unknown>): void;
  info(event: string, message: string, fields?: Record<string, unknown>): void;
  error(event: string, message: string, fields?: Record<string, unknown>): void;
}

export interface JsonlAampLoggerOptions {
  baseDir?: string;
  logLevel?: AampLogLevel;
  now?: () => Date;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  terminal?: boolean;
}

export function resolveAampLogLevel(value: string | undefined, fallback: AampLogLevel = 'info'): AampLogLevel {
  if (value && (AAMP_LOG_LEVELS as readonly string[]).includes(value)) {
    return value as AampLogLevel;
  }
  return fallback;
}

function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeValue(entry, key),
      ]),
    );
  }

  if (typeof value === 'string' && parentKey && /(token|password|authorization|secret)/i.test(parentKey)) {
    return '***';
  }

  return value;
}

function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) {
    return undefined;
  }
  return sanitizeValue(fields) as Record<string, unknown>;
}

function formatTerminalLine(record: AampLogRecord): string {
  const summary = record.fields
    ? Object.entries(record.fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    : '';
  return `[${record.level}] ${record.message}${summary ? ` ${summary}` : ''}\n`;
}

export class JsonlAampLogger implements AampLogger {
  private readonly baseDir: string;
  private readonly logLevel: AampLogLevel;
  private readonly now: () => Date;
  private readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  private readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  private readonly terminal: boolean;
  private cleanedForDate: string | null = null;

  constructor(options: JsonlAampLoggerOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_AAMP_LOG_DIR;
    this.logLevel = options.logLevel ?? resolveAampLogLevel(process.env.KODAX_AAMP_LOG, 'info');
    this.now = options.now ?? (() => new Date());
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.terminal = options.terminal ?? true;
  }

  debug(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('debug', event, message, fields);
  }

  info(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('info', event, message, fields);
  }

  error(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('error', event, message, fields);
  }

  private write(level: Exclude<AampLogLevel, 'off'>, event: string, message: string, fields?: Record<string, unknown>): void {
    if (AAMP_LOG_LEVEL_PRIORITY[this.logLevel] < AAMP_LOG_LEVEL_PRIORITY[level]) {
      return;
    }

    const now = this.now();
    const record: AampLogRecord = {
      ts: now.toISOString(),
      level,
      surface: 'aamp',
      event,
      message,
      fields: sanitizeFields(fields),
    };

    try {
      this.ensureLogFile(now);
      const filePath = path.join(this.baseDir, `${record.ts.slice(0, 10)}.jsonl`);
      fsSync.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      this.stderr.write(`failed to write log file: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    if (!this.terminal) {
      return;
    }

    if (level === 'debug') {
      return;
    }

    const line = formatTerminalLine(record);
    if (level === 'error') {
      this.stderr.write(line);
    } else {
      this.stdout.write(line);
    }
  }

  private ensureLogFile(now: Date): void {
    fsSync.mkdirSync(this.baseDir, { recursive: true });
    const currentDate = now.toISOString().slice(0, 10);
    if (this.cleanedForDate === currentDate) {
      return;
    }

    this.cleanedForDate = currentDate;
    const files = fsSync.readdirSync(this.baseDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map((name) => {
        const fullPath = path.join(this.baseDir, name);
        const stat = fsSync.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    const cutoff = now.getTime() - MAX_AAMP_LOG_AGE_MS;
    files.forEach((file, index) => {
      if (index >= MAX_AAMP_LOG_FILES || file.mtimeMs < cutoff) {
        fsSync.rmSync(file.fullPath, { force: true });
      }
    });
  }
}

export function createDefaultAampLogger(options: JsonlAampLoggerOptions = {}): AampLogger {
  return new JsonlAampLogger(options);
}
