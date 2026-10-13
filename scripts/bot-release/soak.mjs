#!/usr/bin/env node
/** Real-runtime, persistent mixed-work soak. Default is the complete workload.v1 protocol. */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { sanitizeSpawnEnv } from '../../packages/core/dist/sandbox/env-sanitizer.js';
import { RawAgentRuntime } from '../../packages/core/dist/runtime.js';
import { resolveBotPrincipal, ensureSuperBot, dispatchBotTask, tickBotWork, botWorkStatus } from '../../packages/core/dist/bots/bot-work.js';
import { RoutineRunStore, drainRoutineRuns } from '../../packages/core/dist/cron/routine-runtime.js';

const argv=process.argv.slice(2),smoke=argv.includes('--smoke');
if(argv.includes('--help')){console.log('Usage: node scripts/bot-release/soak.mjs [--smoke --smoke-seconds 10] [--out report.json] [--state-dir directory]\nDefault: workload.v1, 30 minute warmup + 24 hour measurement + up to 120 second drain. Smoke never counts as release acceptance.');process.exit(0);}
function option(name,fallback){const index=argv.indexOf(name);return index<0?fallback:argv[index+1];}
function positive(raw,label){const n=Number(raw);if(!Number.isFinite(n)||n<=0)throw new Error(`Invalid ${label}`);return n;}
const workloadText=readFileSync(new URL('./workload.v1.json',import.meta.url),'utf8'),workload=JSON.parse(workloadText);
const hash=value=>createHash('sha256').update(value).digest('hex');
const output=resolve(option('--out','test-results/bot-soak.json'));mkdirSync(dirname(output),{recursive:true});
const stateDir=resolve(option('--state-dir',join(dirname(output),`bot-soak-${Date.now()}`)));mkdirSync(stateDir,{recursive:true});
const seconds=smoke?positive(option('--smoke-seconds',10),'smoke seconds'):workload.soak.measurementSeconds;
const warmup=smoke?Math.min(2,seconds):workload.soak.warmupSeconds;
const configuration={workload,mode:smoke?'smoke':'release-protocol',warmupSeconds:warmup,measurementSeconds:seconds,drainSeconds:workload.soak.drainSeconds};
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',env:sanitizeSpawnEnv()}).trim();
const diff=execFileSync('git',['diff','HEAD'],{encoding:'utf8',env:sanitizeSpawnEnv(),maxBuffer:32*1024*1024});
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8',env:sanitizeSpawnEnv()}).split('\0').filter(Boolean).sort();
const dirtyFingerprint=hash(diff+untracked.map(path=>{try{return path+':'+hash(readFileSync(path));}catch{return path+':unreadable';}}).join('\n'));
const report={version:1,mode:configuration.mode,releaseEvidence:false,configuration,configHash:hash(JSON.stringify(configuration)),workloadHash:hash(workloadText),candidate:{sha,dirty:!!diff||untracked.length>0,dirtyFingerprint},hardware:{platform:platform(),release:release(),node:process.version,logicalCpus:cpus().length,memoryGiB:totalmem()/1024**3,disk:'unverified execution filesystem'},referenceHardwareMatched:false,stateDir,startedAt:new Date().toISOString(),errors:[],limitations:['Controlled local model and HTTP service; does not validate live model quality or third-party software.','Latency samples measure real in-process runtime/store entrypoints, not HTTP auth or browser rendering.','Reference disk type is unverified; this report alone cannot establish release readiness.']};
let seed=workload.seed>>>0;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
function histogram(){const bins=new Uint32Array(10001);let count=0,max=0,sum=0;return {add(ms){count++;sum+=ms;max=Math.max(max,ms);bins[Math.min(10000,Math.ceil(ms))]++;},summary(){let total=0,p95=null;for(let i=0;i<bins.length;i++){total+=bins[i];if(total>=Math.ceil(count*.95)){p95=i===10000?max:i;break;}}return {count,p95Ms:count?p95:null,maxMs:max,meanMs:count?sum/count:null};}};}
const latency=Object.fromEntries(['receive','page','search','status','firstScreen','terminal'].map(name=>[name,histogram()]));
let runtime,stopping=false,measuring=false,modelCalls=0,softwareRequests=0,softwareErrors=0,artifactCount=0,readRequests=0,writeRequests=0;
const server=createServer(async(request,response)=>{
 try{let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>16384)throw new Error('Request too large');}
 const input=JSON.parse(raw),write=input.kind==='write';softwareRequests++;write?writeRequests++:readRequests++;
 await sleep(write?workload.controlledLatencyMs.softwareWrite:workload.controlledLatencyMs.softwareRead);
 const prior=runtime.store.db.prepare('SELECT calls FROM soak_effects WHERE key=?').get(input.key);
 if(prior)runtime.store.db.prepare('UPDATE soak_effects SET calls=calls+1 WHERE key=?').run(input.key);
 else runtime.store.db.prepare('INSERT INTO soak_effects(key,kind,calls,effect_count) VALUES(?,?,1,?)').run(input.key,input.kind,write?1:0);
 let artifact;
 if(!prior&&parseInt(hash(input.key).slice(0,8),16)/0xffffffff<workload.payloadBytes.artifactFraction){artifact=join(stateDir,'artifacts',hash(input.key)+'.bin');mkdirSync(dirname(artifact),{recursive:true});writeFileSync(artifact,Buffer.alloc(workload.payloadBytes.artifact,120));artifactCount++;}
 const prefix=JSON.stringify({key:input.key,ok:true,artifact:artifact??null});const base=JSON.stringify({key:input.key,result:prefix});response.setHeader('Content-Type','application/json');response.end(JSON.stringify({key:input.key,result:prefix+'r'.repeat(Math.max(0,workload.payloadBytes.toolResult-Buffer.byteLength(base)))}));
 }catch(error){softwareErrors++;response.statusCode=500;response.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const serviceUrl=`http://127.0.0.1:${server.address().port}`;
const adapter={name:'soak-controlled-local',async runTurn(input){
 modelCalls++;await sleep(workload.controlledLatencyMs.modelTurn);
 const latest=[...runtime.store.foldMessages(input.sessionId)].reverse().find(message=>message.role==='user'&&message.parts.some(part=>part.type==='text'&&/soak_op_[0-9]+/.test(part.text)));const text=(latest?.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 const operation=[...text.matchAll(/soak_op_[0-9]+/g)].at(-1)?.[0];
 if(operation){const key=`${operation}:${input.sessionId}`,hasResult=input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='soak_software'&&String(part.content).includes(key)));
 if(!hasResult&&input.tools.some(tool=>tool.name==='soak_software'))return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:`software_${hash(key).slice(0,20)}`,name:'soak_software',input:{key,kind:parseInt(hash(key).slice(0,4),16)%3===0?'write':'read'}}]};
 }
 const outputPrefix=`Controlled completed result ${operation??'notification'} `;
 return {stopReason:'end',assistantParts:[{type:'text',text:outputPrefix+'o'.repeat(Math.max(0,workload.payloadBytes.output-Buffer.byteLength(outputPrefix)))}]};
 },async summarizeMessages(){return 'Controlled soak summary: persistent Bot identity and history remain; no unconfirmed operation is declared complete.';}};
const tool={name:'soak_software',description:'Call the isolated local soak service.',inputSchema:{type:'object',properties:{key:{type:'string'},kind:{type:'string',enum:['read','write']}},required:['key','kind']},approvalMode:'never',sideEffectLevel:'none',async execute(context,args){const response=await fetch(serviceUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal:context.signal});const content=await response.text();return {ok:response.ok,content};}};
const ordinaryLog=console.log;console.log=(...args)=>{if(!String(args[0]).startsWith('[runtime]'))ordinaryLog(...args);};
runtime=new RawAgentRuntime({repoRoot:process.cwd(),stateDir,modelAdapter:adapter,extraTools:[tool]});
const running=new Set();const runSession=id=>{running.add(id);return Promise.resolve(runtime.runSession(id)).finally(()=>running.delete(id));};
const store=runtime.store,host={store,stateDir,log:{warn(){},info(){},debug(){},error(){}},runSession,cancelSession:id=>runtime.cancelSession(id),isSessionRunning:id=>running.has(id)||store.getSession(id)?.status==='running'};
store.db.exec("CREATE TABLE IF NOT EXISTS soak_effects(key TEXT PRIMARY KEY,kind TEXT NOT NULL,calls INTEGER NOT NULL,effect_count INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS soak_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,components TEXT NOT NULL,accepted_at INTEGER,finished_at INTEGER,error TEXT); CREATE INDEX IF NOT EXISTS soak_pending ON soak_operations(state)");
const principal=resolveBotPrincipal(store),superBot=ensureSuperBot(host,principal),bots=[superBot.bot];
for(let i=1;i<workload.dataset.botsIncludingSuper;i++)bots.push(runtime.createBot({name:`Soak Bot ${i}`}));
const active=bots.slice(1,workload.dataset.activeBots),sessions=active.map(bot=>bot.canonicalSessionId),humanChains=new Map();
const room=runtime.rooms.create(principal,{title:'Persistent soak room',botIds:active.slice(0,workload.write.maxDownstreamBots).map(bot=>bot.id),maxBotTurns:workload.write.maxDownstreamBots});
const routines=active.map(bot=>runtime.createCronJob({name:`Soak ${bot.name}`,botId:bot.id,prompt:'Controlled soak routine',onceAt:'2100-01-01T00:00:00Z',timezone:'Asia/Shanghai'})),routineStore=new RoutineRunStore(store);
// Seed real historical rows separately from live chat state. Full protocol retains the saved million-row distribution.
const seedStart=performance.now(),totalHistory=smoke?500:workload.dataset.historyMessages;
const insert=store.db.prepare('INSERT INTO session_messages(id,session_id,role,parts_json,created_at,seq,surface_op) VALUES(?,?,?,?,?,?,?)');
const ordinals=Array(bots.length).fill(0);
const historySessions=bots.map(bot=>runtime.createChatSession({agentId:bot.id,title:`Soak historical corpus ${bot.name}`,metadata:{...principal,botId:bot.id,soakHistoryCorpus:true}}).id);
store.db.exec('BEGIN');try{for(let row=0;row<totalHistory;row++){const b=row< (smoke?100:workload.dataset.maxHistoryPerBot)?0:1+(row%(bots.length-1));const ordinal=++ordinals[b];
 // Text corpus is paired user/assistant history; software execution history is generated by the actual runtime below.
 const role=row%2?'assistant':'user',length=role==='assistant'?workload.payloadBytes.output:workload.payloadBytes.input,prefix=`soak_history_${row} `;
 insert.run(`soak_history_${row}`,historySessions[b],role,JSON.stringify([{type:'text',text:prefix+'h'.repeat(length-prefix.length)}]),new Date().toISOString(),ordinal,'append');if((row+1)%5000===0){store.db.exec('COMMIT');store.db.exec('BEGIN');}}
 store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
report.dataset={bots:bots.length,activeBots:active.length+1,activeWorkers:active.length,historyRows:totalHistory,seedSeconds:(performance.now()-seedStart)/1000,corpusPlacement:'Separate history sessions under the same Bot identities; live canonical chats start empty.'};
let sequence=0;const mix=['human','human','human','human','routine','routine','dispatch','dispatch','room','room'];
const accepted=store.db.prepare("UPDATE soak_operations SET state='accepted',components=?,accepted_at=? WHERE id=?"),finish=store.db.prepare("UPDATE soak_operations SET state=?,finished_at=?,error=? WHERE id=? AND state='accepted'");
async function submit(index,hotspot=false){const kind=mix[index%mix.length],id=`soak_op_${index}`,phase=measuring?'measurement':'warmup',bot=hotspot?active[0]:active[index%active.length];const prefix=`${id} `,payload=prefix+'i'.repeat(workload.payloadBytes.input-prefix.length),started=performance.now();
 store.db.prepare("INSERT INTO soak_operations(id,kind,phase,state,components) VALUES(?,?,?,'submitted','[]')").run(id,kind,phase);
 try{
 if(kind==='human'){const previous=humanChains.get(bot.id)??Promise.resolve();const pending=previous.catch(()=>{}).then(async()=>{while(['running','waiting_approval'].includes(store.getSession(bot.canonicalSessionId)?.status))await sleep(10);runtime.sendUserMessage(bot.canonicalSessionId,payload);accepted.run(JSON.stringify([{type:'human',id:bot.canonicalSessionId,operation:id}]),Date.now(),id);if(phase==='measurement')latency.receive.add(performance.now()-started);await runSession(bot.canonicalSessionId);});humanChains.set(bot.id,pending);void pending.catch(error=>{finish.run('failed',Date.now(),String(error),id);});return;}
 let components;
 if(kind==='routine'){const job=routines[active.findIndex(item=>item.id===bot.id)];const run=routineStore.enqueue(job,new Date().toISOString(),{key:id,prompt:payload});components=[{type:'routine',id:run.id}];}
 if(kind==='dispatch'){components=[];for(let leaf=0;leaf<workload.write.maxDownstreamBots;leaf++){const target=hotspot?active[leaf]:active[(index+leaf)%active.length];const task=dispatchBotTask(host,{principal,requesterBotId:superBot.bot.id,targetBotId:target.id,input:payload,idempotencyKey:`${id}:${leaf}`});components.push({type:'dispatch',id:task.id});}}
 if(kind==='room'){const sent=runtime.rooms.send(principal,room.id,{text:payload,mentions:active.slice(0,workload.write.maxDownstreamBots).map(bot=>bot.id),idempotencyKey:id});components=[{type:'room',id:sent.turn.id}];}
 accepted.run(JSON.stringify(components),Date.now(),id);if(phase==='measurement')latency.receive.add(performance.now()-started);
 }catch(error){store.db.prepare("UPDATE soak_operations SET state='rejected',finished_at=?,error=? WHERE id=?").run(Date.now(),String(error),id);if(report.errors.length<100)report.errors.push({id,phase,message:String(error)});}
}
function stateOf(component){if(component.type==='dispatch')return store.db.prepare('SELECT status FROM bot_work_tasks WHERE id=?').get(component.id)?.status??'missing';if(component.type==='routine')return routineStore.get(component.id)?.status??'missing';if(component.type==='room')return store.db.prepare('SELECT status FROM bot_room_turns WHERE id=?').get(component.id)?.status??'missing';const session=store.getSession(component.id);if(!session)return 'missing';if(session.status==='running'||session.status==='waiting_approval')return session.status;const hasOutput=store.foldMessages(component.id).some(message=>message.role==='assistant'&&message.parts.some(part=>part.type==='text'&&part.text.includes(component.operation)));return session.status==='failed'||session.metadata?.outcome?.kind==='aborted'?'failed':hasOutput?'completed':'running';}
let ticking=false;async function tick(){if(ticking)return;ticking=true;try{await tickBotWork(host);await drainRoutineRuns(host);
 for(const approval of store.listApprovals({status:'pending'})){if(approval.toolName==='soak_software'&&Date.now()-Date.parse(approval.createdAt)>=workload.controlledLatencyMs.approval){running.add(approval.sessionId);void runtime.approve(approval.id,'approved').then(()=>runtime.runSession(approval.sessionId)).catch(error=>{if(report.errors.length<100)report.errors.push({phase:'approval',message:String(error)});}).finally(()=>running.delete(approval.sessionId));}}void runtime.rooms.tick().catch(error=>{if(report.errors.length<100)report.errors.push({message:String(error),phase:'room-tick'});});
 for(const row of store.db.prepare("SELECT * FROM soak_operations WHERE state='accepted' LIMIT 500").all()){const states=JSON.parse(row.components).map(stateOf);if(states.includes('missing')){finish.run('lost',Date.now(),'Missing persisted component',row.id);continue;}if(states.every(state=>['completed','failed','cancelled','unknown','skipped'].includes(state))){const status=states.includes('unknown')?'unknown':states.every(state=>state==='completed')?'completed':'failed';finish.run(status,Date.now(),status==='failed'?states.join(','):null,row.id);if(row.phase==='measurement')latency.terminal.add(Date.now()-row.accepted_at);}}
 }catch(error){if(report.errors.length<100)report.errors.push({message:String(error),phase:'tick'});}finally{ticking=false;}}
function queryReads(){for(let i=0;i<workload.read.clients;i++){const type=i%10<5?'page':i%10<8?'search':'status',began=performance.now(),session=historySessions[Math.floor(random()*historySessions.length)];if(type==='status')botWorkStatus(host,principal);else store.listHistory(session,{limit:50,...(type==='search'?{query:`soak_history_${Math.floor(random()*totalHistory)} `}:{})});if(measuring){latency[type].add(performance.now()-began);if(type==='page')latency.firstScreen.add(performance.now()-began);}}}
const rssPath=output+'.rss.jsonl';let windowSamples=[],measurementRssStart=null,baselineRss=null,rssRatio=1,rssPeak=0,lastRss=0;
function sampleRss(force=false){if(!force&&Date.now()-lastRss<workload.soak.rssSampleSeconds*1000)return;lastRss=Date.now();const rss=process.memoryUsage().rss;rssPeak=Math.max(rssPeak,rss);appendFileSync(rssPath,JSON.stringify({at:new Date().toISOString(),phase:measuring?'measurement':'warmup',rssBytes:rss})+'\n');if(measuring){measurementRssStart??=Date.now();windowSamples.push({at:Date.now(),rss});windowSamples=windowSamples.filter(sample=>Date.now()-sample.at<=workload.soak.rssWindowSeconds*1000);const sorted=windowSamples.map(sample=>sample.rss).sort((a,b)=>a-b);const windowP95=sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)];if(baselineRss===null&&(smoke||Date.now()-measurementRssStart>=workload.soak.rssWindowSeconds*1000))baselineRss=windowP95;if(baselineRss!==null)rssRatio=Math.max(rssRatio,windowP95/baselineRss);}}
const driverStart=performance.now();let nextWrite=driverStart,nextRead=driverStart;const measurementStart=driverStart+warmup*1000,end=measurementStart+seconds*1000;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
try{
 while(performance.now()<end&&!stopping){const now=performance.now();measuring=now>=measurementStart;const elapsed=(now-driverStart)/1000,burst=elapsed>=workload.burst.everySeconds&&(elapsed%workload.burst.everySeconds)<workload.burst.durationSeconds;
 if(now>=nextWrite){void submit(sequence++,burst&&random()<workload.burst.hotspotFraction);nextWrite+=1000/(burst?workload.burst.topLevelPerSecond:workload.write.topLevelPerSecond);}
 if(now>=nextRead){queryReads();nextRead+=1000*workload.read.clients/workload.read.requestsPerSecond;}
 await tick();sampleRss();await sleep(Math.min(25,Math.max(0,Math.min(nextWrite,nextRead,end)-performance.now())));
 }
 const stop=performance.now(),drainDeadline=stop+workload.soak.drainSeconds*1000;stopping=true;
 while(performance.now()<drainDeadline){await tick();const unfinished=store.db.prepare("SELECT count(*) AS n FROM soak_operations WHERE state IN ('submitted','accepted')").get().n;if(!unfinished&&!ticking)break;sampleRss();await sleep(25);}
 report.actualWarmupSeconds=Math.min(warmup,(stop-driverStart)/1000);report.actualMeasurementSeconds=Math.max(0,(stop-measurementStart)/1000);report.actualDrainSeconds=(performance.now()-stop)/1000;
}catch(error){report.errors.push({phase:'runner',message:error.stack});}finally{
 sampleRss(true);report.finishedAt=new Date().toISOString();report.counts=store.db.prepare('SELECT phase,kind,state,count(*) AS count FROM soak_operations GROUP BY phase,kind,state').all();
 const count=states=>Number(store.db.prepare(`SELECT count(*) AS n FROM soak_operations WHERE state IN (${states.map(()=>'?').join(',')})`).get(...states).n);
 report.submitted=Number(store.db.prepare('SELECT count(*) AS n FROM soak_operations').get().n);report.accepted=count(['accepted','completed','failed','unknown','lost']);report.terminal=count(['completed','failed','unknown']);report.unknown=count(['unknown']);report.rejected=count(['rejected']);report.pending=count(['submitted','accepted']);report.lost=count(['lost']);report.noLoss=report.lost===0&&report.pending===0&&report.accepted===report.terminal;
 report.software={modelCalls,requests:softwareRequests,reads:readRequests,writes:writeRequests,errors:softwareErrors,artifactCount,effects:Number(store.db.prepare('SELECT COALESCE(sum(effect_count),0) AS n FROM soak_effects').get().n),duplicateRequests:Number(store.db.prepare('SELECT COALESCE(sum(calls-1),0) AS n FROM soak_effects').get().n),duplicateEffects:Number(store.db.prepare('SELECT count(*) AS n FROM soak_effects WHERE effect_count>1').get().n)};
 report.latency=Object.fromEntries(Object.entries(latency).map(([name,h])=>[name,h.summary()]));report.thresholds=workload.thresholdsMs;report.latencyWithinThresholds=Object.entries({page:'pageP95',search:'searchP95',status:'statusP95',receive:'receiveP95',firstScreen:'firstScreenP95'}).every(([metric,threshold])=>report.latency[metric].count>0&&report.latency[metric].p95Ms<=workload.thresholdsMs[threshold]);
 report.rss={samplePath:rssPath,peakBytes:rssPeak,stableWindowBaselineP95Bytes:baselineRss,maxWindowRatio:rssRatio,withinThreshold:rssRatio<=workload.soak.maxRssRatio,windowSeconds:workload.soak.rssWindowSeconds,sufficientWindowDuration:!smoke&&report.actualMeasurementSeconds>=workload.soak.rssWindowSeconds*2};
 report.databaseBytes=statSync(store.dbPath).size;report.observedMeasurementTopLevelPerSecond=report.counts.filter(row=>row.phase==='measurement').reduce((n,row)=>n+row.count,0)/report.actualMeasurementSeconds;
 report.functionalPassed=report.errors.length===0&&count(['failed'])===0&&report.noLoss&&report.rejected===0&&report.unknown===0&&report.software.errors===0&&report.software.duplicateEffects===0;
 report.rss.acceptanceStatus=report.rss.sufficientWindowDuration?(report.rss.withinThreshold?'passed':'failed'):'not-evaluated: insufficient duration for two 30 minute windows';
 report.runnerPassed=report.functionalPassed&&report.latencyWithinThresholds&&report.rss.withinThreshold;
 report.fullDurationCompleted=!smoke&&report.actualWarmupSeconds>=workload.soak.warmupSeconds&&report.actualMeasurementSeconds>=workload.soak.measurementSeconds;
 report.releaseAcceptance=smoke?'NOT ACCEPTED: smoke only; complete 30 minute warmup plus 24 hour measurement required':report.runnerPassed&&report.fullDurationCompleted?'Protocol completed; reference hardware and remaining release gates still require evidence':'NOT ACCEPTED: full protocol or correctness/performance checks incomplete';
 writeFileSync(output,JSON.stringify(report,null,2)+'\n');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.destroy();console.log=ordinaryLog;
 ordinaryLog(JSON.stringify({output,mode:report.mode,runnerPassed:report.runnerPassed,functionalPassed:report.functionalPassed,accepted:report.accepted,terminal:report.terminal,pending:report.pending,releaseAcceptance:report.releaseAcceptance}));if(!report.runnerPassed)process.exitCode=1;
}
