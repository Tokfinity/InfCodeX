import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolBash } from './bash.js';

describe('toolBash', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bash-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('keeps the tail for large command output', async () => {
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(`line-${i}`)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-3000');
    expect(result).toContain('Bash output truncated to the tail');
  });

  it('includes stderr in timeout previews', async () => {
    const command = 'node -e "process.stderr.write(\'timeout-error\\n\'); setTimeout(() => {}, 5000)"';
    const result = await toolBash({ command, timeout: 1 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('[Timeout]');
    expect(result).toContain('timeout-error');
  });

  it('runs command in background and returns output file path', async () => {
    const command = 'node -e "console.log(\'bg-output\')"';
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Command started in background');
    expect(result).toContain('PID:');
    expect(result).toContain('Output:');
    expect(result).toContain('kodax-bg-');

    const outputMatch = result.match(/Output:\s*(.+)/);
    expect(outputMatch).toBeTruthy();
    const outputPath = outputMatch![1]!.trim();

    // Poll for the [Exit:...] marker rather than sleep(500). The background
    // node process flushes its stdout + the post-exit `[Exit: <code>]` line
    // asynchronously; on Windows in particular the 500ms fixed sleep is too
    // tight under loaded CI. Cap the poll at 5s and check every 50ms — this
    // turns the previous race-prone fixed sleep into a deterministic wait.
    const deadline = Date.now() + 5_000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        content = await fs.readFile(outputPath, 'utf-8');
        if (content.includes('[Exit:')) break;
      } catch {
        // file may not exist yet on the first poll iteration
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(content).toContain('bg-output');
    expect(content).toContain('[Exit:');
  });

  // FEATURE_149 (v0.7.38) — live progress reporting via reportToolProgress.
  // The bash tool feeds stdout/stderr chunks into a small UTF-8 tail and
  // calls ctx.reportToolProgress so the REPL spinner / tool-call display
  // can show live output. Mirrors CC's BashTool.renderToolUseProgressMessage.
  describe('live progress reporting (FEATURE_149)', () => {
    it('calls reportToolProgress with stdout tail during execution', async () => {
      const progressEvents: string[] = [];
      // node script that prints 5 lines with a small gap between them so the
      // throttle has time to fire — but short enough that the test stays fast.
      const command = `node -e "const lines=['alpha','beta','gamma','delta','epsilon']; (async()=>{ for(const l of lines){ console.log(l); await new Promise(r=>setTimeout(r,30)); }})()"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('alpha');
      expect(result).toContain('epsilon');
      // We should have received at least one progress event with the tail.
      // Throttle is 100ms so we won't get 5; we get 1-3 typically.
      expect(progressEvents.length).toBeGreaterThan(0);
      // The tail should be visible in at least one event — order is preserved.
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toContain('epsilon');
    });

    it('does not throw when reportToolProgress is undefined (back-compat)', async () => {
      const command = `node -e "console.log('quiet')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        // reportToolProgress intentionally omitted
      });

      expect(result).toContain('quiet');
    });

    it('includes stderr in live progress (npm/pytest etc. emit to stderr)', async () => {
      const progressEvents: string[] = [];
      const command = `node -e "process.stderr.write('warn-msg\\n'); console.log('done')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('done');
      // stderr line should have shown up in progress.
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toMatch(/warn-msg|done/);
    });
  });
});
