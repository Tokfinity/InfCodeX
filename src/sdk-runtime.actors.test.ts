import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKodaXRuntime } from './sdk-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-actors-'));
  tempDirs.push(homeDir);
  return homeDir;
}

describe('F270 Runtime Actor facade', () => {
  it('isolates Actor trees by session and restores reusable identities after restart', async () => {
    const homeDir = await makeHome();
    const first = await createKodaXRuntime({ homeDir });
    const alpha = await first.sessions.create({ sessionId: 'alpha', title: 'Alpha' });
    const beta = await first.sessions.create({ sessionId: 'beta', title: 'Beta' });

    expect((await first.agents.tree(alpha.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    expect((await first.agents.tree(beta.id)).actors.map((actor) => actor.path)).toEqual(['/root']);

    const turn = await first.agents.spawn(alpha.id, {
      taskName: 'worker',
      objective: 'Exercise durable Actor state without an attached run.',
    });
    await expect(first.agents.wait(alpha.id, 2, 1_000)).resolves.toMatchObject({
      kind: 'turn_failed', actorPath: '/root/worker', turnId: turn.turnId,
    });
    expect(await first.agents.output(alpha.id, '/root/worker', turn.turnId)).toMatchObject({
      state: 'failed',
    });
    expect((await first.agents.tree(beta.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    await first.close();

    const restarted = await createKodaXRuntime({ homeDir });
    await restarted.sessions.load(alpha.id);
    expect(await restarted.agents.detail(alpha.id, '/root/worker')).toMatchObject({
      actor: { path: '/root/worker', state: 'idle' },
      turns: [{ turnId: turn.turnId, state: 'failed' }],
    });

    const followup = await restarted.agents.followup(alpha.id, '/root/worker', 'Resume safely.');
    await expect(restarted.agents.wait(alpha.id, 4, 1_000)).resolves.toMatchObject({
      kind: 'turn_failed', actorPath: '/root/worker', turnId: followup.turn.turnId,
    });
    expect((await restarted.agents.tree(alpha.id)).actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/root', state: 'running' }),
      expect.objectContaining({ path: '/root/worker', state: 'idle' }),
    ]));
    await restarted.close();
  });

  it('starts a fork with a fresh Actor tree instead of inheriting the source lifecycle', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const source = await runtime.sessions.create({ sessionId: 'source', title: 'Source' });
    await runtime.agents.spawn(source.id, { taskName: 'scout', objective: 'Inspect.' });
    await runtime.agents.wait(source.id, 2, 1_000);

    const forked = await runtime.sessions.fork({
      sessionId: source.id,
      newSessionId: 'forked',
      title: 'Forked',
    });
    if (!forked) throw new Error('Expected session fork to succeed.');

    expect((await runtime.agents.tree(source.id)).actors.map((actor) => actor.path)).toContain('/root/scout');
    expect((await runtime.agents.tree(forked.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    await runtime.close();
  });

  it('rejects a distinct stale follow-up submitted against an idle Actor revision', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const session = await runtime.sessions.create({ sessionId: 'revision', title: 'Revision' });
    const initial = await runtime.agents.spawn(session.id, {
      taskName: 'worker',
      objective: 'Create a reusable Actor.',
    });
    await runtime.agents.wait(session.id, 2, 1_000);
    const idleRevision = (await runtime.agents.detail(session.id, initial.actorPath)).actor.revision;

    const accepted = runtime.agents.followup(
      session.id,
      initial.actorPath,
      'Accepted follow-up.',
      { expectedRevision: idleRevision },
    );
    const stale = runtime.agents.followup(
      session.id,
      initial.actorPath,
      'Distinct stale follow-up.',
      { expectedRevision: idleRevision },
    );

    await expect(accepted).resolves.toMatchObject({ delivery: 'started_turn' });
    await expect(stale).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: idleRevision,
      currentRevision: idleRevision + 1,
    });
    await runtime.close();
  });
});
