/**
 * AAMP Worker Entry Point
 *
 * Spawned as a child process (via fork) for each task.dispatch.
 * Reads the task envelope and runtime options from AAMP_WORKER_INPUT env var,
 * runs KodaXAampRuntime.execute, then sends the AampTaskExecutionResult back
 * to the parent process via IPC (process.send).
 */
import { FileSessionStorage, prepareRuntimeConfig } from '@kodax-ai/repl';
import { KodaXAampRuntime } from './aamp_runtime.js';
import type { AampWorkerInput } from './aamp_types.js';

const workerInputJson = process.env.AAMP_WORKER_INPUT;
if (workerInputJson) {
  const input = JSON.parse(workerInputJson) as AampWorkerInput;

  // Register custom providers from ~/.kodax/config.json before resolving provider.
  // The worker runs in a forked child process with a fresh memory space, so custom
  // providers registered in the parent process are not inherited automatically.
  prepareRuntimeConfig();

  const runtime = new KodaXAampRuntime({
    provider: input.provider,
    model: input.model,
    repoRoot: input.repoRoot,
    sessionStorage: new FileSessionStorage(),
    dangerousFullPermissions: input.dangerousFullPermissions,
  });

  runtime
    .execute(input.dispatch, input.record)
    .then((result) => {
      process.send!(result);
      process.exit(0);
    })
    .catch((error) => {
      // Do NOT send an IPC message here. Sending a message before exit(1) would
      // cause the parent's 'message' handler to resolve the resultPromise with a
      // non-AampTaskExecutionResult object (missing `outbound`), making the
      // subsequent `execution.outbound.to` access throw at runtime.
      // The parent's 'exit' handler already rejects the promise when code !== 0.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[aamp-worker] task failed: ${message}\n`);
      process.exit(1);
    });
}
