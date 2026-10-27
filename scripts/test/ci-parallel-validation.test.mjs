import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'yaml';
import {releaseFailures} from '../ci/release-results.mjs';
const workflow=name=>parse(readFileSync(`.github/workflows/${name}.yml`,'utf8'));
const library=()=>import('../ci/validation-artifacts.mjs');
const partition=()=>import('../ci/test-partition.mjs');

test('full lanes start independently and required failures cannot disappear [AC:ci-parallel-validation#AC-2] [AC:ci-parallel-validation#AC-7]',()=>{
  const {jobs}=workflow('release-gate');
  for(const lane of ['unit','formal','sdk']) {
    assert.ok(jobs[lane],`missing independent ${lane} lane`);
    assert.equal(jobs[lane].needs,undefined);
    assert.notEqual(jobs[lane]['continue-on-error'],true);
    assert.ok(jobs.gate.needs.includes(lane));
    for(const result of ['failure','cancelled','skipped',undefined])assert.ok(releaseFailures({[lane]:{result}}).includes(lane));
  }
});

test('new formal imports and all existing tests get one owner; unsupported commands fail closed [AC:ci-parallel-validation#AC-3] [AC:ci-parallel-validation#AC-4]',async()=>{
  const {partitionTests,discoverTests}=await partition();
  const files=['a.test.mjs','b.test.mjs','new.test.mjs'];
  const source={'a.test.mjs':'import x from "../formal/verifier.mjs";', 'b.test.mjs':`const text='import x from "../formal/fixture.mjs"';`,'new.test.mjs':'const lib=()=>import("../formal/new.mjs");'};
  const p=partitionTests(files,f=>source[f]);
  assert.deepEqual(p.formal,['a.test.mjs','new.test.mjs']);assert.deepEqual(p.unit,['b.test.mjs']);
  assert.throws(()=>partitionTests(['a.test.mjs','a.test.mjs'],f=>source[f]),/duplicate/i);
  assert.throws(()=>discoverTests({root:process.cwd(),command:'pnpm run something'}),/node|unsupported/i);
  const actual=discoverTests();assert.ok(actual.unit.length>400);assert.ok(actual.formal.includes('scripts/test/session-multiprocess-concurrency-verification.test.mjs'));
  assert.equal(new Set([...actual.unit,...actual.formal]).size,actual.unit.length+actual.formal.length);
});

async function fixtures(fn){
  const lib=await library();const root=mkdtempSync(join(tmpdir(),'validation-bundles-'));
  const identity={candidate:'abc',tree:'tree',runId:'run-1',attempt:'1',inputs:'hash',root:'/repo',node:'22',platform:'linux',arch:'x64'};
  const expected={unit:['unit.test.js'],formal:['formal.test.js'],sdk:['sdk.test.ts']};
  try{
    for(const lane of ['unit','formal','sdk']){
      const dir=join(root,lane);mkdirSync(join(dir,'results'),{recursive:true});
      writeFileSync(join(dir,'results',`${lane}.xml`),'<testsuites><testsuite tests="1" failures="0"><testcase name="ok"/></testsuite></testsuites>');
      mkdirSync(join(dir,lane==='sdk'?'vitest':'node'),{recursive:true});
      if(lane!=='sdk'){mkdirSync(join(dir,'flaky'));writeFileSync(join(dir,'flaky',`${lane}.json`),JSON.stringify({pass:true,firstExitCode:0,flaky:[],failed:[]}));}
      writeFileSync(join(dir,lane==='sdk'?'vitest/coverage-final.json':'node/coverage.json'),JSON.stringify(lane==='sdk'?{'/repo/src/a.ts':{s:{0:1}}}:{result:[{url:'file:///repo/dist/a.js',functions:[]}]}));
      lib.writeBundle({directory:dir,lane,identity,inventory:expected[lane],elapsedSeconds:1});
    }
    await fn({lib,root,identity,expected});
  }finally{rmSync(root,{recursive:true,force:true});}
}

test('coverage lanes still produce reusable bundles without a blocking complexity job [AC:ci-parallel-validation#AC-5] [AC:ci-parallel-validation#AC-8] [AC:drop-blocking-crap#AC-2]',()=>fixtures(({lib,root,identity,expected})=>{
  const bundles=lib.readBundles({directory:root,identity,expected});assert.deepEqual(Object.keys(bundles).sort(),['formal','sdk','unit']);
  assert.equal(workflow('release-gate').jobs.crap, undefined);
}));

test('wrong candidate, attempt, inputs, omitted lane and corrupted evidence are rejected [AC:ci-parallel-validation#AC-6]',()=>fixtures(({lib,root,identity,expected})=>{
  for(const key of ['candidate','tree','runId','attempt','inputs','node','root'])assert.throws(()=>lib.readBundles({directory:root,identity:{...identity,[key]:'wrong'},expected}),/identity|inputs|mismatch/i);
  assert.throws(()=>lib.readBundles({directory:root,identity,expected:{...expected,unit:['missing.test.js']}}),/inventory|scope/i);
  const file=join(root,'formal','node','coverage.json');writeFileSync(file,'{}');
  assert.throws(()=>lib.readBundles({directory:root,identity,expected}),/integrity|digest/i);
}));

test('missing coverage and overlapping inventories cannot produce a green aggregate [AC:ci-parallel-validation#AC-3] [AC:ci-parallel-validation#AC-6] [AC:ci-parallel-validation#AC-8]',()=>fixtures(({lib,root,identity,expected})=>{
  assert.throws(()=>lib.readBundles({directory:root,identity,expected:{...expected,formal:expected.unit}}),/inventory|scope|overlap/i);
  rmSync(join(root,'sdk'),{recursive:true});assert.throws(()=>lib.readBundles({directory:root,identity,expected}),/missing|ENOENT/i);
}));

test('full scope, baselines, two-hour cadence and release artifact requirements remain [AC:ci-parallel-validation#AC-1] [AC:ci-parallel-validation#AC-11] [AC:ci-parallel-validation#AC-13]',()=>{
  assert.equal(workflow('full-validation').on.schedule[0].cron,'17 */2 * * *');
  const ci=workflow('ci');assert.match(ci.jobs['release-gate'].if,/workflow_dispatch/);
  const jobs=workflow('release-gate').jobs;for(const name of ['tests','browser','acceptance','mutation','secrets-gate','unit','formal','sdk'])assert.ok(jobs.gate.needs.includes(name));assert.equal(jobs.gate.needs.includes('crap'), false);
  assert.ok(jobs.mutation.uses.includes('mutation.yml'));
  for(const name of ['publish-npm','docker-nightly'])assert.equal(workflow(name).jobs['release-gate'].uses,'./.github/workflows/release-gate.yml');
  const onsite=parse(readFileSync('acceptance/multi-machine-production-readiness.yaml','utf8'));
  assert.equal(onsite.criteria.length,40);
});

test('Quick keeps the whole-job two-minute limit and adds cheap storage/fork regression [AC:ci-parallel-validation#AC-9] [AC:ci-parallel-validation#AC-10]',()=>{
  const job=workflow('ci').jobs.quick;assert.equal(job['timeout-minutes'],2);assert.notEqual(job['continue-on-error'],true);
  const source=readFileSync('scripts/ci/quick-gate.mjs','utf8');for(const file of ['domain-stores.test.js','session-fork.test.js','bot-reply-quote.test.js'])assert.ok(source.includes(file),`missing ${file}`);
  assert.match(source,/budgetMs=90000/);assert.match(source,/process.exitCode=1/);
});

test('every bundle reports elapsed execution, revision and attempt without summing lanes [AC:ci-parallel-validation#AC-12]',()=>fixtures(({lib,root,identity,expected})=>{
  const bundles=lib.readBundles({directory:root,identity,expected});
  for(const [lane,b]of Object.entries(bundles)){assert.deepEqual(b.identity,identity);assert.equal(b.elapsedSeconds,1);assert.equal(b.lane,lane);}
}));

test('verified merge preserves both V8 producers and SDK data, and refuses stale destination [AC:ci-parallel-validation#AC-5] [AC:ci-parallel-validation#AC-6]',()=>fixtures(({lib,root,identity,expected})=>{
  const output=join(root,'merged');lib.prepareCoverage({directory:root,output,identity,expected});
  assert.match(readFileSync(join(output,'node/unit-coverage.json'),'utf8'),/file:\/\/\/repo\/dist/);
  assert.equal(readFileSync(join(output,'node/formal-coverage.json'),'utf8'),readFileSync(join(root,'formal/node/coverage.json'),'utf8'));
  assert.equal(readFileSync(join(output,'vitest.json'),'utf8'),readFileSync(join(root,'sdk/vitest/coverage-final.json'),'utf8'));
  assert.throws(()=>lib.prepareCoverage({directory:root,output,identity,expected}),/EEXIST/);
}));

test('producer refuses missing, failed JUnit and first-pass flaky evidence [AC:ci-parallel-validation#AC-6] [AC:ci-parallel-validation#AC-7]',()=>fixtures(({lib,root,identity,expected})=>{
  const directory=join(root,'unit');const args={directory,lane:'unit',identity,inventory:expected.unit,elapsedSeconds:1};
  writeFileSync(join(directory,'results/unit.xml'),'<testsuite tests="1" failures="1"><testcase><failure/></testcase></testsuite>');
  assert.throws(()=>lib.writeBundle(args),/failed JUnit/);
  writeFileSync(join(directory,'results/unit.xml'),'<testsuite tests="1" failures="0"><testcase/></testsuite>');
  writeFileSync(join(directory,'flaky/unit.json'),JSON.stringify({pass:true,firstExitCode:1,flaky:[{file:'x'}],failed:[]}));
  assert.throws(()=>lib.writeBundle(args),/flaky/);
  rmSync(join(directory,'results/unit.xml'));assert.throws(()=>lib.writeBundle(args),/Missing.*JUnit/);
}));

test('real node:test top-level testsuites output seals successfully [AC:ci-parallel-validation#AC-8]',()=>fixtures(({lib,root,identity,expected})=>{
  const directory=join(root,'formal');
  writeFileSync(join(directory,'results/formal.xml'),'<?xml version="1.0"?><testsuites><testcase name="real Node output" classname="test"/></testsuites>');
  assert.doesNotThrow(()=>lib.writeBundle({directory,lane:'formal',identity,inventory:expected.formal,elapsedSeconds:1}));
  writeFileSync(join(directory,'results/formal.xml'),'<testsuites><testcase name="incomplete"/>');
  assert.throws(()=>lib.writeBundle({directory,lane:'formal',identity,inventory:expected.formal,elapsedSeconds:1}),/JUnit/);
}));
