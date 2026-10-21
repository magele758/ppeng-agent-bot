import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotWorkStates, parseBotWorkOverview } from './bot-work-state.ts';

test('Bot snapshots use execution counts instead of queued tasks and reject malformed active values', () => {
  assert.deepEqual(parseBotWorkStates({bots:[
    {bot:{id:'working'},activeWorkCount:2},
    {bot:{id:'queued'},status:'running',taskCounts:{queued:10},activeWorkCount:0},
    {bot:{id:'invalid'},activeWorkCount:-1},
    {bot:{id:'fraction'},activeWorkCount:0.5},
    {bot:{id:'bad'},activeWorkCount:'1'},
    null
  ]}),{working:2});
  assert.deepEqual(parseBotWorkStates({bots:[{bot:{id:'working'},activeWorkCount:0}]}),{});
  assert.deepEqual(parseBotWorkStates(null),{});
});

test('Bot summary preserves concurrent executing, queued and human-blocked work [AC:bot-product-p0#AC-2]', () => {
  const overview = parseBotWorkOverview({ bots: [{ bot: { id: 'worker' }, activeWorkCount: 2, pending: 3,
    status: 'waiting_approval', taskCounts: { unknown: 1, waiting_approval: 2 } }] });
  assert.deepEqual(overview.worker, { running: 2, queued: 3, waiting: 2, unknown: 1 });
  assert.deepEqual(parseBotWorkOverview({ bots: [null, { bot: { id: 'x' }, pending: -3 }] }).x,
    { running: 0, queued: 0, waiting: 0, unknown: 0 });
});
