import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const STARTUP_SOURCES = [
  ['Classic REPL', new URL('../interactive/repl.ts', import.meta.url)],
  ['Ink REPL', new URL('../ui/InkREPL.tsx', import.meta.url)],
] as const;

describe('persisted paste-image retention', () => {
  it.each(STARTUP_SOURCES)('%s startup does not run age-only paste pruning', async (_name, source) => {
    const content = await readFile(source, 'utf8');

    expect(content).not.toContain('prunePasteTmpDir');
  });
});
