import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createMemorySurfaceStore } from '../dist/session/surface-store.js';
import { WriterClaimError } from '../dist/session/writer-claim.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'writer-'));
  return new SqliteStateStore(join(dir, 'runtime.sqlite'));
}

function sessionOf(store) {
  store.upsertAgent({
    id: 'general',
    name: 'General',
    role: 'assistant',
    instructions: 'x',
    capabilities: []
  });
  return store.createSession({ title: 'writer', mode: 'chat', agentId: 'general' });
}

test('empty writer claim: append without expected id still works (legacy)', () => {
  const store = tmpStore();
  const session = sessionOf(store);
  assert.equal(store.getSession(session.id).activeWriterRunId, undefined);
  const msg = store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
  assert.equal(msg.seq, 1);
  store.db.close();
});

test('claimed writer: matching expected/bound appends; expired run is rejected', () => {
  const store = tmpStore();
  const session = sessionOf(store);
  store.claimWriter(session.id, 'run_a');
  assert.equal(store.getSession(session.id).activeWriterRunId, 'run_a');

  const ok = store.appendMessage(session.id, 'user', [{ type: 'text', text: 'from-a' }], {
    expectedWriterRunId: 'run_a'
  });
  assert.equal(ok.parts[0].text, 'from-a');

  assert.throws(
    () =>
      store.appendMessage(session.id, 'user', [{ type: 'text', text: 'stale' }], {
        expectedWriterRunId: 'run_old'
      }),
    (err) => err instanceof WriterClaimError && err.code === 'WRITER_CLAIM_MISMATCH'
  );

  assert.throws(() => store.claimWriter(session.id, 'run_b'), WriterClaimError);
  store.releaseWriter(session.id, 'run_a');
  store.claimWriter(session.id, 'run_b');
  assert.throws(
    () =>
      store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'from-a-again' }], {
        expectedWriterRunId: 'run_a'
      }),
    WriterClaimError
  );
  const fromB = store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'from-b' }], {
    expectedWriterRunId: 'run_b'
  });
  assert.equal(fromB.parts[0].text, 'from-b');

  store.releaseWriter(session.id, 'run_b');
  assert.equal(store.getSession(session.id).activeWriterRunId, undefined);
  store.db.close();
});

test('MemorySurfaceStore writer claim matches SQLite semantics', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'mem', mode: 'chat', agentId: 'general' });
  store.claimWriter(session.id, 'run_m');
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'ok' }], {
    expectedWriterRunId: 'run_m'
  });
  assert.throws(
    () =>
      store.appendMessage(session.id, 'user', [{ type: 'text', text: 'nope' }], {
        expectedWriterRunId: 'other'
      }),
    WriterClaimError
  );
});

test('expired async generation cannot write into an empty or successor claim [AC:session-multiprocess-state-consistency#AC-2]', async () => {
  const store = tmpStore(), session = sessionOf(store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    store.claimWriter(session.id, 'old');
    const old = store.runWithWriter(session.id, 'old', async () => {
      await gate;
      assert.throws(() => store.updateSession(session.id, { status: 'failed' }), WriterClaimError);
      assert.throws(() => store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'late' }]), WriterClaimError);
    });
    store.releaseWriter(session.id, 'old');
    store.claimWriter(session.id, 'new');
    store.updateSession(session.id, { status: 'running' });
    release(); await old;
    assert.equal(store.getSession(session.id).status, 'running');
    assert.equal(store.getSession(session.id).activeWriterRunId, 'new');
    assert.equal(store.listMessages(session.id).length, 0);
    store.releaseWriter(session.id, 'new');
    await store.runWithWriter(session.id, 'old', async () => {
      assert.throws(() => store.updateSession(session.id, { status: 'failed' }), WriterClaimError);
    });
    for (const surface of [store, createMemorySurfaceStore()]) {
      const id = surface === store ? session.id : surface.createSession({ title: 'empty', mode: 'chat', agentId: 'general' }).id;
      assert.throws(() => surface.appendMessage(id, 'assistant', [{type:'text',text:'expired'}], {expectedWriterRunId:'old'}), WriterClaimError);
      surface.appendMessage(id, 'user', [{type:'text',text:'legacy without explicit generation'}]);
    }
  } finally { store.db.close(); }
});

test('closing a store releases only its own OS-held writer handle [AC:session-multiprocess-state-consistency#AC-1]', () => {
  const first=tmpStore(), session=sessionOf(first), second=new SqliteStateStore(first.dbPath);
  try {
    first.claimWriter(session.id,'first');
    assert.throws(()=>second.claimWriter(session.id,'second'),WriterClaimError);
    first.db.close();
    second.claimWriter(session.id,'second');
    assert.equal(second.getSession(session.id).activeWriterRunId,'second');
    second.releaseWriter(session.id,'first');
    assert.equal(second.getSession(session.id).activeWriterRunId,'second');
  } finally { if(first.db.isOpen)first.db.close();second.db.close(); }
});
