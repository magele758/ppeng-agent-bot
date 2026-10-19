import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sanitizeSpawnEnv} from '../../packages/core/dist/sandbox/env-sanitizer.js';
import {runHttpLoad, untrackedFingerprintInput} from '../bot-release/http-load.mjs';
import {controlledOperation} from '../bot-release/http-controlled-operation.mjs';
test('dirty fingerprint records vanished files but preserves non-ENOENT errors', () => {
 const missing = Object.assign(new Error('deleted by concurrent test'), { code: 'ENOENT' });
 const input = untrackedFingerprintInput(['temporary-output'], () => { throw missing; });
 assert.match(input, /temporary-output:missing-during-snapshot/);
 assert.notEqual(input, untrackedFingerprintInput([]));
 const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
 assert.throws(() => untrackedFingerprintInput(['source'], () => { throw denied; }), error => error === denied);
});
test('controlled Room oracle selects current trigger despite old and later referenced operations',()=>{
 const text=content=>({type:'text',text:content});
 const messages=[{role:'user',parts:[text('http_op_1 prior')]},{role:'assistant',parts:[text('http_op_999 result')]},{role:'user',parts:[text('Room\nTrigger: '+JSON.stringify({text:'http_op_2 current'})+'\nHistory: '+JSON.stringify([{text:'http_op_1 old'},{text:'http_op_999 other referenced operation'}]))]},{role:'tool',parts:[{type:'tool_result',content:'http_op_555'}]}];
 assert.equal(controlledOperation(messages),'http_op_2');assert.equal(controlledOperation([{role:'user',parts:[text('Message from Worker: Task t completed: http_op_9 original result')]}],'result'),undefined);assert.equal(controlledOperation([{role:'user',parts:[text('http_op_3 current')]},{role:'assistant',parts:[text('http_op_999 quoted')]}]),'http_op_3');assert.equal(controlledOperation([{role:'user',parts:[text('Trigger: '+JSON.stringify({text:'No operation'})+'\nHistory http_op_123')]}]),undefined);
});
test('real authenticated HTTP load fixture observes fixed read/write mix and refuses release acceptance [AC:bot-release-readiness#AC-3]',{timeout:60000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-http-load-test-'));
 try{const report=await runHttpLoad({smoke:true,smokeSeconds:5,out:join(directory,'report.json')});
  assert.equal(report.fixturePassed,true,JSON.stringify(report.errors));assert.equal(report.fullProtocol,false);assert.equal(report.referenceHardwareMatched,false);
  assert.deepEqual(report.readCounts,{warmup:80,measurement:200});assert.deepEqual(report.readMix,{page:100,search:60,status:40});
  assert.deepEqual(report.writeMix,{human:4,routine:2,dispatch:2,room:2});assert.equal(report.clientCount,20);assert.ok(report.maxReadInFlight<=20);
  assert.equal(report.idleSchedulingProbe.observedDistinctSessions,3);assert.equal(report.idleSchedulingProbe.withinTwoCycles,true);
  assert.ok(report.approvals.length>=2);assert.ok(report.approvals.every(item=>item.approvedAt-Date.parse(item.createdAt)>=5000&&item.waitedMs>=5000));
  assert.equal(report.latency.receive.count,10);assert.equal(report.latency.clientQueue.count,200);assert.equal(report.latency.readSocket.count,200);
  assert.equal(report.browserFirstScreen.status,'unverified');assert.match(report.releaseAcceptance,/NOT ACCEPTED/);
  assert.deepEqual(report.daemon.errors,[]);assert.deepEqual(report.daemon.duplicateSoftwareKeys,[]);assert.ok(report.daemon.notificationRuns>0);assert.ok(report.daemon.modelTurns>0);assert.ok(report.daemon.toolCalls>0);
  for(const rows of Object.values(report.daemon.pending))assert.ok(rows.every(row=>!['queued','running','waiting_approval'].includes(row.status)),JSON.stringify(rows));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('HTTP load rejects a daemon shutdown failure even after all results were completed [AC:bot-release-readiness#AC-3]',{timeout:60000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-http-load-exit-test-'));
 try{const report=await runHttpLoad({smoke:true,smokeSeconds:5,fixtureFault:'shutdown',out:join(directory,'report.json')});assert.equal(report.fixturePassed,false);assert.equal(report.daemonExit.code,1);assert.ok(report.errors.some(item=>item.phase==='daemon-exit'));assert.equal(report.acceptedResults.completed,report.acceptedResults.count);assert.match(report.releaseAcceptance,/NOT ACCEPTED/);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('HTTP load persists rejected startup evidence when daemon exits before readiness [AC:bot-release-readiness#AC-3]',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-http-load-start-test-'));
 try{const report=await runHttpLoad({smoke:true,smokeSeconds:5,fixtureFault:'startup',out:join(directory,'report.json')});assert.equal(report.fixturePassed,false);assert.equal(report.daemonExit.code,1);assert.equal(report.errors[0].phase,'startup');assert.match(report.releaseAcceptance,/NOT ACCEPTED/);}finally{rmSync(directory,{recursive:true,force:true});}
});

test('HTTP load fails and kills daemon that hangs after final ledger [AC:bot-release-readiness#AC-3]',{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-http-load-hang-test-'));let timer;
 try{const report=await Promise.race([runHttpLoad({smoke:true,smokeSeconds:5,fixtureFault:'shutdown-hang',out:join(directory,'report.json')}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Parent failed to bound shutdown after final ledger')),35000);})]);
  assert.equal(report.fixturePassed,false);assert.equal(report.daemonExit.signal,'SIGKILL');assert.ok(report.errors.some(item=>item.message.includes('shutdown')&&item.message.includes('budget')));assert.match(report.releaseAcceptance,/NOT ACCEPTED/);
 }finally{clearTimeout(timer);const lines=execFileSync('ps',['-eo','pid,args'],{encoding:'utf8',env:sanitizeSpawnEnv()}).split('\n');for(const line of lines.filter(line=>line.includes('http-load-daemon.mjs')&&line.includes(directory))){try{process.kill(Number(line.trim().split(/\s+/)[0]),'SIGKILL');}catch{}}rmSync(directory,{recursive:true,force:true});}
});
