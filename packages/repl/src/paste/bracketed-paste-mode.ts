/**
 * FEATURE_134 (v0.7.40) — bracketed paste mode (DEC 2004) lifecycle.
 *
 * `enableBracketedPasteMode()` sends `ESC[?2004h` to stdout, asking the
 * terminal to wrap pasted text in `ESC[200~ ... ESC[201~` markers. This
 * lets `parse-keypress.ts` distinguish paste events from keystrokes
 * (see FEATURE_134 Step 1).
 *
 * `disableBracketedPasteMode()` sends `ESC[?2004l` to revert.
 *
 * The REPL must call enable on raw-mode entry, and disable on
 * raw-mode exit AND on process exit / signals — leaving 2004 mode
 * enabled in a non-KodaX shell would cause garbled input forever
 * after KodaX quits.
 *
 * `installBracketedPasteShutdownGuard()` registers `disable` on
 * `beforeExit`, `SIGINT`, `SIGTERM`, and `uncaughtException` so a
 * crash or Ctrl-C still restores the terminal.
 */

const ENABLE = '\x1b[?2004h';
const DISABLE = '\x1b[?2004l';

let installed = false;
let modeEnabled = false;

export function enableBracketedPasteMode(): void {
  if (modeEnabled) return;
  try {
    process.stdout.write(ENABLE);
    modeEnabled = true;
  } catch {
    /* terminal may not accept writes during teardown */
  }
}

export function disableBracketedPasteMode(): void {
  if (!modeEnabled) return;
  try {
    process.stdout.write(DISABLE);
  } catch {
    /* terminal teardown path — best-effort */
  } finally {
    modeEnabled = false;
  }
}

export function isBracketedPasteModeEnabled(): boolean {
  return modeEnabled;
}

export function installBracketedPasteShutdownGuard(): void {
  if (installed) return;
  installed = true;
  const handler = () => disableBracketedPasteMode();
  process.once('beforeExit', handler);
  process.once('exit', handler);
  process.once('SIGINT', () => {
    handler();
    // SIGINT default behavior is to terminate; we still need that to
    // run after our cleanup. Re-emit so default handler fires.
    process.kill(process.pid, 'SIGINT');
  });
  process.once('SIGTERM', () => {
    handler();
    process.kill(process.pid, 'SIGTERM');
  });
  process.once('uncaughtException', (err) => {
    handler();
    // Re-throw so node's default uncaughtException printing still runs.
    throw err;
  });
}
