import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';

export interface CapturedProviderCall {
  readonly messages: KodaXMessage[];
  readonly tools: KodaXToolDefinition[];
  readonly streamOptions?: KodaXProviderStreamOptions;
}

export interface CaptureProviderHandle {
  readonly calls: CapturedProviderCall[];
  cleanup(): void;
}

export function installCaptureProvider(input: {
  readonly providerName: string;
  readonly apiKeyEnv: string;
  readonly contextWindow: number;
  readonly model?: string;
  readonly responseText?: string;
}): CaptureProviderHandle {
  const calls: CapturedProviderCall[] = [];
  const providerName = input.providerName;
  const apiKeyEnv = input.apiKeyEnv;
  const contextWindow = input.contextWindow;
  const model = input.model ?? 'tool-exposure-eval-model';
  const responseText = input.responseText ?? 'tool exposure eval ok';

  class CaptureProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv,
      model,
      supportsThinking: false,
      contextWindow,
    };

    async stream(
      messages: KodaXMessage[],
      tools: KodaXToolDefinition[],
      _system: string,
      _reasoning?: boolean | KodaXReasoningRequest,
      streamOptions?: KodaXProviderStreamOptions,
      _signal?: AbortSignal,
    ): Promise<KodaXStreamResult> {
      calls.push({ messages, tools, streamOptions });
      streamOptions?.onTextDelta?.(responseText);
      return {
        textBlocks: [{ type: 'text', text: responseText }],
        toolBlocks: [],
        thinkingBlocks: [],
        usage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
        },
      };
    }
  }

  process.env[apiKeyEnv] = 'test-key';
  registerModelProvider(providerName, () => new CaptureProvider());

  return {
    calls,
    cleanup() {
      clearRuntimeModelProviders();
      delete process.env[apiKeyEnv];
    },
  };
}

export function writeToolExposureEvalDump(
  suiteName: string,
  caseName: string,
  data: unknown,
): void {
  const dumpRoot = join(tmpdir(), 'kodax-eval-dumps', suiteName);
  mkdirSync(dumpRoot, { recursive: true });
  writeFileSync(join(dumpRoot, `${caseName}.json`), JSON.stringify(data, null, 2), 'utf8');
}

export function toolNames(tools: readonly KodaXToolDefinition[]): readonly string[] {
  return tools.map((tool) => tool.name);
}
