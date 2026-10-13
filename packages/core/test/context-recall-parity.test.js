import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import * as compiler from '../dist/session/context-compiler.js';
import { writeMemorySettings } from '../dist/memory/memory-settings.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'context-parity-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({ title: 'parity', agentId: 'general', mode: 'chat', metadata: { userId: 'owner', tenantId: 'team' } });
  return { dir, store, session };
}

test('preview and actual turn share hybrid recall, working log, settings and formatting [AC:context-reliability#AC-9]', async (t) => {
  const { dir, store, session } = fixture(t);
  writeMemorySettings(store, { embeddingRecallMode: 'on' });
  const am = store.agentMemory();
  am.set({ scope: 'session.long', namespace: 'default', sessionId: session.id, key: 'deploy', value: 'deploy lexical', importance: 0.9 });
  const semantic = am.set({ scope: 'session.long', namespace: 'default', sessionId: session.id, key: 'shipping', value: 'semantic evidence', importance: 0.1 });
  am.putEmbedding(semantic.id, [1, 0]);
  const logDir = join(dir, 'working-logs', session.id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'working-memory.md'), 'deploy source-log evidence\n');
  let calls = 0;
  const input = { store, session, query: 'deploy', stateDir: dir, embedQuery: async () => { calls++; return [1, 0]; } };
  const actual = await compiler.compileTurnAppendixAsync(input);
  assert.equal(calls, 1, 'real turn must request the configured query embedding');
  const pack = await compiler.previewContextPackAsync(input);
  assert.equal(actual, compiler.formatCompiledContextPack(pack));
  assert.match(actual, /source-log evidence/);
  assert.ok(actual.indexOf('shipping:') < actual.indexOf('deploy:'), 'semantic evidence must participate in turn recall');
});

test('unavailable semantic retrieval falls back and exposes the cause without losing lexical results [AC:context-reliability#AC-10]', async (t) => {
  const { store, session } = fixture(t);
  writeMemorySettings(store, { embeddingRecallMode: 'on' });
  store.agentMemory().set({ scope: 'session.long', namespace: 'default', sessionId: session.id, key: 'deploy', value: 'deployment evidence' });
  const diagnostics = [];
  const actual = await compiler.compileTurnAppendixAsync({ store, session, query: 'deploy', embedQuery: async () => { throw new Error('upstream unavailable'); }, onDiagnostic: (d) => diagnostics.push(d) });
  assert.match(actual, /deployment evidence/);
  assert.ok(diagnostics.some((d) => d.code === 'embedding_unavailable' && d.mode === 'lexical'));
  assert.equal(store.getSession(session.id).metadata.memoryRecallDiagnostics[0].code, 'embedding_unavailable');
  assert.doesNotMatch(JSON.stringify(store.getSession(session.id).metadata.memoryRecallDiagnostics), /upstream unavailable/);
});

test('compiler disabled settings apply equally to preview and actual [AC:context-reliability#AC-9]', async (t) => {
  const { store, session } = fixture(t);
  writeMemorySettings(store, { compilerEnabled: false });
  const input = { store, session, query: 'deploy', sources: { userProfile: '', core: '', working: 'private note', workingFile: '' } };
  const pack = await compiler.previewContextPackAsync(input);
  assert.equal(pack.sections.length, 0);
  assert.equal(await compiler.compileTurnAppendixAsync(input), '');
});
