/**
 * Optional real-wire smoke for the five verified Ark Coding image routes.
 *
 * Skipped by default. Run sequentially with a configured ARK_CODING_API_KEY:
 *
 *   KODAX_INTEGRATION_TEST=1 npm run test:integration -- \
 *     packages/llm/src/providers/ark-coding-image-routes.integration.test.ts
 *
 * Budget: five provider calls, one per route, at most 16 output tokens each.
 * Raw responses are retained under the OS temp directory for review.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { KodaXMessage } from '../types.js';
import { resolveProvider } from './resolver.js';

const RUN_INTEGRATION = process.env.KODAX_INTEGRATION_TEST === '1';
const ARK_CODING_IMAGE_MODELS = [
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'MiniMax-M3',
] as const;
const PNG_16X16_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR4AaXBAQEAAAiDMKR/5xuC7QYjkEgiiSSSSCKJJJJIIokkkkgiiR5YbQIeTyCVoAAAAABJRU5ErkJggg==';
const provider = resolveProvider('ark-coding');
const tempDirs: string[] = [];
const rawRuns: Array<Record<string, unknown>> = [];
const dumpDir = path.join(tmpdir(), 'kodax-eval-dumps', 'ark-coding-image-routes');
const dumpPath = path.join(dumpDir, 'real-wire.json');

async function persistRawRuns(): Promise<void> {
  await mkdir(dumpDir, { recursive: true });
  await writeFile(dumpPath, JSON.stringify({ runs: rawRuns }, null, 2));
}

describe.skipIf(!RUN_INTEGRATION || !provider.isConfigured())(
  'Ark Coding image routes — real provider HTTP',
  () => {
    afterAll(async () => {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it.each(ARK_CODING_IMAGE_MODELS)(
      'accepts an Anthropic image block for %s',
      async (model) => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'kodax-ark-image-'));
        tempDirs.push(tempDir);
        const imagePath = path.join(tempDir, 'red-square.png');
        await writeFile(imagePath, Buffer.from(PNG_16X16_BASE64, 'base64'));
        const messages: KodaXMessage[] = [{
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with exactly OK.' },
            { type: 'image', path: imagePath, mediaType: 'image/png' },
          ],
        }];
        const startedAt = Date.now();

        try {
          const result = await provider.stream(
            messages,
            [],
            'You are a terse image-input smoke test.',
            false,
            { modelOverride: model, maxOutputTokensOverride: 16 },
          );
          rawRuns.push({
            model,
            accepted: true,
            text: result.textBlocks.map((block) => block.text).join(''),
            toolCalls: result.toolBlocks.map((block) => block.name),
            stopReason: result.stopReason ?? null,
            usage: result.usage ?? null,
            durationMs: Date.now() - startedAt,
          });
          await persistRawRuns();
          expect(result).toBeDefined();
        } catch (error) {
          rawRuns.push({
            model,
            accepted: false,
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
            durationMs: Date.now() - startedAt,
          });
          await persistRawRuns();
          throw error;
        }
      },
      90_000,
    );
  },
);
