/** Isolated real daemon/app/auth fixture for http-load.mjs. All software/model traffic is local. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {boot} from '../test/helpers/bot-http-fixture.mjs';
import {controlledOperation,preferUnansweredCron} from './http-controlled-operation.mjs';
const workload=JSON.parse(readFileSync(new URL('./workload.v1.json',import.meta.url),'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let fixture,closed=false,ticking=false,cycles=0,modelTurns=0,toolCalls=0,artifactBytes=0;
const send=value=>process.connected&&process.send(value);
const starts=[],receipts=[],errors=[],seen=new Set(),turnCounts={},contexts=new Map(),executionContexts=new Map(),softwareKeys=new Map();let notificationRuns=0;
process.on('message',async message=>{
 if(message.type==='shutdown'&&!closed){closed=true;clearInterval(timer);const store=fixture.runtime.store;
 const ledger=(message.operations??[]).map(operation=>{
  const expected=`Completed ${operation.operation} `;
  if(operation.kind==='human'){const receipt=receipts.find(item=>item.operation===operation.operation);const outputs=receipt?store.db.prepare("SELECT id FROM session_messages WHERE session_id=? AND role='assistant' AND parts_json LIKE ?").all(receipt.sessionId,'%'+expected+'%'):[];return {operation:operation.operation,kind:operation.kind,completed:Boolean(receipt&&outputs.length),receipt,outputs:outputs.length};}
  if(operation.kind==='dispatch'){const results=operation.targets.map(id=>store.db.prepare('SELECT id,status,result FROM bot_work_tasks WHERE id=?').get(id));return {operation:operation.operation,kind:operation.kind,completed:results.length===3&&results.every(row=>row?.status==='completed'&&String(row.result).includes(expected)),results};}
  if(operation.kind==='routine'){const results=operation.targets.flatMap(id=>store.db.prepare('SELECT payload FROM bot_routine_runs WHERE routine_id=?').all(id).map(row=>JSON.parse(row.payload)));return {operation:operation.operation,kind:operation.kind,completed:results.length===1&&results.every(row=>row.status==='completed'&&String(row.result).includes(expected)),results:results.map(row=>({id:row.id,status:row.status,result:row.result}))};}
  const results=operation.targets.map(id=>{const turn=store.db.prepare('SELECT data FROM bot_room_turns WHERE id=?').get(id);const messages=store.db.prepare("SELECT data FROM bot_room_messages WHERE json_extract(data,'$.turnId')=? AND json_extract(data,'$.sender.type')='bot'").all(id).map(row=>JSON.parse(row.data));return {turn:turn?JSON.parse(turn.data):undefined,messages};});return {operation:operation.operation,kind:operation.kind,completed:results.length===1&&results.every(row=>row.turn?.status==='completed'&&row.turn.botTurns===3&&row.messages.length===3&&new Set(row.messages.map(item=>item.sender.id)).size===3&&row.messages.every(item=>item.text.includes(expected))),results:results.map(row=>({status:row.turn?.status,botTurns:row.turn?.botTurns,messageCount:row.messages.length}))};
 });
 send({type:'final',starts,receipts,ledger,errors,cycles,modelTurns,toolCalls,artifactBytes,notificationRuns,duplicateSoftwareKeys:[...softwareKeys].filter(([,count])=>count>1),controlledModelMaxTurns:Math.max(0,...Object.values(turnCounts)),rows:Number(store.db.prepare('SELECT COUNT(*) AS n FROM session_messages').get().n),pending:{tasks:store.db.prepare("SELECT status,COUNT(*) AS n FROM bot_work_tasks GROUP BY status").all(),routines:store.db.prepare("SELECT status,COUNT(*) AS n FROM bot_routine_runs GROUP BY status").all(),rooms:store.db.prepare("SELECT status,COUNT(*) AS n FROM bot_room_turns GROUP BY status").all()}});if(configuration.smoke&&configuration.fixtureFault==='shutdown-hang')await new Promise(()=>{});if(configuration.fixtureFault==='shutdown')throw new Error('Injected fixture shutdown failure after final response');await fixture.close();await new Promise(resolve=>software.close(resolve));process.disconnect();}

});
let timer;
const configuration=JSON.parse(process.argv[2]),stateDir=configuration.stateDir;if(configuration.fixtureFault==='startup')throw new Error('Injected fixture startup failure');mkdirSync(stateDir,{recursive:true});
const software=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);softwareKeys.set(input.key,(softwareKeys.get(input.key)??0)+1);await sleep(input.kind==='write'?workload.controlledLatencyMs.softwareWrite:workload.controlledLatencyMs.softwareRead);toolCalls++;
 let artifact;if(toolCalls%100===0){artifact=join(stateDir,'artifacts',toolCalls+'.bin');mkdirSync(join(stateDir,'artifacts'),{recursive:true});writeFileSync(artifact,Buffer.alloc(workload.payloadBytes.artifact,120));artifactBytes+=workload.payloadBytes.artifact;}
 const base={key:input.key,artifact:artifact??null,result:''};base.result='r'.repeat(Math.max(0,workload.payloadBytes.toolResult-Buffer.byteLength(JSON.stringify(base))));res.setHeader('content-type','application/json');res.end(JSON.stringify(base));});
await new Promise(resolve=>software.listen(0,'127.0.0.1',resolve));
const toolName='http_benchmark_software';
const extraTools=[{name:toolName,description:'Controlled local software benchmark',inputSchema:{type:'object',properties:{key:{type:'string'},kind:{type:'string'}},required:['key','kind']},approvalMode:'auto',sideEffectLevel:'none',needsApproval(context,input){const operation=String(input?.key??'').split(':')[0];if(!/^http_op_\d+$/.test(operation)||!fixture)return false;return Boolean(fixture.runtime.store.db.prepare("SELECT 1 FROM session_messages WHERE session_id=? AND role='user' AND instr(parts_json, ?)>0 LIMIT 1").get(context.session.id,`[cron:${operation}]`));},async execute(ctx,input){const r=await fetch(`http://127.0.0.1:${software.address().port}`,{method:'POST',body:JSON.stringify(input),signal:ctx.signal});return {ok:r.ok,content:await r.text()};}}];
const modelAdapter={name:'http-benchmark-controlled',contextWindow:131072,async runTurn(input){modelTurns++;const execution=fixture.runtime.store.getSession(input.sessionId)?.activeWriterRunId??'unbound',executionKey=input.sessionId+':'+execution;if(!executionContexts.has(executionKey))executionContexts.set(executionKey,contexts.get(input.sessionId)??{});const context=executionContexts.get(executionKey),operation=context.operation;const key=operation+':'+input.sessionId;if(context.durableKind==='result')notificationRuns++;if(operation)turnCounts[executionKey]=(turnCounts[executionKey]??0)+1;
 if(operation&&!seen.has(key)){seen.add(key);starts.push({operation,sessionId:input.sessionId,startedAt:Date.now(),cycle:cycles});}
 await sleep(workload.controlledLatencyMs.modelTurn);
 const result=input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&String(part.content).includes(key)));
 if(operation&&!result&&input.tools.some(tool=>tool.name===toolName))return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'controlled_'+key,name:toolName,input:{key,kind:Number(operation.split('_').at(-1))%3===0?'write':'read'}}]};
 return {stopReason:'end',assistantParts:[{type:'text',text:(`Completed ${operation??'notification'} `).padEnd(workload.payloadBytes.output,'o')}]};},async summarizeMessages(){return 'Controlled historical summary; original benchmark sources remain accessible by sequence.';}};
fixture=await boot(false,{stateDir,modelAdapter,extraTools});
const call=fixture.call,check=async(method,path,body)=>{const result=await call('alice',method,path,body);if(result.status>=300)throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);return result.body;};
const superBot=(await check('GET','/api/bot-work/default')).bot,bots=[superBot];
for(let i=1;i<workload.dataset.botsIncludingSuper;i++)bots.push((await check('POST','/api/bots',{name:'HTTP Benchmark Bot '+i})).bot);
const sessions=[];for(const bot of bots)sessions.push((await check('POST',`/api/bots/${bot.id}/open`)).session.id);
// Corpus lives in these actual canonical chats, including the active chats. No pre-compaction is performed.
const store=fixture.runtime.store,total=configuration.smoke?500:workload.dataset.historyMessages,largest=configuration.smoke?100:workload.dataset.maxHistoryPerBot;
const remaining=total-largest,other=Math.floor(remaining/(bots.length-1)),extra=remaining%(bots.length-1),counts=[];
const insert=store.db.prepare('INSERT INTO session_messages(id,session_id,role,parts_json,created_at,seq,surface_op) VALUES(?,?,?,?,?,?,?)');let payloadBytes=0,row=0;
store.db.exec('BEGIN');try{for(let b=0;b<bots.length;b++){const count=b===0?largest:other+(b<=extra?1:0);counts.push(count);for(let seq=1;seq<=count;seq++){
 const kind=seq%5,role=kind===0?'tool':kind%2?'user':'assistant',prefix=`http_source_${b}_${seq} unique_${b}_${seq}; `,length=role==='tool'?workload.payloadBytes.toolResult:role==='assistant'?workload.payloadBytes.output:workload.payloadBytes.input;
 const content=prefix+(row%100===0?`[artifact reference size=${workload.payloadBytes.artifact}]`:'x'.repeat(Math.max(0,length-prefix.length)));
 const parts=role==='tool'?[{type:'tool_result',name:toolName,toolCallId:'seed_'+b+'_'+(seq-1),ok:true,content}]:[{type:'text',text:content},...(kind===4?[{type:'tool_call',toolCallId:'seed_'+b+'_'+seq,name:toolName,input:{key:'seed',kind:'read'}}]:[])];
 const json=JSON.stringify(parts);payloadBytes+=Buffer.byteLength(json);insert.run('http_seed_'+row,sessions[b],role,json,new Date().toISOString(),seq,'append');row++;if(row%5000===0){store.db.exec('COMMIT');store.db.exec('BEGIN');}}
 send({type:'seed-progress',bots:b+1,rows:row});}store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
const active=bots.slice(0,workload.dataset.activeBots),room=(await check('POST','/api/bot-rooms',{title:'HTTP mixed load room',botIds:active.slice(1,4).map(bot=>bot.id),maxBotTurns:3,maxToolCalls:6})).room;
const original=fixture.runtime.sendUserMessage.bind(fixture.runtime);fixture.runtime.sendUserMessage=(sid,text,...rest)=>{const value=original(sid,text,...rest);const operation=text.match(/http_op_\d+/)?.[0];if(operation)receipts.push({operation,sessionId:sid,persistedAt:Date.now(),cycle:cycles});return value;};
// Bind the oracle to the durable triggering message at the true execution entry.
// Later tool messages, approval continuations and arriving notifications cannot change this run's operation.
const originalRun=fixture.runtime.runSession.bind(fixture.runtime);fixture.runtime.runSession=(sid,...args)=>{
 // A resumed approval receives a new writer generation, but still belongs to
 // the captured triggering operation. The latest user row is its approval
 // continuation, not a new benchmark request.
 const resuming=Boolean(store.getSession(sid)?.metadata?.interrupt)&&contexts.has(sid);
 if(!fixture.runtime.isSessionRunning(sid)&&!resuming){const history=store.listHistory(sid,{limit:50}).messages;const latest=[...history].reverse().find(message=>message.role==='user');const durableKind=latest?store.db.prepare('SELECT kind FROM bot_work_messages WHERE message_ref=?').get(latest.id)?.kind:undefined;contexts.set(sid,{operation:preferUnansweredCron(history,sid,controlledOperation(latest?[latest]:[],durableKind)),durableKind,messageId:latest?.id});}
 return originalRun(sid,...args);
};
// Match daemon's normal 1500ms, nonoverlapping scheduler interval, rather than accelerating it for the benchmark.
timer=setInterval(async()=>{if(ticking)return;ticking=true;cycles++;try{await fixture.runtime.runScheduler();}catch(e){errors.push(String(e));}finally{ticking=false;}},1500);
send({type:'ready',url:fixture.url,headers:fixture.headers,bots,active,sessions,counts,roomId:room.id,dataset:{historyRows:row,payloadBytes,placement:'actual canonical chats; active chats included'},pid:process.pid});
