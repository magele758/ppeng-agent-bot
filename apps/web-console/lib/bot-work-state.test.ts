import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotWorkStates } from './bot-work-state.ts';

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
