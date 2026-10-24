import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBotSuite, gradeBotEvidence, readWireUsage, validateLiveGate } from '../agent-eval/bot-quality.mjs';

test('Bot suite covers P0 and independent observable outcomes [AC:live-bot-quality#AC-1]', () => {
 const suite=buildBotSuite();assert.ok(suite.length>=16);
 for(const category of ['routing','execution','compression','verification','recovery','permissions'])assert.ok(suite.some(t=>t.category===category));
 assert.ok(suite.every(t=>t.bot && t.turns.length && t.expected));
 assert.equal(gradeBotEvidence({goalStatus:'completed',artifact:{result:42}},{goalStatus:'completed',artifact:{}}).pass,false);
 assert.equal(gradeBotEvidence({goalStatus:'completed',artifact:{result:42}},{goalStatus:'completed',artifact:{result:42}}).pass,true);
});
test('wire usage covers chat responses and missing telemetry [AC:live-bot-quality#AC-3]',()=>{
 assert.deepEqual(readWireUsage('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n'),{inputTokens:10,outputTokens:2});
 assert.deepEqual(readWireUsage('{"usage":{"input_tokens":9,"output_tokens":3}}'),{inputTokens:9,outputTokens:3});
 assert.equal(readWireUsage('{"id":"no usage"}'),null);
});
test('gate cannot certify baseline simulation stale versions or weak policies [AC:live-bot-quality#AC-4] [AC:live-bot-quality#AC-5] [AC:live-bot-quality#AC-6]',()=>{
 for(const manifest of [{simulation:true},{mode:'baseline'},{identities:{candidate:{gitSha:'wrong'}}}])assert.throws(()=>validateLiveGate(manifest,{}, {candidateSha:'wanted',baselineSha:'stable'}));
});

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuredModel } from '../agent-eval/configured-model.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { gradeTask } from '../agent-eval/quality.mjs';

test('saved Bot model wins over global default without mutating source database [AC:live-bot-quality#AC-2]',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'live-bot-model-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'.agent-state'));const path=join(dir,'.agent-state/runtime.sqlite'),db=new DatabaseSync(path);
 db.exec('CREATE TABLE bots(id TEXT, canonical_session_id TEXT); CREATE TABLE sessions(id TEXT, metadata_json TEXT); CREATE TABLE daemon_control(key TEXT,value_json TEXT)');
 db.prepare('INSERT INTO bots VALUES (?,?)').run('test-bot','s');
 db.prepare('INSERT INTO sessions VALUES (?,?)').run('s',JSON.stringify({modelRef:{providerId:'p',modelId:'grok-test'}}));
 db.prepare('INSERT INTO daemon_control VALUES (?,?)').run('model_providers',JSON.stringify({providers:[{id:'p',name:'test',kind:'openai-compatible',baseUrl:'https://example.invalid/v1',apiKey:'fixture-secret',models:[{id:'grok-test',enabled:true}]}],defaultRef:{providerId:'p',modelId:'other'}}));db.close();
 const before=readFileSync(path);const selected=await configuredModel(dir,'test-bot',resolve('.'));
 assert.equal(selected.env.RAW_AGENT_MODEL_NAME,'grok-test');assert.equal(selected.env.RAW_AGENT_API_KEY,'fixture-secret');
 assert.ok(!JSON.stringify(selected.model).includes('fixture-secret'));assert.deepEqual(readFileSync(path),before);
 await assert.rejects(()=>configuredModel(dir,'missing',resolve('.')));
});

test('real Bot worker persists actual file changes and hidden checks reject dishonest success [AC:live-bot-quality#AC-1] [AC:live-bot-quality#AC-3]',t=>{
 const dir=mkdtempSync(join(tmpdir(),'live-bot-worker-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const task={id:'repair',bot:true,category:'execution',turns:['帮我修复 calculate.js，输出输入数字的两倍并检查。'],files:{'calculate.js':'x => x + 2'},publicChecks:[[2,4]],expected:{state:{},botEvidence:{sourceChecks:[[3,6],[-1,-2]]}},script:[{tool:'write_project_file',input:{file:'calculate.js',content:'x => x * 2'}},{tool:'check_project',input:{}},{text:'done'}]};
 for(const dishonest of [false,true]){
  const workspace=join(dir,String(dishonest));mkdirSync(workspace);
  const input=join(workspace,'input.json'),out=join(workspace,'result.json');
  writeFileSync(input,JSON.stringify({task:{...task,script:dishonest?[{text:'done, all tests passed'}]:task.script},variant:{repoRoot:resolve('.')},model:{},limits:{maxModelCalls:8,maxInputChars:250000},workspace,simulation:true,trial:0}));
  const run=spawnSync(process.execPath,['scripts/agent-eval/quality-worker.mjs',input,out],{env:sanitizeScriptEnv({...process.env,RAW_AGENT_AGENTS_SKILLS:'0',RAW_AGENT_E2E_ISOLATE:'1',RAW_AGENT_SELF_HEAL_AUTO_START:'0'}),encoding:'utf8',timeout:20000});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(readFileSync(out));assert.equal(gradeTask(task,result).pass,!dishonest,JSON.stringify(result));
 }
});

test('evidence gate rejects missing and tampered artifacts before promotion [AC:live-bot-quality#AC-5]', async t=>{
 const { verifyEvidence }=await import('../agent-eval/quality-gate.mjs');
 const dir=mkdtempSync(join(tmpdir(),'bot-gate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 assert.throws(()=>verifyEvidence(dir,{candidateSha:'new',baselineSha:'old'}));
 writeFileSync(join(dir,'evidence-index.json'),JSON.stringify({'../secret':'abc'}));
 assert.throws(()=>verifyEvidence(dir,{candidateSha:'new',baselineSha:'old'}));
});

test('release promotion checks quality before any deployment and force cannot bypass it [AC:live-bot-quality#AC-5]', async()=>{
 const { promoteWithQuality }=await import('../release/quality-promotion.mjs');
 let promoted=0;const args={report:{candidate:{git_sha:'candidate'}},evidenceDir:null,baselineSha:'stable',force:true};
 await assert.rejects(()=>promoteWithQuality(args,{verify:()=>{throw Error('quality missing');},promote:async()=>{promoted++;}}));
 assert.equal(promoted,0);
});

import { hash, compareQuality } from '../agent-eval/quality.mjs';
test('quality gate recomputes valid evidence and blocks tampering weak policies and source drift [AC:live-bot-quality#AC-4] [AC:live-bot-quality#AC-5]',async t=>{
 const {verifyEvidence}=await import('../agent-eval/quality-gate.mjs');
 const dir=mkdtempSync(join(tmpdir(),'bot-cert-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const suite=Array.from({length:200},(_,i)=>({id:'case-'+i,category:'tools',turns:['Reply OK'],expected:{exact:'OK'}}));
 const records=suite.flatMap(task=>Array.from({length:3},(_,trial)=>['baseline','candidate'].map(variant=>({caseId:task.id,trial,variant,status:'idle',output:'OK',invariantsOk:true,pass:true,failures:[],tokens:100,durationMs:10,modelCalls:1,model:{provider:'openai-compatible',name:'fixture-live',endpointHash:'fixture'}}))).flat());
 const refs={candidateSha:'c'.repeat(40),baselineSha:'b'.repeat(40)};
 const manifest={mode:'compare',simulation:false,trials:3,suiteHash:hash(suite),identities:{baseline:{gitSha:refs.baselineSha,dirty:false,buildHash:'old',lockHash:'lock'},candidate:{gitSha:refs.candidateSha,dirty:false,buildHash:'new',lockHash:'lock'}}};
 const report=compareQuality(suite,records,{trials:3});report.control=false;
 assert.equal(report.promotionEligible,true);
 const files={'manifest.json':manifest,'suite.json':suite,'report.json':report};
 for(const r of records)files[r.caseId+'-'+r.trial+'-'+r.variant+'.json']=r;
 const write=()=>{for(const [f,v] of Object.entries(files))writeFileSync(join(dir,f),JSON.stringify(v));writeFileSync(join(dir,'evidence-index.json'),JSON.stringify(Object.fromEntries(Object.keys(files).map(f=>[f,hash(readFileSync(join(dir,f),'utf8'))]))));};
 write();assert.equal(verifyEvidence(dir,refs).promotionEligible,true);
 assert.throws(()=>verifyEvidence(dir,{...refs,candidateSha:'wrong'}));
 writeFileSync(join(dir,'case-0-0-candidate.json'),'{}');assert.throws(()=>verifyEvidence(dir,refs),/digest/);
 write();files['report.json'].policy.minCases=1;write();assert.throws(()=>verifyEvidence(dir,refs),/weakened/);
});

test('production CLI forwards mandatory evidence to the non-bypassable promotion wrapper [AC:live-bot-quality#AC-5]',()=>{
 const cli=readFileSync('scripts/release-orchestrator.mjs','utf8');
 assert.match(cli,/await promoteWithQuality\(/);assert.doesNotMatch(cli,/await promoteWithSmoke\(/);
 assert.match(cli,/evidenceDir: args.evidenceDir/);
 assert.match(cli,/cmdPromote\(\{ \.\.\.args, runId: report.release_run_id \}\)/);
});

test('negative observations prove absence without pretending a failed lookup succeeded [AC:live-bot-quality#AC-1]',()=>{
 const c=buildBotSuite().find(c=>c.id==='claim-is-not-proof');
 const r={status:'idle',output:'NOT_FOUND',state:{},invariantsOk:true,botEvidence:{goalStatus:'none'},toolCalls:[{name:'lookup_record',input:{key:'result'},ok:false,content:'not_found'}]};
 assert.equal(gradeTask(c,r).pass,true);
 assert.equal(gradeTask(c,{...r,toolCalls:[]}).pass,false);
 assert.equal(gradeTask(c,{...r,toolCalls:[{...r.toolCalls[0],input:{key:'unrelated'}}]}).pass,false);
 assert.equal(gradeTask(c,{...r,infrastructureError:true}).pass,false);
});
test('real Bot compaction records replacement and preserves retrieval source [AC:live-bot-quality#AC-1] [AC:live-bot-quality#AC-3]',t=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-compact-eval-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const task={...buildBotSuite().find(c=>c.id==='compact-tail-failure'),script:[{text:'AUTH-739'}]};
 const input=join(dir,'input.json'),out=join(dir,'out.json');
 writeFileSync(input,JSON.stringify({task,variant:{repoRoot:resolve('.')},model:{},limits:{maxModelCalls:8,maxInputChars:250000},workspace:dir,simulation:true,trial:0}));
 const run=spawnSync(process.execPath,['scripts/agent-eval/quality-worker.mjs',input,out],{env:sanitizeScriptEnv({...process.env,RAW_AGENT_AGENTS_SKILLS:'0',RAW_AGENT_E2E_ISOLATE:'1',RAW_AGENT_SELF_HEAL_AUTO_START:'0'}),encoding:'utf8',timeout:20000});
 assert.equal(run.status,0,run.stderr);const r=JSON.parse(readFileSync(out));assert.equal(r.botEvidence.compacted,true);assert.ok(r.transcript.some(m=>m.parts.some(p=>p.type==='tool_result'&&p.content.includes('AUTH-739'))));
 assert.equal(gradeTask(task,r).pass,true);
});
