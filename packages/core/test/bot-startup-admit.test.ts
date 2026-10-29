import assert from 'node:assert/strict';
import test from 'node:test';
import { admitStartupEvent, emitAdmitPhase, type AdmitStartupEvent } from '../src/observability/admit-trace.ts';

const USER_TEXT = 'admit-secret-user-text-91c4';

test('goal_intake and assemble_loop are separate startup phases [AC:bot-startup-trace#AC-6]', () => {
  const events: AdmitStartupEvent[] = [];
  const started = Date.now();
  emitAdmitPhase((event) => events.push(event), 'goal_intake', started);
  emitAdmitPhase((event) => events.push(event), 'assemble_loop', started);
  assert.equal(events.length, 2);
  assert.notEqual(events[0], events[1]);
  assert.equal(events[0]?.payload.phase, 'goal_intake');
  assert.equal(events[1]?.payload.phase, 'assemble_loop');
  assert.equal(events[0]?.payload.scope, 'admit');
  assert.equal(events[1]?.payload.scope, 'admit');
  assert.equal(typeof events[0]?.payload.durationMs, 'number');
  assert.equal(typeof events[1]?.payload.durationMs, 'number');
  assert.ok((events[0]?.payload.durationMs ?? -1) >= 0);
  assert.ok((events[1]?.payload.durationMs ?? -1) >= 0);
  assert.equal(JSON.stringify(events).includes(USER_TEXT), false);
  for (const event of events) {
    assert.deepEqual(Object.keys(event.payload).sort(), ['durationMs', 'phase', 'scope']);
  }
  assert.equal(admitStartupEvent('goal_intake', 3).payload.durationMs, 3);
  assert.doesNotThrow(() => {
    emitAdmitPhase(() => {
      throw new Error(USER_TEXT);
    }, 'assemble_loop', started);
  });
});
