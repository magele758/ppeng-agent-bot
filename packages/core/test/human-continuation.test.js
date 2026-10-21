import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {requestHumanRun,noteHumanModelInput,releaseHumanModelInput,requestSteerContinuation,dropHumanSteerContinuation,createHumanContinuationObserver,drainHumanContinuations,blockHumanContinuations,withHumanContinuationAdmission,hasHumanContinuationLease,unansweredHumanWork,runAnsweredHumanSession} from '../dist/session/human-continuation.js';
import {claimBotSession,releaseBotSession,updateBotWorkSettings} from '../dist/bots/bot-work.js';
function fixture(){const path=join(mkdtempSync(join(tmpdir(),'human-tail-')),'state.db');const store=new SqliteStateStore(path);const session=store.createSession({title:'human',mode:'chat',agentId:'general',background:false,metadata:{userId:'alice',botId:'quota-bot',outcome:{kind:'idle',reason:'end'}}});return {store,session,path};}
const ledger=(store,id)=>store.getDaemonControl('session.humanContinuation:'+id);
const add=(store,id,text)=>store.appendMessage(id,'user',[{type:'text',text}]);
const wait=()=>new Promise(r=>setImmediate(r));

test('actual snapshot acknowledges only input it contains, and skipped preparation acknowledges nothing [AC:bot-human-continuation#AC-1] [AC:bot-human-continuation#AC-2]',()=>{
 const {store,session}=fixture();const first=add(store,session.id,'one');requestHumanRun(store,session.id);const observe=createHumanContinuationObserver(store,session.id);noteHumanModelInput(store,session.id,[first]);assert.equal(ledger(store,session.id).pending.length,1);
 const second=add(store,session.id,'two');requestHumanRun(store,session.id);observe({type:'model_done',stopReason:'end'});assert.deepEqual(ledger(store,session.id).pending.map(r=>r.id),[second.id]);noteHumanModelInput(store,session.id,[second]);observe({type:'tools_done',results:[]});assert.equal(ledger(store,session.id).pending.length,1);observe({type:'model_done',stopReason:'end'});assert.equal(ledger(store,session.id).pending.length,0);store.db.close();
});

test('identical next-step and next-run text is acknowledged by its claimed receipt key [AC:bot-human-continuation#AC-3]',()=>{
 const {store,session}=fixture();const a=store.enqueueSteer(session.id,'identical',{target:'next-step'}),b=store.enqueueSteer(session.id,'identical',{target:'next-run'});requestSteerContinuation(store,session.id,a);requestSteerContinuation(store,session.id,b);assert.notEqual(a.key,b.key);
 const [claimed]=store.claimInbox(session.id,'next-step');const materialized=store.appendMessage(session.id,'user',[{type:'text',text:claimed.text}],{key:claimed.key});const observe=createHumanContinuationObserver(store,session.id);noteHumanModelInput(store,session.id,[materialized]);observe({type:'model_done',stopReason:'end'});assert.deepEqual(ledger(store,session.id).pending.map(r=>r.id),[b.id]);assert.equal(store.listUnclaimedInbox(session.id)[0].id,b.id);
 dropHumanSteerContinuation(store,session.id,b.id);assert.equal(ledger(store,session.id).pending.length,0);store.db.close();
});

test('slow continuation dispatch does not block the scheduler and active fencing prevents reentry [AC:bot-human-continuation#AC-1]',async()=>{
 const {store,session}=fixture();add(store,session.id,'unread');requestHumanRun(store,session.id);let resolve,calls=0;const gate=new Promise(r=>resolve=r);const host={store,isSessionRunning:()=>false,runSession:()=>{calls++;return gate;}};
 await drainHumanContinuations(host);assert.equal(calls,1);await drainHumanContinuations(host);assert.equal(calls,1);resolve();await wait();assert.match(ledger(store,session.id).blockedReason,/No pending input/);await drainHumanContinuations(host);assert.equal(calls,1);store.db.close();
});

test('approval, cancel, unknown, stale writer and unconfirmed effects block automatic continuation [AC:bot-human-continuation#AC-5]',async()=>{
 const {store,session}=fixture();add(store,session.id,'unread');requestHumanRun(store,session.id);let calls=0;const host={store,isSessionRunning:()=>false,runSession:async()=>{calls++;}};
 const approval=store.createApproval({sessionId:session.id,toolName:'bash',reason:'gated',args:{command:'true'}});await drainHumanContinuations(host);assert.equal(calls,0);store.updateApproval(approval.id,'rejected');
 for(const status of ['unknown','waiting_approval']){store.updateSession(session.id,{status});await drainHumanContinuations(host);assert.equal(calls,0);}
 store.updateSession(session.id,{status:'idle'});store.claimWriter(session.id,'stale');await drainHumanContinuations(host);assert.equal(calls,0);store.releaseWriter(session.id,'stale');
 store.updateSession(session.id,{metadata:{...session.metadata,outcome:{kind:'aborted',reason:'abort'}}});await drainHumanContinuations(host);assert.equal(calls,0);
 store.updateSession(session.id,{status:'idle',metadata:session.metadata});await drainHumanContinuations({...host,hasUnconfirmedEffects:()=>true});assert.equal(calls,0);blockHumanContinuations(store,session.id);await drainHumanContinuations(host);assert.equal(calls,0);store.db.close();
});

test('durable clean-terminal pending input resumes after reopening, with no repeated model read [AC:bot-human-continuation#AC-3]',async()=>{
 const {store,session,path}=fixture();const message=add(store,session.id,'survive');requestHumanRun(store,session.id);store.db.close();const reopened=new SqliteStateStore(path);let calls=0;
 const host={store:reopened,isSessionRunning:()=>false,runSession:async(id)=>{calls++;const observe=createHumanContinuationObserver(reopened,id);noteHumanModelInput(reopened,id,[message]);observe({type:'model_done',stopReason:'end'});}};await drainHumanContinuations(host);await wait();assert.equal(calls,1);assert.equal(ledger(reopened,session.id).pending.length,0);await drainHumanContinuations(host);assert.equal(calls,1);reopened.db.close();
});

test('domain lease keeps original task completion ahead of tail and model errors are recorded without reentrant execution [AC:bot-human-continuation#AC-6]',async()=>{
 const {store,session}=fixture();add(store,session.id,'tail');requestHumanRun(store,session.id);let calls=0;const fence=claimBotSession(store,session.id,'original');assert.equal(hasHumanContinuationLease(store,session.id),true);const host={store,isSessionRunning:()=>false,runSession:async()=>{calls++;throw new Error('model unavailable')},log:{warn(){}}};await drainHumanContinuations(host);assert.equal(calls,0);releaseBotSession(store,session.id,'original',fence);await drainHumanContinuations(host);await wait();assert.equal(calls,1);
 const other=fixture();add(other.store,other.session.id,'sync');requestHumanRun(other.store,other.session.id);await drainHumanContinuations({store:other.store,isSessionRunning:()=>false,runSession:()=>{throw new Error('sync unavailable')},log:{warn(){}}});other.store.db.close();store.db.close();
});

test('capacity and raw intake are atomic, nested transactions survive, and missing sessions keep original behavior [AC:bot-human-continuation#AC-1]',()=>{
 const {store,session}=fixture();updateBotWorkSettings(store,{perBot:1,perPrincipal:1});withHumanContinuationAdmission(store,session.id,()=>{add(store,session.id,'accepted');requestHumanRun(store,session.id)});assert.equal(ledger(store,session.id).pending.length,1);
 assert.throws(()=>withHumanContinuationAdmission(store,session.id,()=>{add(store,session.id,'orphan');throw new Error('rollback')}));assert.equal(store.listMessages(session.id).some(m=>m.parts.some(p=>p.text==='orphan')),false);
 assert.equal(withHumanContinuationAdmission(store,'missing',()=>({status:'not_submitted'})).status,'not_submitted');
 store.db.exec('BEGIN');assert.throws(()=>withHumanContinuationAdmission(store,session.id,()=>{throw new Error('nested rollback')}));assert.equal(store.db.isTransaction,true);store.db.exec('ROLLBACK');store.db.close();
});

test('another SQLite connection can admit new input without an older observer losing its request [AC:bot-human-continuation#AC-1]',()=>{
 const {store,session,path}=fixture();const first=add(store,session.id,'old');requestHumanRun(store,session.id);const observe=createHumanContinuationObserver(store,session.id);noteHumanModelInput(store,session.id,[first]);const secondConnection=new SqliteStateStore(path);const second=add(secondConnection,session.id,'new connection');requestHumanRun(secondConnection,session.id);observe({type:'model_done',stopReason:'end'});assert.deepEqual(ledger(secondConnection,session.id).pending.map(r=>r.id),[second.id]);secondConnection.db.close();store.db.close();
});

test('shutdown with an in-flight tail does not throw from its late completion callback [AC:bot-human-continuation#AC-5]',async()=>{
 const {spawnSync}=await import('node:child_process');const moduleUrl=new URL('../dist/session/human-continuation.js',import.meta.url).href,storageUrl=new URL('../dist/storage.js',import.meta.url).href;
 const source=`import {SqliteStateStore} from ${JSON.stringify(storageUrl)};import {requestHumanRun,drainHumanContinuations} from ${JSON.stringify(moduleUrl)};import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';const store=new SqliteStateStore(join(mkdtempSync(join(tmpdir(),'tail-close-')),'db'));const session=store.createSession({title:'shutdown',mode:'chat',agentId:'general',metadata:{outcome:{kind:'idle',reason:'end'}}});store.appendMessage(session.id,'user',[{type:'text',text:'accepted'}]);requestHumanRun(store,session.id);let release;const gate=new Promise(r=>release=r);await drainHumanContinuations({store,isSessionRunning:()=>false,runSession:()=>gate});store.db.close();release();await new Promise(r=>setTimeout(r,25));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr||child.stdout);
});

test('replacement overflow summary keeps receipt lineage and cannot acknowledge an unclaimed summary [AC:bot-human-continuation#AC-3]',()=>{
 const {store,session}=fixture();store.setDaemonControl('loop_settings',{inboxOverflowCap:2});const receipts=[];
 for(const text of ['old a','old b','new c']){const item=store.enqueueSteer(session.id,text,{target:'next-step'});requestSteerContinuation(store,session.id,item);receipts.push(item);}
 const firstSummary=store.listUnclaimedInbox(session.id).find(item=>item.key==='inbox-overflow');assert.ok(firstSummary);const fourth=store.enqueueSteer(session.id,'new d',{target:'next-step'});requestSteerContinuation(store,session.id,fourth);const replacement=store.listUnclaimedInbox(session.id).find(item=>item.key==='inbox-overflow');assert.notEqual(replacement.id,firstSummary.id);
 const pending=ledger(store,session.id).pending;for(const receipt of receipts)assert.equal(pending.find(request=>request.id===receipt.id).summaryId,replacement.id);
 const observer=createHumanContinuationObserver(store,session.id);noteHumanModelInput(store,session.id,[{id:'older-snapshot',role:'system',key:'inbox-overflow',seq:100,parts:[{type:'text',text:firstSummary.text}]}]);observer({type:'model_done',stopReason:'end'});assert.equal(ledger(store,session.id).pending.length,4);
 const materialized=store.claimInbox(session.id,'next-step').map(item=>store.appendMessage(session.id,item.role,[{type:'text',text:item.text}],{key:item.key}));noteHumanModelInput(store,session.id,materialized);assert.equal(ledger(store,session.id).pending.length,4);observer({type:'model_done',stopReason:'end'});assert.equal(ledger(store,session.id).pending.length,0);store.db.close();
});

test('final normal request fitting must not acknowledge a request absent from delivered model input [AC:bot-human-continuation#AC-2]',async()=>{
 const {applyNormalSessionRequestBudget}=await import('../dist/runtime/normal-request-guard.js');const {store,session}=fixture();const first=add(store,session.id,'pending first '+'x'.repeat(6000));requestHumanRun(store,session.id);const second=add(store,session.id,'pending latest');requestHumanRun(store,session.id);const before=[first,second],observer=createHumanContinuationObserver(store,session.id);observer({type:'turn_prepared',messages:before});
 const fitted=await applyNormalSessionRequestBudget({sessionId:session.id,messages:before,tools:[],systemPrompt:''},{session:store.getSession(session.id),maxContextTokens:1024,summarize:async()=> 'Historical summary'});const delivered=fitted.messages;noteHumanModelInput(store,session.id,delivered);assert.ok(!delivered.some(message=>message.id===first.id));assert.ok(delivered.some(message=>message.id===second.id));observer({type:'model_done',stopReason:'end'});assert.deepEqual(ledger(store,session.id).pending.map(request=>request.id),[first.id],JSON.stringify({prepared:before.map(message=>message.id),delivered:delivered.map(message=>message.id)}));store.db.close();
});

test('actual Bot model-window repacking must not acknowledge a pending request absent from adapter input [AC:bot-human-continuation#AC-2]',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const {bindTurnKernelHost}=await import('../dist/runtime/l5-bindings.js');let delivered;
 const adapter={name:'actual-delivery-repack',contextWindow:8192,async summarizeMessages(){return 'Historical constraints and unfinished work'},async runTurn(input){delivered=input.messages;return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]}}};
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'delivery-repack-repo-')),stateDir:mkdtempSync(join(tmpdir(),'delivery-repack-state-')),modelAdapter:adapter});
 try{const bot=runtime.createBot({name:'Delivery repack'}),session=runtime.getSession(runtime.openBot(bot.id).sessionId);let first;
  for(let n=0;n<40;n++){const message=runtime.store.appendMessage(session.id,n%2?'assistant':'user',[{type:'text',text:'context '+n+' '+ 'x'.repeat(700)}]);if(n===0){first=message;requestHumanRun(runtime.store,session.id)}}requestHumanRun(runtime.store,session.id);const before=runtime.store.foldMessages(session.id),observer=createHumanContinuationObserver(runtime.store,session.id);observer({type:'turn_prepared',messages:before});const host=bindTurnKernelHost(runtime.l5());await host.runTurnWithRetries({sessionId:session.id,agent:runtime.store.getAgent(bot.agentId),messages:before,systemPrompt:'s'.repeat(1000),tools:[]});assert.ok(!delivered.some(message=>(message.sourceId??message.id)===first.id));observer({type:'model_done',stopReason:'end'});assert.ok(ledger(runtime.store,session.id).pending.some(request=>request.id===first.id),JSON.stringify({preparedFirst:first.id,actualDelivered:delivered.map(message=>message.sourceId??message.id)}));
  await drainHumanContinuations({store:runtime.store,isSessionRunning:()=>false,runSession:async id=>{const tailObserver=createHumanContinuationObserver(runtime.store,id);await host.runTurnWithRetries({sessionId:id,agent:runtime.store.getAgent(bot.agentId),messages:runtime.store.foldMessages(id),systemPrompt:'s'.repeat(1000),tools:[]});tailObserver({type:'model_done',stopReason:'end'});}});
  for(let n=0;n<100&&ledger(runtime.store,session.id).pending.length;n++)await new Promise(r=>setTimeout(r,5));assert.equal(ledger(runtime.store,session.id).pending.length,0);assert.ok(delivered.some(message=>message.parts.some(part=>part.type==='text'&&part.text===first.parts[0].text)));assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE id=?').get(first.id).n,1);assert.equal(runtime.store.listMessages(session.id).filter(message=>message.key==='human-source:'+first.id).length,1);

 }finally{await runtime.destroy();}
});

test('folded steer and shared overflow summary sources resume once from original WAL [AC:bot-human-continuation#AC-3]',async()=>{
 for(const overflow of [false,true]){
  const {store,session}=fixture();if(overflow)store.setDaemonControl('loop_settings',{inboxOverflowCap:2});for(const text of overflow?['older a','older b','new c']:['one pending steer']){const item=store.enqueueSteer(session.id,text,{target:'next-step'});requestSteerContinuation(store,session.id,item)}
  const originals=store.claimInbox(session.id,'next-step').map(item=>store.appendMessage(session.id,item.role,[{type:'text',text:item.text}],{key:item.key}));store.appendReplacement(session.id,{startSeq:originals[0].seq,endSeq:originals.at(-1).seq,role:'system',parts:[{type:'text',text:'compressed historical notes'}]});let calls=0;
  await drainHumanContinuations({store,isSessionRunning:()=>false,runSession:async id=>{calls++;const observer=createHumanContinuationObserver(store,id);noteHumanModelInput(store,id,store.foldMessages(id));observer({type:'model_done',stopReason:'end'});}});await wait();assert.equal(ledger(store,session.id).pending.length,0);assert.equal(calls,1);for(const original of originals){const rows=store.db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE session_id=? AND key=? AND role=?').get(session.id,original.key,original.role);assert.equal(rows.n,2);}store.db.close();
 }
});

test('a joined human send runs again only when that message was not forked', async () => {
  const { store, session } = fixture();
  const message = add(store, session.id, 'while busy');
  requestHumanRun(store, session.id);
  assert.equal(unansweredHumanWork(store, session.id, [message.id]), true);
  store.updateSession(session.id, { metadata: { ...session.metadata, concurrentBotForks: [{ sourceMessageId: message.id, childSessionId: 'child', status: 'running' }] } });
  assert.equal(unansweredHumanWork(store, session.id, [message.id]), false);
  let calls = 0;
  const host = { store, isRunning: () => false, runSession: async () => { calls += 1; return 'done'; } };
  assert.equal(await runAnsweredHumanSession(host, session.id), 'done');
  assert.equal(calls, 1);
  store.updateSession(session.id, { metadata: { ...session.metadata, concurrentBotForks: [] } });
  calls = 0;
  const follow = { store, isRunning: () => false, runSession: async () => { calls += 1; if (calls === 1) return 'joined'; const observe = createHumanContinuationObserver(store, session.id); noteHumanModelInput(store, session.id, [message]); observe({ type: 'model_done', stopReason: 'end' }); return 'answered'; } };
  assert.equal(await runAnsweredHumanSession(follow, session.id), 'answered');
  assert.equal(calls, 2);
  requestHumanRun(store, session.id);
  calls = 0;
  const stopped = { store, isRunning: () => false, runSession: async () => { calls += 1; blockHumanContinuations(store, session.id); const current = store.getSession(session.id); store.updateSession(session.id, { status: 'idle', metadata: { ...current.metadata, outcome: { kind: 'aborted', reason: 'user_abort' } } }); return 'aborted'; } };
  assert.equal(await runAnsweredHumanSession(stopped, session.id), 'aborted');
  assert.equal(calls, 1);
  store.db.close();
});

test('human continuation restores the original quote pointer after compaction [AC:bot-reply-quote#AC-5]',async()=>{
 const {store,session}=fixture();try{const original=store.appendMessage(session.id,'assistant',[{type:'text',text:'full quoted answer'}]);const quote={messageId:original.id,excerpt:'quoted'};const source=store.appendMessage(session.id,'user',[{type:'text',text:'explain quote'}],{replyTo:quote});requestHumanRun(store,session.id);store.appendReplacement(session.id,{startSeq:source.seq,endSeq:source.seq,role:'system',parts:[{type:'text',text:'compressed'}]});let delivered;await drainHumanContinuations({store,isSessionRunning:()=>false,runSession:async id=>{delivered=store.foldMessages(id).find(m=>m.key==='human-source:'+source.id);}});await wait();assert.deepEqual(delivered?.replyTo,quote);}finally{store.db.close();}
});
