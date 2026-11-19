import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectMagpieCacheSource} from '../monitoring/magpie-cache-source.mjs';

const startMs = Date.parse('2020-11-19T00:00:00+08:00');
const endMs = startMs + 1800000;
const stamp = offset => new Date(startMs + offset).toISOString();
function proxy(overrides = {}) {
  return {t:stamp(100),status:200,route_id:'route',rid:'up-id',response_id:'response-id',provider:'provider',model:'requested',served:'served',
    in:100,cache_read:60,cache_write:10, ...overrides};
}
function turn(id, offset = 700, extra = {}) {
  return {ts:stamp(offset),kind:'turn_end',sessionId:'chat',payload:{requestId:id,...extra}};
}
function lines(rows) { return rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')+'\n'; }
async function files(t) {
  const dir = await mkdtemp(join(tmpdir(),'magpie-source-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const magpieDir = join(dir,'proxy'), traceDir = join(dir,'traces');
  await mkdir(magpieDir);
  await mkdir(join(traceDir,'chat'),{recursive:true});
  return {
    async usage(rows, name = 'usage.jsonl') {
      const text = lines(rows);
      await writeFile(join(magpieDir,name), name.endsWith('.gz') ? gzipSync(text) : text);
    },
    async corruptArchive() { await writeFile(join(magpieDir,'usage.2020-11-19.jsonl.gz'),'invalid gzip bytes'); },
    async trace(rows, id = 'chat') {
      await mkdir(join(traceDir,id),{recursive:true});
      await writeFile(join(traceDir,id,'events.jsonl'),lines(rows));
    },
    run: (options = {}) => collectMagpieCacheSource({magpieDir,traceDir,startMs,endMs,...options}),
  };
}

test('counts exact local upstream and response IDs once across rotated files and completion windows [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t), row = proxy({metadata:'private prompt',providerAccount:'private account'});
  await f.usage([row],'usage.jsonl.1.gz');
  await f.usage([proxy({rid:'different',response_id:'other',route_id:'unrelated'}),row,
    proxy({t:stamp(200),rid:undefined,response_id:'second',route_id:'two',cache_read:0,cache_write:0}),
    proxy({t:stamp(1800000),rid:'third',response_id:'third',route_id:'three'})]);
  await f.trace([turn('up-id'),turn('up-id'),turn('second',1804000),turn('third',1805000)]);
  const {records,coverage} = await f.run();
  assert.deepEqual(records,[{time:startMs+100,provider:'provider',model:'served',input:170,cached:60},
    {time:startMs+200,provider:'provider',model:'served',input:100,cached:0}]);
  assert.equal(coverage.matched,2);
  assert.equal(coverage.duplicates,1);
  assert.equal(coverage.duplicateTraceIds,1);
  assert.deepEqual(coverage.incompleteIntervals,[]);
  assert.doesNotMatch(JSON.stringify({records,coverage}),/private prompt|private account|up-id|response-id/);
});

test('missing explicit cache data and collisions only invalidate identifiable affected periods [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t);
  await f.usage([
    proxy({rid:'bad-cache',response_id:'bad-cache',cache_read:undefined}),
    proxy({t:stamp(1000),rid:'unknown-client',response_id:'unknown-client',cache_write:undefined}),
    proxy({t:stamp(2000),rid:'ambiguous',response_id:'a1',route_id:'a1'}),
    proxy({t:stamp(2100),rid:'ambiguous',response_id:'a2',route_id:'a2'}),
    proxy({t:stamp(3000),rid:'failed',response_id:'failed',status:502}),
    proxy({t:stamp(4000),rid:'empty',response_id:'empty',in:0,cache_read:0,cache_write:0}),
    proxy({t:stamp(5000),rid:'negative',response_id:'negative',cache_read:-10}),
    proxy({t:stamp(6000),rid:'bad-write',response_id:'bad-write',cache_write:undefined}),
  ]);
  await f.trace(['bad-cache','ambiguous','failed','empty','negative','bad-write'].map(id => turn(id)));
  const {records,coverage} = await f.run();
  assert.deepEqual(records,[]);
  assert.equal(coverage.matchedExcluded.invalidUsage,3);
  assert.equal(coverage.matchedExcluded.ambiguous,2);
  assert.equal(coverage.matchedExcluded.unsuccessful,1);
  assert.equal(coverage.matchedExcluded.zeroInput,1);
  const unavailable = offset => coverage.incompleteIntervals.some(gap => gap.startMs<=startMs+offset && startMs+offset<gap.endMs);
  assert.deepEqual([100,1000,2000,2100,3000,4000,5000,6000].map(unavailable),[true,false,true,true,false,false,true,true]);
});

test('distinguishes empty healthy logs from absent or malformed sources without leaking the offending line [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t);
  let result = await f.run();
  assert.equal(result.coverage.sourceAvailable,false);
  assert.ok(result.coverage.incompleteIntervals.length);
  await f.usage([]);await f.trace([]);
  result = await f.run();
  assert.equal(result.coverage.sourceAvailable,true);
  assert.deepEqual(result.coverage.incompleteIntervals,[]);
  await f.usage(['{"t":"'+stamp(250)+'","secret":"never-emit-this"']);
  result = await f.run();
  assert.ok(result.coverage.incompleteIntervals.some(gap => gap.startMs===startMs+250 && gap.endMs===startMs+251));
  assert.doesNotMatch(JSON.stringify(result),/never-emit-this/);
});

test('rejects one ID attributed to two sessions and fails closed on an unreadable compressed archive [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t);
  await f.usage([proxy()]);
  await f.trace([turn('response-id')]);
  await f.trace([turn('response-id',700,{privateBody:'not exposed'})],'other-chat');
  const shared = await f.run();
  assert.deepEqual(shared.records,[]);
  assert.equal(shared.coverage.matchedExcluded.ambiguous,1);
  assert.equal(shared.coverage.incompleteIntervals[0].startMs,startMs+100);
  await f.corruptArchive();
  const bad = await f.run();
  assert.equal(bad.coverage.sourceAvailable,false);
  assert.ok(bad.coverage.incompleteIntervals.some(interval => interval.reason === 'usageReadError'));
  assert.doesNotMatch(JSON.stringify(bad),/not exposed|invalid gzip bytes/);
});


test('live monitoring attributes long calls exactly once to the window in which the local turn finished [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t), usage = {inputTokens:170, cachedInputTokens:60, outputTokens:4};
  await f.usage([proxy({t:stamp(-3600000)}),proxy({t:stamp(120),rid:'late',response_id:'late',route_id:'late'})]);
  await f.trace([turn('up-id',400,{usage}),turn('up-id',1800300,{usage}),turn('late',1800400,{usage})]);
  const historic = await f.run();
  assert.deepEqual(historic.records.map(r=>r.time),[startMs+120]);
  assert.deepEqual(historic.coverage.incompleteIntervals,[]);
  const current = await f.run({timeBasis:'completed'});
  assert.deepEqual(current.records.map(r=>r.time),[startMs+400]);
  assert.deepEqual(current.coverage.incompleteIntervals,[]);
  const next = await f.run({timeBasis:'completed',startMs:endMs,endMs:endMs+1800000});
  assert.deepEqual(next.records.map(r=>r.time),[endMs+400]);
});

test('unattributed billable local turns mark only their completion window; terminal markers and explicit local adapters do not [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t), usage={inputTokens:9,outputTokens:1};
  await f.usage([proxy()]);
  await f.trace([turn('up-id',500,{usage}),turn('absent',700,{usage}),turn(undefined,800,{usage}),turn(undefined,900),
    turn(undefined,1000,{usage,servedBy:{adapter:'heuristic'}})]);
  for (const basis of ['start','completed']) {
    const result = await f.run({timeBasis:basis});
    assert.equal(result.records.length,1);
    assert.deepEqual(result.coverage.incompleteIntervals.map(x=>x.startMs),[startMs+700,startMs+800]);
    assert.equal(result.coverage.unattributedUsage.missingId,1);
    assert.equal(result.coverage.unattributedUsage.unmatchedId,1);
  }
});

test('a proxy-billed call without SDK usage stays in its first completion window exactly once [AC:magpie-cache-monitor#AC-1]', async t => {
  const f = await files(t);
  const usage = {inputTokens:170,outputTokens:4,cachedInputTokens:60};
  await f.usage([proxy({t:stamp(-3600000)})]);
  await f.trace([turn('up-id',100,{stopReason:'end'}),turn(undefined,150,{terminal:true,reason:'end'}),
    turn('up-id',1800200,{usage}),turn('not-in-proxy',400,{stopReason:'end'}),
    turn('unreported',600,{stopReason:'end'}),turn('unreported',700,{usage})]);
  const first = await f.run({timeBasis:'completed'});
  assert.deepEqual(first.records,[{time:startMs+100,provider:'provider',model:'served',input:170,cached:60}]);
  assert.deepEqual(first.coverage.incompleteIntervals,[{startMs:startMs+600,endMs:startMs+601,reason:'billableTraceUnmatched'}]);
  const next = await f.run({timeBasis:'completed',startMs:endMs,endMs:endMs+1800000});
  assert.deepEqual(next.records,[]);
  assert.deepEqual(next.coverage.incompleteIntervals,[]);
});
