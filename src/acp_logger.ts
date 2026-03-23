import process from 'node:process';

export const ACP_LOG_LEVELS = ['off', 'error', 'info', 'debug'] as const;
export type AcpLogLevel = (typeof ACP_LOG_LEVELS)[number];

const ACP_LOG_LEVEL_RANK: Record<AcpLogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

export function resolveAcpLogLevel(
  value: string | undefined,
  fallback: AcpLogLevel = 'info',
): AcpLogLevel {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (ACP_LOG_LEVELS.includes(normalized as AcpLogLevel)) {
    return normalized as AcpLogLevel;
  }

  return fallback;
}

export interface AcpLoggerOptions {
  level?: AcpLogLevel;
  sink?: (line: string) => void;
}

type AcpLogFields = Record<string, string | number | boolean | null | undefined>;

export class AcpLogger {
  private readonly level: AcpLogLevel;
  private readonly sink: (line: string) => void;

  constructor(options: AcpLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line) => {
      process.stderr.write(`${line}\n`);
    });
  }

  error(message: string, fields?: AcpLogFields): void {
    this.log('error', message, fields);
  }

  info(message: string, fields?: AcpLogFields): void {
    this.log('info', message, fields);
  }

  debug(message: string, fields?: AcpLogFields): void {
    this.log('debug', message, fields);
  }

  private log(level: Exclude<AcpLogLevel, 'off'>, message: string, fields?: AcpLogFields): void {
    if (ACP_LOG_LEVEL_RANK[this.level] < ACP_LOG_LEVEL_RANK[level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const renderedFields = fields ? formatFields(fields) : '';
    const suffix = renderedFields ? ` ${renderedFields}` : '';
    this.sink(`[ACP][${level.toUpperCase()}][${timestamp}] ${message}${suffix}`);
  }
}

function formatFields(fields: AcpLogFields): string {
  return Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined) {
        return [];
      }
      return `${key}=${formatFieldValue(value)}`;
    })
    .join(' ');
}

function formatFieldValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value.length > 160 ? `${value.slice(0, 157)}...` : value);
  }

  return String(value);
}
