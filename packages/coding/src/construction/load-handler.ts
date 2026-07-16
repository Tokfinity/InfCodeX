import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ToolHandlerSync } from '../tools/types.js';
import type { CreateCtxProxyOptions } from './ctx-proxy.js';
import {
  disposeConstructedHandlerWorker,
  prepareConstructedHandlerWorker,
  shutdownConstructedHandlerWorkersForTest,
} from './handler-worker-client.js';
import type { Capabilities, ScriptSource } from './types.js';
import { DEFAULT_HANDLER_TIMEOUT_MS } from './types.js';

export { shutdownConstructedHandlerWorkersForTest };

const CONSTRUCTED_TOOLS_SUBPATH = path.join('.kodax', 'constructed', 'tools');

export interface LoadHandlerScope {
  readonly name: string;
  readonly version: string;
  readonly cwd?: string;
}

export interface LoadHandlerOptions {
  readonly timeoutMs?: number;
  readonly ctxProxyOptions?: CreateCtxProxyOptions;
}

export async function loadHandler(
  scope: LoadHandlerScope,
  source: ScriptSource,
  capabilities: Capabilities,
  options: LoadHandlerOptions = {},
): Promise<ToolHandlerSync> {
  if (source.kind !== 'script' || source.language !== 'javascript') {
    throw new Error(
      `Constructed handler must be { kind: 'script', language: 'javascript' } (got kind='${source.kind}', language='${source.language}'). v0.7.28 does not support TS handlers.`,
    );
  }

  const cwd = scope.cwd ?? process.cwd();
  const dir = path.resolve(cwd, CONSTRUCTED_TOOLS_SUBPATH, scope.name);
  await fs.mkdir(dir, { recursive: true });
  const modulePath = path.join(dir, `${scope.version}.mjs`);
  await fs.writeFile(modulePath, source.code, 'utf8');

  const invoke = await prepareConstructedHandlerWorker({
    key: modulePath,
    moduleUrl: pathToFileURL(modulePath).href,
    label: `${scope.name}@${scope.version}`,
    capabilities,
    timeoutMs: options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    ctxProxyOptions: options.ctxProxyOptions,
  });
  return (input, ctx) => invoke(input, ctx);
}

export function disposeLoadedHandler(scope: LoadHandlerScope): Promise<void> {
  const cwd = scope.cwd ?? process.cwd();
  const modulePath = path.resolve(
    cwd,
    CONSTRUCTED_TOOLS_SUBPATH,
    scope.name,
    `${scope.version}.mjs`,
  );
  return disposeConstructedHandlerWorker(modulePath);
}
