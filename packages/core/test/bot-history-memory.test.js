import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createHistoryTools } from '../dist/session/history/tools.js';
import { resolveBotWindowBudget } from '../dist/session/history/window.js';
const fresh = () => new SqliteStateStore(join(mkdtempSync(join(tmpdir(),'history-')), 'db'));
test('raw history survives replacements, time filters and exact context [AC:bot-history-memory#AC-1]', () => {
 const s=fresh(); const c=s.createSession({title:'bot',mode:'chat',agentId:'a'});
 const a=s.appendMessage(c.id,'user',[{type:'text',text:'original unique fact'}]);
 s.appendMessage(c.id,'assistant',[{type:'text',text:'answer'}]);
 s.appendReplacement(c.id,{startSeq:a.seq,endSeq:a.seq,role:'system',parts:[{type:'text',text:'summary'}]});
 const p=s.listHistory(c.id,{query:'unique',from:a.createdAt,to:a.createdAt});
 assert.equal(p.messages.length,1); assert.equal(p.messages[0].id,a.id);
 assert.equal(s.readHistory(c.id,a.seq,1,1).message.id,a.id);
 assert.equal(s.listHistory(c.id,{query:'summary'}).messages.length,0);
 s.db.close();
});
test('history role filter keeps the latest user rows [AC:bot-session-row#AC-1]', () => {
 const s=fresh(); const c=s.createSession({title:'bot',mode:'chat',agentId:'a'});
 s.appendMessage(c.id,'assistant',[{type:'text',text:'answer'}]);
 const user=s.appendMessage(c.id,'user',[{type:'text',text:'question'}]);
 s.appendMessage(c.id,'assistant',[{type:'text',text:'later'}]);
 const page=s.listHistory(c.id,{role:'user',limit:4});
 assert.deepEqual(page.messages.map(m=>m.id),[user.id]);
 assert.throws(()=>s.listHistory(c.id,{role:'nope'}),/Invalid history role/);
 s.db.close();
});
test('stable cursor pages concurrent history without repeats [AC:bot-history-memory#AC-2]', () => {
 const s=fresh(); const c=s.createSession({title:'bot',mode:'chat',agentId:'a'});
 for(let n=0;n<123;n++) s.appendMessage(c.id,'user',[{type:'text',text:String(n)}]);
 const first=s.listHistory(c.id,{limit:50});
 s.appendMessage(c.id,'user',[{type:'text',text:'new'}]);
 const all=[...first.messages]; let cursor=first.nextCursor;
 while(cursor){const p=s.listHistory(c.id,{limit:50,beforeSeq:cursor});all.push(...p.messages);cursor=p.nextCursor;}
 assert.equal(all.length,123);assert.equal(new Set(all.map(m=>m.id)).size,123);
 assert.ok(first.messages[0].seq < first.messages.at(-1).seq);
 s.db.close();
});
test('actual model windows reserve system/tool overhead [AC:bot-history-memory#AC-3]',()=>{
 const legacy={getDaemonControl:()=>({fallbackContextTokens:32768})};
 const named=resolveBotWindowBudget(legacy,{contextWindow:64000},{systemPromptChars:4000,toolCount:10});
 assert.equal(named.contextTokens,64000);
 assert.equal(named.structuredTokens,32000);
 assert.equal(named.hygieneTokens,54400);
 const small=resolveBotWindowBudget(legacy,{contextWindow:8000},{systemPromptChars:4000,toolCount:10});
 assert.equal(small.structuredTokens,4000);
 assert.equal(small.hygieneTokens,6800);
 assert.ok(small.historyTokens < small.structuredTokens);
 const saved=resolveBotWindowBudget(legacy,{},{});
 assert.equal(saved.contextTokens,32768);
 assert.equal(saved.structuredTokens,16384);
 assert.equal(saved.hygieneTokens,27852);
 const unset=resolveBotWindowBudget({getDaemonControl:()=>undefined},{},{});
 assert.equal(unset.contextTokens,131072);
 assert.equal(unset.structuredTokens,65536);
 assert.equal(unset.hygieneTokens,111411);
 assert.ok(unset.historyTokens >= unset.hygieneTokens);
 const custom={getDaemonControl:()=>({fallbackContextTokens:90000})};
 assert.equal(resolveBotWindowBudget(custom,{},{}).contextTokens,90000);
});
test('model history tools only operate current session [AC:bot-history-memory#AC-1]',async()=>{
 const s=fresh(); const a=s.createSession({title:'a',mode:'chat',agentId:'a'}),b=s.createSession({title:'b',mode:'chat',agentId:'b'});
 s.appendMessage(a.id,'user',[{type:'text',text:'own'}]);s.appendMessage(b.id,'user',[{type:'text',text:'secret'}]);
 const tool=createHistoryTools(s).find(t=>t.name==='history_search');
 const r=await tool.execute({session:a},{query:'secret',sessionId:b.id});assert.equal(JSON.parse(r.content).messages.length,0);s.db.close();
});
test('memory sources persist and edit/delete invalidate recall vectors [AC:bot-history-memory#AC-4]',()=>{
 const s=fresh(), am=s.agentMemory();
 const data={scope:'user.memory',namespace:'semantic',key:'fact:city',value:'city is old',userId:'owner',agentId:'bot',sourceRefs:[{sessionId:'s',messageId:'m',seq:1}]};
 const m=am.set(data); assert.equal(m.sourceRefs[0].messageId,'m');
 am.putEmbedding(m.id,[1,2]);am.set({...data,value:'city is corrected'});
 assert.equal(am.getEmbedding(m.id),null);assert.equal(am.getEntryById(m.id).value,'city is corrected');
 am.delete(m.id);assert.equal(am.getEntryById(m.id),null);assert.equal(am.search({userId:'owner',agentId:'bot'}).length,0);s.db.close();
});
test('installation and login memory extraction retain separate principals [AC:bot-history-memory#AC-5]',async()=>{
 const {scheduleMemoryTurnEnd}=await import('../dist/memory/memory-turn-end.js');
 const {createBot,openBot}=await import('../dist/bots/bot-facade.js');
 const {compileTurnAppendix}=await import('../dist/session/context-compiler.js');
 const s=fresh(),host={store:s}; const bot=createBot(host,{name:'Memory bot'});
 const local=openBot(host,bot.id); const session=s.getSession(local.sessionId);
 const msg=s.appendMessage(session.id,'user',[{type:'text',text:'请记住我叫小明，偏好简洁中文回答'}]);
 scheduleMemoryTurnEnd({store:s.agentMemory(),settingsStore:s,session,messages:[msg],botLookup:s,agentId:bot.id});
 await new Promise(resolve=>setTimeout(resolve,20));
 const localRows=s.agentMemory().search({userId:session.metadata.userId,agentId:bot.id});
 assert.ok(localRows.some(row=>row.value.includes('小明'))); assert.equal(localRows[0].sourceRefs[0].messageId,msg.id);
 const logged=s.getSession(openBot(host,bot.id,{userId:'another'}).sessionId);
 assert.equal(s.agentMemory().search({userId:'another',agentId:bot.id}).length,0);
 assert.ok(compileTurnAppendix({session,query:'小明',store:s}).includes('小明'));
 assert.ok(!compileTurnAppendix({session:logged,query:'小明',store:s}).includes('小明'));s.db.close();
});
test('200 turns and 12 replacement boundaries preserve 100 source facts [AC:bot-history-memory#AC-6]',()=>{
 const s=fresh(),c=s.createSession({title:'long',mode:'chat',agentId:'bot'});const facts=[];
 for(let n=0;n<200;n++){const m=s.appendMessage(c.id,n%2?'assistant':'user',[{type:'text',text:n%2?'Acknowledged':`source-fact-${n/2} deadline retained`}]);if(n%2===0)facts.push(m);}
 for(let n=0;n<12;n++){const start=1+n*16;s.appendReplacement(c.id,{startSeq:start,endSeq:start+15,role:'system',parts:[{type:'text',text:'Goal: continuing; Constraints: deadline; Next steps: pending'}]});}
 for(const m of facts){const found=s.readHistory(c.id,m.seq,0,0);assert.equal(found.message.id,m.id);assert.deepEqual(found.message.parts,m.parts);}
 assert.equal(s.listHistory(c.id,{query:'source-fact-',limit:200}).messages.length,100);s.db.close();
});
test('100000 raw messages paginate and search in real SQLite [AC:bot-history-memory#AC-2]',()=>{
 const s=fresh(),c=s.createSession({title:'scale',mode:'chat',agentId:'bot'});
 const insert=s.db.prepare('INSERT INTO session_messages(id,session_id,role,parts_json,created_at,seq,surface_op) VALUES(?,?,?,?,?,?,?)');
 s.db.exec('BEGIN');try{for(let n=1;n<=100000;n++)insert.run('scale-'+n,c.id,'user',JSON.stringify([{type:'text',text:n===12345?'rare searchable original':'ordinary '+n}]),'2026-10-13T00:00:00.000Z',n,'append');s.db.exec('COMMIT');}catch(e){s.db.exec('ROLLBACK');throw e;}
 const begin=performance.now(), page=s.listHistory(c.id,{limit:50});const pageMs=performance.now()-begin;
 const scan=performance.now(),found=s.listHistory(c.id,{query:'rare searchable original',limit:50});const searchMs=performance.now()-scan;
 assert.equal(page.messages.length,50);assert.equal(found.messages[0].seq,12345);
 console.log(JSON.stringify({workload:'100000 history messages',pageMs,searchMs}));s.db.close();
});
test('real Bot model execution repacks against actual adapter window [AC:bot-history-memory#AC-3]',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');
 const {bindTurnKernelHost}=await import('../dist/runtime/l5-bindings.js');
 let captured, summaries=0;
 const adapter={name:'window-test',contextWindow:8192,async runTurn(input){captured=input;return {assistantParts:[{type:'text',text:'done'}],stopReason:'end'};},async summarizeMessages(){summaries++;return 'Goal: keep going\nConstraints: preserve deadline\nNext steps: unfinished';}};
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'window-repo-')),stateDir:mkdtempSync(join(tmpdir(),'window-state-')),modelAdapter:adapter});
 const b=rt.createBot({name:'Window bot'}),session=rt.getSession(rt.openBot(b.id).sessionId);
 for(let n=0;n<40;n++)rt.store.appendMessage(session.id,n%2?'assistant':'user',[{type:'text',text:'x'.repeat(700)}]);
 const host=bindTurnKernelHost(rt.l5());
 await host.runTurnWithRetries({sessionId:session.id,agent:rt.store.getAgent(b.agentId),systemPrompt:'s'.repeat(1000),messages:rt.store.foldMessages(session.id),tools:[]});
 assert.ok(summaries>=1);assert.ok(captured.messages.length<40);assert.equal(rt.store.listHistory(session.id,{limit:50}).messages.length,40);rt.store.db.close();
});
test('12 actual compactions preserve fixture constraints plus searchable original sources [AC:bot-history-memory#AC-6]',async()=>{
 const {autoCompactSession}=await import('../dist/runtime/compact-host.js');const {createExtensionRegistry}=await import('../dist/extensions/extension-registry.js');
 const s=fresh(),c=s.createSession({title:'quality fixture',mode:'chat',agentId:'bot',metadata:{botId:'bot',canonicalBotChat:true}});
 let calls=0;const adapter={name:'deterministic-fixture',contextWindow:8192,async summarizeMessages({messages}){calls++;const text=messages.flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.text)).join('\n');const facts=[...new Set(text.match(/FACT\d+/g)??[])];return `Goal: pending work\nConstraints: never erase deadline\nProgress: ${facts.join(' ')}\nDecisions: source anchored\nFiles: original history\nNext steps: unfinished`;}};
 const host={store:s,stateDir:mkdtempSync(join(tmpdir(),'compact-quality-')),modelAdapter:adapter,extensionRegistry:createExtensionRegistry(),turnShapeBySession:new Map(),emitTrace(){},prepareMessagesForModel:async(_c,m)=>m};
 const context={session:c,agent:{id:'bot',name:'bot',role:'assistant',instructions:'',capabilities:[]},repoRoot:'/tmp',stateDir:host.stateDir};
 for(let n=0;n<200;n++){
 s.appendMessage(c.id,n%2?'assistant':'user',[{type:'text',text:n%2?'continue':`FACT${n/2} original requirement`}]);
 if(n>=31&&(n+1)%16===0)await autoCompactSession(host,context,{force:true});
 }
 await autoCompactSession(host,context,{force:true});assert.equal(calls,12);
 assert.ok(s.getSession(c.id).summary.includes('never erase deadline'));assert.ok(s.getSession(c.id).summary.includes('unfinished'));
 for(let n=0;n<100;n++){const p=s.listHistory(c.id,{query:`FACT${n} original requirement`});assert.equal(p.messages.length,1);}
 assert.ok(s.agentMemory().search({sessionId:c.id,scope:'session.long'}).every(memory=>memory.sourceRefs?.length));s.db.close();
});
test('routine dialogue tools override optional group choice and respect Bot allowlists',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const {bindTurnKernelHost}=await import('../dist/runtime/l5-bindings.js');
 const old=process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS;process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS='1';
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'tools-repo-')),stateDir:mkdtempSync(join(tmpdir(),'tools-state-')),modelAdapter:{name:'fixture',runTurn:async()=>({assistantParts:[],stopReason:'end'}),summarizeMessages:async()=>''}});
 try {
 const bot=rt.createBot({name:'Routine owner'}),s=rt.getSession(rt.openBot(bot.id).sessionId);rt.mergeSessionMetadata(s.id,{enabledOptionalToolGroups:[]});
 rt.store.setDaemonControl('routine.settings',{dialogToolsEnabled:true});const host=bindTurnKernelHost(rt.l5());
 const input=()=>({session:rt.getSession(s.id),agent:rt.store.getAgent(bot.agentId),messages:[],systemPromptChars:0});
 const enabled=await host.resolveTurnTools(input());assert.ok(enabled.tools.some(t=>t.name==='cron_create'));
 rt.mergeSessionMetadata(s.id,{allowedTools:['memory_get']});const limited=await host.resolveTurnTools(input());assert.ok(!limited.tools.some(t=>t.name==='cron_create'));
 } finally {rt.store.db.close();if(old===undefined)delete process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS;else process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS=old;}
});
test('Room prompts and inherited child memory cannot recall private Bot facts',()=>{
 const s=fresh(),am=s.agentMemory();
 const room=s.createSession({title:'room',mode:'chat',agentId:'bot',metadata:{roomId:'room-1',botId:'bot',userId:'u'}});
 const child=s.createSession({title:'child',mode:'subagent',agentId:'worker',parentSessionId:room.id,metadata:{userId:'u'}});
 am.set({scope:'user.memory',namespace:'semantic',key:'fact:private',value:'PRIVATE_ROOM_SECRET_CONTACT',userId:'u',agentId:'bot'});
 return import('../dist/session/context-compiler.js').then(({compileTurnAppendix:compile})=>import('../dist/memory/bot-memory-scope.js').then(({resolveBotMemoryAgentId})=>{
  assert.equal(resolveBotMemoryAgentId(room,s),'room:room-1:bot');assert.equal(resolveBotMemoryAgentId(child,s),'room:room-1:bot');
  assert.ok(!compile({session:room,query:'PRIVATE_ROOM_SECRET_CONTACT',store:s}).includes('PRIVATE_ROOM_SECRET_CONTACT'));
  assert.ok(!compile({session:child,query:'PRIVATE_ROOM_SECRET_CONTACT',store:s}).includes('PRIVATE_ROOM_SECRET_CONTACT'));s.db.close();
 }));
});
test('real Room model input and memory_get tool exclude private Bot memory',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');let captured;
 const adapter={name:'room-spy',contextWindow:131072,async runTurn(input){captured=input;return {assistantParts:[{type:'text',text:'room reply'}],stopReason:'end'};},async summarizeMessages(){return ''}};
 const repoRoot=mkdtempSync(join(tmpdir(),'room-spy-repo-')),stateDir=mkdtempSync(join(tmpdir(),'room-spy-state-'));const rt=new RawAgentRuntime({repoRoot,stateDir,modelAdapter:adapter});
 try {
 const bot=rt.createBot({name:'Private worker'}), principal={userId:'u'}, room=rt.rooms.create(principal,{title:'Shared Room',botIds:[bot.id]});
 rt.store.agentMemory().set({scope:'user.memory',namespace:'semantic',key:'fact:private',value:'PRIVATE_CONTACT_ONLY_PERSONAL',userId:'u',agentId:bot.agentId});
 rt.rooms.send(principal,room.id,{text:'Recall the contact'});await rt.rooms.tick();assert.ok(captured);assert.ok(!JSON.stringify(captured.messages).includes('PRIVATE_CONTACT_ONLY_PERSONAL'));assert.ok(!captured.systemPrompt.includes('PRIVATE_CONTACT_ONLY_PERSONAL'));
 assert.ok(captured.sessionId, 'the model spy captures the actual Room execution context');
 const tool=rt.tools.find(t=>t.name==='memory_get');const response=await tool.execute({session:rt.getSession(captured.sessionId),agent:rt.store.getAgent(bot.agentId),repoRoot,stateDir},{scope:'user'});assert.ok(!response.content.includes('PRIVATE_CONTACT_ONLY_PERSONAL'));
 } finally {await rt.destroy();}
});
