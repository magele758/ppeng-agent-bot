import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionStartMetrics} from '../lab-performance/session-start.mjs';

function sample() {
  const rows = ['chat', 'bot'].flatMap(surface => Array.from({length: 5}, () => ({surface, elapsed: 25, reconnects: 0})));
  const history = Array.from({length:15},(_,i) => ['user','assistant'].map(role => ({
    role,content:'Fixture history '+role+' ['+i+'].',
  }))).flat();
  function body(phase) {
    return {model:'fixture', prompt_cache_key:'stable', tools:[{name:'read_fixture'}], instructions:'Stable instructions',
      input:[...history, {role:'developer',content:[{type:'input_text',text:'Session phase: '+phase+' (90% confidence)'}]}]};
  }
  function appendCall(name) {
    history.push({type:'function_call',name,arguments:'{}',call_id:name}, {type:'function_call_output',output:'done',call_id:name});
  }
  const start = body('exploration');
  appendCall('plan_fixture');
  const planning = body('planning');
  appendCall('read_fixture');
  const sequence = [start, planning, body('exploration')];
  return {rows, requests:{chat:sequence, bot:structuredClone(sequence)}};
}

function values(rows, requests) {
  return Object.fromEntries(sessionStartMetrics(rows,requests).map(({name,value})=>[name,value]));
}

test('requires complete warm samples and natural phase changes on both entry points [AC:lab-performance-regression-gate#AC-2]', () => {
  const {rows, requests} = sample();
  assert.deepEqual(values(rows,requests), {chat_start_p50_ms:25,bot_start_p50_ms:25,warm_desktop_reconnects:0,responses_prefix_drifts:0});
  assert.throws(() => values(rows.slice(1),requests), /sample/i);
  assert.throws(() => values(rows,{...requests,bot:requests.bot.slice(1)}), /phase sample/i);
  assert.throws(() => values(rows,{...requests,bot:Array(3).fill(requests.bot[0])}), /natural session phases/i);
  requests.bot[1].input = requests.bot[1].input.filter(item => item.type !== 'function_call_output');
  assert.throws(() => values(rows,requests), /tool call\/result pair/i);
});

test('reports slow starts, reconnections and rewritten history or request settings [AC:lab-performance-regression-gate#AC-2]', () => {
  const {rows, requests} = sample();
  for (const row of rows.filter(row => row.surface === 'bot')) {
    row.elapsed = 3000;
    row.reconnects = 1;
  }
  requests.bot[1].instructions += ' Session phase: debugging';
  requests.chat[2].input[0] = {role:'user',content:'Replacement'};
  assert.deepEqual(values(rows,requests), {chat_start_p50_ms:25,bot_start_p50_ms:3000,warm_desktop_reconnects:5,responses_prefix_drifts:3});
});


test('ignores transport annotations and detects missing history or cache routing [AC:lab-performance-regression-gate#AC-2]', () => {
  const {rows,requests} = sample();
  Object.assign(requests.chat[1], {stream:true,stream_options:{include_usage:true},metadata:{trace:'request-2'}});
  assert.equal(values(rows,requests).responses_prefix_drifts,0);
  requests.chat[2].prompt_cache_key = 'other';
  assert.equal(values(rows,requests).responses_prefix_drifts,1);
  for (const body of requests.bot) body.input.shift();
  assert.throws(() => values(rows,requests), /seeded history/);
});
