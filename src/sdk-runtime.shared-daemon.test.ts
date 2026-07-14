import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireKodaXInlineOwner,
  createKodaXRuntime,
  setKodaXRuntimeOwnerMode,
} from './sdk-runtime.js';
import { acquireRuntimeDaemonProcessLease } from './runtime-daemon/process.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

describe('F269 shared Runtime contracts', () => {
  it('uses revision CAS for session settings and never silently overwrites', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const session = await runtime.sessions.create({ title: 'CAS' });
    const initial = await runtime.sessions.getSettingsVersioned(session.id);

    const applied = await runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-a' },
      { expectedRevision: initial.revision },
    );

    expect(applied).toEqual({ revision: 1, value: { model: 'model-a' } });
    await expect(runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-b' },
      { expectedRevision: initial.revision },
    )).rejects.toMatchObject({ code: 'conflict' });
    await expect(runtime.sessions.getSettingsVersioned(session.id)).resolves.toEqual(applied);
    await runtime.close();
  });

  it('joins with an atomic snapshot cursor and emits each later event once', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const session = await runtime.sessions.create({ title: 'Observe' });
    const received: string[] = [];

    const observation = await runtime.sessions.observe(session.id, (event) => {
      received.push(event.id);
    });
    await runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-a' },
      { expectedRevision: observation.snapshot.settings.revision },
    );

    expect(observation.snapshot.runtimeId).toBe(runtime.identity.runtimeId);
    expect(observation.snapshot.session.id).toBe(session.id);
    expect(observation.snapshot.runs).toEqual([]);
    expect(observation.snapshot.pendingPermissions).toEqual([]);
    expect(received).toHaveLength(1);
    expect(new Set(received).size).toBe(received.length);
    expect((await runtime.events.replay({
      sessionId: session.id,
      sinceSeq: observation.snapshot.cursor,
    })).map((event) => event.id)).toEqual(received);

    observation.close();
    await runtime.close();
  });

  it('takes a session snapshot while unrelated sessions keep emitting events', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const target = await runtime.sessions.create({ title: 'Target' });
    const noisy = await runtime.sessions.create({ title: 'Noisy' });
    let churning = true;
    const churn = (async () => {
      while (churning) await runtime.sessions.load(noisy.id);
    })();

    try {
      const observation = await runtime.sessions.observe(target.id, () => undefined);
      expect(observation.snapshot.session.id).toBe(target.id);
      observation.close();
    } finally {
      churning = false;
      await churn;
      await runtime.close();
    }
  });

  it('fences daemon auto-start while explicit inline rollback owns the profile', async () => {
    const homeDir = makeHome();
    const policy = setKodaXRuntimeOwnerMode({
      homeDir,
      profile: 'coder',
      mode: 'inline',
      expectedRevision: 0,
    });
    const inline = acquireKodaXInlineOwner({ homeDir, profile: 'coder' });

    expect(policy.revision).toBe(1);
    expect(() => acquireKodaXInlineOwner({ homeDir, profile: 'coder' })).toThrow(/already has an owner/i);
    await expect(acquireRuntimeDaemonProcessLease({ homeDir, profile: 'coder' }))
      .rejects.toThrow(/inline rollback policy/i);

    inline.close();
    expect(setKodaXRuntimeOwnerMode({
      homeDir,
      profile: 'coder',
      mode: 'daemon',
      expectedRevision: 1,
    })).toMatchObject({ mode: 'daemon', revision: 2 });
  });

  it('keeps persistent permission grants under the single Runtime owner', async () => {
    const homeDir = makeHome();
    const runtime = await createKodaXRuntime({
      homeDir,
      profile: 'coder',
      sharedDaemonHost: true,
    });
    const decision = runtime.permissions.request({
      sessionId: 'session-grant',
      runId: 'run-grant',
      toolName: 'space_write',
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-grant' });
    if (!pending) throw new Error('expected permission request');
    expect(await runtime.permissions.respond(pending.id, {
      type: 'allow_always',
      scope: { sessionId: 'session-grant', toolName: 'space_write' },
    })).toBe(true);
    await expect(decision).resolves.toMatchObject({ type: 'allow_always' });
    await runtime.close();

    const reopened = await createKodaXRuntime({
      homeDir,
      profile: 'coder',
      sharedDaemonHost: true,
    });
    await expect(reopened.permissions.listGrants()).resolves.toMatchObject({
      revision: 1,
      value: [expect.objectContaining({
        scope: { sessionId: 'session-grant', toolName: 'space_write' },
      })],
    });
    await reopened.close();
  });
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-f269-runtime-'));
  homes.push(home);
  return home;
}
