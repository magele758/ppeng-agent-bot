import assert from 'node:assert/strict';
import test from 'node:test';
import { grokReplicaId, readGrokHistory } from './grok-history.ts';

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
function filename(key: string) {
  const bits = Array.from(Buffer.from(key), byte => byte.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{1,5}/g)!.map(group => alphabet[parseInt(group.padEnd(5, '0'), 2)]).join('') + '.blob';
}
const id = '12345678-aaaa-bbbb-cccc-0123456789ab';
test('recognizes only transcript replicas [AC:grok-local-history#AC-1]', () => {
  assert.equal(grokReplicaId(filename('sand.client.slice.account.test.transcript.replicas.' + id)), id);
  assert.equal(grokReplicaId(filename('sand.client.slice.account.test.roster.last-roster')), null);
});
test('reads both text entry formats in recorded order [AC:grok-local-history#AC-2]', () => {
  const rows = readGrokHistory({ schemaVersion: 1, value: {entries: [
    {kind:'message', role:'user', content:'question', seq:3},
    {kind:'event', seq:4},
    {kind:'send-message', message:{type:'text',content:'reply'}, seq:5},
  ]}});
  assert.deepEqual(rows.map(row => [row.role,row.text]), [['user','question'],['assistant','reply']]);
});
test('distinguishes empty and invalid transcripts [AC:grok-local-history#AC-3]', () => {
  assert.deepEqual(readGrokHistory({schemaVersion:1,value:{entries:[]}}), []);
  assert.throws(() => readGrokHistory({value:{}}));
});
