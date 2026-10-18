import test from 'node:test';
import assert from 'node:assert/strict';
import { memberNeedsHuman, privateHandbackText, roomMetadataAfterHandOff, ROOM_HUMAN_STEP_NOTICE } from '../dist/rooms/human-step.js';
import { privateChatCanTakeHandOff } from '../dist/bots/bot-work.js';

test('only a parked member with a pending approval needs a person [AC:bot-rooms#AC-8]', () => {
  assert.equal(memberNeedsHuman({ status: 'waiting_approval' }, [{ status: 'pending' }]), true);
  assert.equal(memberNeedsHuman({ status: 'waiting_approval' }, [{ status: 'approved' }]), false);
  assert.equal(memberNeedsHuman({ status: 'idle' }, [{ status: 'pending' }]), false);
  assert.equal(memberNeedsHuman({ status: 'running' }, []), false);
});

test('the private note names the room and the room notice carries no step detail [AC:bot-rooms#AC-8]', () => {
  assert.match(privateHandbackText('  值班群 '), /值班群/);
  assert.match(privateHandbackText('   '), /群/);
  assert.equal(ROOM_HUMAN_STEP_NOTICE.includes('write_file'), false);
  assert.equal(ROOM_HUMAN_STEP_NOTICE.includes('token'), false);
});

test('handing off drops the room waiting latch so a private decision cannot resume it [AC:bot-rooms#AC-8]', () => {
  const next = roomMetadataAfterHandOff({ roomId: 'room-1', interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' }, botId: 'alpha', roomDelivery: { throughSeq: 4, extraSeqs: [] } });
  assert.equal(next.roomId, 'room-1');
  assert.equal(next.botId, 'alpha');
  assert.deepEqual(next.roomDelivery, { throughSeq: 4, extraSeqs: [] });
  assert.equal('interrupt' in next, false);
  assert.equal('outcome' in next, false);
});

test('a private chat takes a handed step unless it is busy or already waiting [AC:bot-rooms#AC-8]', () => {
  assert.equal(privateChatCanTakeHandOff({ status: 'idle' }), true);
  assert.equal(privateChatCanTakeHandOff({ status: 'completed' }), true);
  assert.equal(privateChatCanTakeHandOff({ status: 'failed' }), true);
  assert.equal(privateChatCanTakeHandOff({ status: 'cancelled' }), true);
  assert.equal(privateChatCanTakeHandOff({ status: 'unknown' }), true);
  assert.equal(privateChatCanTakeHandOff({ status: 'running' }), false);
  assert.equal(privateChatCanTakeHandOff({ status: 'waiting_approval' }), false);
  assert.equal(privateChatCanTakeHandOff(undefined), false);
});
