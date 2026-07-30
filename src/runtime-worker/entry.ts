import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

import { KODAX_DIR } from '@kodax-ai/repl';
import {
  createConfiguredA2ARuntimeIntegration,
  type ConfiguredA2ARuntimeHandle,
} from '../a2a/runtime-config.js';
import { createKodaXRuntime } from '../sdk-runtime.js';
import { isRuntimeDaemonRequest } from '../runtime-daemon/protocol.js';
import { createRuntimeDaemonDispatcher } from '../runtime-daemon/server.js';
import type { RuntimeWorkerBootstrapOptions } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Runtime Worker requires a parent MessagePort.');

const {
  configuredA2A = false,
  ...runtimeBootstrap
} = workerData as RuntimeWorkerBootstrapOptions;
const a2aIntegration = configuredA2A
  ? createConfiguredA2ARuntimeIntegration({
      configHome: runtimeBootstrap.homeDir
        ? path.join(path.resolve(runtimeBootstrap.homeDir), '.kodax')
        : KODAX_DIR,
    })
  : undefined;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
let a2aHandle: ConfiguredA2ARuntimeHandle | undefined;
try {
  runtime = await createKodaXRuntime({
    mode: 'embedded',
    isolation: 'inline',
    ...runtimeBootstrap,
    ...(a2aIntegration ? { externalAgents: a2aIntegration.runtimeOptions } : {}),
  });
  if (a2aIntegration) a2aHandle = await a2aIntegration.start(runtime);
} catch (error: unknown) {
  try {
    await runtime?.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [error, cleanupError],
      'Runtime Worker initialization failed and cleanup was incomplete.',
    );
  }
  throw error;
}
const dispatcher = createRuntimeDaemonDispatcher({
  runtime,
  notify: (notification) => port.postMessage(notification),
  capabilities: { hardDispose: true },
});

port.on('message', async (message: unknown) => {
  if (!isRuntimeDaemonRequest(message)) return;
  if (message.method === 'runtime.shutdown' || message.method === 'daemon.stop') {
    a2aHandle?.close();
  }
  const response = await dispatcher.handle(message);
  port.postMessage(response);
  if (message.method === 'runtime.shutdown' || message.method === 'daemon.stop') {
    dispatcher.close();
    port.close();
  }
});
