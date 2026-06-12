/**
 * FEATURE_217 (v0.7.49) Phase D — Durable workflow run graph.
 *
 * Persists a workflow run as `run.json` + append-only `events.jsonl` +
 * `artifacts/` under a caller-supplied run directory (the REPL points
 * this at `~/.kodax/workflow-runs/<project-key>/<runId>/` via
 * `getAgentConfigPath`). Modelling the run as an event stream — not a
 * single summary blob — keeps the agent relationships (spawn / message /
 * complete / synthesize) inspectable after the fact.
 *
 * `appendFileSync` is used for events so the on-disk order matches the
 * recorder's `seq` order with no async interleave.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  WorkflowArtifactRef,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowRunState,
} from '@kodax-ai/agent/workflow';

export interface RunGraphWriterDeps {
  /** Clock for the per-event `ts` stamp. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface RunJsonInput {
  readonly meta: WorkflowMeta;
  readonly args: unknown;
  readonly state: WorkflowRunState;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface RunGraphWriter {
  readonly runDir: string;
  /** Append one event to `events.jsonl`. */
  onEvent(event: WorkflowEvent): void;
  /** Persist an artifact under `artifacts/<safe-name>.json`. */
  writeArtifact(name: string, value: unknown): WorkflowArtifactRef;
  /** Write the terminal `run.json` summary. */
  writeRunJson(input: RunJsonInput): void;
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'artifact';
}

export function createRunGraphWriter(runDir: string, deps: RunGraphWriterDeps = {}): RunGraphWriter {
  const now = deps.now ?? (() => Date.now());
  const artifactsDir = join(runDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const eventsPath = join(runDir, 'events.jsonl');

  return {
    runDir,
    onEvent: (event) => {
      appendFileSync(eventsPath, `${JSON.stringify({ ...event, ts: now() })}\n`, 'utf8');
    },
    writeArtifact: (name, value) => {
      const path = join(artifactsDir, `${safeName(name)}.json`);
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
      return { name, path };
    },
    writeRunJson: (input) => {
      const runJson = {
        runId: input.state.runId,
        workflow: input.meta.name,
        status: input.state.status,
        totalSpawned: input.state.totalSpawned,
        artifacts: input.state.artifacts.map((a) => a.name),
        eventCount: input.state.events.length,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        args: input.args,
      };
      writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(runJson, null, 2)}\n`, 'utf8');
    },
  };
}
