/**
 * FEATURE_204 (v0.7.45) — `kodax doctor` diagnostic CLI.
 *
 * Minimalist scope: read-only environment probes that need no network + no
 * billing — runtime, terminal capabilities, configured providers, session/
 * trace disk usage, config home. Live provider `ping` (network + billing) and
 * MCP handshake probes are deferred until there's demand; `kodax doctor` today
 * answers "is my env sane / how much disk are sessions using" without any cost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAgentConfigHome } from '@kodax-ai/agent';
import { getAvailableProviderNames } from '@kodax-ai/coding';

interface DirSummary {
  readonly count: number;
  readonly bytes: number;
}

interface DoctorReport {
  readonly version: string;
  readonly runtime: { readonly node: string; readonly platform: string };
  readonly terminal: { readonly tty: boolean; readonly truecolor: boolean };
  readonly providers: readonly string[];
  readonly configHome: string;
  readonly sessions: DirSummary | null;
  readonly traces: DirSummary | null;
}

function summarizeDir(dir: string): DirSummary | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    try {
      const stat = fs.statSync(path.join(dir, entry));
      if (stat.isFile()) {
        bytes += stat.size;
        count += 1;
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return { count, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function buildReport(version: string): DoctorReport {
  const home = getAgentConfigHome();
  return {
    version,
    runtime: { node: process.version, platform: `${os.platform()} ${os.release()}` },
    terminal: {
      tty: Boolean(process.stdout.isTTY),
      truecolor: process.env.COLORTERM === 'truecolor',
    },
    providers: getAvailableProviderNames(),
    configHome: home,
    sessions: summarizeDir(path.join(home, 'sessions')),
    traces: summarizeDir(path.join(home, '.traces')),
  };
}

function summaryLine(label: string, summary: DirSummary | null): string {
  if (!summary) return `  ${label}: (none)`;
  return `  ${label}: ${summary.count} files, ${formatBytes(summary.bytes)}`;
}

export function runDoctor(version: string, asJson: boolean): void {
  const report = buildReport(version);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const lines = [
    `KodaX v${report.version} diagnostic`,
    '',
    'Runtime',
    `  Node ${report.runtime.node}`,
    `  Platform: ${report.runtime.platform}`,
    '',
    'Terminal',
    `  TTY: ${report.terminal.tty ? 'yes' : 'no'}`,
    `  Truecolor: ${report.terminal.truecolor ? 'yes' : 'unknown'}`,
    '',
    'Providers (configured / available)',
    report.providers.length > 0
      ? `  ${report.providers.join(', ')}`
      : '  (none configured)',
    '',
    `Storage (${report.configHome})`,
    summaryLine('sessions', report.sessions),
    summaryLine('traces  ', report.traces),
  ];
  console.log(lines.join('\n'));
}
