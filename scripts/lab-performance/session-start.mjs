import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker, parentPort, workerData} from 'node:worker_threads';

const surfaces = ['chat', 'bot'];
const sampleCount = 5;
const desktopInstructions = 'The fixture desktop supports local observation.';
const answer = 'Fixture complete.';
const phaseTools = ['plan_fixture', 'read_fixture'];
const historyLength = 15;
const workloadTimeout = 90_000;

function phaseText(body) {
  const phase = body.input.at(-1);
  assert.equal(phase?.role, 'developer', 'missing trailing runtime phase');
  assert.match(phase.content[0]?.text, /^Session phase: \w+ \(\d+% confidence\)$/);
  return phase.content[0].text.split(' ')[2];
}

function requestSettings({input, stream, stream_options, metadata, ...settings}) {
  // Only the transport and request annotations vary independently of model input.
  return JSON.stringify(Object.keys(settings).sort().map(key => [key,settings[key]]));
}

function historyText(role, index) {
  return 'Fixture history ' + role + ' [' + index + '].';
}

function verifyHistory(body) {
  assert.ok(body.instructions?.length && body.tools?.length && body.prompt_cache_key?.length, 'missing model instructions, tools or prompt cache key');
  // The short seeded exchanges all fit the normal history budget. A consistently empty or clipped prefix is not a sample.
  const history = body.input.filter(item => item.role === 'user' || item.role === 'assistant');
  let previous = -1;
  for (let i = 0; i < historyLength; i++) {
    for (const role of ['user','assistant']) {
      const index = history.findIndex(item => item.role === role && JSON.stringify(item.content).includes(historyText(role,i)));
      assert.ok(index > previous, 'missing or reordered seeded history at '+role+' '+i);
      previous = index;
    }
  }
}

function prefixDrifts(requests) {
  assert.equal(requests?.length, phaseTools.length + 1, 'incomplete phase samples');
  verifyHistory(requests[0]);
  const phases = requests.map(phaseText);
  assert.ok(new Set(phases).size >= 2, 'no distinct natural session phases');
  let drifts = 0;
  for (let i = 1; i < requests.length; i++) {
    const before = requests[i - 1], after = requests[i];
    const history = before.input.slice(0, -1);
    assert.ok(history.length > 0, 'empty history sample');
    const call = after.input.find(item => item.type === 'function_call' && item.name === phaseTools[i - 1]);
    assert.ok(call && after.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id), 'missing tool call/result pair');
    const changed = requestSettings(before) !== requestSettings(after) ||
      JSON.stringify(history) !== JSON.stringify(after.input.slice(0, history.length));
    const misplaced = after.instructions.includes('Session phase:') ||
      after.input.slice(0,-1).some(item => item.role === 'developer' && JSON.stringify(item.content).includes('Session phase:'));
    if (changed || misplaced) drifts++;
  }
  return drifts;
}

export function sessionStartMetrics(rows, phaseRequests) {
  assert.equal(rows.length, sampleCount * surfaces.length, 'incomplete startup samples');
  const metrics = surfaces.map(surface => {
    const samples = rows.filter(row => row.surface === surface);
    assert.equal(samples.length, sampleCount, 'incorrect ' + surface + ' samples');
    assert.ok(samples.every(row => Number.isFinite(row.elapsed) && row.elapsed >= 0 && Number.isInteger(row.reconnects) && row.reconnects >= 0), 'invalid startup sample');
    const elapsed = samples.map(row => row.elapsed).sort((a,b) => a-b);
    return {name: surface + '_start_p50_ms', value: Math.round(elapsed[2] * 10) / 10};
  });
  metrics.push({name: 'warm_desktop_reconnects', value: rows.reduce((sum, row) => sum + row.reconnects, 0)});
  metrics.push({name: 'responses_prefix_drifts', value: surfaces.reduce((sum, surface) => sum + prefixDrifts(phaseRequests[surface]), 0)});
  return metrics;
}

function desktopFixture() {
  let connections = 0;
  return {
    count: () => connections,
    factory: async () => ({
      connect: async () => { connections++; },
      instructions: desktopInstructions,
      publicTools: () => [{name:'js', description:'Fixture desktop command', inputSchema:{type:'object'}}],
      call: async () => { throw Error('Unexpected desktop action in text-only workload'); },
      turnEnded: async () => {},
      close: async () => {},
    }),
  };
}

function modelOutput(toolName) {
  if (toolName) return {type:'function_call', id:'fixture_' + toolName, call_id:'call_' + toolName, name:toolName, arguments:'{}'};
  return {type:'message', role:'assistant', content:[{type:'output_text', text:answer}]};
}

async function modelEndpoint() {
  let turns = [], tools = [];
  const server = createServer(async (req, res) => {
    try {
      // Capture arrival before reading the body or producing the first model token.
      const at = performance.now();
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/responses');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const main = Boolean(body.tools?.length);
      const output = modelOutput(main ? tools[turns.length] : undefined);
      if (main) turns.push({at, body});
      const response = {status:'completed', output:[output]};
      if (!body.stream) {
        res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(response));
        return;
      }
      const event = output.type === 'function_call' ? {type:'response.output_item.done', item:output} : {type:'response.output_text.delta', delta:answer};
      const records = [event, {type:'response.completed', response}].map(item => 'data: ' + JSON.stringify(item) + '\n\n');
      res.writeHead(200, {'content-type':'text/event-stream'}).end(records.join('') + 'data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  await new Promise((resolve,reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    start(sequence = []) { turns = []; tools = sequence; },
    turns: () => turns,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function openBot(fixture, label) {
  const created = await fixture.call('alice', 'POST', '/api/bots', {name:label});
  assert.equal(created.status, 201);
  const opened = await fixture.call('alice', 'POST', '/api/bots/' + created.body.bot.id + '/open', {});
  assert.equal(opened.status, 200);
  return opened.body.session.id;
}

async function send(fixture, model, desktop, sid, sequence = []) {
  model.start(sequence);
  const before = desktop.count();
  const start = performance.now();
  const path = sid ? '/api/sessions/' + sid + '/stream' : '/api/chat/stream';
  const response = await fetch(fixture.url + path, {
    method:'POST', headers:fixture.headers, body:JSON.stringify({message:'Complete the local fixture check.'}), signal:AbortSignal.timeout(12000),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.doesNotMatch(stream, /^event: error$/m);
  assert.match(stream, /^event: result$/m);
  assert.ok(stream.includes(answer), 'missing fixture model answer');
  const turns = model.turns();
  assert.equal(turns.length, sequence.length + 1, 'missing or unexpected model request');
  for (const {body} of turns) {
    assert.ok(body.tools.some(tool => tool.name === 'lcu_js'), 'desktop tool missing on model wire');
    assert.ok(JSON.stringify(body).includes(desktopInstructions), 'desktop instructions missing on model wire');
  }
  return {elapsed:turns[0].at-start, reconnects:desktop.count()-before, requests:turns.map(turn => turn.body)};
}

async function phaseHistory(fixture, surface) {
  if (surface === 'bot') return openBot(fixture, 'Phase fixture bot');
  const result = await fixture.call('alice','POST','/api/sessions',{title:'Phase fixture chat',agentId:'general',autoRun:false});
  assert.equal(result.status, 201);
  return result.body.session.id;
}

async function measureSessions(dir) {
  const {boot} = await import('../test/helpers/bot-http-fixture.mjs');
  const {OpenAICompatibleAdapter} = await import('../../packages/core/dist/model/model-adapters.js');
  const model = await modelEndpoint(), desktop = desktopFixture();
  const origins = new Set([model.base]);
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = (resource, options) => {
    const url = new URL(resource instanceof Request ? resource.url : resource);
    assert.ok(origins.has(url.origin), 'unexpected non-fixture HTTP destination');
    return fetchLocal(resource, {...options,redirect:'error'});
  };
  let fixture;
  try {
    const modelAdapter = new OpenAICompatibleAdapter({model:'fixture', httpKind:'responses', baseUrl:model.base+'/v1', apiKey:'fixture', useJsonMode:false});
    const extraTools = phaseTools.map(name => ({name, description:'A deterministic local fixture tool', inputSchema:{type:'object',properties:{}}, approvalMode:'never', sideEffectLevel:'none', execute:async () => ({ok:true,content:'Fixture operation completed.'})}));
    fixture = await boot(false,{repoRoot:dir,stateDir:join(dir,'state'),modelAdapter,computerUseClientFactory:desktop.factory,extraTools});
    origins.add(fixture.url);
    fixture.runtime.store.setDaemonControl('computer_use_settings',{enabled:true,command:join(dir,'desktop-fixture')});
    fixture.runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
    await send(fixture,model,desktop);
    assert.equal(desktop.count(),1,'cold discovery must connect exactly once');
    await send(fixture,model,desktop,await openBot(fixture,'Warmup fixture bot'));
    assert.equal(desktop.count(),1,'first Bot must reuse the desktop discovery from ordinary chat');
    const rows = [], phases = {};
    for (let i=0; i<sampleCount; i++) {
      for (const surface of surfaces) {
        const connections = desktop.count();
        const sid = surface === 'bot' ? await openBot(fixture,'Timed fixture bot '+i) : undefined;
        const {elapsed} = await send(fixture,model,desktop,sid);
        rows.push({surface,elapsed,reconnects:desktop.count()-connections});
      }
    }
    for (const surface of surfaces) {
      const sid = await phaseHistory(fixture,surface);
      // An established conversation activates the product's normal episodic phase detector.
      for (let i=0; i<historyLength; i++) {
        for (const role of ['user','assistant']) fixture.runtime.store.appendMessage(sid,role,[{type:'text',text:historyText(role,i)}]);
      }
      const result = await send(fixture,model,desktop,sid,phaseTools);
      assert.equal(result.reconnects, 0, 'unexpected desktop connection during '+surface+' phase comparison');
      phases[surface] = result.requests;
    }
    return sessionStartMetrics(rows,phases);
  } finally {
    try { await fixture?.close(); } finally {
      await model.close();
      globalThis.fetch = fetchLocal;
    }
  }
}

// A worker isolates runtime environment, global fetch, and singleton caches from other gates.
export async function runSessionStart() {
  const dir = mkdtempSync(join(tmpdir(), 'lab-performance-sessions-'));
  let worker, deadline;
  try {
    const system = Object.fromEntries(['PATH','SystemRoot','TMPDIR','TEMP','TMP'].filter(key => process.env[key]).map(key => [key,process.env[key]]));
    worker = new Worker(new URL(import.meta.url), {
      workerData:{suite:'session-start', dir}, execArgv:[],
      env:{...system, RAW_AGENT_AGENTS_SKILLS:'0', RAW_AGENT_EXTERNAL_AI_TOOLS:'0', RAW_AGENT_MODEL_PROVIDER:'heuristic'},
    });
    return await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Timed out waiting for complete session samples')), workloadTimeout);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(Error('Incomplete session startup benchmark (exit '+code+')')));
    });
  } finally {
    clearTimeout(deadline);
    await worker?.terminate();
    rmSync(dir,{recursive:true,force:true});
  }
}

if (workerData?.suite === 'session-start' && parentPort) {
  parentPort.postMessage(await measureSessions(workerData.dir));
}
