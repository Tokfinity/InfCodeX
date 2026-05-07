/**
 * FEATURE_131 v0.7.36 Part B — edit/multi_edit Unicode-normalized
 * fuzzy match contract.
 *
 * Verifies the four character classes from the design spec
 * (smart quotes / em-dash / 全角 / NFKC) against the new
 * `findUniqueUnicodeNormalizedBlockMatch` plus the live edit tool
 * end-to-end through `toolEdit` and `toolMultiEdit`. The critical
 * invariants this suite locks down are:
 *
 *   1. byte-exact match wins when present (no normalization drift)
 *   2. NFKC + smart-quote / em-dash / nbsp / ideographic-space
 *      fallback resolves the typical 'pasted from chat / Word / Web'
 *      anchors KodaX users hit in the field
 *   3. WRITES use the caller's `new_string` bytes — file's other
 *      typographic characters are NOT silently rewritten
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { toolEdit } from '../edit.js';
import { toolMultiEdit } from '../multi-edit.js';
import {
  findUniqueUnicodeNormalizedBlockMatch,
  normalizeForFuzzyMatch,
} from '../text-anchor.js';
import type { KodaXToolExecutionContext } from '../../types.js';

const SMART_LDQUO = '“';
const SMART_RDQUO = '”';
const EM_DASH = '—';
const NBSP = ' ';
const IDEOGRAPHIC_SPACE = '　';
const FULLWIDTH_DOT = '．'; // ．

let tempDir: string;

async function makeTempFile(content: string): Promise<string> {
  const filePath = path.join(tempDir, `f-${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

function buildCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map(),
  } as KodaXToolExecutionContext;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-feat131-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('normalizeForFuzzyMatch — character classes', () => {
  it('normalizes smart double quotes to ASCII double quote', () => {
    expect(normalizeForFuzzyMatch(`${SMART_LDQUO}foo${SMART_RDQUO}`)).toBe('"foo"');
  });

  it('normalizes em-dash to "--" and en-dash to ASCII hyphen', () => {
    // Em-dash is visually closer to `--` (and is the common LLM
    // needle for it), so we map it to `--`. En-dash is the single-
    // hyphen variant.
    expect(normalizeForFuzzyMatch(`a${EM_DASH}b`)).toBe('a--b');
    expect(normalizeForFuzzyMatch('a–b')).toBe('a-b');
  });

  it('normalizes non-breaking space and ideographic space to ASCII space', () => {
    expect(normalizeForFuzzyMatch(`a${NBSP}b`)).toBe('a b');
    expect(normalizeForFuzzyMatch(`a${IDEOGRAPHIC_SPACE}b`)).toBe('a b');
  });

  it('NFKC folds full-width Latin to half-width', () => {
    expect(normalizeForFuzzyMatch('arr．length')).toBe('arr.length');
    expect(normalizeForFuzzyMatch('ＡＢＣ')).toBe('ABC');
  });

  it('passes ASCII through untouched', () => {
    expect(normalizeForFuzzyMatch('arr.length')).toBe('arr.length');
  });
});

describe('findUniqueUnicodeNormalizedBlockMatch', () => {
  it('matches an ASCII needle against a smart-quote haystack', () => {
    const result = findUniqueUnicodeNormalizedBlockMatch(
      `function f() {\n  return ${SMART_LDQUO}foo${SMART_RDQUO};\n}`,
      `return "foo";`,
    );
    expect(result.status).toBe('unique');
  });

  it('matches an ASCII needle against an em-dash haystack', () => {
    const result = findUniqueUnicodeNormalizedBlockMatch(
      `// step 1 -- step 2\n`,
      `// step 1 -- step 2`,
    );
    expect(result.status).toBe('unique');
    const result2 = findUniqueUnicodeNormalizedBlockMatch(
      `// step 1 ${EM_DASH} step 2\n`,
      `// step 1 -- step 2`,
    );
    expect(result2.status).toBe('unique');
  });

  it('matches an ASCII needle against a full-width haystack', () => {
    const haystack = `arr${FULLWIDTH_DOT}length\n`;
    const result = findUniqueUnicodeNormalizedBlockMatch(haystack, 'arr.length');
    expect(result.status).toBe('unique');
  });

  it('reports missing when no Unicode-equivalent match exists', () => {
    const result = findUniqueUnicodeNormalizedBlockMatch(
      `function g() {}\n`,
      `function notHere() {}`,
    );
    expect(result.status).toBe('missing');
  });
});

describe('toolEdit — Unicode normalization end-to-end', () => {
  it('finds smart-quote anchor with ASCII old_string', async () => {
    const filePath = await makeTempFile(`function f() {\n  return ${SMART_LDQUO}foo${SMART_RDQUO};\n}\n`);
    const result = await toolEdit(
      { path: filePath, old_string: 'return "foo";', new_string: 'return "bar";' },
      buildCtx(),
    );
    expect(result).toContain('File edited');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toContain('return "bar";');
    // NB: the rest of the file's typography is whatever multi-line
    // normalize emitted — the function-body line is fully replaced
    // because we matched a whole logical line.
  });

  it('finds em-dash anchor with ASCII old_string', async () => {
    const filePath = await makeTempFile(`// step 1 ${EM_DASH} step 2\n`);
    const result = await toolEdit(
      { path: filePath, old_string: '// step 1 -- step 2', new_string: '// step 1 - step 2' },
      buildCtx(),
    );
    expect(result).toContain('File edited');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toContain('// step 1 - step 2');
    // Em-dash must NOT remain on the matched line — the replacement
    // line is the new_string bytes verbatim.
    expect(after).not.toContain(EM_DASH);
  });

  it('exact match wins over Unicode normalization (precedence guarantee)', async () => {
    // File has BOTH ASCII and smart-quote variants. needle is ASCII.
    // We must hit the ASCII version exactly, not the smart-quote one.
    const filePath = await makeTempFile(
      `// note A: "exactly here"\n// note B: ${SMART_LDQUO}similar${SMART_RDQUO}\n`,
    );
    const result = await toolEdit(
      {
        path: filePath,
        old_string: '// note A: "exactly here"',
        new_string: '// note A: NEW',
      },
      buildCtx(),
    );
    expect(result).toContain('File edited');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toContain('// note A: NEW');
    // The smart-quote line MUST still carry its smart quotes.
    expect(after).toContain(SMART_LDQUO);
    expect(after).toContain(SMART_RDQUO);
  });

  it('preserves untouched smart-quote regions when replacing a different region', async () => {
    const filePath = await makeTempFile(
      `// untouched: ${SMART_LDQUO}keep me${SMART_RDQUO}\nconst x = "foo";\n`,
    );
    await toolEdit(
      {
        path: filePath,
        old_string: 'const x = "foo";',
        new_string: 'const x = "bar";',
      },
      buildCtx(),
    );
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toContain(`untouched: ${SMART_LDQUO}keep me${SMART_RDQUO}`);
    expect(after).toContain('const x = "bar";');
  });
});

describe('toolMultiEdit — Unicode normalization end-to-end', () => {
  it('applies a batch using Unicode-normalized fallbacks', async () => {
    // Block-match consumes the matched logical line's trailing
    // newline (existing convention shared with
    // findUniqueNormalizedBlockMatch — see edit.test.ts:52). The
    // new_string must therefore include `\n` to preserve document
    // structure across edits in a batch.
    const filePath = await makeTempFile(
      [
        `// step 1 ${EM_DASH} step 2`,
        `const greeting = ${SMART_LDQUO}hi${SMART_RDQUO};`,
        `arr${FULLWIDTH_DOT}length;`,
        '',
      ].join('\n'),
    );
    const result = await toolMultiEdit(
      {
        path: filePath,
        edits: [
          { old_string: '// step 1 -- step 2', new_string: '// step 1 to step 2\n' },
          { old_string: 'const greeting = "hi";', new_string: 'const greeting = "hey";\n' },
          { old_string: 'arr.length;', new_string: 'arr.size;\n' },
        ],
      },
      buildCtx(),
    );
    expect(result).toContain('3 edits');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toContain('// step 1 to step 2');
    expect(after).toContain('const greeting = "hey";');
    expect(after).toContain('arr.size;');
  });
});
