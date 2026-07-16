import type { BashOutputFilterInput, FilterResult, Lossiness } from './types.js';

export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/);
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

export function mergeLossiness(left: Lossiness, right: Lossiness): Lossiness {
  if (left === 'whole' || right === 'whole') return 'whole';
  if (left === 'tail' || right === 'tail') return 'tail';
  return 'none';
}

export function appendNote(current: string | undefined, note: string | undefined): string | undefined {
  if (!note) return current;
  return current ? `${current}\n${note}` : note;
}

export function changedResult(
  input: BashOutputFilterInput,
  stdout: string,
  stderr: string,
  lossiness: Lossiness,
  note: string,
): FilterResult {
  if (stdout === input.stdout && stderr === input.stderr) {
    return {
      stdout: input.stdout,
      stderr: input.stderr,
      lossiness: input.lossiness,
      note: input.note,
    };
  }

  return {
    stdout,
    stderr,
    lossiness: mergeLossiness(input.lossiness, lossiness),
    note: appendNote(input.note, note),
  };
}

export function uniqueInOrder(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    output.push(line);
  }
  return output;
}
