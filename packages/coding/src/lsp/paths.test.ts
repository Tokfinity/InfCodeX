import { describe, expect, it } from 'vitest';
import { normalizeFsPath } from './paths.js';

describe('normalizeFsPath', () => {
  it('converts backslashes to forward slashes (lowercased on Windows)', () => {
    // Case-folding only applies on win32; assert slash conversion always and
    // accept either case so the test is platform-portable.
    expect(normalizeFsPath('C:\\Works\\proj\\src\\a.ts')).toMatch(/^c:\/works\/proj\/src\/a\.ts$|^C:\/Works\/proj\/src\/a\.ts$/);
  });

  it('leaves a posix path lowercased only on Windows', () => {
    const out = normalizeFsPath('/home/Me/proj/a.ts');
    expect(out).toBe(process.platform === 'win32' ? '/home/me/proj/a.ts' : '/home/Me/proj/a.ts');
  });

  it('is idempotent', () => {
    const once = normalizeFsPath('C:\\a\\b.ts');
    expect(normalizeFsPath(once)).toBe(once);
  });
});
