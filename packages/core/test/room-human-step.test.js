import test from 'node:test';
import assert from 'node:assert/strict';
import { memberNeedsHuman, privateHandbackText, roomMetadataAfterHandOff, ROOM_HUMAN_STEP_NOTICE } from '../dist/rooms/human-step.js';

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
  const next = roomMetadataAfterHandOff({ roomId: 'room-1', interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' }, botId: 'alpha' });
  assert.equal(next.roomId, 'room-1');
  assert.equal(next.botId, 'alpha');
  assert.equal('interrupt' in next, false);
  assert.equal('outcome' in next, false);
});
