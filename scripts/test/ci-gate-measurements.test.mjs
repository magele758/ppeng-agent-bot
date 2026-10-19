import test from 'node:test';
import assert from 'node:assert/strict';
const implementation=await import('../ci/gate-measurements.mjs').catch(()=>({}));
const fixture=()=>({run:{id:123,status:'completed',conclusion:'success',created_at:'2026-10-20T00:00:00Z',run_attempt:1},jobs:[{name:'Release gate / Main release gate',conclusion:'success',started_at:'2026-10-20T00:00:10Z',completed_at:'2026-10-20T00:01:50Z'},{name:'Release gate / work',conclusion:'success',started_at:'2026-10-20T00:00:20Z',completed_at:'2026-10-20T00:01:40Z'}],provenance:{schema:1,candidate:'tree',node:'v22',environment:'image',scope:['unit'],runId:'123',attempt:'1'}});
test('measured wall time, initial queue and total job compute use actual job timestamps [AC:ci-gate-speedup#AC-9]',()=>{
  assert.equal(typeof implementation.measureRun,'function');
  const r=implementation.measureRun(fixture());
  assert.equal(r.queueSeconds,10);assert.equal(r.executionSeconds,100);assert.equal(r.computeSeconds,180);
});
test('unfinished runs, reruns and mismatched provenance cannot support a speedup claim [AC:ci-gate-speedup#AC-9]',()=>{
  assert.equal(typeof implementation.measureRun,'function');
  for(const change of [{run:{...fixture().run,status:'in_progress'}},{run:{...fixture().run,run_attempt:2}},{provenance:{...fixture().provenance,runId:'999'}}])assert.throws(()=>implementation.measureRun({...fixture(),...change}));
});
test('the first-pass denominator retains failed attempts rather than selecting only green samples [AC:ci-gate-speedup#AC-9]',()=>{
  const failed=fixture();failed.run.conclusion='failure';failed.jobs[0].conclusion='failure';
  const row=implementation.measureRun(failed);
  assert.equal(row.firstPass,false);assert.equal(row.complete,false);
  const retried={...fixture(),cleanUnit:false};
  assert.equal(implementation.measureRun(retried).firstPass,false);
});
test('all supplied attempt IDs are unique before filtering failed samples [AC:ci-gate-speedup#AC-9]',()=>{
  assert.equal(typeof implementation.validateAttemptIds,'function');
  assert.throws(()=>implementation.validateAttemptIds(['1','1'],['2']));
  assert.throws(()=>implementation.validateAttemptIds(['1'],['1','2']));
  assert.doesNotThrow(()=>implementation.validateAttemptIds(['1','2','3'],['4','5','6']));
});
