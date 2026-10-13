#!/usr/bin/env node
/** Real SQLite/store benchmark. --full runs the saved warmup/measurement protocol; default is a labelled smoke sample. */
import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync,unlinkSync} from 'node:fs';
import {tmpdir,cpus,totalmem,platform,release} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {SqliteStateStore} from '../../packages/core/dist/storage.js';
import {createBot} from '../../packages/core/dist/bots/bot-facade.js';
const argv=process.argv.slice(2), option=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1]};
const full=argv.includes('--full'), workloadPath=new URL('./workload.v1.json',import.meta.url);
const workloadText=readFileSync(workloadPath,'utf8'),workload=JSON.parse(workloadText),hash=text=>createHash('sha256').update(text).digest('hex');
const output=resolve(option('--out','test-results/bot-history-benchmark.json'));
mkdirSync(dirname(output),{recursive:true});
const dbPath=resolve(option('--db',join(dirname(output),'bot-history-benchmark.sqlite')));
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const trackedDiff=execFileSync('git',['diff','HEAD'],{encoding:'utf8'});
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).sort();
const fingerprint=hash(trackedDiff+untracked.map(path=>path+':'+hash(readFileSync(path))).join('\n'));
const report={version:1,layer:'SQLite store (does not measure HTTP, auth or browser)',fullProtocol:full,workloadHash:hash(workloadText),seed:workload.seed,candidate:{sha,dirtyFingerprint:fingerprint,dirty:trackedDiff.length>0||untracked.length>0},hardware:{platform:platform(),release:release(),node:process.version,logicalCpus:cpus().length,memoryGiB:totalmem()/1024**3,disk:'execution workspace; media type unverified'},referenceHardwareMatched:false,releaseAcceptance:'pending: reference hardware and complete API/browser/full-load evidence required',dataset:workload.dataset,dbPath,startedAt:new Date().toISOString()};
const store=new SqliteStateStore(dbPath),sessions=[];
let seed=workload.seed>>>0;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const prior=store.getDaemonControl('historyBenchmark.dataset');
if(prior){if(prior.workloadHash!==report.workloadHash)throw new Error('Existing dataset belongs to a different workload');sessions.push(...prior.sessions);}
else {
 const start=performance.now(), count=workload.dataset.botsIncludingSuper;
 for(let b=0;b<count;b++)sessions.push(createBot({store},{name:b===0?'Super Bot':`Benchmark Bot ${b}`}).canonicalSessionId);
 const remaining=workload.dataset.historyMessages-workload.dataset.maxHistoryPerBot,other=Math.floor(remaining/(count-1)),extra=remaining%(count-1);
 const insert=store.db.prepare('INSERT INTO session_messages(id,session_id,role,parts_json,created_at,seq,surface_op) VALUES(?,?,?,?,?,?,?)');
 let rows=0,bytes=0;store.db.exec('BEGIN');
 try {
  for(let b=0;b<count;b++){
   const size=b===0?workload.dataset.maxHistoryPerBot:other+(b<=extra?1:0);
   for(let n=1;n<=size;n++){
    const artifact=(rows%100)===0,kind=rows%5,role=kind===4?'tool':kind%2?'assistant':'user';
    const length=role==='tool'?workload.payloadBytes.toolResult:role==='assistant'?workload.payloadBytes.output:workload.payloadBytes.input;
    const prefix=`source ${b} ${n} needle_${b}_${n} `;
    const text=artifact?prefix+`[artifact ref=artifact_${rows} bytes=${workload.payloadBytes.artifact}]`:prefix+'x'.repeat(Math.max(0,length-prefix.length));
    const parts=JSON.stringify(role==='tool'?[{type:'tool_result',toolCallId:'benchmark_'+rows,ok:true,content:text}]:[{type:'text',text}]);
    insert.run('benchmark_'+b+'_'+n,sessions[b],role,parts,'2026-10-13T00:00:00.000Z',n,'append');bytes+=Buffer.byteLength(parts);rows++;
    if(rows%5000===0){store.db.exec('COMMIT');store.db.exec('BEGIN');}
   }
   console.error(JSON.stringify({phase:'seed',bots:b+1,rows}));
  }
  store.db.exec('COMMIT');
 }catch(error){try{store.db.exec('ROLLBACK');}catch{}report.error={message:error.message,code:error.code,phase:'seed',rows};report.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n');throw error;}
 store.setDaemonControl('historyBenchmark.dataset',{workloadHash:report.workloadHash,sessions,rows,bytes});
 report.seedSeconds=(performance.now()-start)/1000;report.payloadBytes=bytes;
}
report.actualRows=Number(store.db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE id LIKE \'benchmark_%\'').get().n);
if(report.actualRows!==workload.dataset.historyMessages)throw new Error('Incomplete benchmark dataset');
report.databaseBytes=statSync(dbPath).size;
const latencies={page:[],search:[],status:[]};
const sampleReads=Number(option('--sample-reads','1000'));
const warmupReads=full?workload.read.warmupSeconds*workload.read.requestsPerSecond:100;
const measuredReads=full?workload.read.measurementSeconds*workload.read.requestsPerSecond:sampleReads;
function query(index,record){
 const type=index%10<5?'page':index%10<8?'search':'status',b=Math.floor(random()*sessions.length);
 const start=performance.now();
 if(type==='page'){const p=store.listHistory(sessions[b],{limit:50});if(p.messages.length!==50)throw new Error('Incorrect page');}
 else if(type==='search'){const n=1+Math.floor(random()*10000);const p=store.listHistory(sessions[b],{query:`source ${b} ${n} needle_${b}_${n}`,limit:50});if(p.messages.length!==1)throw new Error('Search lost original source');}
 else {if(!store.getSession(sessions[b]))throw new Error('Missing session');}
 if(record)latencies[type].push(performance.now()-start);
}
async function readPhase(count,record){
 const start=performance.now();let done=0;
 while(done<count){const batchStart=performance.now();const batch=Math.min(workload.read.clients,count-done);
  // 20 independent virtual readers scheduled together; store execution itself is synchronous in one daemon process.
  await Promise.all(Array.from({length:batch},(_,i)=>Promise.resolve().then(()=>query(done+i,record))));done+=batch;
  const cadence=1000*batch/workload.read.requestsPerSecond;
  if(full||record)await new Promise(resolve=>setTimeout(resolve,Math.max(0,cadence-(performance.now()-batchStart))));
 }
 return (performance.now()-start)/1000;
}
await readPhase(warmupReads,false);report.measurementSeconds=await readPhase(measuredReads,true);
function quantile(samples,q){const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]??null;}
report.reads=Object.fromEntries(Object.entries(latencies).map(([key,samples])=>[key,{count:samples.length,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),p99Ms:quantile(samples,.99),maxMs:Math.max(...samples)}]));
report.observedRequestsPerSecond=measuredReads/report.measurementSeconds;
report.thresholds=workload.thresholdsMs;report.storeSampleWithinThresholds=report.reads.page.p95Ms<=workload.thresholdsMs.pageP95&&report.reads.search.p95Ms<=workload.thresholdsMs.searchP95&&report.reads.status.p95Ms<=workload.thresholdsMs.statusP95;
report.rssBytes=process.memoryUsage().rss;report.finishedAt=new Date().toISOString();store.db.close();
if(!argv.includes('--keep-db')){for(const suffix of ['', '-wal', '-shm']){const path=dbPath+suffix;if(existsSync(path))unlinkSync(path);}report.datasetRetained=false;}else report.datasetRetained=true;
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,rows:report.actualRows,fullProtocol:full,reads:report.reads,releaseAcceptance:report.releaseAcceptance}));
