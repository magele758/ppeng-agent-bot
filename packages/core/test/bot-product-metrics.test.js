import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import * as work from '../dist/bots/bot-work.js';
import { createBot } from '../dist/bots/bot-facade.js';

test('delivery metrics distinguish unverified outcomes and missing costs from zero [AC:bot-product-p2#AC-8]', async () => {
  const dir=mkdtempSync(join(tmpdir(),'bot-metrics-')),store=new SqliteStateStore(join(dir,'state.db'));
  const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){},debug(){},error(){}},
    async runSession(id){
      store.appendMessage(id,'assistant',[{type:'text',text:'Delivered'}]);
      store.updateSession(id,{status:'completed',metadata:{...store.getSession(id).metadata,usageCostUsd:12.3}});
    }};
  try {
    const principal=work.resolveBotPrincipal(store),boss=createBot(host,{name:'Boss'}),worker=createBot(host,{name:'Worker'});
    const task=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:worker.id,input:'Report'});
    await work.tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));
    const range={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z'};
    let metrics=work.botProductMetrics(store,principal,range);
    assert.equal(metrics.tasks,1);assert.equal(metrics.acceptanceRate,null);assert.equal(metrics.costPerAcceptedDeliveryUsd,null);
    work.reviewBotDelivery(store,principal,task.id,1,true);
    metrics=work.botProductMetrics(store,principal,range);
    assert.equal(metrics.reviewed,1);assert.equal(metrics.accepted,1);assert.equal(metrics.acceptanceRate,1);
    assert.equal(metrics.costPerAcceptedDeliveryUsd,null);assert.equal(metrics.recoveryRate,null);
    assert.ok(metrics.firstAcceptedDeliveryMs>=0);
    assert.throws(()=>work.reviewBotDelivery(store,{userId:'stranger'},task.id,1,true),/not found/i);
    assert.equal(work.botProductMetrics(store,{userId:'stranger'},range).tasks,0);
  } finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
});
