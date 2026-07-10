import { parentPort, workerData } from 'node:worker_threads';

import { createKodaXRuntime } from '../sdk-runtime.js';
import { isRuntimeDaemonRequest } from '../runtime-daemon/protocol.js';
import { createRuntimeDaemonDispatcher } from '../runtime-daemon/server.js';
import type { RuntimeWorkerBootstrapOptions } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Runtime Worker requires a parent MessagePort.');

const bootstrap = workerData as RuntimeWorkerBootstrapOptions;
const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'inline',
  ...bootstrap,
});
const dispatcher = createRuntimeDaemonDispatcher({
  runtime,
  notify: (notification) => port.postMessage(notification),
  capabilities: { hardDispose: true },
});

port.on('message', async (message: unknown) => {
  if (!isRuntimeDaemonRequest(message)) return;
  const response = await dispatcher.handle(message);
  port.postMessage(response);
  if (message.method === 'runtime.shutdown' || message.method === 'daemon.stop') {
    dispatcher.close();
    port.close();
  }
});
