import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlAampLogger } from '../src/aamp_logger.js';

describe('JsonlAampLogger', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-aamp-logger-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes JSONL log records and redacts sensitive fields', async () => {
    const logger = new JsonlAampLogger({
      baseDir: tempDir,
      logLevel: 'debug',
      terminal: false,
      now: () => new Date('2026-04-03T12:34:56.000Z'),
    });

    logger.info('worker.started', 'worker listening for task.dispatch messages', {
      mailbox: 'agent@example.com',
      mailboxToken: 'secret-token',
      smtpPassword: 'super-secret',
      nested: {
        authorization: 'Basic abc',
      },
    });

    const filePath = path.join(tempDir, '2026-04-03.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      level: 'info',
      surface: 'aamp',
      event: 'worker.started',
      message: 'worker listening for task.dispatch messages',
      fields: {
        mailbox: 'agent@example.com',
        mailboxToken: '***',
        smtpPassword: '***',
        nested: {
          authorization: '***',
        },
      },
    });
  });

  it('respects off log level and skips file creation', async () => {
    const logger = new JsonlAampLogger({
      baseDir: tempDir,
      logLevel: 'off',
      terminal: false,
    });

    logger.info('worker.started', 'worker listening for task.dispatch messages');

    const files = await fs.readdir(tempDir).catch(() => []);
    expect(files).toEqual([]);
  });

  it('prints terminal output without duplicated AAMP prefix', async () => {
    const writes: string[] = [];
    const stdout = { write: (text: string) => writes.push(text) };
    const stderr = { write: (_text: string) => true };
    const logger = new JsonlAampLogger({
      baseDir: tempDir,
      logLevel: 'info',
      terminal: true,
      stdout,
      stderr,
      now: () => new Date('2026-04-03T12:34:56.000Z'),
    });

    logger.info('worker.started', 'worker listening', { mailbox: 'agent@example.com' });

    expect(writes).toEqual(['[info] worker listening mailbox=agent@example.com\n']);
  });

  it('writes tool lifecycle records into JSONL files', async () => {
    const logger = new JsonlAampLogger({
      baseDir: tempDir,
      logLevel: 'info',
      terminal: false,
      now: () => new Date('2026-04-03T12:34:56.000Z'),
    });

    logger.info('tool.execution_started', 'tool execution started', {
      toolId: 'tool-1',
      toolName: 'read_file',
      path: '/tmp/demo.txt',
    });
    logger.info('tool.execution_finished', 'tool execution finished', {
      toolId: 'tool-1',
      toolName: 'read_file',
      isError: false,
    });
    logger.error('tool.execution_blocked', 'tool execution blocked by permissions', {
      toolId: 'tool-2',
      toolName: 'bash',
      command: 'rm -rf dist',
      reason: '[Blocked] dangerous command',
    });
    logger.error('tool.execution_failed', 'tool execution failed', {
      toolId: 'tool-3',
      toolName: 'read_file',
      error: 'ENOENT',
    });

    const filePath = path.join(tempDir, '2026-04-03.jsonl');
    const lines = (await fs.readFile(filePath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual([
      'tool.execution_started',
      'tool.execution_finished',
      'tool.execution_blocked',
      'tool.execution_failed',
    ]);
  });
});
