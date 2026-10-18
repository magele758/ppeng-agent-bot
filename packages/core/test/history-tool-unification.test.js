import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteStateStore} from '../dist/storage.js';
import {createHistoryTools} from '../dist/session/history/tools.js';
import {RawAgentRuntime} from '../dist/runtime.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(){
 const store=new SqliteStateStore(':memory:');
 store.upsertAgent({id:'general',name:'General',role:'assistant',instructions:'',capabilities:[]});
 const metadata={userId:'owner',tenantId:'tenant'};
 const current=store.createSession({title:'current',mode:'chat',agentId:'general',metadata});
 const old=store.createSession({title:'old',mode:'chat',agentId:'general',metadata});
 const foreign=store.createSession({title:'foreign',mode:'chat',agentId:'general',metadata:{userId:'other',tenantId:'tenant'}});
 const text='originalneedle '+ 'retained evidence '.repeat(1800);
 const original=store.appendMessage(old.id,'user',[{type:'text',text:'part zero'},{type:'text',text}]);
 store.appendMessage(foreign.id,'user',[{type:'text',text:'originalneedle SECRET'}]);
 store.appendReplacement(old.id,{startSeq:original.seq,endSeq:original.seq,role:'system',parts:[{type:'text',text:'Summary without the source'}]});
 const tools=createHistoryTools(store),ctx={session:current};
 return {store,current,old,foreign,original,text,tools,ctx,search:tools.find(t=>t.name==='history_search'),read:tools.find(t=>t.name==='history_read')};
}

test('ordinary history retains upstream identity-scoped cross-session search and source pages [AC:context-reliability#AC-6] [AC:context-reliability#AC-7]',async()=>{
 const f=fixture();try{
  const search=JSON.parse((await f.search.execute(f.ctx,{query:'originalneedle',session_id:f.old.id})).content);
  assert.equal(search.matches.length,1);assert.equal(search.matches[0].messageId,f.original.id);
  const page=JSON.parse((await f.read.execute(f.ctx,{ref:search.matches[0].ref,offset:100,limit:500})).content);
  assert.equal(page.text,f.text.slice(100,600));assert.equal(page.nextOffset,600);
  const note=JSON.parse((await f.read.execute(f.ctx,{session_id:f.old.id,seq:f.original.seq,part:1,limit:15000})).content);
  assert.equal(note.text,f.text.slice(0,12000));
  assert.equal((await f.read.execute(f.ctx,{ref:`history:${f.foreign.id}:anything:0`})).ok,false);
 }finally{f.store.db.close();}
});

test('Bot and Room history deny other sessions even in the same principal and use bounded indexed originals [AC:bot-history-memory#AC-1] [AC:bot-rooms#AC-2]',async()=>{
 for(const room of [false,true]){const f=fixture();try{
  const session=f.store.updateSession(f.current.id,{metadata:{...f.current.metadata,botId:'private-bot',...(room?{roomId:'room-one'}:{})}});
  const original=f.store.appendMessage(session.id,'user',[{type:'text',text:'part zero'},{type:'tool_result',toolCallId:'source',name:'software',ok:true,content:f.text}]);
  f.store.appendReplacement(session.id,{startSeq:original.seq,endSeq:original.seq,role:'system',parts:[{type:'text',text:'Summary'}]});
  f.store.listSurfaceNodes=()=>{throw new Error('Unbounded original hydration is forbidden for Bot/Room history');};
  const ctx={session};
  assert.equal((await f.search.execute(ctx,{query:'originalneedle',session_id:f.old.id})).ok,false);
  assert.equal((await f.read.execute(ctx,{ref:`history:${f.old.id}:${f.original.id}:1`})).ok,false);
  assert.equal((await f.read.execute(ctx,{session_id:f.old.id,seq:f.original.seq})).ok,false);
  const search=JSON.parse((await f.search.execute(ctx,{query:'originalneedle'})).content);
  assert.equal(search.messages.length,1);assert.equal(search.matches[0].messageId,original.id);
  let offset=0,text='';do{const result=await f.read.execute(ctx,{ref:search.matches[0].ref,offset,limit:1200});assert.equal(result.ok,true);const page=JSON.parse(result.content);text+=page.text;offset=page.nextOffset;}while(offset!==null);
  assert.equal(text,f.text);
  const note=JSON.parse((await f.read.execute(ctx,{session_id:session.id,seq:original.seq,part:1,offset:15,limit:500})).content);
  assert.equal(note.text,f.text.slice(15,515));
  assert.equal((await f.read.execute(ctx,{ref:`history:${session.id}:${original.id}:99`})).ok,false);
  const child=f.store.createSession({title:'child',mode:'subagent',agentId:'general',parentSessionId:session.id,metadata:{userId:'owner',tenantId:'tenant'}});
  const childSource=f.store.appendMessage(child.id,'user',[{type:'text',text:'childneedle'}]);
  assert.equal((await f.read.execute({session:child},{ref:`history:${session.id}:${original.id}:1`})).ok,false);
  assert.equal(JSON.parse((await f.read.execute({session:child},{seq:childSource.seq})).content).message.parts[0].text,'childneedle');
 }finally{f.store.db.close();}}
});

test('indexed id read never returns another session or replacement node [AC:bot-history-memory#AC-1]',()=>{
 const f=fixture();try{assert.equal(f.store.readHistoryById(f.old.id,f.original.id).id,f.original.id);assert.equal(f.store.readHistoryById(f.current.id,f.original.id),undefined);const replacement=f.store.listSurfaceNodes(f.old.id).find(row=>row.surfaceOp==='replace');assert.equal(f.store.readHistoryById(f.old.id,replacement.id),undefined);}finally{f.store.db.close();}
});

test('Bot legacy context and time-only original history stay available through the unified pair [AC:bot-history-memory#AC-1]',async()=>{
 const f=fixture();try{
  const session=f.store.updateSession(f.current.id,{metadata:{...f.current.metadata,botId:'private-bot'}});
  const left=f.store.appendMessage(session.id,'user',[{type:'text',text:'left original'}]);
  const middle=f.store.appendMessage(session.id,'assistant',[{type:'text',text:'middle original'}]);
  const right=f.store.appendMessage(session.id,'user',[{type:'text',text:'right original'}]);
  f.store.appendReplacement(session.id,{startSeq:middle.seq,endSeq:middle.seq,role:'system',parts:[{type:'text',text:'summary'}]});
  f.store.listSurfaceNodes=()=>{throw new Error('No whole-WAL hydration');};
  const context=JSON.parse((await f.read.execute({session},{seq:middle.seq,before:1,after:1})).content);
  assert.equal(context.message.id,middle.id);assert.deepEqual(context.messages.map(message=>message.id),[left.id,middle.id,right.id]);
  assert.ok(!f.search.inputSchema.required?.includes('query'));
  const page=JSON.parse((await f.search.execute({session},{from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z'})).content);
  assert.deepEqual(page.messages.map(message=>message.id),[left.id,middle.id,right.id]);
  assert.equal((await f.search.execute(f.ctx,{from:'2000-01-01T00:00:00Z'})).ok,false,'ordinary upstream still requires query');
 }finally{f.store.db.close();}
});

test('anonymous history keeps the current-session indexed messages and default context contracts [AC:bot-history-memory#AC-1]',async()=>{
 const f=fixture();try{
  const session=f.store.createSession({title:'anonymous',mode:'chat',agentId:'general',metadata:{}});
  const other=f.store.createSession({title:'anonymous other',mode:'chat',agentId:'general',metadata:{}});
  const original=f.store.appendMessage(session.id,'user',[{type:'text',text:'anonymousneedle own'}]);
  f.store.appendMessage(other.id,'user',[{type:'text',text:'anonymousneedle foreign'}]);
  f.store.listSurfaceNodes=()=>{throw new Error('No whole-WAL hydration');};
  const search=JSON.parse((await f.search.execute({session},{query:'anonymousneedle'})).content);
  assert.deepEqual(search.messages.map(message=>message.id),[original.id]);
  assert.equal((await f.search.execute({session},{query:'anonymousneedle',session_id:other.id})).ok,false);
  const legacy=JSON.parse((await f.read.execute({session},{seq:original.seq})).content);
  assert.equal(legacy.message.id,original.id);assert.deepEqual(legacy.messages.map(message=>message.id),[original.id]);
  const bounded=JSON.parse((await f.read.execute({session},{seq:original.seq,part:0,offset:1,limit:5})).content);
  assert.equal(bounded.text,'nonym');
 }finally{f.store.db.close();}
});

test('runtime exposes exactly one history_search and one history_read after upstream integration [AC:bot-history-memory#AC-1]',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'history-catalog-'));const runtime=new RawAgentRuntime({repoRoot:directory,stateDir:join(directory,'state'),modelAdapter:{name:'catalog',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'ok'}]};},async summarizeMessages(){return '';}}});
 try{for(const name of ['history_search','history_read'])assert.equal(runtime.tools.filter(tool=>tool.name===name).length,1,name);}finally{try{await runtime.destroy();}catch{try{runtime.store?.db?.close();}catch{/* already closed */}}rmSync(directory,{recursive:true,force:true});}
});
