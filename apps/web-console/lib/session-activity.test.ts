import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTabReturnWatch,
  forgetSessionActivity,
  noteLocalSending,
  noteSessionStatus,
  noteSessionStatuses,
  onSessionActivityChange,
  onTabVisibility,
  sessionBusy,
  sessionPollMs,
  sessionPollPace,
  sessionStamp,
  statusIsBusy
} from './session-activity.ts';

test('an idle session is read slowly, a running or approval-waiting one quickly [AC:lab-startup-request-load#AC-12]', () => {
  forgetSessionActivity();
  assert.equal(sessionPollMs('s1', 2000, 6000), 6000, 'unknown counts as idle');
  noteSessionStatus('s1', 'running');
  assert.equal(sessionPollMs('s1', 2000, 6000), 2000);
  noteSessionStatus('s1', 'waiting_approval');
  assert.equal(sessionPollMs('s1', 2000, 6000), 2000);
  noteSessionStatus('s1', 'idle');
  assert.equal(sessionPollMs('s1', 2000, 6000), 6000);
  assert.equal(statusIsBusy('completed'), false);
  assert.equal(statusIsBusy(undefined), false);
});

test('watchers are told when a session starts and stops, not on every report [AC:lab-startup-request-load#AC-12]', () => {
  forgetSessionActivity();
  let calls = 0;
  const stop = onSessionActivityChange('s1', () => { calls += 1; });
  noteSessionStatuses([{ id: 's1', status: 'idle' }, { id: 's2', status: 'running' }]);
  assert.equal(calls, 0);
  noteSessionStatus('s1', 'running');
  noteSessionStatus('s1', 'running');
  noteSessionStatus('s1', 'waiting_approval');
  assert.equal(calls, 1, 'start is reported once');
  noteSessionStatus('s1', undefined);
  assert.equal(sessionBusy('s1'), true, 'a report without a status changes nothing');
  noteSessionStatus('s1', 'idle');
  assert.equal(calls, 2, 'the end is reported so the last results are read');
  stop();
  noteSessionStatus('s1', 'running');
  assert.equal(calls, 2);
});

test('sending from this page marks the session busy before any status read [AC:lab-startup-request-load#AC-12]', () => {
  forgetSessionActivity();
  const pace = sessionPollPace('s1', 2000, 6000);
  let woke = 0;
  const stop = pace.wake(() => { woke += 1; });
  noteLocalSending(null, true);
  noteLocalSending('s1', false);
  assert.equal(pace.delayMs(), 6000);
  noteLocalSending('s1', true);
  assert.equal(pace.delayMs(), 2000);
  assert.equal(woke, 1);
  stop();
});

test('the open conversation is re-read on return only when its session moved while hidden [AC:lab-startup-request-load#AC-11]', async () => {
  forgetSessionActivity();
  noteSessionStatuses([{ id: 's1', status: 'idle', updatedAt: 't1' }]);
  const watch = createTabReturnWatch(() => sessionStamp('s1'));
  const calls: string[] = [];
  const refreshOverview = async () => { calls.push('overview'); };
  const refreshOpen = () => { calls.push('conversation'); };

  await onTabVisibility(true, watch, refreshOverview, refreshOpen);
  assert.deepEqual(calls, [], 'hiding the tab reads nothing');
  await onTabVisibility(false, watch, refreshOverview, refreshOpen);
  assert.deepEqual(calls, ['overview'], 'nothing happened meanwhile: the conversation is left alone');

  calls.length = 0;
  await onTabVisibility(true, watch, refreshOverview, refreshOpen);
  await onTabVisibility(false, watch, async () => {
    calls.push('overview');
    noteSessionStatuses([{ id: 's1', status: 'idle', updatedAt: 't2' }]);
  }, refreshOpen);
  assert.deepEqual(calls, ['overview', 'conversation'], 'a turn that ran unseen is picked up');

  calls.length = 0;
  await onTabVisibility(false, watch, refreshOverview, refreshOpen);
  assert.deepEqual(calls, ['overview'], 'a show without a preceding hide does not re-read the conversation');
  assert.equal(sessionStamp(null), '');
});
