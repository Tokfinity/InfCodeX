import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RuntimeControlJournalError,
  createRuntimeControlJournal,
} from './control-journal.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('runtime control journal', () => {
  it('persists one applied result and returns it without repeating the effect', async () => {
    const rootDir = makeRoot();
    const first = createRuntimeControlJournal({ rootDir });
    let calls = 0;

    const result = await first.execute(operation(first.journalEpoch), {}, async () => {
      calls += 1;
      return { runId: 'run-1' };
    });
    const reopened = createRuntimeControlJournal({ rootDir });
    const replayed = await reopened.execute(operation(reopened.journalEpoch), {}, async () => {
      calls += 1;
      return { runId: 'run-2' };
    });

    expect(result).toEqual({ runId: 'run-1' });
    expect(replayed).toEqual(result);
    expect(calls).toBe(1);
    expect(reopened.get('op-1')).toMatchObject({
      operationId: 'op-1',
      state: 'applied',
      method: 'run.start',
    });
  });

  it('rejects operation id reuse with a different request or principal', async () => {
    const journal = createRuntimeControlJournal({ rootDir: makeRoot() });
    await journal.execute(operation(journal.journalEpoch), {}, async () => ({ ok: true }));

    await expect(journal.execute({
      ...operation(journal.journalEpoch),
      principalId: 'client-b',
    }, {}, async () => ({ ok: false }))).rejects.toMatchObject({
      code: 'operation_id_reuse',
    });
    await expect(journal.execute({
      ...operation(journal.journalEpoch),
      params: { sessionId: 'session-2' },
    }, {}, async () => ({ ok: false }))).rejects.toMatchObject({
      code: 'operation_id_reuse',
    });
  });

  it('rejects an operation from an old journal epoch', async () => {
    const journal = createRuntimeControlJournal({ rootDir: makeRoot() });

    await expect(journal.execute(operation('old-epoch'), {}, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: 'operation_epoch_mismatch' });
  });

  it('quarantines corrupt control history instead of accepting new effects', async () => {
    const rootDir = makeRoot();
    const journal = createRuntimeControlJournal({ rootDir });
    await journal.execute(operation(journal.journalEpoch), {}, async () => ({ ok: true }));
    fs.appendFileSync(path.join(rootDir, 'control.jsonl'), '{broken\n', 'utf8');

    const reopened = createRuntimeControlJournal({ rootDir });

    expect(reopened.health).toBe('control_history_untrusted');
    await expect(reopened.execute({
      ...operation(reopened.journalEpoch),
      operationId: 'op-2',
    }, {}, async () => ({ ok: true }))).rejects.toBeInstanceOf(RuntimeControlJournalError);
    await expect(reopened.execute({
      ...operation(reopened.journalEpoch),
      operationId: 'op-2',
    }, {}, async () => ({ ok: true }))).rejects.toMatchObject({
      code: 'control_history_untrusted',
    });
  });

  it('opens corrupt journal metadata as queryable read-only health without overwriting it', async () => {
    const rootDir = makeRoot();
    fs.writeFileSync(path.join(rootDir, 'journal-meta.json'), '{broken-meta', 'utf8');

    const journal = createRuntimeControlJournal({ rootDir });

    expect(journal.health).toBe('control_history_untrusted');
    expect(journal.journalEpoch).toMatch(/^je_/);
    expect(fs.readFileSync(path.join(rootDir, 'journal-meta.json'), 'utf8')).toBe('{broken-meta');
    await expect(journal.execute(operation(journal.journalEpoch), {}, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: 'control_history_untrusted' });
  });

  it('recovers accepted and dispatched records without replaying them', async () => {
    const rootDir = makeRoot();
    const journal = createRuntimeControlJournal({ rootDir });
    fs.appendFileSync(path.join(rootDir, 'control.jsonl'), `${JSON.stringify({
      type: 'operation',
      operationId: 'op-accepted',
      journalEpoch: journal.journalEpoch,
      principalId: 'client-a',
      method: 'run.start',
      requestDigest: 'digest-a',
      state: 'accepted',
      updatedAt: new Date().toISOString(),
    })}\n${JSON.stringify({
      type: 'operation',
      operationId: 'op-dispatched',
      journalEpoch: journal.journalEpoch,
      principalId: 'client-a',
      method: 'run.start',
      requestDigest: 'digest-b',
      state: 'dispatched',
      updatedAt: new Date().toISOString(),
    })}\n`, 'utf8');

    const reopened = createRuntimeControlJournal({ rootDir });

    expect(reopened.get('op-accepted')?.state).toBe('interrupted');
    expect(reopened.get('op-dispatched')?.state).toBe('unknown');
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-control-journal-'));
  roots.push(root);
  return root;
}

function operation(journalEpoch: string) {
  return {
    operationId: 'op-1',
    journalEpoch,
    principalId: 'client-a',
    method: 'run.start',
    params: { sessionId: 'session-1' },
  } as const;
}
