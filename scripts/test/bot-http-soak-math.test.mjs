import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedHistogram,latencyWithinThreshold,RssWindows,queueGrowth} from '../bot-release/http-soak-stats.mjs';
import {expectedWorkload} from '../bot-release/http-soak-schedule.mjs';
import {isFreshCompletedOutput,pendingHumanInputs,hasControlledSoftwareResult,pendingControlledOperations} from '../bot-release/http-soak-oracle.mjs';
test('24h immutable offered protocol retains hourly burst and exact 50 percent hotspot',()=>{
 const result=expectedWorkload({warmupSeconds:1800,measurementSeconds:86400,burstEverySeconds:3600,burstDurationSeconds:60});assert.equal(result.readWarmup,72000);assert.equal(result.readMeasurement,3456000);assert.equal(result.measurement,197640);assert.equal(result.burst,27600);assert.equal(result.hot,13800);assert.deepEqual(result.kinds,{human:79056,routine:39528,dispatch:39528,room:39528});
});
test('smoke latency gate keeps the published SLO on the median and mean',()=>{
 const stalled=new BoundedHistogram();for(let i=0;i<32;i++)stalled.add(150);stalled.add(747);stalled.add(1020);
 assert.equal(latencyWithinThreshold(stalled,500,'strict'),false);
 assert.equal(latencyWithinThreshold(stalled,500,'smoke'),true);
 const barely=new BoundedHistogram();for(let i=0;i<32;i++)barely.add(144);barely.add(502);barely.add(514);
 assert.equal(latencyWithinThreshold(barely,500,'strict'),false);
 assert.equal(latencyWithinThreshold(barely,500,'smoke'),true);
 const slow=new BoundedHistogram();for(let i=0;i<34;i++)slow.add(600);
 assert.equal(latencyWithinThreshold(slow,500,'smoke'),false);
 assert.equal(latencyWithinThreshold(slow,500,'strict'),false);
 const heavyTail=new BoundedHistogram();for(let i=0;i<18;i++)heavyTail.add(10);for(let i=0;i<16;i++)heavyTail.add(2000);
 assert.equal(latencyWithinThreshold(heavyTail,500,'smoke'),false);
 const fast=new BoundedHistogram();for(let i=0;i<34;i++)fast.add(80);
 assert.equal(latencyWithinThreshold(fast,500,'strict'),true);
 assert.equal(latencyWithinThreshold(fast,500,'smoke'),true);
 assert.equal(latencyWithinThreshold(new BoundedHistogram(),500,'smoke'),false);
 assert.throws(()=>latencyWithinThreshold(fast,500,'other'),/Unknown latency mode/);
});
test('smoke latency gate rejects thirty fast receives plus four multi-second receives',()=>{
 const tail=new BoundedHistogram();for(let i=0;i<30;i++)tail.add(100);for(let i=0;i<4;i++)tail.add(3000);
 assert.equal(tail.quantile(.5)<=500,true);assert.equal(tail.sum/tail.count<=500,true);assert.equal(latencyWithinThreshold(tail,500,'smoke'),false);
});
test('smoke latency gate tolerates four ~1s receive stalls under CI load but not a tail past 3x the SLO',()=>{
 const ci=new BoundedHistogram();for(let i=0;i<30;i++)ci.add(150);for(const v of [646,700,950,1085])ci.add(v);
 assert.equal(latencyWithinThreshold(ci,500,'strict'),false);assert.equal(latencyWithinThreshold(ci,500,'smoke'),true);
 const edge=new BoundedHistogram();for(let i=0;i<30;i++)edge.add(150);for(let i=0;i<4;i++)edge.add(1501);
 assert.equal(latencyWithinThreshold(edge,500,'smoke'),false);
});
test('bounded histograms keep constant storage and conservatively reject overflow latency',()=>{
 const h=new BoundedHistogram();for(let i=0;i<100000;i++)h.add(i%100);assert.equal(h.bins.length,10002);assert.equal(h.count,100000);assert.equal(h.quantile(.95),94);const overflow=new BoundedHistogram();for(let i=0;i<100;i++)overflow.add(20000+i);assert.equal(overflow.quantile(.95),20099);
});
test('RSS windows reject duplicate slots missing windows and growth over original 120 percent',()=>{
 const valid=new RssWindows(30,10);for(let i=0;i<6;i++)valid.add(i*10,i<3?100:120);valid.finish();assert.ok(valid.results.every(row=>row.passed));
 const duplicate=new RssWindows(30,10);duplicate.add(0,100);duplicate.add(0,100);duplicate.add(10,100);duplicate.add(20,100);duplicate.finish();assert.equal(duplicate.results[0].passed,false);
 const missing=new RssWindows(30,10);missing.add(60,100);missing.finish();assert.equal(missing.results.length,3);assert.equal(missing.baseline,null);assert.ok(missing.results.every(row=>!row.passed));
 const growing=new RssWindows(30,10);for(let i=0;i<6;i++)growing.add(i*10,i<3?100:121);growing.finish();assert.equal(growing.results[1].passed,false);
});
test('queue growth compares equivalent half-hour phases across three hours',()=>{
 const rows=Array.from({length:6},(_,index)=>({index,complete:true,queueP95:index%2?0:index,ageP95:index%2?0:index*1000}));assert.equal(queueGrowth(rows).passed,false);assert.deepEqual(queueGrowth(rows).failures,[[0,2,4]]);assert.equal(queueGrowth(rows.map(row=>({...row,ageP95:0}))).passed,true);
});
test('completion oracle rejects fresh-looking text after abort or abnormal idle',()=>{
 const session={status:'idle',metadata:{outcome:{kind:'idle',reason:'end'}}};assert.equal(isFreshCompletedOutput(session,10,11),true);assert.equal(isFreshCompletedOutput(session,10,10),false);assert.equal(isFreshCompletedOutput({...session,metadata:{outcome:{kind:'aborted',reason:'abort'}}},10,11),false);assert.equal(isFreshCompletedOutput({...session,metadata:{outcome:{kind:'idle',reason:'busy'}}},10,11),false);assert.equal(isFreshCompletedOutput({...session,metadata:{outcome:{kind:'idle',reason:'end',failureStage:'tool'}}},10,11),false);
});
test('input observer sees multiple real human sources without treating quotations or notifications as work',()=>{
 const text=value=>[{type:'text',text:value}],messages=[{id:'real-1',role:'user',parts:text('http_op_1 first')},{id:'real-2',role:'user',parts:text('http_op_2 second')},{id:'quoted',role:'user',parts:text('Recall http_op_555 reference')},{id:'result',role:'user',parts:text('Task completed http_op_1')},{id:'tool',role:'tool',parts:text('http_op_888')}];
 const rows=pendingHumanInputs(messages,{isResult:message=>message.id==='result',receipt:(operation,message)=>message.id==='real-1'&&operation==='http_op_1'?{sourceSeq:10}:message.id==='real-2'&&operation==='http_op_2'?{sourceSeq:12}:undefined});assert.deepEqual(rows,[{operation:'http_op_1',sourceSeq:10,messageId:'real-1'},{operation:'http_op_2',sourceSeq:12,messageId:'real-2'}]);
});
test('successful archived software result uses actual invocation identity and rejects quoted or failed results',()=>{
 const part={type:'tool_result',name:'http_benchmark_software',toolCallId:'controlled_http_op_3:sid',ok:true,content:'[Tool result archived — context protected]\nHandle: artifact_123\nPreview: ...'};
 assert.equal(hasControlledSoftwareResult([{role:'tool',parts:[part]}],'http_op_3','sid'),true);assert.equal(hasControlledSoftwareResult([{role:'tool',parts:[{...part,ok:false}]}],'http_op_3','sid'),false);assert.equal(hasControlledSoftwareResult([{role:'tool',parts:[{...part,toolCallId:'controlled_http_op_30:sid',content:'Quoted http_op_3:sid'}]}],'http_op_3','sid'),false);assert.equal(hasControlledSoftwareResult([{role:'assistant',parts:[{type:'text',text:'http_op_3:sid'}]}],'http_op_3','sid'),false);
});

test('explicitly emitted decisions retire before later input drops their typed result without inventing a new confirmation',()=>{
 const decisions=new Map([['old',{finished:1}],['awaiting',{finished:0}]]);const options={completed:operation=>operation==='terminal',explicitDecision:operation=>decisions.get(operation)};assert.deepEqual(pendingControlledOperations(['old','awaiting','new','unknown','old','terminal'],options),['awaiting','new','unknown']);assert.equal(decisions.get('awaiting').finished,0);assert.equal(decisions.has('new'),false);
});
