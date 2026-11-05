import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createExtensionRegistry} from '../dist/extensions/extension-registry.js';
import {autoCompactForTurn, waitForBotSummary, scheduleSummaryAfterTurn} from '../dist/runtime/bot-summary-background.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'async-summary-'));
 const store=new SqliteStateStore(join(dir,'state.db'));
 const session=store.createSession({title:'bot',mode:'chat',agentId:'b',metadata:{canonicalBotChat:true,botId:'b'}});
 store.appendMessage(session.id,'user',[{type:'text',text:'old-history '.repeat(6000)}]);
 for(let i=0;i<60;i++)store.appendMessage(session.id,i%2?'assistant':'user',[{type:'text',text:`message-${i}`}]);
 let resolve, reject; let calls=0;
 const pending=new Promise((r,j)=>{resolve=r;reject=j;});
 const adapter={name:'scripted',contextWindow:8192,completeText:async()=>{calls++;return pending;}};
 const host={store,stateDir:dir,modelAdapter:adapter,extensionRegistry:createExtensionRegistry(),turnShapeBySession:new Map(),emitTrace(){},prepareMessagesForModel:async(_,m)=>m};
 const context={session,agent:{id:'b',name:'b',role:'assistant',instructions:'',capabilities:[]},repoRoot:dir,stateDir:dir};
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 return {host,context,store,dir,resolve,reject,calls:()=>calls};
}
const summary='Goal: preserve context\nConstraints: none\nProgress: done\nDecisions: keep history\nFiles: none\nNext steps: continue';

test('turn preparation never awaits pending summary [AC:bot-async-summary#AC-1] [AC:bot-async-summary#AC-2]',async t=>{
 const f=fixture(t);
 await autoCompactForTurn(f.host,f.context);
 await new Promise(r=>setImmediate(r));
 assert.equal(f.calls(),1);
 await autoCompactForTurn(f.host,f.context);
 assert.equal(f.calls(),1);
 const tail=f.store.appendMessage(f.context.session.id,'user',[{type:'text',text:'new message while summarizing'}]);
 f.resolve(summary);await waitForBotSummary(f.host.store,f.context.session.id);
 assert.ok(f.store.getSession(f.context.session.id).summary);
 assert.ok(f.store.foldMessages(f.context.session.id).some(m=>m.id===tail.id));
});

test('newer summary wins over a stale background result [AC:bot-async-summary#AC-3]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 f.store.updateSession(f.context.session.id,{summary:'newer summary'});
 f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.store.getSession(f.context.session.id).summary,'newer summary');
 assert.equal(f.store.foldMessages(f.context.session.id).length,61);
});

test('completed turns update durable summary [AC:bot-async-summary#AC-4]',async t=>{
 const f=fixture(t);scheduleSummaryAfterTurn(f.host,f.context,{kind:'turn_end',payload:{stopReason:'end'}});
 await new Promise(r=>setImmediate(r));f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 assert.ok(f.store.db.prepare('SELECT summary FROM sessions WHERE id=?').get(f.context.session.id).summary);
 assert.ok(f.store.foldMessages(f.context.session.id).length<61);
});

test('unchanged history and below-threshold messages never resummarize [AC:bot-async-summary#AC-5]',async t=>{
 const f=fixture(t);f.host.modelAdapter.contextWindow=1_000_000;
 await autoCompactForTurn(f.host,f.context);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.calls(),0);
 f.host.modelAdapter.contextWindow=8192;
 f.store.appendMessage(f.context.session.id,'user',[{type:'text',text:'new turn'}]);
 await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 assert.equal(f.calls(),1);f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 await autoCompactForTurn(f.host,f.context);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.calls(),1);
});

test('failed background requests preserve history and back off [AC:bot-async-summary#AC-3]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 f.reject(new Error('upstream unavailable'));await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.store.foldMessages(f.context.session.id).length,61);
 await autoCompactForTurn(f.host,f.context);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.calls(),1);
});

test('repeated compact cycles retain one active summary and searchable source [AC:bot-async-summary#AC-5]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 for(let i=0;i<40;i++) f.store.appendMessage(f.context.session.id,i%2?'assistant':'user',[{type:'text',text:'more history '.repeat(500)}]);
 await autoCompactForTurn(f.host,f.context);await waitForBotSummary(f.store,f.context.session.id);
 const folded=f.store.foldMessages(f.context.session.id);
 assert.equal(f.calls(),2);
 assert.equal(folded.filter(m=>m.key==='compact-summary').length,1);
 assert.ok(f.store.listMessages(f.context.session.id).some(m=>m.parts.some(p=>p.type==='text'&&p.text.includes('old-history'))));
});

test('shutdown cancels an outstanding summary without publishing [AC:bot-async-summary#AC-3]',async t=>{
 const {stopBotSummaries}=await import('../dist/runtime/bot-summary-background.js');
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 await stopBotSummaries(f.store);
 f.resolve(summary);await new Promise(r=>setImmediate(r));
 assert.equal(f.store.getSession(f.context.session.id).summary,undefined);
});

test('restart reuses the durable summary and does not repeat unchanged work [AC:bot-async-summary#AC-4] [AC:bot-async-summary#AC-5]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 const reopened=new SqliteStateStore(join(f.dir,'state.db'));
 try {
   const session=reopened.getSession(f.context.session.id);
   assert.ok(session.summary);
   assert.equal(reopened.foldMessages(session.id).filter(m=>m.key==='compact-summary').length,1);
   await autoCompactForTurn({...f.host,store:reopened},{...f.context,session});
   await waitForBotSummary(reopened,session.id);assert.equal(f.calls(),1);
 } finally {reopened.db.close();}
});

test('separate runtime stores share one pending summary lease [AC:bot-async-summary#AC-2]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 const second=new SqliteStateStore(join(f.dir,'state.db'));
 try {
   await autoCompactForTurn({...f.host,store:second},f.context);
   await new Promise(r=>setImmediate(r));assert.equal(f.calls(),1);
   f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 } finally {second.db.close();}
});

test('new work during a summary is coalesced into a later threshold check [AC:bot-async-summary#AC-2]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 for(let i=0;i<40;i++)f.store.appendMessage(f.context.session.id,i%2?'assistant':'user',[{type:'text',text:'concurrent tail '.repeat(500)}]);
 await autoCompactForTurn(f.host,f.context);assert.equal(f.calls(),1);
 f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.calls(),2);
 assert.equal(f.store.foldMessages(f.context.session.id).filter(m=>m.key==='compact-summary').length,1);
});

test('rewritten source history invalidates an in-flight summary [AC:bot-async-summary#AC-3]',async t=>{
 const f=fixture(t);await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));
 const first=f.store.foldMessages(f.context.session.id)[0];
 f.store.appendReplacement(f.context.session.id,{startSeq:first.seq,endSeq:first.seq,role:'user',parts:[{type:'text',text:'corrected history'}]});
 f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(f.store.getSession(f.context.session.id).summary,undefined);
 assert.ok(f.store.foldMessages(f.context.session.id).some(m=>m.parts.some(p=>p.text==='corrected history')));
});

test('rolling summary input includes prior summary once plus new history [AC:bot-async-summary#AC-5]',async t=>{
 const f=fixture(t), inputs=[];
 const original=f.host.modelAdapter.completeText;
 f.host.modelAdapter.completeText=async input=>{inputs.push(JSON.parse(input.user));return original(input);};
 await autoCompactForTurn(f.host,f.context);await new Promise(r=>setImmediate(r));f.resolve(summary);await waitForBotSummary(f.store,f.context.session.id);
 const prior=f.store.getSession(f.context.session.id).summary;
 for(let i=0;i<40;i++)f.store.appendMessage(f.context.session.id,i%2?'assistant':'user',[{type:'text',text:'incremental content '.repeat(500)}]);
 await autoCompactForTurn(f.host,f.context);await waitForBotSummary(f.store,f.context.session.id);
 assert.equal(inputs[1].previousSummary,prior);
 assert.equal(inputs[1].history.some(m=>m.key==='compact-summary'),false);
 assert.equal(inputs[1].history.some(m=>m.parts.some(p=>p.text?.includes('old-history'))),false);
});
