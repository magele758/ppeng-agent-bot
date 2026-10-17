import test from 'node:test';
import assert from 'node:assert/strict';
import {runFixedHttpWindow} from '../bot-release/http-fixed-window.mjs';

test('fixed window bounds queues and terminates stalled work at original deadline',async()=>{
 let active=0,max=0;const signals=[];
 const phase=await runFixedHttpWindow({name:'warmup',seconds:.12,streams:[{name:'read',rate:100,clients:2,maxPendingPerClient:1,run:({signal})=>{active++;max=Math.max(max,active);signals.push(signal);return new Promise(()=>{});}}]});
 const counts=phase.streams.read;
 // Bound the fixture clock, not Date.now(). CI delay before the window starts must not fail a window that closed on its own deadline.
 assert.ok(phase.observedElapsedSeconds*1000<400,`window elapsed ${phase.observedElapsedSeconds}s`);
 assert.ok(phase.deadlineOvershootMs<400);
 assert.equal(max,2);assert.equal(counts.planned,12);assert.equal(counts.started,2);assert.equal(counts.timedOut,2);assert.equal(counts.expiredQueued,2);assert.equal(counts.queueRejected,8);assert.equal(counts.planned,counts.completed+counts.failed+counts.timedOut+counts.expiredQueued+counts.queueRejected+counts.missedSchedule);assert.equal(phase.protocolPassed,false);assert.ok(signals.every(s=>s.aborted));
});
test('fast work retains fixed planned counts without allowing late completions',async()=>{
 const phase=await runFixedHttpWindow({name:'measurement',seconds:.1,streams:[{name:'read',rate:100,clients:20,maxPendingPerClient:1,run:async()=>true},{name:'write',rate:20,clients:10,maxPendingPerClient:1,run:async()=>true}]});
 assert.equal(phase.streams.read.planned,10);assert.equal(phase.streams.read.completed,10);assert.equal(phase.streams.write.completed,2);assert.equal(phase.protocolPassed,true);
});
test('completion after deadline cannot retroactively turn failed window into a pass',async()=>{
 let finish;const phase=await runFixedHttpWindow({name:'measurement',seconds:.05,streams:[{name:'read',rate:20,clients:1,maxPendingPerClient:1,run:()=>new Promise(resolve=>{finish=resolve;})}]});
 assert.equal(phase.streams.read.timedOut,1);finish(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(phase.streams.read.completed,0);assert.equal(phase.protocolPassed,false);
});
test('a rejected callback is a terminal error rather than an unhandled promise or completion',async()=>{
 const phase=await runFixedHttpWindow({name:'measurement',seconds:.05,streams:[{name:'read',rate:20,clients:1,maxPendingPerClient:1,run:async()=>{throw new Error('server failed');}}]});
 assert.equal(phase.streams.read.failed,1);assert.equal(phase.streams.read.completed,0);assert.equal(phase.protocolPassed,false);
});

test('driver stall cannot launch reserved work after its deadline',async()=>{
 let calls=0;const phase=await runFixedHttpWindow({name:'measurement',seconds:.02,streams:[{name:'read',rate:50,clients:1,run:async()=>{calls++;}}],onProgress(){const end=performance.now()+30;while(performance.now()<end){}}});
 assert.equal(calls,0);assert.equal(phase.streams.read.started,0);assert.equal(phase.streams.read.expiredQueued,1);assert.equal(phase.protocolPassed,false);
});
test('invalid rates or duplicate stream names cannot hide failed workload',async()=>{
 await assert.rejects(runFixedHttpWindow({name:'x',seconds:1,streams:[{name:'read',rate:0,clients:1,run(){}}]}));
 await assert.rejects(runFixedHttpWindow({name:'x',seconds:.1,streams:[{name:'read',rate:10,clients:1,run(){}},{name:'read',rate:10,clients:1,run(){}}]}));
});
test('progress callback failure prevents reserved work from escaping cleanup',async()=>{
 let calls=0;await assert.rejects(runFixedHttpWindow({name:'x',seconds:.1,streams:[{name:'read',rate:10,clients:1,run(){calls++;}}],onProgress(){throw new Error('cannot write progress');}}),/cannot write progress/);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});

test('completion grace lets the final admitted slot finish but never admits new work after the deadline',async()=>{
 const phase=await runFixedHttpWindow({name:'measurement',seconds:.1,completionGraceMs:200,streams:[{name:'read',rate:100,clients:20,maxPendingPerClient:1,run:({index})=>new Promise(resolve=>setTimeout(()=>resolve(true),index===9?60:1))}]});
 const counts=phase.streams.read;assert.equal(counts.planned,10);assert.equal(counts.completed,10);assert.equal(counts.timedOut,0);assert.equal(phase.protocolPassed,true);assert.ok(phase.admissionElapsedSeconds<phase.observedElapsedSeconds);
});
test('work exceeding the completion grace still times out and fails the window',async()=>{
 const started=performance.now();const phase=await runFixedHttpWindow({name:'measurement',seconds:.05,completionGraceMs:50,streams:[{name:'read',rate:20,clients:1,maxPendingPerClient:1,run:()=>new Promise(()=>{})}]});
 assert.ok(performance.now()-started<400);assert.equal(phase.streams.read.timedOut,1);assert.equal(phase.streams.read.completed,0);assert.equal(phase.protocolPassed,false);
 await assert.rejects(runFixedHttpWindow({name:'x',seconds:.1,completionGraceMs:-1,streams:[{name:'read',rate:10,clients:1,run(){}}]}));
});
