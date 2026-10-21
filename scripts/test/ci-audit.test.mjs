import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dedupeResults } from '../acceptance/acceptance-lib.mjs';
import { buildReport } from '../ci/flaky-retry-lib.mjs';
import { evaluateGate, buildBaseline } from '../crap/crap-lib.mjs';
import { assessReleaseEvidence, REQUIRED_GATES } from '../bot-release/evidence.mjs';

test('retry recovery is not a clean pass [AC:ci-audit-p1-p2#AC-1]', () => {
 const runs=['failed','passed'].map(outcome=>({title:'test',source:'unit.xml',outcome}));
 assert.equal(dedupeResults(runs)[0].outcome,'failed');
 assert.equal(buildReport({plan:{retry:true},flaky:[{file:'x',tests:[{name:'x'}]}],failed:[]}).pass,false);
});

test('zero coverage has no CRAP slack [AC:ci-audit-p1-p2#AC-7]',()=>{
 const row={key:'x::handler',file:'x',name:'handler',crap:100,coverage:0,complexity:10};
 assert.equal(evaluateGate([{...row,crap:100.01}],buildBaseline([row])).pass,false);
});

test('all twelve evidence obligations are independently pinned [AC:ci-audit-p1-p2#AC-10]',()=>{
 const expected=['build','unit','integration','browser','faults','migration-rollback','performance','soak','live-model','live-software','acceptance','crap'];
 assert.deepEqual(REQUIRED_GATES,expected);
 const checks=expected.map(gate=>({gate,candidate:'a',status:'passed',artifact:'evidence.json',durationSeconds:86400,warmupSeconds:1800,fullProtocol:true,referenceHardwareMatched:true,sequences:10000,consecutivePasses:3,killRestart:true,retries:0,trialsPerModel:3,criticalRecall:1,otherRecall:1}));
 assert.equal(assessReleaseEvidence({candidate:'a',checks}).ready,true);
 for(const gate of expected){
  const result=assessReleaseEvidence({candidate:'a',checks:checks.filter(c=>c.gate!==gate)});
  assert.equal(result.ready,false);assert.deepEqual(result.missing,[gate]);
 }
});

test('base acceptance obligations cannot disappear or downgrade [AC:ci-audit-p1-p2#AC-2]',async()=>{
 const { compareAcceptance }=await import('../ci/base-revision.mjs');
 const old={id:'feature',status:'implemented',criteria:[{id:'AC-1'}]};
 for(const next of [[],[{...old,status:'draft'}],[{...old,status:'retired'}],[{...old,status:'approved'}],[{...old,criteria:[]}]]) assert.ok(compareAcceptance([old],next).length);
 assert.deepEqual(compareAcceptance([old],[old]),[]);
});

test('baseline relaxations fail and web-console is scanned [AC:ci-audit-p1-p2#AC-3]',async()=>{
 const { compareBaselines }=await import('../ci/base-revision.mjs');
 const base={threshold:30,functions:{a:{crap:100,coverage:0}}};
 assert.ok(compareBaselines(base,{...base,functions:{a:{crap:101,coverage:0}}}).length);
 assert.ok(compareBaselines(base,{...base,threshold:31}).length);
 assert.ok(compareBaselines(base,{...base,functions:{...base.functions,b:{crap:40}}}).length);
 assert.deepEqual(compareBaselines(base,base),[]);
 assert.match(readFileSync('scripts/crap/crap-gate.mjs','utf8'),/'apps\/web-console'/);
});

test('baseline coverage improvements from zero pass without a CRAP increase [AC:ci-audit-p1-p2#AC-3]',async()=>{
 const { compareBaselines }=await import('../ci/base-revision.mjs');
 const base={threshold:30,functions:{a:{crap:100,coverage:0}}};
 for(const crap of [90,100]) {
  assert.deepEqual(compareBaselines(base,{...base,functions:{a:{crap,coverage:50}}}),[]);
 }
});

test('baseline CRAP increases fail regardless of coverage [AC:ci-audit-p1-p2#AC-3] [AC:ci-audit-p1-p2#AC-7]',async()=>{
 const { compareBaselines }=await import('../ci/base-revision.mjs');
 for(const priorCoverage of [0,50]) {
  const base={threshold:30,functions:{a:{crap:100,coverage:priorCoverage}}};
  for(const coverage of [0,50,100]) {
   assert.deepEqual(compareBaselines(base,{...base,functions:{a:{crap:100.01,coverage}}}),['CRAP baseline relaxed: a']);
  }
 }
});

test('formal structure and cfg references are checked [AC:ci-audit-p1-p2#AC-8]',async()=>{
 const { checkTla }=await import('../formal/tla-sanity.mjs');
 const good='---- MODULE Demo ----\nInit == TRUE\nNext == TRUE\nSpec == Init /\\ Next\n====';
 assert.deepEqual(checkTla('Demo',good,'INIT Init\nNEXT Next'),[]);
 assert.deepEqual(checkTla('Demo',good,'SPECIFICATION Spec'),[]);
 for(const [tla,cfg] of [[good.replace('Demo','Wrong'),'INIT Init'],[good.replace('====',''),'INIT Init'],[good,'SPECIFICATION Missing'],[good,'INIT Missing\nNEXT Next']]) assert.ok(checkTla('Demo',tla,cfg).length);
});

test('nested unit-test files are discovered [AC:ci-audit-p1-p2#AC-6]',async()=>{
 const { nodeTestPatterns,globToRegExp }=await import('../acceptance/acceptance-lib.mjs');
 const pkg=JSON.parse(readFileSync('package.json'));
 const patterns=nodeTestPatterns(pkg.scripts['test:unit']).map(globToRegExp);
 for(const file of ['packages/core/test/new/nested.test.js','scripts/test/new/nested.test.mjs','apps/web-console/lib/new/nested.test.ts']) assert.ok(patterns.some(p=>p.test(file)),file);
});

test('CLI requires an explicit approval decision [AC:ci-audit-p1-p2#AC-4]',async()=>{
 const { spawnSync }=await import('node:child_process');
 const { sanitizeScriptEnv }=await import('../spawn-utils.mjs');
 for(const action of [[],['typo'],['APPROVE']]) {
  const r=spawnSync(process.execPath,['apps/cli/dist/index.js','approve','missing',...action],{encoding:'utf8',env:sanitizeScriptEnv()});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Expected explicit approve or reject/);
 }
});

test('release gate consumes every participating quality result [AC:ci-audit-p1-p2#AC-9]',async()=>{
 const { parse }=await import('yaml');
 const workflow=parse(readFileSync('.github/workflows/release-gate.yml','utf8'));
 for(const job of ['mutation','remote-model-smoke','harness','compact-ab']) assert.ok(workflow.jobs.gate.needs.includes(job),job);
 const { releaseFailures }=await import('../ci/release-results.mjs');
 const required={unit:{result:'success'},formal:{result:'success'},sdk:{result:'success'},tests:{result:'success'},crap:{result:'success'},browser:{result:'success'},acceptance:{result:'success'},mutation:{result:'success'},'secrets-gate':{result:'success'},'soak-performance':{result:'success'}};
 for(const name of ['remote-model-smoke']) {
  assert.deepEqual(releaseFailures({...required,[name]:{result:'skipped'}}),[]);
  assert.ok(releaseFailures({...required,[name]:{result:'failure'}}).includes(name));
  assert.ok(releaseFailures({...required,[name]:{result:'cancelled'}}).includes(name));
 }
 for (const result of ['success','failure','cancelled','skipped']) {
  for (const name of ['harness', 'compact-ab']) {
   assert.deepEqual(releaseFailures({...required,[name]:{result}}),[]);
  }
 }
 assert.ok(releaseFailures({...required,mutation:{result:'skipped'}}).includes('mutation'));
});

test('flaky exceptions require exact file and title and do not forgive persistent failures [AC:ci-audit-p1-p2#AC-1]',()=>{
 const flaky=[{file:'test.mjs',tests:[{name:'flaky'}]}];
 const args={plan:{retry:true},flaky,failed:[],allowlist:[{file:'test.mjs',name:'flaky',reason:'tracked timeout'}]};
 assert.equal(buildReport(args).pass,true);
 assert.equal(buildReport({...args,failed:flaky}).pass,false);
 assert.equal(buildReport({...args,flaky:[{file:'other.mjs',tests:[{name:'flaky'}]}]}).pass,false);
 assert.equal(buildReport({...args,flaky:[{file:'test.mjs',tests:[{name:'another'}]}]}).pass,false);
});

test('a failed retry cannot use the known-flaky exception [AC:ci-audit-p1-p2#AC-1]',()=>{
 const result = dedupeResults([
  {title:'flaky',outcome:'failed',source:'unit.xml'},
  {title:'flaky',outcome:'passed',source:'unit.retry-1.xml'},
  {title:'flaky',outcome:'failed',source:'unit.retry-2.xml'}
 ])[0];
 assert.equal(result.outcome,'failed');assert.notEqual(result.retryRecovered,true);
});

test('recursive unit pattern executes a nested test and propagates failure [AC:ci-audit-p1-p2#AC-6]',async()=>{
 const { mkdtempSync,mkdirSync,writeFileSync,rmSync }=await import('node:fs');
 const { tmpdir }=await import('node:os');
 const { join }=await import('node:path');
 const { spawnSync }=await import('node:child_process');
 const { sanitizeScriptEnv }=await import('../spawn-utils.mjs');
 const { nodeTestPatterns }=await import('../acceptance/acceptance-lib.mjs');
 const pattern=nodeTestPatterns(JSON.parse(readFileSync('package.json')).scripts['test:unit']).find(p=>p.startsWith('packages/core/'));
 const root=mkdtempSync(join(tmpdir(),'recursive-unit-'));
 try {
  const dir=join(root,'packages/core/test/new/deeper');mkdirSync(dir,{recursive:true});
  const file=join(dir,'nested.test.js');
  writeFileSync(file,"const test = require('node:test'); test('nested sentinel', () => {});");
  const env=sanitizeScriptEnv();delete env.NODE_TEST_CONTEXT;
  const run=()=>spawnSync(process.execPath,['--test',pattern],{cwd:root,encoding:'utf8',env});
  const green=run();assert.equal(green.status,0,green.stderr);assert.match(green.stdout,/nested sentinel/);
  writeFileSync(file,"const test = require('node:test'); test('nested sentinel', () => { throw Error('nested failure'); });");
  const red=run();assert.equal(red.status,1);assert.match(red.stdout,/nested failure/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('fixed HTTP window no longer needs a known-flaky wall-clock exception [AC:ci-audit-p1-p2#AC-1]', async () => {
 const { knownFlaky, isKnownFlaky } = await import('../ci/known-flaky.mjs');
 const file = 'scripts/test/bot-http-fixed-window.test.mjs';
 const name = 'fixed window bounds queues and terminates stalled work at original deadline';
 const source = readFileSync(file, 'utf8');
 assert.ok(source.includes("test('" + name + "'"));
 assert.match(source, /observedElapsedSeconds/);
 assert.doesNotMatch(source, /Date\.now\(\)-started/);
 assert.equal(isKnownFlaky(file, name), false);
 assert.equal(knownFlaky.filter(entry => entry.file === file && entry.name === name).length, 0);
 const flaky = [{file, tests:[{name}]}];
 assert.equal(buildReport({plan:{retry:true}, flaky, failed:[]}).pass, false);
});

test('release CLI reports non-blocking diagnostics in stdout and step summary [AC:ci-audit-p1-p2#AC-9]', async () => {
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { spawnSync } = await import('node:child_process');
 const { sanitizeScriptEnv } = await import('../spawn-utils.mjs');
 const dir = mkdtempSync(join(tmpdir(), 'release-summary-'));
 try {
  const summary = join(dir, 'summary.md');
  const needs = Object.fromEntries(['tests','unit','formal','sdk','crap','browser','acceptance','mutation','secrets-gate','soak-performance'].map(name => [name,{result:'success'}]));
  needs.harness = {result:'failure'};
  needs['compact-ab'] = {result:'failure'};
  const run = spawnSync(process.execPath, ['scripts/ci/release-results.mjs', JSON.stringify(needs)], {encoding:'utf8',env:{...sanitizeScriptEnv(),GITHUB_STEP_SUMMARY:summary}});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const output of [run.stdout, readFileSync(summary, 'utf8')]) {
   assert.match(output, /Harness \(non-blocking\): failure/);
   assert.match(output, /Compact A[/]B \(non-blocking\): failure/);
   assert.match(output, /non-deterministic/);
  }
 } finally { rmSync(dir, {recursive:true,force:true}); }
});
