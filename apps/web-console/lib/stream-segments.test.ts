import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackToCheckpoint, streamCheckpoint, type StreamSegment } from './stream-segments.ts';

test('rollback drops segments added after the checkpoint and restores merged text [AC:upstream-resilience#AC-3]', () => {
  const segments: StreamSegment[] = [
    { kind: 'tool', id: 's-1', toolCallId: 'c1', name: 'read_file', args: '{}' },
    { kind: 'text', id: 's-2', raw: 'turn one', html: '<p>turn one</p>' }
  ];
  const cp = streamCheckpoint(segments);
  const last = segments[1] as Extract<StreamSegment, { kind: 'text' }>;
  last.raw += ' PARTIAL';
  segments.push({ kind: 'reasoning', id: 's-3', text: 'thinking' });

  rollbackToCheckpoint(segments, cp);

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[1], { kind: 'text', id: 's-2', raw: 'turn one', html: '<p>turn one</p>' });
});

test('rollback to an empty checkpoint clears the stream; a2ui envelopes are not shared', () => {
  const segments: StreamSegment[] = [];
  const empty = streamCheckpoint(segments);
  segments.push({ kind: 'a2ui', id: 's-1', surfaceId: 'x', catalogId: 'c', envelopes: [1] });
  const cp = streamCheckpoint(segments);
  (segments[0] as Extract<StreamSegment, { kind: 'a2ui' }>).envelopes.push(2);

  rollbackToCheckpoint(segments, cp);
  assert.deepEqual((segments[0] as Extract<StreamSegment, { kind: 'a2ui' }>).envelopes, [1]);

  rollbackToCheckpoint(segments, empty);
  assert.deepEqual(segments, []);
});

test('saved message identity closes a shot without swallowing the next identical answer [AC:night-runtime-reliability#AC-2]', async () => {
  const {markStreamSaved,streamTailCanMerge}=await import('./stream-segments.ts');
  const segments:StreamSegment[]=[{kind:'text',id:'s1',raw:'same',html:'same'},{kind:'reasoning',id:'s2',text:'thinking'}];
  markStreamSaved(segments,'a1');
  assert.equal(streamTailCanMerge(segments.at(-1),'reasoning'),false);
  segments.push({kind:'text',id:'s3',raw:'same',html:'same'});
  assert.equal(streamTailCanMerge(segments.at(-1),'text'),true);
  const checkpoint=streamCheckpoint(segments);
  segments.push({kind:'text',id:'failed',raw:'discard',html:'discard'});
  rollbackToCheckpoint(segments,checkpoint);
  assert.deepEqual(segments.map(s=>s.id),['s1','s2','s3']);
});

test('a reconnect knows durable identity before its first shot and done is not a commit [AC:night-runtime-reliability#AC-2]',async()=>{
 const {streamSupportsSavedIdentity,checkpointAfterModelDone,pendingStreamIdentity}=await import('./stream-segments.ts');
 assert.equal(streamSupportsSavedIdentity('ready',{durableAssistantIds:true}),true);
 assert.equal(streamSupportsSavedIdentity('model',{durableAssistantIds:true}),false);
 const segments:StreamSegment[]=[];
 const committed=streamCheckpoint(segments);
 segments.push({kind:'text',id:'attempt',raw:'same',html:'same',...pendingStreamIdentity(true)});
 assert.equal(checkpointAfterModelDone(segments,committed,true),committed);
 assert.equal(checkpointAfterModelDone(segments,committed,false).count,1);
 rollbackToCheckpoint(segments,checkpointAfterModelDone(segments,committed,true));
 assert.deepEqual(segments,[]);
});
