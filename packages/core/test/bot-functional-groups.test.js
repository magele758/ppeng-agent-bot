import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot, setBotDefinitionOwner, resolveBotPrincipal } from '../dist/bots/index.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { BotFunctionalGroupService } from '../dist/bots/functional-groups.js';
import { bindMemoryAppendixPrompt } from '../dist/runtime/l5-bindings.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'functional-groups-')), 'state.db');
  const store = new SqliteStateStore(path);
  const facade = {store, runImageRetention:async()=>{},wakeAllAutonomousSessions:()=>{},wakeAgentSessions:()=>{}};
  const a = createBot(facade,{name:'Alpha'}), b=createBot(facade,{name:'Beta'}), c=createBot(facade,{name:'Gamma'});
  const principal={userId:'owner'};
  for(const bot of [a,b,c]) { store.updateSession(bot.canonicalSessionId,{metadata:{...store.getSession(bot.canonicalSessionId).metadata,...principal}}); setBotDefinitionOwner(store,bot.id,principal); }
  const groups = new BotFunctionalGroupService(store);
  const rooms = new BotRoomService({store,createChatSession:()=>{throw Error('unused');},runSession:async()=>{},cancelSession:()=>{}});
  return {path,store,facade,a,b,c,principal,groups,rooms};
}

test('functional groups and moves survive reopen; deleting a group preserves bots and private history [AC:bot-functional-groups#AC-6] [AC:bot-functional-groups#AC-7]',()=>{
 const f=fixture();const g=f.groups.create(f.principal,'Research');
 f.store.appendMessage(f.a.canonicalSessionId,'user',[{type:'text',text:'PRIVATE'}]);
 f.groups.move(f.principal,f.a.id,g.id);
 assert.deepEqual(new BotFunctionalGroupService(f.store).get(f.principal,g.id).botIds,[f.a.id]);
 f.groups.rename(f.principal,g.id,'Writing');
 const reopenedStore = new SqliteStateStore(f.path);
 const reopened = new BotFunctionalGroupService(reopenedStore);
 assert.equal(reopened.list(f.principal)[0].name,'Writing');
 assert.deepEqual(reopened.get(f.principal,g.id).botIds,[f.a.id]);
 reopenedStore.db.close();
 f.groups.delete(f.principal,g.id);
 assert.equal(f.groups.groupIdForBot(f.principal,f.a.id),null);
 assert.equal(f.groups.list(f.principal).length,0);
 assert.ok(f.store.getBot(f.a.id));assert.equal(f.store.listMessages(f.a.canonicalSessionId).length,1);
});

test('shared facts resolve room over group over global and reach the actual turn appendix [AC:bot-functional-groups#AC-8]',async()=>{
 const f=fixture(),g=f.groups.create(f.principal,'Research');f.groups.move(f.principal,f.a.id,g.id);
 const room=f.rooms.create(f.principal,{title:'Room',botIds:[f.a.id,f.b.id]});
 f.groups.setShared(f.principal,{scope:'global'},{location:'global',fallback:'yes'});
 f.groups.setShared(f.principal,{scope:'group',id:g.id},{location:'group'});
 f.groups.setShared(f.principal,{scope:'room',id:room.id},{location:'room'});
 const plain=f.store.getSession(f.a.canonicalSessionId);
 assert.equal(f.groups.sharedForSession(plain).location,'group');
 assert.equal(f.groups.sharedForSession(f.store.getSession(f.b.canonicalSessionId)).location,'global');
 const roomSession={...plain,metadata:{...plain.metadata,botId:f.a.id,roomId:room.id}};
 assert.deepEqual(f.groups.sharedForSession(roomSession),{location:'room',fallback:'yes'});
 const prompt={lastCognitivePhaseBySession:new Map(),getRouting:()=>{},buildStablePrefix:()=>'',buildSystemPrompt:()=>'',buildMemoryAppendixAsync:async()=> 'private notes'};
 const binding=bindMemoryAppendixPrompt({store:f.store,promptBuilder:prompt,stateDir:'/tmp'});
 const appendix=await binding.buildMemoryAppendix({session:roomSession});
 assert.match(appendix,/room/);assert.match(appendix,/fallback/);assert.doesNotMatch(appendix,/"location":"group"/);
});

test('scope isolation and reassignment revoke old group reads without exposing private history [AC:bot-functional-groups#AC-9] [AC:bot-functional-groups#AC-10]',()=>{
 const f=fixture(),g1=f.groups.create(f.principal,'One'),g2=f.groups.create(f.principal,'Two');
 f.groups.move(f.principal,f.a.id,g1.id);f.groups.move(f.principal,f.b.id,g2.id);
 f.store.appendMessage(f.a.canonicalSessionId,'user',[{type:'text',text:'PRIVATE_SECRET'}]);
 f.groups.setShared(f.principal,{scope:'group',id:g1.id},{secret:'ONE'});
 f.groups.setShared(f.principal,{scope:'group',id:g2.id},{secret:'TWO'});
 const session=f.store.getSession(f.a.canonicalSessionId);
 assert.equal(f.groups.sharedForSession(session).secret,'ONE');
 f.groups.move(f.principal,f.a.id,g2.id);
 assert.equal(f.groups.sharedForSession(session).secret,'TWO');
 assert.ok(!JSON.stringify(f.groups.sharedForSession(session)).includes('PRIVATE_SECRET'));
 f.groups.move(f.principal,f.a.id,null);assert.deepEqual(f.groups.sharedForSession(session),{});
 assert.throws(()=>f.groups.get({userId:'stranger'},g1.id));
 assert.throws(()=>f.groups.setShared({userId:'stranger'},{scope:'group',id:g1.id},{secret:'hack'}));
 assert.throws(()=>f.groups.move({userId:'stranger'},f.a.id,null));
 const otherRoom=f.rooms.create(f.principal,{title:'Private room',botIds:[f.b.id,f.c.id]});
 f.groups.setShared(f.principal,{scope:'room',id:otherRoom.id},{roomSecret:'OTHER'});
 assert.deepEqual(f.groups.sharedForSession({...session,metadata:{...session.metadata,roomId:otherRoom.id,botId:f.a.id}}),{});
});

test('invalid names and destinations leave the prior membership intact',()=>{
 const f=fixture(),g=f.groups.create(f.principal,'One');f.groups.move(f.principal,f.a.id,g.id);
 assert.throws(()=>f.groups.move(f.principal,f.a.id,'missing'));
 assert.equal(f.groups.groupIdForBot(f.principal,f.a.id),g.id);
 assert.throws(()=>f.groups.create(f.principal,'  '));
 assert.throws(()=>f.groups.setShared(f.principal,{scope:'global'},{key:5}));
});


function childOf(f, parent, metadata = {}, mode = 'subagent') {
  return f.store.createSession({title:'Child',mode,agentId:f.b.agentId,parentSessionId:parent.id,
    metadata:{...f.principal,botId:f.b.id,...metadata}});
}

test('child uses parent identity and current membership despite forged bot and room metadata [AC:bot-functional-groups#AC-8] [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture(),g1=f.groups.create(f.principal,'One'),g2=f.groups.create(f.principal,'Two');
 f.groups.move(f.principal,f.a.id,g1.id);f.groups.move(f.principal,f.b.id,g2.id);
 f.groups.setShared(f.principal,{scope:'global'},{fallback:'GLOBAL'});
 f.groups.setShared(f.principal,{scope:'group',id:g1.id},{secret:'ONE'});
 f.groups.setShared(f.principal,{scope:'group',id:g2.id},{secret:'TWO'});
 const foreignRoom=f.rooms.create(f.principal,{title:'Other room',botIds:[f.b.id,f.c.id]});
 f.groups.setShared(f.principal,{scope:'room',id:foreignRoom.id},{secret:'OTHER_ROOM'});
 const parent=f.store.getSession(f.a.canonicalSessionId);
 const child=childOf(f,parent,{roomId:foreignRoom.id});
 const teammate=childOf(f,child,{roomId:foreignRoom.id},'teammate');
 assert.deepEqual(f.groups.sharedForSession(teammate),{fallback:'GLOBAL',secret:'ONE'});
 f.groups.move(f.principal,f.a.id,g2.id);
 assert.deepEqual(f.groups.sharedForSession(teammate),{fallback:'GLOBAL',secret:'TWO'});
 f.groups.move(f.principal,f.a.id,null);
 assert.deepEqual(f.groups.sharedForSession(teammate),{fallback:'GLOBAL'});
 f.store.db.close();
});

test('child parent pointers cannot grant another user or tenant shared facts [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture();
 f.groups.setShared(f.principal,{scope:'global'},{secret:'OWNER'});
 const parent=f.store.getSession(f.a.canonicalSessionId);
 for(const identity of [{userId:'stranger'},{userId:f.principal.userId,tenantId:'other-tenant'}]) {
   const child=childOf(f,parent,identity);
   assert.deepEqual(f.groups.sharedForSession(child),{},'cross-principal parent pointer must fail closed');
 }
 f.store.db.close();
});

test('cyclic and over-limit child ancestry fails closed instead of resolving a child supplied identity [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture();
 f.groups.setShared(f.principal,{scope:'global'},{secret:'DO_NOT_LEAK'});
 const parent=f.store.getSession(f.a.canonicalSessionId);
 // The declared parent resolves back to the child itself.
 const cycle=childOf(f,parent);
 f.store.db.prepare('UPDATE sessions SET parent_session_id=? WHERE id=?').run(cycle.id,cycle.id);
 assert.deepEqual(f.groups.sharedForSession(f.store.getSession(cycle.id)),{});
 let deepest=parent;
 for(let depth=0;depth<8;depth++) deepest=childOf(f,deepest);
 assert.deepEqual(f.groups.sharedForSession(deepest),{});
 f.store.db.close();
});

test('tenant ownership partitions moves and shared scopes even for the same user id [AC:bot-functional-groups#AC-9] [AC:bot-functional-groups#AC-10]',()=>{
 const f=fixture(),tenantA={userId:'owner',tenantId:'a'},tenantB={userId:'owner',tenantId:'b'};
 f.store.updateSession(f.a.canonicalSessionId,{metadata:{...f.store.getSession(f.a.canonicalSessionId).metadata,...tenantA}});
 setBotDefinitionOwner(f.store,f.a.id,tenantA);
 const group=f.groups.create(tenantA,'Tenant A');
 f.groups.move(tenantA,f.a.id,group.id);
 f.groups.setShared(tenantA,{scope:'global'},{secret:'A_GLOBAL'});
 f.groups.setShared(tenantA,{scope:'group',id:group.id},{secret:'A_GROUP'});
 const peer=createBot(f.facade,{name:'TenantPeer'});
 f.store.updateSession(peer.canonicalSessionId,{metadata:{...f.store.getSession(peer.canonicalSessionId).metadata,...tenantA}});
 setBotDefinitionOwner(f.store,peer.id,tenantA);
 const room=f.rooms.create(tenantA,{title:'Tenant A room',botIds:[f.a.id,peer.id]});
 f.groups.setShared(tenantA,{scope:'room',id:room.id},{secret:'A_ROOM'});
 assert.throws(()=>f.groups.move(tenantB,f.a.id,null));
 assert.throws(()=>f.groups.getShared(tenantB,{scope:'group',id:group.id}));
 assert.throws(()=>f.groups.getShared(tenantB,{scope:'room',id:room.id}));
 const session=f.store.getSession(f.a.canonicalSessionId);
 assert.deepEqual(f.groups.sharedForSession({...session,metadata:{...session.metadata,...tenantB}}),{});
 assert.deepEqual(f.groups.getShared(tenantB,{scope:'global'}),{});
 f.store.db.close();
});


test('shared roster Bot keeps separate functional memberships and facts for each principal [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture(),other={userId:'second-user'};
 setBotDefinitionOwner(f.store,f.a.id,resolveBotPrincipal(f.store));
 const firstGroup=f.groups.create(f.principal,'First group'),secondGroup=f.groups.create(other,'Second group');
 f.groups.move(f.principal,f.a.id,firstGroup.id);
 f.groups.move(other,f.a.id,secondGroup.id);
 f.groups.setShared(f.principal,{scope:'group',id:firstGroup.id},{secret:'FIRST'});
 f.groups.setShared(other,{scope:'group',id:secondGroup.id},{secret:'SECOND'});
 const session=f.store.getSession(f.a.canonicalSessionId);
 const otherSession=f.store.createSession({title:'Second principal Bot',mode:'chat',agentId:f.a.agentId,metadata:{...other,botId:f.a.id}});
 assert.deepEqual(f.groups.sharedForSession(session),{secret:'FIRST'});
 assert.deepEqual(f.groups.sharedForSession(otherSession),{secret:'SECOND'});
 f.groups.move(other,f.a.id,null);
 assert.deepEqual(f.groups.sharedForSession(otherSession),{});
 assert.deepEqual(f.groups.sharedForSession(session),{secret:'FIRST'});
 f.store.db.close();
});

test('next prompt reads saved shared changes, deletes and owner isolation [AC:bot-workspace-interaction-polish#AC-6]', async () => {
 const f=fixture(), group=f.groups.create(f.principal,'Scoped');
 f.groups.move(f.principal,f.a.id,group.id);
 const prompt={lastCognitivePhaseBySession:new Map(),getRouting:()=>{},buildStablePrefix:()=>'',buildSystemPrompt:()=>'',buildMemoryAppendixAsync:async()=>''};
 const binding=bindMemoryAppendixPrompt({store:f.store,promptBuilder:prompt,stateDir:'/tmp'});
 const read=()=>binding.buildMemoryAppendix({session:f.store.getSession(f.a.canonicalSessionId)});
 f.groups.setShared(f.principal,{scope:'global'},{language:'GLOBAL'});
 f.groups.setShared(f.principal,{scope:'group',id:group.id},{language:'GROUP'});
 f.groups.setShared({userId:'other'},{scope:'global'},{secret:'OTHER_USER_SECRET'});
 assert.match(await read(),/GROUP/); assert.doesNotMatch(await read(),/GLOBAL|OTHER_USER_SECRET/);
 f.groups.setShared(f.principal,{scope:'group',id:group.id},{language:'UPDATED'});
 assert.match(await read(),/UPDATED/); assert.doesNotMatch(await read(),/GROUP/);
 f.groups.setShared(f.principal,{scope:'group',id:group.id},{});
 assert.match(await read(),/GLOBAL/); assert.doesNotMatch(await read(),/UPDATED/);
 f.store.db.close();
});
