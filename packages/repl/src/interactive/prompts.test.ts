import { describe, expect, it, vi, afterEach } from 'vitest';
import type * as readline from 'node:readline';
import { confirmToolExecution } from './prompts.js';

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('confirmToolExecution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the safety reason only once for protected confirmations', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rl = {
      question: (_prompt: string, callback: (answer: string) => void) => callback('n'),
    } as any;

    await confirmToolExecution(
      rl,
      'write',
      {
        path: 'README.md',
        _reason: 'Outside the project root.',
      },
      {
        isOutsideProject: true,
        reason: 'Outside the project root.',
      },
    );

    const rendered = logSpy.mock.calls
      .flat()
      .map((entry) => stripAnsi(String(entry)))
      .join('\n');
    const matches = rendered.match(/Outside the project root\./g) ?? [];

    expect(matches).toHaveLength(1);
  });

  it('shows protected-path scope even when the flag is passed via options', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rl = {
      question: (_prompt: string, callback: (answer: string) => void) => callback('n'),
    } as any;

    await confirmToolExecution(
      rl,
      'write',
      {
        path: 'README.md',
      },
      {
        isProtectedPath: true,
      },
    );

    const rendered = logSpy.mock.calls
      .flat()
      .map((entry) => stripAnsi(String(entry)))
      .join('\n');

    expect(rendered).toContain('Scope: Protected path');
  });

  it('renders Runtime-issued Session and Always choices and returns their kind', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const suggestions = [
      { id: 'session-scope', kind: 'session' as const, label: 'This exact command for this session' },
      { id: 'persistent-scope', kind: 'persistent' as const, label: 'Always allow this exact command' },
    ];
    const answer = (value: string): readline.Interface => ({
      question: (_prompt: string, callback: (response: string) => void) => callback(value),
    }) as unknown as readline.Interface;

    await expect(confirmToolExecution(
      answer('s'),
      'bash',
      { command: 'npm test' },
      { runtimeGrantSuggestions: suggestions },
    )).resolves.toEqual({ confirmed: true, runtimeGrantKind: 'session' });
    await expect(confirmToolExecution(
      answer('a'),
      'bash',
      { command: 'npm test' },
      { runtimeGrantSuggestions: suggestions },
    )).resolves.toEqual({ confirmed: true, runtimeGrantKind: 'persistent' });

    const rendered = logSpy.mock.calls.flat().map((entry) => stripAnsi(String(entry))).join('\n');
    expect(rendered).toContain('Session');
    expect(rendered).toContain('Always');
    expect(rendered).toContain('Runtime scope: Always allow this exact command');
    expect(rendered).toContain('Runtime state: run active until this approval is resolved.');
  });

  it('does not offer persistent approval when Runtime omitted that candidate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rl = {
      question: (_prompt: string, callback: (response: string) => void) => callback('a'),
    } as unknown as readline.Interface;

    await expect(confirmToolExecution(
      rl,
      'bash',
      { command: 'rm -rf build' },
      {
        runtimeGrantSuggestions: [
          { id: 'session-only', kind: 'session', label: 'This exact command for this session' },
        ],
      },
    )).resolves.toEqual({ confirmed: false });
    const rendered = logSpy.mock.calls.flat().map((entry) => stripAnsi(String(entry))).join('\n');
    expect(rendered).toContain('Session');
    expect(rendered).not.toMatch(/\[a\]\s+Always/);
  });

  it('rejects and settles when the Runtime aborts an active prompt', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const rl = {
      question: vi.fn(() => undefined),
    } as unknown as readline.Interface;

    const decision = confirmToolExecution(
      rl,
      'bash',
      { command: 'git push' },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(decision).resolves.toEqual({ confirmed: false });
  });
});
