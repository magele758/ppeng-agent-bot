import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStateStore } from '../dist/storage.js';
import { createHistoryTools } from '../dist/session/history/tools.js';
import { historyReference, searchHistory, readHistory } from '../dist/session/history-retrieval.js';

function fixture() {
 const store = new SqliteStateStore(':memory:');
 store.upsertAgent({id:'general',name:'General',role:'assistant',instructions:'',capabilities:[]});
 const session = store.createSession({title:'Bot conversation',mode:'chat',agentId:'general',metadata:{userId:'owner',botId:'bot-alpha'}});
 const privateBefore=store.appendMessage(session.id,'user',[{type:'text',text:'private unaffected needle before'}]);
 const exposed=store.appendMessage(session.id,'assistant',[{type:'text',text:'REVOKED_GROUP_SECRET needle'}]);
 const privateAfter=store.appendMessage(session.id,'user',[{type:'text',text:'private unaffected needle after'}]);
 store.setDaemonControl(`bot.sharedExposure:${session.id}`, {revoked:[{fromSeq:exposed.seq,toSeq:exposed.seq,startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:01:00Z'}]});
 const tools = createHistoryTools(store);
 return {store,session,privateBefore,exposed,privateAfter,ctx:{session},search:tools.find(t=>t.name==='history_search'),read:tools.find(t=>t.name==='history_read')};
}

test('Bot history search hides revoked group messages in both matches and original page [AC:bot-functional-groups#AC-9]', async()=>{
 const f=fixture();try {
  const result=await f.search.execute(f.ctx,{query:'needle'});
  assert.equal(result.ok,true);
  const page=JSON.parse(result.content);
  assert.deepEqual(page.messages.map(m=>m.id),[f.privateBefore.id,f.privateAfter.id]);
  assert.deepEqual(page.matches.map(m=>m.messageId),[f.privateBefore.id,f.privateAfter.id]);
  assert.ok(!result.content.includes('REVOKED_GROUP_SECRET'));
  assert.equal(f.store.listMessages(f.session.id).length,3,'retained user-visible history stays intact');
 }finally{f.store.db.close();}
});

test('revoked group originals cannot be reread by known reference, seq or neighbour context [AC:bot-functional-groups#AC-9]',async()=>{
 const f=fixture();try {
  for(const args of [{ref:historyReference(f.session.id,f.exposed.id,0)}, {seq:f.exposed.seq}, {seq:f.exposed.seq,part:0,offset:0}]) {
   assert.equal((await f.read.execute(f.ctx,args)).ok,false);
  }
  const result=await f.read.execute(f.ctx,{seq:f.privateAfter.seq,before:3,after:1});
  assert.equal(result.ok,true);
  const context=JSON.parse(result.content);
  assert.equal(context.message.id,f.privateAfter.id);
  assert.deepEqual(context.messages.map(m=>m.id),[f.privateBefore.id,f.privateAfter.id]);
  assert.ok(!result.content.includes('REVOKED_GROUP_SECRET'));
 }finally{f.store.db.close();}
});

test('visible-history source helpers enforce revocation too without changing ordinary original reads [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture();try {
  assert.deepEqual(searchHistory(f.store,f.session.id,{query:'REVOKED_GROUP_SECRET'}).matches,[]);
  assert.equal(readHistory(f.store,f.session.id,{ref:historyReference(f.session.id,f.exposed.id,0)}),null);
  assert.equal(readHistory(f.store,f.session.id,{seq:f.privateBefore.seq}).text,'private unaffected needle before');
  f.store.setDaemonControl(`bot.sharedExposure:${f.session.id}`,{revoked:[]});
  assert.equal(readHistory(f.store,f.session.id,{seq:f.exposed.seq}).text,'REVOKED_GROUP_SECRET needle');
 }finally{f.store.db.close();}
});

test('moving a Bot revokes history sources exposed to the old group while retaining its transcript [AC:bot-functional-groups#AC-9]',async()=>{
 const {createBot,setBotDefinitionOwner}=await import('../dist/bots/index.js');
 const {BotFunctionalGroupService}=await import('../dist/bots/functional-groups.js');
 const store=new SqliteStateStore(':memory:');
 try {
  const facade={store,runImageRetention:async()=>{},wakeAllAutonomousSessions:()=>{},wakeAgentSessions:()=>{}};
  const bot=createBot(facade,{name:'Researcher'});
  const principal={userId:'owner'};
  setBotDefinitionOwner(store,bot.id,principal);
  const prior=store.getSession(bot.canonicalSessionId);
  const session=store.updateSession(prior.id,{metadata:{...prior.metadata,...principal}});
  const groups=new BotFunctionalGroupService(store),old=groups.create(principal,'Old'),next=groups.create(principal,'Next');
  groups.move(principal,bot.id,old.id);
  groups.setShared(principal,{scope:'group',id:old.id},{secret:'OLD_TEAM_SECRET'});
  const privateMessage=store.appendMessage(session.id,'user',[{type:'text',text:'Earlier private note'}]);
  store.appendMessage(session.id,'user',[{type:'text',text:'What is the shared secret?'}]);
  assert.match(groups.appendix(session),/OLD_TEAM_SECRET/);
  const exposed=store.appendMessage(session.id,'assistant',[{type:'text',text:'OLD_TEAM_SECRET'}]);
  groups.move(principal,bot.id,next.id);
  const tools=createHistoryTools(store),read=tools.find(tool=>tool.name==='history_read'),search=tools.find(tool=>tool.name==='history_search');
  assert.equal((await read.execute({session},{ref:historyReference(session.id,exposed.id,0)})).ok,false);
  const found=await search.execute({session},{query:'OLD_TEAM_SECRET'});
  assert.ok(!found.content.includes('OLD_TEAM_SECRET'));
  assert.equal((await read.execute({session},{seq:privateMessage.seq})).ok,true);
  assert.ok(JSON.stringify(store.listMessages(session.id)).includes('OLD_TEAM_SECRET'),'history remains available in stored conversation');
 }finally{store.db.close();}
});
