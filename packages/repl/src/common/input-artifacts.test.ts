import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { preparePromptInputArtifacts } from './input-artifacts.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('preparePromptInputArtifacts', () => {
  it('extracts quoted image refs into multimodal message content', async () => {
    const cwd = await createTempDir('kodax-input-artifacts-');
    const imagePath = path.join(cwd, 'design shot.png');
    await writeFile(imagePath, 'fake-image');

    const prepared = preparePromptInputArtifacts(
      'Please review @"design shot.png" and explain the issue.',
      cwd,
    );

    expect(prepared.warnings).toEqual([]);
    expect(prepared.inputArtifacts).toEqual([
      expect.objectContaining({
        kind: 'image',
        path: imagePath,
        mediaType: 'image/png',
        source: 'user-inline',
      }),
    ]);
    expect(prepared.messageContent).toEqual([
      {
        type: 'text',
        // claudecode parity (2026-05-20): no `[Image #N]` anchor is emitted
        // into the user-message text. Models see pure user text + image
        // blocks appended in order. The double space at the `@path` site
        // is acceptable — models tokenize whitespace and treat it as a
        // single delimiter.
        text: 'Please review  and explain the issue.',
      },
      {
        type: 'image',
        path: imagePath,
        mediaType: 'image/png',
      },
    ]);
  });

  it('handles duplicate image refs by emitting a single artifact (no anchors)', async () => {
    const cwd = await createTempDir('kodax-input-artifacts-');
    const imagePath = path.join(cwd, 'statusbar.png');
    await writeFile(imagePath, 'fake-image');

    const prepared = preparePromptInputArtifacts(
      'Compare @statusbar.png with @statusbar.png and summarize the difference.',
      cwd,
    );

    expect(prepared.warnings).toEqual([]);
    expect(prepared.inputArtifacts).toHaveLength(1);
    expect(prepared.messageContent).toEqual([
      {
        type: 'text',
        text: 'Compare  with  and summarize the difference.',
      },
      {
        type: 'image',
        path: imagePath,
        mediaType: 'image/png',
      },
    ]);
  });

  it('ignores non-image refs and emits warnings for missing images', async () => {
    const cwd = await createTempDir('kodax-input-artifacts-');

    const prepared = preparePromptInputArtifacts(
      'Look at @README.md and @missing.png before continuing.',
      cwd,
    );

    expect(prepared.inputArtifacts).toEqual([]);
    expect(prepared.warnings).toEqual([
      `[Image input missing] missing.png was not found from ${cwd}.`,
    ]);
    expect(prepared.messageContent).toBe(
      'Look at @README.md and [Image unavailable] before continuing.',
    );
  });
});
